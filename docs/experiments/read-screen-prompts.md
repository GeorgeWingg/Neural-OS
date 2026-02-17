# read_screen Benchmark Prompt Fixtures

This fixture set is used by `scripts/read-screen-benchmark.mjs` to compare baseline A versus candidate B.

## Non-Stateful

1. `ns_desktop_focus`
   Prompt: Render a clean desktop with launch tiles and one status widget for current date/time.
   App context: `desktop_env`

2. `ns_calendar_compact`
   Prompt: Render a compact monthly calendar with previous/next month controls and an events sidebar.
   App context: `calendar_app`

## State-Sensitive

1. `ss_preserve_filter_state`
   Prompt: Assume a file list is already visible with filters active. Update only the sort mode to Name (A-Z) while preserving current filters and existing `data-interaction-id` values.
   App context: `documents`

2. `ss_partial_update_only`
   Prompt: Assume a browser page is already rendered. Update only the tab strip to add a new tab and keep existing page content unchanged.
   App context: `web_browser_app`

## Notes

- Candidate B is expected to use `read_screen` rarely for non-stateful prompts and conditionally for state-sensitive prompts.
- The stream benchmark captures runtime and missing-emit-screen error rates directly.
- Client quality-retry and fallback behavior is not directly emitted by `/api/llm/stream`; use runtime error proxies in the comparison report.
