import type { Command } from "commander";
import { resolveAgentIdByWorkspacePath } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { reconcilePromptFiles, type PromptReconcilerResult } from "../prompts/reconciler.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveOptionFromCommand } from "./cli-utils.js";

type PromptReconcileCliOptions = {
  agent?: string;
  runtime?: string;
  repo?: string;
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
  json?: boolean;
};

function resolveOption(
  command: Command | undefined,
  name: string,
  value?: string,
): string | undefined {
  return resolveOptionFromCommand<string>(command, name) ?? value;
}

function formatPathList(paths: string[]): string {
  if (paths.length === 0) {
    return "none";
  }
  return paths.join(", ");
}

function formatPromptReconcileResult(result: PromptReconcilerResult): string {
  const changed = result.changed;
  const created = changed
    .filter((file) => file.action === "create")
    .map((file) => file.relativePath);
  const updated = changed
    .filter((file) => file.action === "update")
    .map((file) => file.relativePath);
  const deleted = changed
    .filter((file) => file.action === "delete")
    .map((file) => file.relativePath);
  const mode = result.applied ? "applied" : "dry-run";
  const lines = [
    `Prompt reconcile ${mode} for ${result.runtimeId}/${result.agentId}`,
    `source: ${result.sourceDir}`,
    `workspace: ${result.workspaceDir}`,
    `support: ${result.supportDir}`,
    `created: ${formatPathList(created)}`,
    `updated: ${formatPathList(updated)}`,
    `deleted: ${formatPathList(deleted)}`,
  ];
  if (!result.applied && changed.length > 0) {
    lines.push("run with --apply to write these changes");
  }
  return lines.join("\n");
}

function resolveAgentOption(opts: PromptReconcileCliOptions, command: Command | undefined): string {
  const config = getRuntimeConfig();
  const explicit = normalizeOptionalString(resolveOption(command, "agent", opts.agent));
  if (explicit) {
    return explicit;
  }
  return resolveAgentIdByWorkspacePath(config, process.cwd()) ?? "main";
}

export function registerPromptsCli(program: Command) {
  const prompts = program
    .command("prompts")
    .description("Reconcile rendered prompt files into agent workspaces")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/prompts", "docs.openclaw.ai/cli/prompts")}\n`,
    );

  prompts
    .command("reconcile")
    .description("Pull, render, diff, and optionally apply prompt files for one agent")
    .option("--agent <id>", "Target agent id (defaults to cwd-inferred, then main)")
    .option(
      "--runtime <id>",
      "Prompt bundle runtime/user id (defaults to OPENCLAW_PROMPTS_RUNTIME, OPENCLAW_PROFILE, then OS user)",
    )
    .option("--repo <url>", "Prompt source git repository")
    .option("--ref <ref>", "Prompt source git ref", "main")
    .option("--checkout-dir <path>", "Managed prompt source checkout directory")
    .option(
      "--source-dir <path>",
      "Use an already-rendered prompt bundle directory and skip git/render",
    )
    .option("--bundle-root <path>", "Rendered prompt bundle root inside checkout", "agent-prompts")
    .option("--workspace-dir <path>", "Override target agent workspace directory")
    .option("--support-dir <path>", "Override target runtime support directory")
    .option("--apply", "Write changes instead of dry-running", false)
    .option("--no-pull", "Do not fetch/update the prompt source checkout")
    .option("--no-render", "Do not run scripts/render-openclaw-prompts.mjs when present")
    .option("--no-prune", "Keep stale optional prompt/support files")
    .option(
      "--allow-dirty-checkout",
      "Allow prompt source checkout local changes before updating",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (opts: PromptReconcileCliOptions, command: Command) => {
      try {
        const config = getRuntimeConfig();
        const result = await reconcilePromptFiles({
          config,
          agentId: resolveAgentOption(opts, command),
          runtimeId: resolveOption(command, "runtime", opts.runtime),
          repository: resolveOption(command, "repo", opts.repo),
          ref: resolveOption(command, "ref", opts.ref),
          checkoutDir: resolveOption(command, "checkoutDir", opts.checkoutDir),
          sourceDir: resolveOption(command, "sourceDir", opts.sourceDir),
          bundleRoot: resolveOption(command, "bundleRoot", opts.bundleRoot),
          workspaceDir: resolveOption(command, "workspaceDir", opts.workspaceDir),
          supportDir: resolveOption(command, "supportDir", opts.supportDir),
          apply: Boolean(opts.apply),
          pull: opts.pull !== false,
          render: opts.render !== false,
          prune: opts.prune !== false,
          allowDirtyCheckout: Boolean(opts.allowDirtyCheckout),
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.writeStdout(formatPromptReconcileResult(result));
      } catch (err) {
        defaultRuntime.error(err instanceof Error ? err.message : String(err));
        defaultRuntime.exit(1);
      }
    });
}
