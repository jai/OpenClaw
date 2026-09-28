import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { retainGatewayPluginMetadata } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import { sweepPluginSourceCaptureDirectories } from "./plugin-source-capture-directory.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const captureModule = new URL("./plugin-package-metadata-capture.ts", import.meta.url).href;
const hour = 60 * 60 * 1_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function age(directory: string) {
  const timestamp = new Date(Date.now() - 2 * hour);
  fs.utimesSync(directory, timestamp, timestamp);
}

function runCaptureProcess(stateDir: string, script: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", loader, "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: path.dirname(stateDir),
        TMP: path.dirname(stateDir),
        TEMP: path.dirname(stateDir),
      },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it.each(["sync", "async"])(
  "retains a loaded native addon after cache eviction and %s disposal through process exit",
  async (mode) => {
    const stateDir = path.join(temp.make("plugin-capture-native-"), "state");
    const observed = runCaptureProcess(
      stateDir,
      `
      import fs from "node:fs";
      import path from "node:path";
      import { createRequire } from "node:module";
      import { createPluginSourceCapture } from ${JSON.stringify(captureModule)};
      const require = createRequire(import.meta.url);
      require("koffi");
      const original = Object.keys(require.cache).find(file => file.endsWith("koffi.node"));
      if (!original) throw new Error("Koffi did not load its native addon");
      const capture = createPluginSourceCapture();
      const file = path.join(capture.directory, "koffi.node");
      fs.copyFileSync(original, file);
      const addon = require(file);
      delete require.cache[file];
      ${mode === "sync" ? "capture.dispose();" : "await capture.disposeAsync();"}
      // This listener follows the capture owner's terminal cleanup.
      process.on("exit", () => process.stdout.write(JSON.stringify({
        file, present: fs.existsSync(file), size: addon.type("int").size,
      })));
      `,
    );
    expect(observed.size).toBe(4);
    expect(observed.present).toBe(true);
    expect(fs.existsSync(observed.file)).toBe(true);
    age(path.dirname(path.dirname(path.dirname(observed.file))));
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.existsSync(observed.file)).toBe(false);
  },
);

it("removes ordinary capture payloads after successful disposal", () => {
  const stateDir = path.join(temp.make("plugin-capture-disposal-"), "state");
  const observed = runCaptureProcess(
    stateDir,
    `
    import fs from "node:fs";
    import path from "node:path";
    import { createPluginSourceCapture } from ${JSON.stringify(captureModule)};
    const captures = [createPluginSourceCapture(), createPluginSourceCapture()];
    for (const capture of captures) fs.writeFileSync(path.join(capture.directory, "payload"), "bytes");
    captures[0].dispose();
    await captures[1].disposeAsync();
    process.stdout.write(JSON.stringify(captures.map(capture => fs.existsSync(capture.directory))));
    `,
  );
  expect(observed).toEqual([false, false]);
});

async function startCaptureProcess(stateDir: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "-e",
      `
      import fs from "node:fs";
      import path from "node:path";
      import { createPluginSourceCapture } from ${JSON.stringify(captureModule)};
      const capture = createPluginSourceCapture();
      const file = path.join(capture.directory, "payload");
      fs.writeFileSync(file, "captured bytes");
      process.stdout.write(JSON.stringify({ directory: capture.directory, file }) + "\\n");
      process.stdin.on("data", () => process.stdout.write(fs.readFileSync(file, "utf8") + "\\n"));
      process.stdin.resume();
    `,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: path.dirname(stateDir),
        TMP: path.dirname(stateDir),
        TEMP: path.dirname(stateDir),
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  void exited.catch(() => {});
  const nextLine = async () => {
    const result = await lines.next();
    if (result.done) {
      throw new Error(`Capture process exited before replying: ${stderr}`);
    }
    return result.value;
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    reader.close();
  };
  try {
    const captured: { directory: string; file: string } = JSON.parse(await nextLine());
    return {
      ...captured,
      root: path.dirname(path.dirname(captured.directory)),
      stop,
      async read() {
        child.stdin.write("read\n");
        return nextLine();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function abandonCapture(stateDir: string) {
  const child = await startCaptureProcess(stateDir);
  await child.stop();
  expect(fs.readFileSync(child.file, "utf8")).toBe("captured bytes");
  return child;
}

it.each(["managed", "fallback"])(
  "protects live %s captures and reclaims them after SIGKILL without pruning legacy files",
  async (location) => {
    const runtimeTemp = temp.make("plugin-capture-crash-");
    const stateDir = path.join(runtimeTemp, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(name, runtimeTemp);
    }
    if (location === "fallback") {
      fs.writeFileSync(stateDir, "unavailable state directory");
    }
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const child = await startCaptureProcess(stateDir);
    const legacy = path.join(runtimeTemp, "openclaw-plugin-build-legacy");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "sentinel"), "unknown custody");
    age(legacy);
    age(child.root);
    const metadata = retainGatewayPluginMetadata();
    try {
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(await child.read()).toBe("captured bytes");
      await child.stop();
      await sweepPluginSourceCaptureDirectories(stateDir);
      expect(fs.existsSync(child.root)).toBe(false);
      expect(fs.readFileSync(path.join(legacy, "sentinel"), "utf8")).toBe("unknown custody");
    } finally {
      await child.stop();
      await metadata.close();
    }
  },
);

it("gateway boot reclaims old crashes and hourly maintenance later reclaims recent crashes", async () => {
  const stateDir = path.join(temp.make("plugin-capture-startup-"), "state");
  const old = await abandonCapture(stateDir);
  const recent = await abandonCapture(stateDir);
  age(old.root);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const metadata = retainGatewayPluginMetadata();
  try {
    await vi.waitFor(() => expect(fs.existsSync(old.root)).toBe(false));
    expect(fs.readFileSync(recent.file, "utf8")).toBe("captured bytes");
    await vi.advanceTimersByTimeAsync(2 * hour);
    await vi.waitFor(() => expect(fs.existsSync(recent.root)).toBe(false));
  } finally {
    await metadata.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
  }
});

it.each(["payload", "instance"])(
  "retries a failed %s removal with its custody token intact",
  async (stage) => {
    const stateDir = path.join(temp.make("plugin-capture-retry-"), "state");
    const orphan = await abandonCapture(stateDir);
    age(orphan.root);
    const remove = fsPromises.rm.bind(fsPromises);
    const failingPath = stage === "payload" ? path.dirname(orphan.directory) : orphan.root;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const fault = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === failingPath) {
        throw Object.assign(new Error("fixture removal refused"), { code: "EACCES" });
      }
      await remove(target, options);
    });
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(orphan.root, "owner.sqlite"))).toBe(true);
    expect(fs.existsSync(orphan.file)).toBe(stage === "payload");
    fault.mockRestore();
    age(orphan.root);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.existsSync(orphan.root)).toBe(false);
  },
);

it.each([
  "missing",
  "symlink",
  "hardlink",
  "malformed SQLite",
  "payload symlink",
  "newer native layout",
])("refuses reclamation with %s ownership instead of guessing from age", async (kind) => {
  const runtimeTemp = temp.make("plugin-capture-refusal-");
  const stateDir = path.join(runtimeTemp, "state");
  const orphan = await abandonCapture(stateDir);
  const token = path.join(orphan.root, "owner.sqlite");
  if (kind === "payload symlink") {
    const payload = path.join(orphan.root, "captures");
    const retained = path.join(runtimeTemp, "retained-payload");
    fs.renameSync(payload, retained);
    fs.symlinkSync(retained, payload, "junction");
  } else if (kind === "malformed SQLite") {
    fs.writeFileSync(token, "not a SQLite database");
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  } else if (kind === "newer native layout") {
    fs.mkdirSync(path.join(orphan.root, "native"));
    fs.writeFileSync(path.join(orphan.root, "native", "receipt-owned"), "durable native bytes");
  } else if (kind === "hardlink") {
    fs.linkSync(token, path.join(runtimeTemp, "other-owner.sqlite"));
  } else {
    fs.unlinkSync(token);
    if (kind === "symlink") {
      const foreign = path.join(runtimeTemp, "foreign");
      fs.writeFileSync(foreign, "do not open as SQLite");
      fs.symlinkSync(foreign, token);
    }
  }
  age(orphan.root);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.readFileSync(orphan.file, "utf8")).toBe("captured bytes");
  if (kind === "missing") {
    expect(fs.existsSync(token)).toBe(false);
  }
  if (kind === "symlink") {
    expect(fs.readFileSync(token, "utf8")).toBe("do not open as SQLite");
  }
});

it("retains a failed native close for retry without opening another connection to its token", async () => {
  const stateDir = path.join(temp.make("plugin-capture-close-retry-"), "state");
  const orphan = await abandonCapture(stateDir);
  age(orphan.root);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { DatabaseSync } = requireNodeSqlite();
  const removal = vi.spyOn(fsPromises, "rm");
  const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(() => {
    throw new Error("fixture native close refused");
  });
  try {
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(close).toHaveBeenCalled();
    expect(fs.existsSync(path.join(orphan.root, "owner.sqlite"))).toBe(true);
    const attempts = removal.mock.calls.length;
    age(orphan.root);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(removal).toHaveBeenCalledTimes(attempts);
  } finally {
    close.mockRestore();
  }
  age(orphan.root);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(orphan.root)).toBe(false);
});

it.each(["before command", "inside command"])(
  "keeps maintenance outside the first CLI request when imported %s",
  (order) => {
    const stateDir = path.join(temp.make("plugin-capture-cli-context-"), "state");
    const cleanupModule = new URL("../cli/runtime-cleanup-scope.ts", import.meta.url).href;
    const observed = runCaptureProcess(
      stateDir,
      `
      import { AsyncLocalStorage, createHook } from "node:async_hooks";
      import { getCliPluginInvocationResources, withCliCommandCleanup, withCliProcessScope } from ${JSON.stringify(cleanupModule)};
      const load = () => import(${JSON.stringify(captureModule)});
      if (${JSON.stringify(order)} === "before command") await load();
      const request = new AsyncLocalStorage();
      const observed = [];
      const hook = createHook({ init(id, type, trigger, resource) {
        if (type === "Timeout") observed.push({
          resource, context: request.getStore() ?? null,
          cli: Boolean(getCliPluginInvocationResources()),
        });
      }});
      const result = await request.run("first-command", () => withCliProcessScope(() =>
        withCliCommandCleanup(false, async (cleanup) => {
          const { createPluginSourceCapture } = await load();
          hook.enable();
          try { return { capture: createPluginSourceCapture(), cleanup }; }
          finally { hook.disable(); }
        }),
      ));
      const timers = observed.map(({ resource, context, cli }) => ({ context, cli, referenced: resource.hasRef() }));
      await result.capture.disposeAsync();
      await result.cleanup.pluginResources.release();
      process.stdout.write(JSON.stringify(timers));
    `,
    );
    expect(observed).toEqual([{ context: null, cli: false, referenced: false }]);
  },
);

it("keeps sibling and explicitly worker-owned captures until their own disposal", async () => {
  const stateDir = path.join(temp.make("plugin-capture-borrowers-"), "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const source = temp.make("plugin-capture-source-");
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 42;");
  const metadata = retainGatewayPluginMetadata();
  const first = capturePluginGenerationArtifact(source);
  const second = capturePluginGenerationArtifact(source);
  const workerRoot = temp.make("plugin-capture-worker-");
  fs.writeFileSync(path.join(workerRoot, "sentinel"), "parent custody");
  const worker = withPluginSourceCaptureDirectory(workerRoot, () =>
    capturePluginGenerationArtifact(source),
  );
  try {
    const root = path.dirname(path.dirname(first.boundaryRoot));
    age(root);
    await first.disposeAsync();
    await metadata.close();
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(second.resolve(path.join(source, "index.cjs")), "utf8")).toBe(
      "module.exports = 42;",
    );
    expect(path.dirname(worker.boundaryRoot)).toBe(workerRoot);
    await second.disposeAsync();
    expect(fs.existsSync(root)).toBe(false);
    await worker.disposeAsync();
    expect(fs.readFileSync(path.join(workerRoot, "sentinel"), "utf8")).toBe("parent custody");
  } finally {
    await first.disposeAsync();
    await second.disposeAsync();
    await worker.disposeAsync();
    await metadata.close();
  }
});

it("records native initialization before it reenters disposal and throws", () => {
  const stateDir = path.join(temp.make("plugin-capture-reentrant-"), "state");
  const observed = runCaptureProcess(
    stateDir,
    `
    import fs from "node:fs";
    import path from "node:path";
    const failure = new Error("native initialization failed");
    const native = process.dlopen;
    let capture;
    process.dlopen = function(module, file, flags) {
      if (!file.endsWith("synthetic.node")) return native.apply(this, arguments);
      if (this !== process || flags !== 17) throw new Error("native calling convention changed");
      capture.dispose();
      throw failure;
    };
    const { createPluginSourceCapture } = await import(${JSON.stringify(captureModule)});
    capture = createPluginSourceCapture();
    const file = path.join(capture.directory, "synthetic.node");
    fs.writeFileSync(file, "synthetic mapped image");
    let originalError = false;
    try { process.dlopen({}, path.toNamespacedPath(file), 17); }
    catch (error) { originalError = error === failure; }
    await capture.disposeAsync();
    process.stdout.write(JSON.stringify({ originalError, present: fs.existsSync(file) }));
  `,
  );
  expect(observed).toEqual({ originalError: true, present: true });
});

it.each(["natural", "explicit"])("cleans ordinary captures on %s process exit", (mode) => {
  const stateDir = path.join(temp.make("plugin-capture-exit-"), "state");
  const observed = runCaptureProcess(
    stateDir,
    `
    import fs from "node:fs";
    import { createPluginSourceCapture } from ${JSON.stringify(captureModule)};
    const capture = createPluginSourceCapture();
    process.on("exit", () => process.stdout.write(JSON.stringify({ directory: capture.directory, present: fs.existsSync(capture.directory) })));
    ${mode === "explicit" ? "process.exit(0);" : ""}
  `,
  );
  expect(observed.present).toBe(false);
  expect(fs.existsSync(observed.directory)).toBe(false);
});
