---
name: skill-creator
description: Create or update AgentSkills. Use when designing, structuring, validating, or packaging skills with scripts, references, and assets.
---

# Skill Creator

Build maintainable skills that stay concise, trigger correctly, and ship with reliable resources.

## Core Rules

- Keep `SKILL.md` focused on workflow and decision rules; move bulky detail into `references/`.
- Prefer deterministic scripts in `scripts/` for repeatable or fragile operations.
- Keep files minimal: include only assets/resources that directly support execution.
- Frontmatter must include only `name` and `description`.
- Write in imperative style.

## Skill Anatomy

Required:
- `SKILL.md`

Optional:
- `scripts/` executable helpers
- `references/` detailed docs loaded on demand
- `assets/` templates/static files used in outputs

Suggested layout:

```text
<skill-name>/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

## Progressive Disclosure

Use three levels of context:

1. Metadata (`name`, `description`) always visible.
2. `SKILL.md` body loaded only when triggered.
3. Resource files loaded only when needed.

Design for this model:
- Keep trigger intent in `description`.
- Keep the body short and operational.
- Link to references for deep material.

## Naming

- Use lowercase letters, digits, and hyphens.
- Keep under 64 characters.
- Prefer short verb-led names (`gh-address-comments`, `linear-address-issue`).
- Folder name must match skill name.

## Workflow

Follow this sequence unless a step is clearly unnecessary.

### 1) Understand Real Usage

Collect concrete trigger examples and expected outcomes.

Ask only the minimum high-impact questions first:
- What tasks should this skill handle?
- What user wording should trigger it?
- What outputs are considered success?

### 2) Plan Reusable Resources

For each example, identify repeatable artifacts:
- scripts for deterministic execution
- references for domain/process knowledge
- assets for reusable output scaffolding

Keep only resources that reduce repeated effort.

### 3) Initialize (New Skills)

When creating a new skill, use the initializer:

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Examples:

```bash
scripts/init_skill.py my-skill --path skills/public
scripts/init_skill.py my-skill --path skills/public --resources scripts,references
scripts/init_skill.py my-skill --path skills/public --resources scripts --examples
```

The initializer creates structure + `SKILL.md` scaffolding; then replace placeholders.

### 4) Implement and Edit

Build resources first, then finalize `SKILL.md`.

Resource guidance:
- `scripts/`: prefer for reliability and repetition; run representative tests.
- `references/`: place long schemas/policies/playbooks here.
- `assets/`: include only files used in generated deliverables.

`SKILL.md` guidance:
- `description` must clearly describe capabilities and activation triggers.
- Do not put trigger logic only in body sections.
- Document when to load each resource file.

### 5) Validate + Package

Package with built-in validation:

```bash
scripts/package_skill.py <path/to/skill-folder>
scripts/package_skill.py <path/to/skill-folder> ./dist
```

Validation should catch:
- frontmatter structure
- naming/structure errors
- weak or incomplete descriptions
- inconsistent file organization

Fix validation errors before packaging.

### 6) Iterate From Real Use

After actual usage:
1. Record friction/failure points.
2. Update `SKILL.md` or resources.
3. Re-test changed scripts.
4. Re-package.

## Quality Bar

- High signal, low verbosity.
- No redundant docs (`README.md`, `CHANGELOG.md`, quick refs) unless explicitly required.
- Keep references one hop from `SKILL.md`; avoid deep link chains.
- For long references, add a table of contents.

## Quick Review Checklist

- Triggering is explicit in `description`.
- `SKILL.md` is operational and concise.
- Resource files exist and are referenced only where needed.
- Scripts run successfully in the current environment.
- Package command succeeds without validation errors.
