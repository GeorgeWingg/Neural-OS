# OpenClaw vs Neural Computer: Self-Improvement and Skills Difference Report

Date: 2026-02-14

## Scope
This report compares:
1. How self-improvement currently works in this Neural Computer repo.
2. How skills currently work in this Neural Computer repo.
3. Equivalent mechanisms in OpenClaw.
4. Practical architectural differences and migration implications.

Evidence sources are code and docs from:
- `/Users/juno/Downloads/gemini-os-2`
- `/Users/juno/workspace/openclaw`

## Executive Summary
Neural Computer currently uses an internal `AppSkill` scoring pipeline that behaves like prompt policy tuning, while OpenClaw uses filesystem `SKILL.md` packages with runtime discovery and on-demand loading.

Neural Computer self-improvement is primarily a local telemetry loop (`episodes`, `generations`, `feedback`) that updates skill scores/status in `localStorage`. OpenClaw self-improvement is primarily memory-and-retrieval based: write durable memory to workspace files, index it, and retrieve it in later runs.

Core difference:
- Neural Computer optimizes prompt policy objects.
- OpenClaw compounds persistent memory and file-backed skills.

## Side-by-Side Differences

### 1) Skill Primitive
Neural Computer:
- Skills are seeded in code as `AppSkill[]` objects, not filesystem packages.
- Reference: `services/skillRegistry.ts:10`.

OpenClaw:
- Skills are AgentSkills-compatible folders with `SKILL.md` as the primary artifact.
- Reference: `/Users/juno/workspace/openclaw/docs/tools/skills.md:11`.

Difference:
- Gemini skill unit is an in-memory policy record.
- OpenClaw skill unit is a file-backed capability package.

### 2) Skill Discovery and Source of Truth
Neural Computer:
- Registry loads from `localStorage`, defaulting to hardcoded seeds.
- References: `services/skillRegistry.ts:83`, `services/skillRegistry.ts:95`.

OpenClaw:
- Skills are loaded from bundled, managed, workspace, and extra dirs with precedence rules.
- References: `/Users/juno/workspace/openclaw/docs/tools/skills.md:15`, `/Users/juno/workspace/openclaw/src/agents/skills/workspace.ts:125`, `/Users/juno/workspace/openclaw/src/agents/skills/workspace.ts:170`.

Difference:
- Gemini has no filesystem-based skill discovery path.
- OpenClaw skill source is directory-scanned and precedence-controlled.

### 3) How Skills Enter Model Context
Neural Computer:
- Injects selected skill instructions directly into `systemPrompt` as full inline text.
- References: `services/geminiService.ts:263`, `services/geminiService.ts:273`.

OpenClaw:
- Injects compact `<available_skills>` metadata and instructs the model to read `SKILL.md` via tool.
- References: `/Users/juno/workspace/openclaw/docs/concepts/system-prompt.md:103`, `/Users/juno/workspace/openclaw/src/agents/system-prompt.ts:29`.

Difference:
- Gemini uses eager inline instruction injection.
- OpenClaw uses lazy, tool-mediated skill loading.

### 4) Skill Runtime Lifecycle and Refresh
Neural Computer:
- Uses status lifecycle (`shadow/candidate/canary/active/disabled`) and score/confidence updates from outcomes.
- References: `services/selfImprovementCoordinator.ts:119`, `services/skillRegistry.ts:137`.
- Runtime retrieval includes only `active` and sampled `canary`.
- Reference: `services/skillRegistry.ts:125`.

OpenClaw:
- Uses skill eligibility/gating and watcher-driven snapshot refresh on filesystem changes.
- References: `/Users/juno/workspace/openclaw/docs/tools/skills.md:105`, `/Users/juno/workspace/openclaw/src/agents/skills/refresh.ts:109`, `/Users/juno/workspace/openclaw/src/agents/skills/workspace.ts:234`.

Difference:
- Gemini experiments with policy status transitions.
- OpenClaw operationalizes filesystem skill lifecycle and eligibility at load/run time.

### 5) Self-Improvement Mechanism
Neural Computer:
- On each generation:
  - select skills,
  - generate,
  - quality gate,
  - save episode/generation,
  - update skill usage,
  - run cycle evaluation.
- References: `App.tsx:352`, `App.tsx:456`, `App.tsx:490`.

OpenClaw:
- Uses memory persistence and retrieval as the main long-term adaptation loop.
- Automatic pre-compaction memory flush captures durable notes before context compaction.
- References: `/Users/juno/workspace/openclaw/docs/concepts/memory.md:39`, `/Users/juno/workspace/openclaw/src/auto-reply/reply/memory-flush.ts:78`, `/Users/juno/workspace/openclaw/src/auto-reply/reply/agent-runner-memory.ts:27`.

Difference:
- Gemini loop optimizes local skill metrics.
- OpenClaw loop grows durable memory and recall.

### 6) Memory and Learning from Experience
Neural Computer:
- Stores episodes/generations/feedback in browser `localStorage` with caps.
- References: `services/interactionTelemetry.ts:8`, `services/generationTelemetry.ts:8`, `services/feedbackTelemetry.ts:8`.
- No first-class semantic memory store with retrieval tools.

OpenClaw:
- Memory is explicit markdown in workspace (`MEMORY.md`, `memory/YYYY-MM-DD.md`).
- Memory search/get tools provide semantic recall and line-scoped retrieval.
- References: `/Users/juno/workspace/openclaw/docs/concepts/memory.md:11`, `/Users/juno/workspace/openclaw/src/agents/tools/memory-tool.ts:41`.
- Index manager syncs via watchers and session events.
- References: `/Users/juno/workspace/openclaw/src/memory/manager.ts:175`, `/Users/juno/workspace/openclaw/src/memory/manager-sync-ops.ts:262`.

Difference:
- Gemini lacks durable semantic memory as a core learning substrate.
- OpenClaw centers learning on persistent memory + retrieval.

### 7) Feedback Model
Neural Computer:
- Feedback pill is categorical (`good/okay/bad`) plus fixed tags.
- Reference: `components/FeedbackPill.tsx:20`.
- Feedback updates episode/generation and logs feedback event.
- References: `App.tsx:745`, `App.tsx:750`, `services/feedbackTelemetry.ts:39`.

OpenClaw:
- No equivalent fixed feedback pill in core loop; durable learning mainly occurs through memory writes and retrieval.
- Reference: `/Users/juno/workspace/openclaw/docs/concepts/memory.md:31`.

Difference:
- Gemini has explicit UX feedback channel but low semantic bandwidth today.
- OpenClaw has stronger persistence path but weaker direct UI rating channel.

### 8) Insights and Observability
Neural Computer:
- Insights panel aggregates local stats for overview, skills, generations, experiments.
- References: `components/InsightsPanel.tsx:31`, `services/insights.ts:47`.

OpenClaw:
- Stronger operational surfaces around skills/memory/session state across CLI/UI/gateway, including skill status, session status, and memory tools.
- References: `/Users/juno/workspace/openclaw/docs/tools/skills.md:188`, `/Users/juno/workspace/openclaw/docs/date-time.md:75`, `/Users/juno/workspace/openclaw/src/agents/tools/memory-tool.ts:41`.

Difference:
- Gemini observability is local and app-centric.
- OpenClaw observability is system-level and tool/runtime-centric.

### 9) Temporal/Datefulness
Neural Computer:
- Timestamps are recorded in telemetry events but there is no explicit temporal memory policy.
- References: `services/feedbackTelemetry.ts:42`, `services/generationTelemetry.ts:124`.

OpenClaw:
- Timezone-aware prompt guidance and `session_status` for current time.
- Reference: `/Users/juno/workspace/openclaw/docs/date-time.md:67`.
- Date-structured memory files (`memory/YYYY-MM-DD.md`).
- Reference: `/Users/juno/workspace/openclaw/docs/concepts/memory.md:21`.

Difference:
- Gemini has timestamps as metadata.
- OpenClaw encodes temporal structure in both prompt policy and memory layout.

## Practical Implications for This Repo

### What Neural Computer Has That OpenClaw Does Not (in this scope)
1. Immediate UI-native skill scoring and transition experiments integrated with rendering quality signals.
2. A built-in feedback UX surface tied directly into the runtime cycle.

### What OpenClaw Has That Neural Computer Does Not (in this scope)
1. Real filesystem skills (`SKILL.md`) with discovery, precedence, and on-demand read semantics.
2. Durable memory substrate with retrieval tools and indexing watchers.
3. Pre-compaction memory capture loop for preserving long-term learning.
4. Stronger temporal/datefulness in memory organization and runtime policy.

## High-Impact Gaps (Neural Computer vs OpenClaw)
1. Skill architecture mismatch: policy records are being called skills, but they are not Pi/OpenClaw style skills.
2. Missing filesystem skill runtime: no workspace-backed skill discovery and no on-demand `SKILL.md` loading.
3. Missing durable memory loop: no first-class memory store + retrieval tool path.
4. Limited experiential learning: feedback is mainly categorical and not converted into persistent, queryable memory/procedure artifacts.

## Suggested Migration Direction
1. Treat filesystem `SKILL.md` packages as canonical skills; demote `AppSkill` to temporary runtime evaluation state only.
2. Shift prompt strategy from inline full instructions to OpenClaw-style available-skills metadata + on-demand read.
3. Add workspace-backed memory files and retrieval tools for durable learning.
4. Keep Gemini’s strengths: preserve insights/quality scoring as an experimentation layer on top of Pi-style skills and memory.

## Notes
This report compares current implemented behavior, not aspirational architecture.
