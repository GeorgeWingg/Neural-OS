#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";
const DEFAULT_LABEL = "benchmark";
const DEFAULT_RUNS = 20;
const DEFAULT_PROVIDER_ID = "google";
const DEFAULT_MODEL_ID = "gemini-3-flash-preview";
const DEFAULT_TOOL_TIER = "standard";
const DEFAULT_WORKSPACE_ROOT = "./workspace";
const DEFAULT_SESSION_ID = "read_screen_benchmark_session";

const PROMPT_FIXTURES = [
	{
		id: "ns_desktop_focus",
		category: "non_stateful",
		appContext: "desktop_env",
		text: "Render a clean desktop with launch tiles and one status widget for current date/time.",
	},
	{
		id: "ns_calendar_compact",
		category: "non_stateful",
		appContext: "calendar_app",
		text: "Render a compact monthly calendar with previous/next month controls and an events sidebar.",
	},
	{
		id: "ss_preserve_filter_state",
		category: "state_sensitive",
		appContext: "documents",
		text: "Assume a file list is already visible with filters active. Update only the sort mode to Name (A-Z) while preserving current filters and existing data-interaction-id values.",
	},
	{
		id: "ss_partial_update_only",
		category: "state_sensitive",
		appContext: "web_browser_app",
		text: "Assume a browser page is already rendered. Update only the tab strip to add a new tab and keep existing page content unchanged.",
	},
];

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[index + 1];
		if (typeof next === "string" && !next.startsWith("--")) {
			args[key] = next;
			index += 1;
			continue;
		}
		args[key] = "true";
	}
	return args;
}

function toInt(value, fallback, { min = undefined, max = undefined } = {}) {
	let parsed = Number(value);
	if (!Number.isFinite(parsed)) parsed = fallback;
	parsed = Math.floor(parsed);
	if (Number.isFinite(min)) parsed = Math.max(min, parsed);
	if (Number.isFinite(max)) parsed = Math.min(max, parsed);
	return parsed;
}

function percentile(values, p) {
	const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (!numbers.length) return null;
	if (numbers.length === 1) return numbers[0];
	const rank = (Math.max(0, Math.min(100, p)) / 100) * (numbers.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) return numbers[low];
	const weight = rank - low;
	return numbers[low] * (1 - weight) + numbers[high] * weight;
}

function mean(values) {
	const numbers = values.filter((value) => Number.isFinite(value));
	if (!numbers.length) return null;
	return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function roundMetric(value, digits = 2) {
	if (!Number.isFinite(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function summarizeResults(results) {
	const total = results.length || 1;
	const timeToDone = results.map((result) => result.time_to_done_ms);
	const timeToFirstRender = results
		.map((result) => result.time_to_first_render_output_ms)
		.filter((value) => Number.isFinite(value));
	const toolCalls = results.map((result) => result.tool_calls_per_turn);
	const readScreenCalls = results.map((result) => result.read_screen_calls_per_turn);
	const runtimeErrors = results.filter((result) => result.runtime_error).length;
	const missingEmitScreenErrors = results.filter((result) => result.missing_emit_screen_error).length;
	const rendered = results.filter((result) => result.did_render_output).length;

	return {
		runs: results.length,
		p50_time_to_done_ms: roundMetric(percentile(timeToDone, 50), 2),
		p95_time_to_done_ms: roundMetric(percentile(timeToDone, 95), 2),
		mean_time_to_done_ms: roundMetric(mean(timeToDone), 2),
		p50_time_to_first_render_output_ms: roundMetric(percentile(timeToFirstRender, 50), 2),
		p95_time_to_first_render_output_ms: roundMetric(percentile(timeToFirstRender, 95), 2),
		mean_time_to_first_render_output_ms: roundMetric(mean(timeToFirstRender), 2),
		p50_tool_calls_per_turn: roundMetric(percentile(toolCalls, 50), 2),
		p50_read_screen_calls_per_turn: roundMetric(percentile(readScreenCalls, 50), 2),
		runtime_error_rate: roundMetric(runtimeErrors / total, 4),
		missing_emit_screen_error_rate: roundMetric(missingEmitScreenErrors / total, 4),
		render_output_rate: roundMetric(rendered / total, 4),
	};
}

function summarizeByCategory(results) {
	const categories = [...new Set(results.map((result) => result.category))];
	const byCategory = {};
	for (const category of categories) {
		const categoryResults = results.filter((result) => result.category === category);
		byCategory[category] = summarizeResults(categoryResults);
	}
	return byCategory;
}

function createUserMessage(prompt) {
	return [
		`Current User Interaction: User Global Prompt: "${prompt.text}"`,
		`Current App Context: '${prompt.appContext}'.`,
		"Runtime Viewport Context (exact available content area this turn):",
		"- width: 1280px",
		"- height: 720px",
		"- devicePixelRatio: 1.00",
		"Layout Contract:",
		"- Root layout must be at least viewport height.",
		"- Horizontal overflow should be avoided.",
		"- Vertical overflow is allowed when needed.",
		"Use the emit_screen tool to publish HTML for the window's content area only.",
	].join("\n");
}

async function readNdjsonStream(response, onEvent) {
	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let event;
			try {
				event = JSON.parse(trimmed);
			} catch {
				continue;
			}
			onEvent(event);
		}
	}
	const remainder = buffer.trim();
	if (!remainder) return;
	try {
		const event = JSON.parse(remainder);
		onEvent(event);
	} catch {
		// Ignore malformed trailing chunk.
	}
}

async function maybeStoreProviderCredential({ apiOrigin, sessionId, providerId, apiKey }) {
	if (!apiKey) return;
	const response = await fetch(`${apiOrigin}/api/credentials/set`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId, providerId, apiKey }),
	});
	if (!response.ok) {
		let detail = `HTTP ${response.status}`;
		try {
			const payload = await response.json();
			detail = payload?.error?.message || payload?.message || detail;
		} catch {
			// Ignore JSON parsing failure.
		}
		throw new Error(`Failed to set provider credential for benchmark session: ${detail}`);
	}
}

async function runSingleStream({ apiOrigin, sessionId, providerId, modelId, toolTier, workspaceRoot, prompt, runIndex }) {
	const startedAt = Date.now();
	let firstRenderAt = null;
	let doneAt = null;
	let toolCallCount = 0;
	let readScreenCallCount = 0;
	let runtimeError = false;
	let missingEmitScreenError = false;
	let runtimeErrorMessage = "";
	let didRenderOutput = false;

	const body = {
		sessionId,
		llmConfig: {
			providerId,
			modelId,
			toolTier,
		},
		systemPrompt:
			"You are benchmark mode. Use tools intentionally, keep tool usage minimal, and always publish visible UI with emit_screen.",
		userMessage: createUserMessage(prompt),
		appContext: prompt.appContext,
		currentInteraction: {
			id: `benchmark_prompt_${prompt.id}_${runIndex}`,
			type: "user_prompt",
			value: prompt.text,
			elementType: "search_bar",
			elementText: "Global Search",
			appContext: prompt.appContext,
			source: "host",
		},
		contextMemoryMode: "compacted",
		workspaceRoot,
		styleConfig: {
			workspaceRoot,
		},
	};

	let response = null;
	try {
		response = await fetch(`${apiOrigin}/api/llm/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		doneAt = Date.now();
		return {
			prompt_id: prompt.id,
			category: prompt.category,
			runtime_error: true,
			runtime_error_message: error instanceof Error ? error.message : String(error),
			missing_emit_screen_error: false,
			did_render_output: false,
			tool_calls_per_turn: 0,
			read_screen_calls_per_turn: 0,
			time_to_first_render_output_ms: null,
			time_to_done_ms: doneAt - startedAt,
		};
	}

	if (!response.ok || !response.body) {
		runtimeError = true;
		try {
			const payload = await response.json();
			runtimeErrorMessage = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
		} catch {
			runtimeErrorMessage = `HTTP ${response.status}`;
		}
		doneAt = Date.now();
		return {
			prompt_id: prompt.id,
			category: prompt.category,
			runtime_error: true,
			runtime_error_message: runtimeErrorMessage,
			missing_emit_screen_error: false,
			did_render_output: false,
			tool_calls_per_turn: 0,
			read_screen_calls_per_turn: 0,
			time_to_first_render_output_ms: null,
			time_to_done_ms: doneAt - startedAt,
		};
	}

	await readNdjsonStream(response, (event) => {
		if (event.type === "tool_call_start") {
			toolCallCount += 1;
			if (event.toolName === "read_screen") {
				readScreenCallCount += 1;
			}
		}
		if (event.type === "render_output") {
			didRenderOutput = true;
			if (firstRenderAt === null) {
				firstRenderAt = Date.now();
			}
		}
		if (event.type === "error") {
			runtimeError = true;
			runtimeErrorMessage = String(event.error || "Unknown runtime error.");
			if (/No render output was emitted/i.test(runtimeErrorMessage)) {
				missingEmitScreenError = true;
			}
		}
		if (event.type === "done") {
			doneAt = Date.now();
		}
	});

	if (doneAt === null) {
		doneAt = Date.now();
	}

	return {
		prompt_id: prompt.id,
		category: prompt.category,
		runtime_error: runtimeError,
		runtime_error_message: runtimeErrorMessage || null,
		missing_emit_screen_error: missingEmitScreenError,
		did_render_output: didRenderOutput,
		tool_calls_per_turn: toolCallCount,
		read_screen_calls_per_turn: readScreenCallCount,
		time_to_first_render_output_ms: firstRenderAt === null ? null : firstRenderAt - startedAt,
		time_to_done_ms: doneAt - startedAt,
	};
}

async function runBenchmark(config) {
	const results = [];
	await maybeStoreProviderCredential(config);
	for (let index = 0; index < config.runs; index += 1) {
		const prompt = PROMPT_FIXTURES[index % PROMPT_FIXTURES.length];
		const result = await runSingleStream({
			apiOrigin: config.apiOrigin,
			sessionId: config.sessionId,
			providerId: config.providerId,
			modelId: config.modelId,
			toolTier: config.toolTier,
			workspaceRoot: config.workspaceRoot,
			prompt,
			runIndex: index,
		});
		results.push(result);
	}
	return {
		label: config.label,
		createdAt: new Date().toISOString(),
		config: {
			apiOrigin: config.apiOrigin,
			runs: config.runs,
			sessionId: config.sessionId,
			providerId: config.providerId,
			modelId: config.modelId,
			toolTier: config.toolTier,
			workspaceRoot: config.workspaceRoot,
		},
		fixtures: PROMPT_FIXTURES,
		results,
		summary: summarizeResults(results),
		byCategory: summarizeByCategory(results),
	};
}

function createComparisonRow(metric, baselineValue, candidateValue) {
	const baseline = Number.isFinite(baselineValue) ? baselineValue : null;
	const candidate = Number.isFinite(candidateValue) ? candidateValue : null;
	let delta = null;
	if (baseline !== null && candidate !== null) {
		delta = roundMetric(candidate - baseline, 4);
	}
	return { metric, baseline, candidate, delta };
}

function renderComparisonMarkdown({ baselineLabel, candidateLabel, baseline, candidate }) {
	const metrics = [
		"p50_time_to_done_ms",
		"p95_time_to_done_ms",
		"p50_time_to_first_render_output_ms",
		"p50_tool_calls_per_turn",
		"p50_read_screen_calls_per_turn",
		"runtime_error_rate",
		"missing_emit_screen_error_rate",
		"render_output_rate",
	];

	const rows = metrics.map((metric) =>
		createComparisonRow(metric, baseline.summary?.[metric] ?? null, candidate.summary?.[metric] ?? null),
	);

	const lines = [];
	lines.push("# read_screen Candidate B Comparison");
	lines.push("");
	lines.push(`Compared baseline \`${baselineLabel}\` vs candidate \`${candidateLabel}\`.`);
	lines.push("");
	lines.push("## Overall");
	lines.push("");
	lines.push("| Metric | Baseline | Candidate | Delta (candidate-baseline) |");
	lines.push("| --- | ---: | ---: | ---: |");
	for (const row of rows) {
		lines.push(
			`| ${row.metric} | ${row.baseline ?? "n/a"} | ${row.candidate ?? "n/a"} | ${row.delta ?? "n/a"} |`,
		);
	}

	const categories = new Set([
		...Object.keys(baseline.byCategory || {}),
		...Object.keys(candidate.byCategory || {}),
	]);
	for (const category of categories) {
		lines.push("");
		lines.push(`## Category: ${category}`);
		lines.push("");
		lines.push("| Metric | Baseline | Candidate | Delta (candidate-baseline) |");
		lines.push("| --- | ---: | ---: | ---: |");
		for (const metric of metrics) {
			const baselineValue = baseline.byCategory?.[category]?.[metric] ?? null;
			const candidateValue = candidate.byCategory?.[category]?.[metric] ?? null;
			const row = createComparisonRow(metric, baselineValue, candidateValue);
			lines.push(
				`| ${row.metric} | ${row.baseline ?? "n/a"} | ${row.candidate ?? "n/a"} | ${row.delta ?? "n/a"} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Rollout Gate Checklist");
	lines.push("");
	lines.push("- Missing-emit_screen error rate does not increase.");
	lines.push("- Runtime error rate does not increase.");
	lines.push("- Non-stateful p50 time_to_done regression <= 10%.");
	lines.push("- Non-stateful p50 read_screen calls per turn <= 0.25.");
	lines.push("- State-sensitive error/fallback proxy does not regress.");
	lines.push("");
	lines.push("## Notes");
	lines.push("");
	lines.push(
		"- `state-sensitive error/fallback proxy` in this report uses runtime and missing-emit_screen rates because client quality-retry/fallback telemetry is outside this stream endpoint script.",
	);
	lines.push("");
	return lines.join("\n");
}

async function writeJsonFile(filePath, payload) {
	const resolvedPath = path.resolve(filePath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await fs.writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeTextFile(filePath, content) {
	const resolvedPath = path.resolve(filePath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await fs.writeFile(resolvedPath, `${content}\n`, "utf8");
}

async function main() {
	const rawArgs = process.argv.slice(2);
	const args = parseArgs(rawArgs);

	if (args.help === "true") {
		console.log(
			[
				"Usage:",
				"  node scripts/read-screen-benchmark.mjs --label candidate-b --runs 20 --out docs/experiments/read-screen-candidate-b.json",
				"  node scripts/read-screen-benchmark.mjs --compare baseline.json candidate.json --out docs/experiments/read-screen-candidate-b-results.md",
			].join("\n"),
		);
		return;
	}

	if (typeof args.compare === "string") {
		const compareIndex = rawArgs.indexOf("--compare");
		const baselineArg = compareIndex >= 0 ? rawArgs[compareIndex + 1] : "";
		const candidateArg = compareIndex >= 0 ? rawArgs[compareIndex + 2] : "";
		if (!baselineArg || !candidateArg || baselineArg.startsWith("--") || candidateArg.startsWith("--")) {
			throw new Error("Comparison mode requires two file paths: --compare <baseline.json> <candidate.json>.");
		}
		const baselinePath = path.resolve(baselineArg);
		const candidatePath = path.resolve(candidateArg);
		const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
		const candidate = JSON.parse(await fs.readFile(candidatePath, "utf8"));
		const markdown = renderComparisonMarkdown({
			baselineLabel: baseline.label || path.basename(baselinePath),
			candidateLabel: candidate.label || path.basename(candidatePath),
			baseline,
			candidate,
		});
		if (typeof args.out === "string" && args.out.trim()) {
			await writeTextFile(args.out, markdown);
		}
		console.log(markdown);
		return;
	}

	const apiOrigin = String(args["api-origin"] || DEFAULT_API_ORIGIN).trim().replace(/\/+$/, "");
	const runs = toInt(args.runs, DEFAULT_RUNS, { min: 1, max: 200 });
	const label = String(args.label || DEFAULT_LABEL);
	const sessionId = String(args["session-id"] || DEFAULT_SESSION_ID);
	const providerId = String(args["provider-id"] || DEFAULT_PROVIDER_ID);
	const modelId = String(args["model-id"] || DEFAULT_MODEL_ID);
	const toolTier = String(args["tool-tier"] || DEFAULT_TOOL_TIER);
	const workspaceRoot = String(args["workspace-root"] || DEFAULT_WORKSPACE_ROOT);
	const apiKey = typeof args["api-key"] === "string" && args["api-key"].trim() ? args["api-key"].trim() : undefined;

	const result = await runBenchmark({
		apiOrigin,
		runs,
		label,
		sessionId,
		providerId,
		modelId,
		toolTier,
		workspaceRoot,
		apiKey,
	});

	if (typeof args.out === "string" && args.out.trim()) {
		await writeJsonFile(args.out, result);
	}

	console.log(`label=${result.label} runs=${result.summary.runs}`);
	console.log(`p50_time_to_done_ms=${result.summary.p50_time_to_done_ms ?? "n/a"}`);
	console.log(
		`p50_time_to_first_render_output_ms=${result.summary.p50_time_to_first_render_output_ms ?? "n/a"}`,
	);
	console.log(`p50_tool_calls_per_turn=${result.summary.p50_tool_calls_per_turn ?? "n/a"}`);
	console.log(`p50_read_screen_calls_per_turn=${result.summary.p50_read_screen_calls_per_turn ?? "n/a"}`);
	console.log(`runtime_error_rate=${result.summary.runtime_error_rate ?? "n/a"}`);
	console.log(`missing_emit_screen_error_rate=${result.summary.missing_emit_screen_error_rate ?? "n/a"}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
