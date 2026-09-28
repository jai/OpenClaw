import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import {
  ensurePrivateSqliteCoordinatorDirectory,
  tryAcquireExclusiveSqliteCoordinator,
  type SqliteCoordinatorLease,
} from "../infra/sqlite-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runInPluginSourceCaptureContext } from "./plugin-source-capture-context.js";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;
const LEASE_FILE = "owner.sqlite";
type Instance = {
  references: number;
  closing?: boolean;
  timer: ReturnType<typeof setInterval>;
  root?: string;
  outputRoot?: string;
  lease?: SqliteCoordinatorLease;
};
const {
  instances,
  ownedRoots,
  failedReleases,
  nativeLoadPaths,
  retainedRoots,
  sweeps,
  warningBackoff,
} = resolveGlobalSingleton(Symbol.for("openclaw.pluginSourceCaptureInstances"), () => {
  const observedNativePaths = new Set<string>();
  const loadAddon = process.dlopen.bind(process);
  // An addon can throw or reenter disposal after its image has already been mapped.
  // Cache eviction does not unload it, and Windows cannot unlink a mapped image.
  process.dlopen = (...args) => {
    try {
      const file = fs.realpathSync.native(args[1]);
      observedNativePaths.add(
        process.platform === "win32" ? normalizeWindowsPathPreservingCase(file) : file,
      );
    } catch {
      // Observation must preserve the native loader's original result or error.
    }
    return loadAddon(...args);
  };
  process.once("exit", () => {
    for (const [key, instance] of instances) {
      try {
        const root = retireInstance(key, instance);
        if (root) {
          removeInstanceSync(root);
        }
      } catch (error) {
        process.stderr.write(`Plugin source capture exit cleanup failed: ${String(error)}\n`);
      }
    }
  });
  return {
    instances: new Map<string, Instance>(),
    ownedRoots: new Set<string>(),
    failedReleases: new Map<string, SqliteCoordinatorLease>(),
    nativeLoadPaths: observedNativePaths,
    retainedRoots: new Set<string>(),
    sweeps: new Map<string, Promise<void>>(),
    warningBackoff: new Map<string, { next: number; delay: number }>(),
  };
});

function instanceDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

function fallbackDirectory(stateDir: string): string {
  const profile = createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 24);
  return path.join(tmpdir(), `openclaw-plugin-captures-${profile}`);
}

/** Loaded native code retains physical source custody until the process exits. */
export function retainLoadedPluginSourceCapture(directory: string): boolean {
  if (![...nativeLoadPaths].some((file) => isPathInside(directory, file))) {
    return false;
  }
  const root = [...ownedRoots].find((owned) => isPathInside(owned, directory)) ?? directory;
  if (![...retainedRoots].some((owned) => isPathInside(owned, root) || isPathInside(root, owned))) {
    warn(`retained-by-loaded-module: ${root}; cleanup deferred until a later process sweep`);
  }
  retainedRoots.add(root);
  return true;
}

function retireInstance(key: string, instance: Instance): string | undefined {
  if (instance.root && retainLoadedPluginSourceCapture(instance.root)) {
    instance.references = 0;
    return undefined;
  }
  instance.closing = true;
  // A failed native close retains the same handle and refuses new capture admission.
  instance.lease?.release();
  if (instance.root) {
    ownedRoots.delete(instance.root);
  }
  instance.references = 0;
  instances.delete(key);
  clearInterval(instance.timer);
  return instance.root;
}

function removeInstanceSync(root: string): void {
  // Preserve the ownership file if payload removal fails, so a later sweep can retry.
  fs.rmSync(path.join(root, "captures"), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

async function reclaimInstances(
  root: string,
  recordFailure: (error: unknown) => void,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    const stat = await fsPromises.lstat(root);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
      return;
    }
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }
  const cutoff = Date.now() - CAPTURE_GRACE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(root, entry.name);
    let lease: SqliteCoordinatorLease | null = null;
    let heldRoot: string | undefined;
    try {
      const stat = await fsPromises.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.mtimeMs > cutoff ||
        (process.platform === "win32" && (stat.dev === 0 || stat.ino === 0)) ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        continue;
      }
      const canonical = await fsPromises.realpath(directory);
      // Opening/closing a second native connection can disturb this process's POSIX locks.
      if (ownedRoots.has(canonical) || retainLoadedPluginSourceCapture(canonical)) {
        continue;
      }
      const leasePath = path.join(canonical, LEASE_FILE);
      const leaseStat = await fsPromises.lstat(leasePath);
      const captures = path.join(canonical, "captures");
      const captureStat = await fsPromises.lstat(captures).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        // A prior pass may have removed the payload before instance removal failed.
        return undefined;
      });
      if (
        !leaseStat.isFile() ||
        leaseStat.nlink !== 1 ||
        (process.platform === "win32" && (leaseStat.dev === 0 || leaseStat.ino === 0)) ||
        (process.getuid && leaseStat.uid !== process.getuid()) ||
        (captureStat && !captureStat.isDirectory()) ||
        ownedRoots.has(canonical)
      ) {
        continue;
      }
      // Unknown layouts can contain durable native receipts from newer releases.
      const names = await fsPromises.readdir(canonical);
      if (names.some((name) => name !== LEASE_FILE && name !== "captures")) {
        continue;
      }
      if (ownedRoots.has(canonical)) {
        continue;
      }
      const unchanged = () => {
        const current = fs.lstatSync(canonical);
        const owner = fs.lstatSync(leasePath);
        return (
          current.isDirectory() &&
          current.dev === stat.dev &&
          current.ino === stat.ino &&
          owner.isFile() &&
          owner.nlink === 1 &&
          owner.dev === leaseStat.dev &&
          owner.ino === leaseStat.ino
        );
      };
      // Never recreate a missing custody token during reclamation.
      lease = tryAcquireExclusiveSqliteCoordinator(resolveExistingSqliteFileUri(leasePath));
      if (!lease) {
        continue;
      }
      ownedRoots.add(canonical);
      heldRoot = canonical;
      if (
        !unchanged() ||
        fs.readdirSync(canonical).some((name) => name !== LEASE_FILE && name !== "captures")
      ) {
        continue;
      }
      const currentCapture = fs.lstatSync(captures, { throwIfNoEntry: false });
      if (
        currentCapture &&
        (!currentCapture.isDirectory() ||
          currentCapture.dev !== captureStat?.dev ||
          currentCapture.ino !== captureStat?.ino)
      ) {
        continue;
      }
      // The native lock proves released custody even across PID namespaces.
      await fsPromises.rm(captures, { recursive: true, force: true });
      lease.release();
      lease = null;
      // Instance IDs are never reused. Close the lease before removing its file on Windows.
      if (unchanged()) {
        await fsPromises.rm(canonical, { recursive: true, force: true });
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        recordFailure(error);
      }
    } finally {
      try {
        lease?.release();
      } catch (error) {
        recordFailure(error);
      }
      if (heldRoot) {
        if (lease && !lease.closed) {
          failedReleases.set(heldRoot, lease);
        } else {
          ownedRoots.delete(heldRoot);
        }
      }
    }
  }
}

/** Coalesce active scans, but throttle diagnostics independently of cleanup retries. */
export function sweepPluginSourceCaptureDirectories(stateDir = resolveStateDir()): Promise<void> {
  const root = path.resolve(instanceDirectory(stateDir));
  let sweep = sweeps.get(root);
  if (!sweep) {
    let failures = 0;
    let firstFailure: unknown;
    const recordFailure = (error: unknown) => {
      if (failures++ === 0) {
        firstFailure = error;
      }
    };
    sweep = (async () => {
      for (const [directory, lease] of failedReleases) {
        try {
          lease.release();
          failedReleases.delete(directory);
          ownedRoots.delete(directory);
        } catch (error) {
          recordFailure(error);
        }
      }
      for (const directory of [root, fallbackDirectory(stateDir)]) {
        await reclaimInstances(directory, recordFailure).catch(recordFailure);
      }
    })()
      .then(() => {
        if (failures === 0) {
          warningBackoff.delete(root);
          return;
        }
        const now = Date.now();
        const previous = warningBackoff.get(root);
        if (previous && now < previous.next) {
          return;
        }
        const delay = Math.min(
          (previous?.delay ?? CAPTURE_GRACE_MS / 2) * 2,
          24 * CAPTURE_GRACE_MS,
        );
        // Bound diagnostics for processes that inspect many independent profiles.
        if (!previous && warningBackoff.size >= 32) {
          const oldest = warningBackoff.keys().next().value;
          if (oldest !== undefined) {
            warningBackoff.delete(oldest);
          }
        }
        warningBackoff.set(root, { next: now + delay, delay });
        warn(
          `${failures} cleanup failure(s) in ${root}; will retry. First: ${String(firstFailure)}`,
        );
      })
      .finally(() => sweeps.delete(root));
    sweeps.set(root, sweep);
  }
  return sweep;
}

function createCaptureDirectory(instance: Instance, stateDir: string): string {
  if (instance.root) {
    return fs.mkdtempSync(path.join(instance.root, "captures", PLUGIN_SOURCE_CAPTURE_PREFIX));
  }
  const prepare = (fallback: boolean): string => {
    let directory: string | undefined;
    let lease: SqliteCoordinatorLease | null = null;
    try {
      const parent = fallback ? fallbackDirectory(stateDir) : instanceDirectory(stateDir);
      ensurePrivateSqliteCoordinatorDirectory(parent, "Plugin source capture");
      instance.outputRoot = fs.realpathSync(parent);
      const candidate = path.join(instance.outputRoot, randomUUID());
      fs.mkdirSync(candidate, { mode: 0o700 });
      directory = candidate;
      const canonical = fs.realpathSync(directory);
      lease = tryAcquireExclusiveSqliteCoordinator(path.join(canonical, LEASE_FILE));
      if (!lease) {
        throw new Error("Could not acquire new plugin source instance");
      }
      fs.chmodSync(path.join(canonical, LEASE_FILE), 0o600);
      const captures = path.join(canonical, "captures");
      fs.mkdirSync(captures, { mode: 0o700 });
      const capture = fs.mkdtempSync(path.join(captures, PLUGIN_SOURCE_CAPTURE_PREFIX));
      instance.root = canonical;
      instance.lease = lease;
      ownedRoots.add(canonical);
      return capture;
    } catch (error) {
      try {
        lease?.release();
      } catch (releaseError) {
        // Retain custody for release() to retry; never unlink a still-open coordinator.
        instance.root = directory;
        instance.lease = lease ?? undefined;
        instance.closing = true;
        if (directory) {
          ownedRoots.add(directory);
        }
        throw new AggregateError(
          [error, releaseError],
          "Plugin source preparation cleanup failed",
          {
            cause: releaseError,
          },
        );
      }
      if (directory) {
        try {
          removeInstanceSync(directory);
        } catch (cleanupError) {
          warn(cleanupError);
        }
      }
      throw error;
    }
  };
  try {
    return prepare(false);
  } catch (error) {
    if (instance.closing) {
      throw error;
    }
    // The fallback covers the whole allocation, including SQLite and the first capture.
    // Profile-qualified fallback instances have the same lease and reclamation contract.
    warn(error);
    return prepare(true);
  }
}

/** Metadata and its captures share custody; standalone CLI captures own their own lifetime. */
export function retainPluginSourceCaptureInstance(stateDir = resolveStateDir()) {
  const key = path.resolve(stateDir);
  let instance = instances.get(key);
  if (instance?.closing) {
    throw new Error(
      "Plugin source instance cleanup is incomplete; retry cleanup before creating captures",
    );
  }
  if (!instance) {
    const timer = runInPluginSourceCaptureContext(() =>
      setInterval(() => void sweepPluginSourceCaptureDirectories(key), CAPTURE_GRACE_MS),
    );
    timer.unref();
    instance = { references: 0, timer };
    instances.set(key, instance);
    void sweepPluginSourceCaptureDirectories(key);
  }
  instance.references += 1;
  const retained = instance;
  let released = false;
  let pendingRemoval: string | undefined;
  const retire = () => {
    if (released) {
      return pendingRemoval;
    }
    if (retained.references > 1) {
      retained.references -= 1;
      released = true;
      return undefined;
    }
    pendingRemoval = retireInstance(key, retained);
    released = true;
    return pendingRemoval;
  };
  return {
    get outputRoot() {
      return retained.outputRoot;
    },
    createDirectory() {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return createCaptureDirectory(retained, key);
    },
    release() {
      const root = retire();
      if (root) {
        removeInstanceSync(root);
        pendingRemoval = undefined;
      }
    },
    async releaseAsync() {
      const root = retire();
      if (root) {
        await fsPromises.rm(path.join(root, "captures"), { recursive: true, force: true });
        await fsPromises.rm(root, { recursive: true, force: true });
        pendingRemoval = undefined;
      }
    },
  };
}
