# Core Directives

## Model Selection Policy

This project is built on top of the Pi agent framework. Model selection is user-controlled at runtime.

Rules:
1. Do not hard-pin a single model in agent instructions.
2. Respect the provider/model selected by the user in Settings and the Pi runtime catalog.
3. Treat model choice and tool tier as runtime configuration, not static project policy.

## Tauri App Direction

This project is now being built and packaged as a Tauri desktop app.

Rules:
1. Preserve Tauri compatibility for frontend and backend integration changes.
2. Prefer configuration and runtime behavior that works in both Tauri dev and packaged builds.
3. Treat desktop packaging requirements as first-class project constraints.

## Canonical Skill Definition (Pi-Compatible)

### Definition
A **skill** is a filesystem capability package rooted in a directory that contains a `SKILL.md` definition file (with frontmatter metadata), plus optional scripts/references/assets used by that skill.

### How Skills Work in Pi
1. Skills are discovered from configured skill directories (global, project, package, and explicit settings/CLI paths).
2. The model receives a compact available-skills metadata list in the prompt (name, description, location).
3. Full skill instructions are read on demand from disk via file tools (for example `read`) when needed.
4. Skill-local resources are resolved relative to the skill directory.

This means proper skills are file-backed and tool-readable, not just inline prompt snippets.

## Required Runtime Capabilities for Proper Skills

To implement skills correctly in Neural Computer on Pi:
1. The backend agent must run with a real workspace path.
2. The agent must be able to read skill files from that workspace/configured skill directories.
3. File-read tooling must be available to the model path that executes skills.
4. Sandbox policy must allow read access to skill directories (and execute access where a skill requires scripts/tools).

If these capabilities are missing, the system is not running full Pi-style skills.

## Deprecated Pattern: AppSkill Records

`AppSkill` records are a legacy internal pattern and are **not** the target skill architecture.

Policy:
1. Do not define new behavior systems around `AppSkill` records.
2. Do not describe `AppSkill` records as real skills.
3. Use filesystem Pi skills (`SKILL.md`) as the only canonical skill type.
4. Treat remaining `AppSkill` references in code as migration debt, not architecture.

## What Is Not a Skill

- A hardcoded prompt fragment with no file-backed `SKILL.md`.
- A raw feedback label or rating.
- A model fine-tune.
- Generic heuristics with no skill package or provenance.
- Any in-memory policy object that is not backed by a `SKILL.md` package.

## Implementation Guidance

1. Prefer Pi skill packages as the source of truth for behavior instructions.
2. Keep prompt injection lightweight: advertise skill metadata, then read full skill content on demand.
3. Preserve a clear link between runtime behavior and the skill file path/version that produced it.
4. Fail clearly when a skill cannot be read (missing path, denied sandbox access, tool unavailable).
