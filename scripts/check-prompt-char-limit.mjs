#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CHARS = 12_000;

// Canonical prompt files are defined by runtime/template loading and skill conventions:
// - Workspace + dev prompt templates under docs/reference/templates
//   (src/agents/workspace.ts, src/cli/gateway-cli/dev.ts)
// - Skill prompt files named SKILL.md in bundled and extension skills
//   (src/agents/skills/workspace.ts + src/agents/skills/plugin-skills.ts)
const TEMPLATE_PROMPTS = [
  'docs/reference/templates/AGENTS.md',
  'docs/reference/templates/SOUL.md',
  'docs/reference/templates/TOOLS.md',
  'docs/reference/templates/IDENTITY.md',
  'docs/reference/templates/USER.md',
  'docs/reference/templates/HEARTBEAT.md',
  'docs/reference/templates/BOOTSTRAP.md',
  'docs/reference/templates/BOOT.md',
  'docs/reference/templates/AGENTS.dev.md',
  'docs/reference/templates/SOUL.dev.md',
  'docs/reference/templates/TOOLS.dev.md',
  'docs/reference/templates/IDENTITY.dev.md',
  'docs/reference/templates/USER.dev.md',
];

const SKILL_GLOBS = [
  'skills/**/SKILL.md',
  'extensions/**/skills/**/SKILL.md',
];

function gitTrackedFiles(pathspecs) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    encoding: 'utf-8',
  });
  return out
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function codePointLength(text) {
  return Array.from(text).length;
}

function main() {
  const tracked = new Set([...gitTrackedFiles(TEMPLATE_PROMPTS), ...gitTrackedFiles(SKILL_GLOBS)]);
  const files = [...tracked].sort();

  if (files.length === 0) {
    console.error('Prompt character limit check failed: no prompt files were discovered.');
    process.exit(1);
  }

  const offenders = [];
  for (const rel of files) {
    const abs = path.resolve(rel);
    const content = fs.readFileSync(abs, 'utf-8');
    const chars = codePointLength(content);
    if (chars > MAX_CHARS) {
      offenders.push({ path: rel, chars, over: chars - MAX_CHARS });
    }
  }

  if (offenders.length > 0) {
    console.error(`Prompt character limit check failed (max ${MAX_CHARS} chars per file).`);
    for (const offender of offenders.sort((a, b) => b.chars - a.chars || a.path.localeCompare(b.path))) {
      console.error(`- ${offender.path}: ${offender.chars} chars (over by ${offender.over})`);
    }
    process.exit(1);
  }

  console.log(`Prompt character limit check passed: ${files.length} files, max ${MAX_CHARS} chars.`);
}

main();
