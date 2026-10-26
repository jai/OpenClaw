import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  reconcilePromptFiles,
  REQUIRED_PROMPT_FILES,
  resolvePromptReconcilerDefaults,
} from "./reconciler.js";

let tempRoot: string;

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function createPromptSource(sourceDir: string, options?: { includeUser?: boolean }) {
  for (const fileName of REQUIRED_PROMPT_FILES) {
    await writeFile(path.join(sourceDir, fileName), `${fileName} from source\n`);
  }
  if (options?.includeUser) {
    await writeFile(path.join(sourceDir, "USER.md"), "user prompt\n");
  }
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompts-test-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("prompt reconciler", () => {
  it("defaults support path to runtime-agent for non-main agents", () => {
    const stateDir = path.join(tempRoot, "state");
    const defaults = resolvePromptReconcilerDefaults({
      config: {
        agents: { list: [{ id: "argus", workspace: path.join(tempRoot, "workspace") }] },
      },
      agentId: "argus",
      runtimeId: "jai-work",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });

    expect(defaults.supportDir).toBe(path.join(stateDir, "runtime", "jai-work-argus"));
  });

  it("plans prompt and support file updates without applying by default", async () => {
    const sourceDir = path.join(tempRoot, "source");
    const workspaceDir = path.join(tempRoot, "workspace");
    const supportDir = path.join(tempRoot, "runtime", "jai-work");
    await createPromptSource(sourceDir);
    await writeFile(path.join(sourceDir, "support", "greenhouse.yaml"), "fresh: true\n");
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "old agents\n");
    await writeFile(path.join(workspaceDir, "USER.md"), "stale user\n");
    await writeFile(path.join(supportDir, "stale.yaml"), "remove: true\n");
    const config: OpenClawConfig = { agents: { list: [{ id: "main", workspace: workspaceDir }] } };

    const result = await reconcilePromptFiles({
      config,
      sourceDir,
      runtimeId: "jai-work",
      workspaceDir,
      supportDir,
      apply: false,
    });

    expect(result.applied).toBe(false);
    expect(
      result.changed.map((file) => `${file.action}:${file.kind}:${file.relativePath}`),
    ).toEqual([
      "update:prompt:AGENTS.md",
      "create:prompt:SOUL.md",
      "create:prompt:TOOLS.md",
      "create:prompt:IDENTITY.md",
      "delete:prompt:USER.md",
      "create:support:greenhouse.yaml",
      "delete:support:stale.yaml",
    ]);
    await expect(fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "old agents\n",
    );
  });

  it("applies prompt and support file changes atomically", async () => {
    const sourceDir = path.join(tempRoot, "source");
    const workspaceDir = path.join(tempRoot, "workspace");
    const supportDir = path.join(tempRoot, "runtime", "jai-work");
    await createPromptSource(sourceDir, { includeUser: true });
    await writeFile(path.join(sourceDir, "support", "greenhouse.yaml"), "fresh: true\n");
    const config: OpenClawConfig = { agents: { list: [{ id: "main", workspace: workspaceDir }] } };

    const result = await reconcilePromptFiles({
      config,
      sourceDir,
      runtimeId: "jai-work",
      workspaceDir,
      supportDir,
      apply: true,
    });

    expect(result.applied).toBe(true);
    await expect(fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "AGENTS.md from source\n",
    );
    await expect(fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).resolves.toBe(
      "user prompt\n",
    );
    await expect(fs.readFile(path.join(supportDir, "greenhouse.yaml"), "utf8")).resolves.toBe(
      "fresh: true\n",
    );
  });

  it("fails clearly when a required prompt file is missing", async () => {
    const sourceDir = path.join(tempRoot, "source");
    await createPromptSource(sourceDir);
    await fs.rm(path.join(sourceDir, "TOOLS.md"));

    await expect(
      reconcilePromptFiles({
        config: {},
        sourceDir,
        runtimeId: "jai-work",
        workspaceDir: path.join(tempRoot, "workspace"),
        supportDir: path.join(tempRoot, "runtime", "jai-work"),
      }),
    ).rejects.toThrow("Missing required prompt files");
  });
});
