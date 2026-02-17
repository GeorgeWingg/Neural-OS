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

`onboarding_complete` is allowed only when all required non-completed checkpoints are true.

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
- `memory_append`
- `onboarding_complete`

Blocked during required onboarding:

- `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `memory_get`, `memory_search`, `google_search`

## Safety

- Provider keys are accepted only via `save_provider_key` and persisted in server session credentials.
- Secret-like payloads are blocked in generic write/edit/bash flows.
- Direct memory file writes are blocked during required onboarding; onboarding memory persistence uses `memory_append`.

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
