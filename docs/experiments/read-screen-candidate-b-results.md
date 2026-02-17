# read_screen Candidate B Comparison

Compared baseline `baseline-a-smoke` vs candidate `candidate-b-smoke`.

## Overall

| Metric | Baseline | Candidate | Delta (candidate-baseline) |
| --- | ---: | ---: | ---: |
| p50_time_to_done_ms | 15762 | 46605 | 30843 |
| p95_time_to_done_ms | 15762 | 46605 | 30843 |
| p50_time_to_first_render_output_ms | 11639 | 21803 | 10164 |
| p50_tool_calls_per_turn | 1 | 5 | 4 |
| p50_read_screen_calls_per_turn | 0 | 0 | 0 |
| runtime_error_rate | 0 | 0 | 0 |
| missing_emit_screen_error_rate | 0 | 0 | 0 |
| render_output_rate | 1 | 1 | 0 |

## Category: non_stateful

| Metric | Baseline | Candidate | Delta (candidate-baseline) |
| --- | ---: | ---: | ---: |
| p50_time_to_done_ms | 15762 | 46605 | 30843 |
| p95_time_to_done_ms | 15762 | 46605 | 30843 |
| p50_time_to_first_render_output_ms | 11639 | 21803 | 10164 |
| p50_tool_calls_per_turn | 1 | 5 | 4 |
| p50_read_screen_calls_per_turn | 0 | 0 | 0 |
| runtime_error_rate | 0 | 0 | 0 |
| missing_emit_screen_error_rate | 0 | 0 | 0 |
| render_output_rate | 1 | 1 | 0 |

## Rollout Gate Checklist

- Missing-emit_screen error rate does not increase.
- Runtime error rate does not increase.
- Non-stateful p50 time_to_done regression <= 10%.
- Non-stateful p50 read_screen calls per turn <= 0.25.
- State-sensitive error/fallback proxy does not regress.

## Notes

- `state-sensitive error/fallback proxy` in this report uses runtime and missing-emit_screen rates because client quality-retry/fallback telemetry is outside this stream endpoint script.

