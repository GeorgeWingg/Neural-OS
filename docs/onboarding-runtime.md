# Onboarding Runtime

## Purpose

Neural Computer onboarding is model-driven and host-enforced.

- The model generates onboarding UI and flow via `emit_screen`.
- The host enforces lifecycle state, safety policy, and action constraints.
- Filesystem skills (`SKILL.md`) remain canonical behavior sources.

## State Model

State file path:

- `<workspaceRoot>/.neural/onboarding-state.json`

Schema highlights:

- `completed`
- `lifecycle` (`pending` | `active` | `revisit` | `completed`)
- `runId`
- `workspaceRoot`
- `providerConfigured`
- `providerId`
- `modelId`
- `toolTier`
- `checkpoints`
- `lastError`

Checkpoints:

- `workspace_ready`
- `provider_ready`
- `model_ready`
- `memory_seeded`
- `completed`

Required completion checkpoints:

- `workspace_ready`
- `provider_ready`
- `model_ready`
- `memory_seeded`

`provider_ready` is deterministic and derived from runtime-auth availability for the selected provider:

- valid OAuth token (for OAuth-backed providers such as `openai-codex`), or
- valid provider API key (session/env).

`model_ready` is deterministic and derived from whether selected `providerId/modelId` resolves in the runtime catalog.

`onboarding_complete` is allowed only when all required completion checkpoints are true.

## API

- `GET /api/onboarding/state`
- `POST /api/onboarding/reopen`
- `POST /api/onboarding/complete`

## Tool Contract During Required Onboarding

Allowed tools/actions:

- `emit_screen`
- `onboarding_get_state`
- `onboarding_set_workspace_root`
- `save_provider_key`
- `onboarding_set_model_preferences`
- `read`
- `write`
- `edit`
- `onboarding_complete`

Blocked during required onboarding:

- `grep`, `find`, `ls`, `bash`, `memory_get`, `memory_search`, `google_search`

## Safety

- Provider keys are accepted only via `save_provider_key` and persisted in server session credentials.
- Secret-like payloads are blocked in generic write/edit/bash flows.
- Onboarding memory seeding happens when the model writes `MEMORY.md` or `memory/*.md` via `write`/`edit`.

## Observability

Events are appended to:

- `<workspaceRoot>/.neural/onboarding-events.jsonl`

Typical event categories:

- `workspace_root_updated`
- `provider_key_saved`
- `model_preferences_saved`
- `memory_seeded`
- `onboarding_completed`

## Host Routing

Frontend startup checks onboarding state:

- `completed=false` -> open `onboarding_app`
- `completed=true` -> open `desktop_env`

No predefined onboarding step UI exists in React; host surfaces model-generated onboarding content.
