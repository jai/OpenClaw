import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";

export const REQUIRED_PROMPT_FILES = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"] as const;
export const OPTIONAL_PROMPT_FILES = ["USER.md"] as const;
export const MANAGED_PROMPT_FILES = [...REQUIRED_PROMPT_FILES, ...OPTIONAL_PROMPT_FILES] as const;

const DEFAULT_PROMPT_REPO = "git@github.com:jai/openclaw-prompts.git";
const DEFAULT_PROMPT_REF = "main";
const DEFAULT_BUNDLE_ROOT = "agent-prompts";

export type PromptReconcilerFileKind = "prompt" | "support";
export type PromptReconcilerFileAction = "create" | "update" | "delete" | "unchanged";

export type PromptReconcilerFileChange = {
  kind: PromptReconcilerFileKind;
  action: PromptReconcilerFileAction;
  relativePath: string;
  source?: string;
  destination: string;
  beforeSha256?: string;
  afterSha256?: string;
  mode?: number;
};

export type PromptReconcilerRunStep = {
  command: string;
  args: string[];
  cwd?: string;
};

export type PromptReconcilerOptions = {
  config: OpenClawConfig;
  agentId?: string;
  runtimeId?: string;
  repository?: string;
  ref?: string;
  checkoutDir?: string;
  sourceDir?: string;
  bundleRoot?: string;
  workspaceDir?: string;
  supportDir?: string;
  apply?: boolean;
  pull?: boolean;
  render?: boolean;
  prune?: boolean;
  allowDirtyCheckout?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type PromptReconcilerResult = {
  applied: boolean;
  agentId: string;
  runtimeId: string;
  repository?: string;
  ref?: string;
  checkoutDir?: string;
  bundleRoot: string;
  sourceDir: string;
  workspaceDir: string;
  supportDir: string;
  files: PromptReconcilerFileChange[];
  changed: PromptReconcilerFileChange[];
  steps: PromptReconcilerRunStep[];
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

function normalizeRuntimeId(env: NodeJS.ProcessEnv): string {
  const explicit =
    normalizeOptionalString(env.OPENCLAW_PROMPTS_RUNTIME) ??
    normalizeOptionalString(env.OPENCLAW_PROMPT_RUNTIME) ??
    normalizeOptionalString(env.OPENCLAW_PROFILE) ??
    normalizeOptionalString(os.userInfo().username);
  return explicit ?? "default";
}

export function resolvePromptReconcilerDefaults(options: {
  config: OpenClawConfig;
  agentId?: string;
  runtimeId?: string;
  checkoutDir?: string;
  bundleRoot?: string;
  workspaceDir?: string;
  supportDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  agentId: string;
  runtimeId: string;
  checkoutDir: string;
  bundleRoot: string;
  workspaceDir: string;
  supportDir: string;
} {
  const env = options.env ?? process.env;
  const agentId = normalizeAgentId(options.agentId ?? "main");
  const runtimeId = options.runtimeId?.trim() || normalizeRuntimeId(env);
  const stateDir = resolveStateDir(env);
  const checkoutDir =
    normalizeOptionalString(options.checkoutDir) ??
    normalizeOptionalString(env.OPENCLAW_PROMPTS_CHECKOUT_DIR) ??
    path.join(stateDir, "prompt-source", "openclaw-prompts");
  const bundleRoot =
    normalizeOptionalString(options.bundleRoot) ??
    normalizeOptionalString(env.OPENCLAW_PROMPTS_BUNDLE_ROOT) ??
    DEFAULT_BUNDLE_ROOT;
  const workspaceDir =
    normalizeOptionalString(options.workspaceDir) ??
    resolveAgentWorkspaceDir(options.config, agentId, env);
  const supportRoot = agentId === "main" ? runtimeId : `${runtimeId}-${agentId}`;
  const supportDir =
    normalizeOptionalString(options.supportDir) ?? path.join(stateDir, "runtime", supportRoot);

  return {
    agentId,
    runtimeId,
    checkoutDir: resolveUserPath(checkoutDir, env),
    bundleRoot,
    workspaceDir: resolveUserPath(workspaceDir, env),
    supportDir: resolveUserPath(supportDir, env),
  };
}

function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit ${code}${detail ? `:\n${detail}` : ""}`,
        ),
      );
    });
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        out.push(path.relative(root, fullPath));
      }
    }
  }
  return out;
}

async function readSha256(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function copyFileAtomic(source: string, destination: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.copyFile(source, temp);
  if (mode !== undefined) {
    await fs.chmod(temp, mode);
  }
  await fs.rename(temp, destination);
}

async function ensurePromptSourceCheckout(params: {
  repository: string;
  ref: string;
  checkoutDir: string;
  pull: boolean;
  allowDirtyCheckout: boolean;
  env: NodeJS.ProcessEnv;
  steps: PromptReconcilerRunStep[];
}): Promise<void> {
  if (!params.pull && (await isDirectory(params.checkoutDir))) {
    return;
  }

  if (!(await pathExists(params.checkoutDir))) {
    if (!params.pull) {
      throw new Error(
        `Prompt checkout does not exist: ${params.checkoutDir}. Drop --no-pull or provide --source-dir.`,
      );
    }
    await fs.mkdir(path.dirname(params.checkoutDir), { recursive: true });
    const args = ["clone", params.repository, params.checkoutDir];
    params.steps.push({ command: "git", args });
    await runCommand("git", args, { env: params.env });
  }

  if (!(await isDirectory(path.join(params.checkoutDir, ".git")))) {
    throw new Error(`Prompt checkout is not a git repository: ${params.checkoutDir}`);
  }

  const status = await runCommand("git", ["status", "--porcelain"], {
    cwd: params.checkoutDir,
    env: params.env,
  });
  if (status.stdout.trim() && !params.allowDirtyCheckout) {
    throw new Error(
      `Prompt checkout has local changes: ${params.checkoutDir}. Commit, clean, or use --allow-dirty-checkout.`,
    );
  }

  if (!params.pull) {
    return;
  }

  const fetchArgs = ["fetch", "origin", params.ref, "--depth=1"];
  params.steps.push({ command: "git", args: fetchArgs, cwd: params.checkoutDir });
  try {
    await runCommand("git", fetchArgs, { cwd: params.checkoutDir, env: params.env });
  } catch {
    const fallbackFetchArgs = ["fetch", "origin", "--depth=1"];
    params.steps.push({ command: "git", args: fallbackFetchArgs, cwd: params.checkoutDir });
    await runCommand("git", fallbackFetchArgs, { cwd: params.checkoutDir, env: params.env });
  }

  const checkoutArgs = ["checkout", params.ref];
  params.steps.push({ command: "git", args: checkoutArgs, cwd: params.checkoutDir });
  await runCommand("git", checkoutArgs, { cwd: params.checkoutDir, env: params.env });

  const resetArgs = ["reset", "--hard", `origin/${params.ref}`];
  params.steps.push({ command: "git", args: resetArgs, cwd: params.checkoutDir });
  try {
    await runCommand("git", resetArgs, { cwd: params.checkoutDir, env: params.env });
  } catch {
    const detachArgs = ["checkout", "--detach", params.ref];
    params.steps.push({ command: "git", args: detachArgs, cwd: params.checkoutDir });
    await runCommand("git", detachArgs, { cwd: params.checkoutDir, env: params.env });
  }
}

async function renderPromptSource(params: {
  checkoutDir: string;
  render: boolean;
  env: NodeJS.ProcessEnv;
  steps: PromptReconcilerRunStep[];
}): Promise<void> {
  if (!params.render) {
    return;
  }
  const scriptPath = path.join(params.checkoutDir, "scripts", "render-openclaw-prompts.mjs");
  if (!(await pathExists(scriptPath))) {
    return;
  }
  const args = [scriptPath, "--write", "--repo-root", params.checkoutDir];
  params.steps.push({ command: process.execPath, args, cwd: params.checkoutDir });
  await runCommand(process.execPath, args, { cwd: params.checkoutDir, env: params.env });
}

async function validatePromptSourceDir(sourceDir: string): Promise<void> {
  const missing: string[] = [];
  for (const fileName of REQUIRED_PROMPT_FILES) {
    if (!(await pathExists(path.join(sourceDir, fileName)))) {
      missing.push(fileName);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required prompt files in ${sourceDir}: ${missing.join(", ")}`);
  }
}

async function planPromptFiles(params: {
  sourceDir: string;
  workspaceDir: string;
  prune: boolean;
}): Promise<PromptReconcilerFileChange[]> {
  const changes: PromptReconcilerFileChange[] = [];
  for (const fileName of MANAGED_PROMPT_FILES) {
    const source = path.join(params.sourceDir, fileName);
    const destination = path.join(params.workspaceDir, fileName);
    const sourceSha = await readSha256(source);
    const destinationSha = await readSha256(destination);
    if (sourceSha) {
      changes.push({
        kind: "prompt",
        action:
          destinationSha === undefined
            ? "create"
            : destinationSha === sourceSha
              ? "unchanged"
              : "update",
        relativePath: fileName,
        source,
        destination,
        beforeSha256: destinationSha,
        afterSha256: sourceSha,
      });
      continue;
    }
    if (params.prune && destinationSha !== undefined) {
      changes.push({
        kind: "prompt",
        action: "delete",
        relativePath: fileName,
        destination,
        beforeSha256: destinationSha,
      });
    }
  }
  return changes;
}

async function planSupportFiles(params: {
  sourceDir: string;
  supportDir: string;
  prune: boolean;
}): Promise<PromptReconcilerFileChange[]> {
  const sourceSupportDir = path.join(params.sourceDir, "support");
  const [sourceFiles, destinationFiles] = await Promise.all([
    listFilesRecursive(sourceSupportDir),
    params.prune ? listFilesRecursive(params.supportDir) : Promise.resolve([]),
  ]);
  const sourceSet = new Set(sourceFiles);
  const changes: PromptReconcilerFileChange[] = [];

  for (const relativePath of sourceFiles) {
    const source = path.join(sourceSupportDir, relativePath);
    const destination = path.join(params.supportDir, relativePath);
    const [sourceSha, destinationSha, stat] = await Promise.all([
      readSha256(source),
      readSha256(destination),
      fs.stat(source),
    ]);
    if (!sourceSha) {
      continue;
    }
    const mode = (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
    changes.push({
      kind: "support",
      action:
        destinationSha === undefined
          ? "create"
          : destinationSha === sourceSha
            ? "unchanged"
            : "update",
      relativePath,
      source,
      destination,
      beforeSha256: destinationSha,
      afterSha256: sourceSha,
      mode,
    });
  }

  for (const relativePath of destinationFiles) {
    if (sourceSet.has(relativePath)) {
      continue;
    }
    const destination = path.join(params.supportDir, relativePath);
    changes.push({
      kind: "support",
      action: "delete",
      relativePath,
      destination,
      beforeSha256: await readSha256(destination),
    });
  }

  return changes;
}

async function applyChange(change: PromptReconcilerFileChange): Promise<void> {
  if (change.action === "unchanged") {
    return;
  }
  if (change.action === "delete") {
    await fs.rm(change.destination, { force: true });
    return;
  }
  if (!change.source) {
    throw new Error(`Missing source for ${change.relativePath}`);
  }
  await copyFileAtomic(change.source, change.destination, change.mode);
}

export async function reconcilePromptFiles(
  options: PromptReconcilerOptions,
): Promise<PromptReconcilerResult> {
  const env = options.env ?? process.env;
  const defaults = resolvePromptReconcilerDefaults({
    config: options.config,
    agentId: options.agentId,
    runtimeId: options.runtimeId,
    checkoutDir: options.checkoutDir,
    bundleRoot: options.bundleRoot,
    workspaceDir: options.workspaceDir,
    supportDir: options.supportDir,
    env,
  });
  const repository =
    normalizeOptionalString(options.repository) ??
    normalizeOptionalString(env.OPENCLAW_PROMPTS_REPO) ??
    DEFAULT_PROMPT_REPO;
  const ref =
    normalizeOptionalString(options.ref) ??
    normalizeOptionalString(env.OPENCLAW_PROMPTS_REF) ??
    DEFAULT_PROMPT_REF;
  const apply = Boolean(options.apply);
  const pull = options.pull !== false;
  const render = options.render !== false;
  const prune = options.prune !== false;
  const steps: PromptReconcilerRunStep[] = [];

  if (!options.sourceDir) {
    await ensurePromptSourceCheckout({
      repository,
      ref,
      checkoutDir: defaults.checkoutDir,
      pull,
      allowDirtyCheckout: Boolean(options.allowDirtyCheckout),
      env,
      steps,
    });
    await renderPromptSource({ checkoutDir: defaults.checkoutDir, render, env, steps });
  }

  const sourceDir = resolveUserPath(
    normalizeOptionalString(options.sourceDir) ??
      path.join(defaults.checkoutDir, defaults.bundleRoot, defaults.runtimeId, defaults.agentId),
    env,
  );
  await validatePromptSourceDir(sourceDir);

  const files = [
    ...(await planPromptFiles({
      sourceDir,
      workspaceDir: defaults.workspaceDir,
      prune,
    })),
    ...(await planSupportFiles({
      sourceDir,
      supportDir: defaults.supportDir,
      prune,
    })),
  ];

  const changed = files.filter((file) => file.action !== "unchanged");
  if (apply) {
    for (const change of changed) {
      await applyChange(change);
    }
  }

  return {
    applied: apply,
    agentId: defaults.agentId,
    runtimeId: defaults.runtimeId,
    repository: options.sourceDir ? undefined : repository,
    ref: options.sourceDir ? undefined : ref,
    checkoutDir: options.sourceDir ? undefined : defaults.checkoutDir,
    bundleRoot: defaults.bundleRoot,
    sourceDir,
    workspaceDir: defaults.workspaceDir,
    supportDir: defaults.supportDir,
    files,
    changed,
    steps,
  };
}
