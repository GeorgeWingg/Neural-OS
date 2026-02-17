import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import {
	WorkspacePolicyError,
	resolveWorkspacePathForRead,
	resolveWorkspacePathForWrite,
	resolveWorkspaceRoot,
	isPathInsideWorkspace,
} from "./workspaceSandbox.mjs";
import { readMemoryFile, searchMemory } from "./memoryRuntime.mjs";
import { looksSensitiveSecret } from "./secretGuard.mjs";

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 16_000;
const DEFAULT_MAX_READ_CHARS = 12_000;
const DEFAULT_MAX_FIND_RESULTS = 200;
const DEFAULT_MAX_BASH_COMMAND_LENGTH = 4_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const BASH_POLICY_ERROR_PREFIX = "WORKSPACE_POLICY_ERROR:";
const PI_TOOL_PROMPT_DESCRIPTIONS = Object.freeze({
	emit_screen: "Publish user-visible window HTML to the host UI",
	read_screen: "Read current rendered screen state in bounded form",
	onboarding_get_state: "Read onboarding lifecycle and checkpoint state",
	onboarding_set_workspace_root: "Set workspace root for onboarding runtime",
	save_provider_key: "Save provider API key to secure session storage",
	onboarding_set_model_preferences: "Persist onboarding model/provider preferences",
	onboarding_complete: "Request onboarding completion after required checkpoints",
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore)",
	find: "Find files by glob pattern (respects .gitignore)",
	ls: "List directory contents",
	memory_search: "Search durable workspace memory files",
	memory_get: "Read a durable workspace memory file",
});

const ONBOARDING_ALLOWED_TOOLS = new Set([
	"emit_screen",
	"read_screen",
	"onboarding_get_state",
	"onboarding_set_workspace_root",
	"save_provider_key",
	"onboarding_set_model_preferences",
	"read",
	"write",
	"edit",
	"onboarding_complete",
]);

function toInt(value, fallback) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.floor(parsed);
}

function clampInt(value, { min, max, fallback }) {
	let next = toInt(value, fallback);
	if (!Number.isFinite(next)) next = fallback;
	if (Number.isFinite(min)) next = Math.max(min, next);
	if (Number.isFinite(max)) next = Math.min(max, next);
	return next;
}

function normalizeTextValue(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function appendLimitedText(current, chunk, maxChars) {
	if (!chunk) {
		return { text: current, truncated: false };
	}
	if (current.length >= maxChars) {
		return { text: current, truncated: true };
	}
	const remaining = maxChars - current.length;
	if (chunk.length <= remaining) {
		return { text: current + chunk, truncated: false };
	}
	return { text: current + chunk.slice(0, remaining), truncated: true };
}

function truncateOutput(text, maxChars, hint) {
	const source = normalizeTextValue(text);
	if (source.length <= maxChars) return source;
	const snippet = source.slice(0, maxChars);
	return `${snippet}\n\n${hint}`;
}

function buildToolResultText({ prefix, body, maxChars, continuationHint }) {
	const bodyText = normalizeTextValue(body);
	const combined = prefix ? `${prefix}\n${bodyText}` : bodyText;
	return truncateOutput(
		combined,
		maxChars,
		continuationHint || "[truncated output; refine the query or use narrower path constraints]",
	);
}

function normalizeRelativePath(pathValue) {
	return normalizeTextValue(pathValue).trim() || ".";
}

function wildcardToRegExp(pattern) {
	const source = normalizeTextValue(pattern).trim();
	if (!source) return null;
	const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

async function resolveWorkspaceContext(runtimeConfig, context) {
	return resolveWorkspaceRoot({
		requestedWorkspaceRoot: context.workspaceRoot,
		policy: runtimeConfig.workspacePolicy,
	});
}

async function runProcess(command, args, { cwd, env, timeoutMs, maxOutputChars = 120_000 }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;

		const onStdout = (chunk) => {
			const result = appendLimitedText(stdout, chunk.toString(), maxOutputChars);
			stdout = result.text;
			if (result.truncated) stdoutTruncated = true;
		};
		const onStderr = (chunk) => {
			const result = appendLimitedText(stderr, chunk.toString(), maxOutputChars);
			stderr = result.text;
			if (result.truncated) stderrTruncated = true;
		};

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);

		const timeoutId = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
		}, timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timeoutId);
			resolve({
				exitCode: null,
				error,
				timedOut,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
			});
		});

		child.on("close", (exitCode) => {
			clearTimeout(timeoutId);
			resolve({
				exitCode: Number.isFinite(exitCode) ? Number(exitCode) : null,
				error: null,
				timedOut,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
			});
		});
	});
}

function splitCommandTokens(command) {
	const tokens = [];
	const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
	let match = null;
	while ((match = matcher.exec(command))) {
		if (match[1] !== undefined) tokens.push(match[1]);
		else if (match[2] !== undefined) tokens.push(match[2]);
		else tokens.push(match[0]);
	}
	return tokens;
}

async function assertCommandTokensInsideWorkspace(command, canonicalWorkspaceRoot) {
	if (command.length > DEFAULT_MAX_BASH_COMMAND_LENGTH) {
		throw new WorkspacePolicyError(
			"BASH_COMMAND_TOO_LONG",
			`bash command exceeds ${DEFAULT_MAX_BASH_COMMAND_LENGTH} characters.`,
		);
	}
	if (/[`]/.test(command)) {
		throw new WorkspacePolicyError(
			"BASH_COMMAND_UNSAFE_SYNTAX",
			"Backticks are blocked by workspace command policy.",
		);
	}
	if (/\$\(|\$\{|\$[A-Za-z_]/.test(command)) {
		throw new WorkspacePolicyError(
			"BASH_COMMAND_UNSAFE_SYNTAX",
			"Shell variable or command expansion is blocked by workspace command policy.",
		);
	}
	if (/\.\.(\/|\\|$)/.test(command)) {
		throw new WorkspacePolicyError(
			"BASH_COMMAND_PATH_ESCAPE",
			"Parent-directory traversal is blocked by workspace command policy.",
		);
	}
	if (/(^|[;&|]\s*)(cd|pushd)\s+([/~]|-\b|\.\.)/i.test(command)) {
		throw new WorkspacePolicyError(
			"BASH_COMMAND_CD_ESCAPE",
			"cd/pushd to paths outside the workspace is blocked.",
		);
	}

	const tokens = splitCommandTokens(command);
	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
		const token = tokens[tokenIndex];
		const cleaned = token.trim().replace(/[;,]+$/, "");
		if (!cleaned) continue;
		if (cleaned.startsWith("-")) continue;
		if (cleaned === "~" || cleaned.startsWith("~/")) {
			throw new WorkspacePolicyError(
				"BASH_COMMAND_HOME_BLOCKED",
				"Home-directory path expansion is blocked by workspace command policy.",
			);
		}

		const existingWorkspaceEntry =
			tokenIndex > 0 && fs.existsSync(path.join(canonicalWorkspaceRoot, cleaned));
		const looksLikePath =
			cleaned.startsWith("/") ||
			cleaned.startsWith("./") ||
			cleaned.startsWith("../") ||
			cleaned.includes("/") ||
			existingWorkspaceEntry;
		if (!looksLikePath) continue;

		const candidate = cleaned.startsWith("/")
			? path.resolve(cleaned)
			: path.resolve(path.join(canonicalWorkspaceRoot, cleaned));

		if (!isPathInsideWorkspace(candidate, canonicalWorkspaceRoot)) {
			throw new WorkspacePolicyError(
				"BASH_COMMAND_PATH_OUTSIDE_WORKSPACE",
				`Command references path '${cleaned}' outside workspace root.`,
			);
		}

		try {
			const realCandidate = await fs.promises.realpath(candidate);
			if (!isPathInsideWorkspace(realCandidate, canonicalWorkspaceRoot)) {
				throw new WorkspacePolicyError(
					"BASH_COMMAND_SYMLINK_ESCAPE",
					`Command path '${cleaned}' resolves outside workspace root.`,
				);
			}
		} catch (error) {
			if (error && error.code === "ENOENT") {
				// A new path inside workspace is allowed.
				continue;
			}
			if (error instanceof WorkspacePolicyError) throw error;
			throw error;
		}
	}
}

function buildBashExecutionScript(command, canonicalWorkspaceRoot) {
	return [
		"set -euo pipefail",
		"set -f",
		`workspace_root=${JSON.stringify(canonicalWorkspaceRoot)}`,
		"cd \"$workspace_root\"",
		"__enforce_workspace() {",
		"  local current",
		"  current=\"$(pwd -P)\"",
		"  case \"$current\" in",
		"    \"$workspace_root\"|\"$workspace_root\"/*) ;;",
		"    *)",
		`      echo "${BASH_POLICY_ERROR_PREFIX} command attempted to leave workspace root '$workspace_root'." >&2`,
		"      exit 120",
		"      ;;",
		"  esac",
		"}",
		"trap '__enforce_workspace' DEBUG",
		command,
	].join("\n");
}

async function runBashCommand(command, canonicalWorkspaceRoot, runtimeConfig) {
	await assertCommandTokensInsideWorkspace(command, canonicalWorkspaceRoot);
	const tempDir = path.join(canonicalWorkspaceRoot, ".neural-computer-tmp");
	await fs.promises.mkdir(tempDir, { recursive: true });

	const script = buildBashExecutionScript(command, canonicalWorkspaceRoot);
	const childEnv = {
		...process.env,
		HOME: canonicalWorkspaceRoot,
		TMPDIR: tempDir,
		PWD: canonicalWorkspaceRoot,
	};

	const execution = await new Promise((resolve) => {
		const child = spawn("bash", ["--noprofile", "--norc"], {
			cwd: canonicalWorkspaceRoot,
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let timedOut = false;

		const onStdout = (chunk) => {
			const result = appendLimitedText(stdout, chunk.toString(), 120_000);
			stdout = result.text;
			if (result.truncated) stdoutTruncated = true;
		};
		const onStderr = (chunk) => {
			const result = appendLimitedText(stderr, chunk.toString(), 120_000);
			stderr = result.text;
			if (result.truncated) stderrTruncated = true;
		};

		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.stdin.end(`${script}\n`);

		const timeoutId = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
		}, runtimeConfig.commandTimeoutMs);

		child.on("error", (error) => {
			clearTimeout(timeoutId);
			resolve({
				exitCode: null,
				error,
				timedOut,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
			});
		});

		child.on("close", (exitCode) => {
			clearTimeout(timeoutId);
			resolve({
				exitCode: Number.isFinite(exitCode) ? Number(exitCode) : null,
				error: null,
				timedOut,
				stdout,
				stderr,
				stdoutTruncated,
				stderrTruncated,
			});
		});
	});

	if (execution.timedOut) {
		return {
			isError: true,
			text: `Command timed out after ${Math.round(runtimeConfig.commandTimeoutMs / 1000)}s.`,
		};
	}
	if (execution.error) {
		return {
			isError: true,
			text: `bash failed to start: ${execution.error.message}`,
		};
	}
	if (execution.stderr.includes(BASH_POLICY_ERROR_PREFIX)) {
		const normalized = execution.stderr
			.split("\n")
			.find((line) => line.includes(BASH_POLICY_ERROR_PREFIX))
			?.replace(BASH_POLICY_ERROR_PREFIX, "")
			.trim();
		return {
			isError: true,
			text: normalized || "Command blocked by workspace policy.",
		};
	}

	if (execution.exitCode !== 0) {
		const combined = `${execution.stdout}${execution.stderr}`.trim();
		return {
			isError: true,
			text: buildToolResultText({
				prefix: `[bash] exit ${execution.exitCode}`,
				body: combined || "Command failed without stderr output.",
				maxChars: runtimeConfig.maxOutputChars,
				continuationHint: "[truncated bash output; rerun with narrower command]",
			}),
		};
	}

	const output = `${execution.stdout}${execution.stderr}`.trim();
	return {
		isError: false,
		text: buildToolResultText({
			prefix: "[bash] success",
			body: output || "(no output)",
			maxChars: runtimeConfig.maxOutputChars,
			continuationHint: "[truncated bash output; rerun with narrower command]",
		}),
	};
}

async function runFind({
	canonicalWorkspaceRoot,
	startRelativePath,
	pattern,
	type,
	maxResults,
	maxDepth,
	includeHidden,
}) {
	const start = await resolveWorkspacePathForRead(canonicalWorkspaceRoot, startRelativePath || ".", {
		allowDirectory: true,
		allowFile: true,
	});
	const nameMatcher = wildcardToRegExp(pattern);
	const wantedType = type === "file" || type === "directory" ? type : "any";
	const normalizedMaxDepth = clampInt(maxDepth, { min: 0, max: 32, fallback: 8 });
	const normalizedMaxResults = clampInt(maxResults, { min: 1, max: 500, fallback: DEFAULT_MAX_FIND_RESULTS });

	const results = [];
	const visited = new Set();
	const queue = [
		{
			absolute: start.canonicalPath,
			depth: 0,
		},
	];
	visited.add(start.canonicalPath);

	while (queue.length > 0 && results.length < normalizedMaxResults) {
		const current = queue.shift();
		if (!current) continue;

		let stats = null;
		try {
			stats = await fs.promises.stat(current.absolute);
		} catch {
			continue;
		}

		const relative = path.relative(canonicalWorkspaceRoot, current.absolute) || ".";
		const basename = path.basename(current.absolute);
		const typeLabel = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
		const matchesType = wantedType === "any" || wantedType === typeLabel;
		const matchesPattern = !nameMatcher || nameMatcher.test(basename);
		if (matchesType && matchesPattern) {
			results.push(`${typeLabel}\t${relative}`);
			if (results.length >= normalizedMaxResults) break;
		}

		if (!stats.isDirectory() || current.depth >= normalizedMaxDepth) continue;
		let entries = [];
		try {
			entries = await fs.promises.readdir(current.absolute, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!includeHidden && entry.name.startsWith(".")) continue;
			const nextAbsolute = path.join(current.absolute, entry.name);
			let canonicalCandidate = nextAbsolute;
			if (entry.isSymbolicLink()) {
				try {
					canonicalCandidate = await fs.promises.realpath(nextAbsolute);
				} catch {
					continue;
				}
			}
			if (!isPathInsideWorkspace(canonicalCandidate, canonicalWorkspaceRoot)) continue;
			if (visited.has(canonicalCandidate)) continue;
			visited.add(canonicalCandidate);
			queue.push({
				absolute: canonicalCandidate,
				depth: current.depth + 1,
			});
		}
	}

	return {
		lines: results,
		maxResults: normalizedMaxResults,
	};
}

async function runGrep({
	runtimeConfig,
	canonicalWorkspaceRoot,
	pattern,
	targetPath,
	caseSensitive,
	maxResults,
}) {
	const safePattern = normalizeTextValue(pattern).trim();
	if (!safePattern) {
		throw new WorkspacePolicyError("GREP_PATTERN_REQUIRED", "grep requires a non-empty pattern.");
	}
	const resolvedTarget = await resolveWorkspacePathForRead(canonicalWorkspaceRoot, targetPath || ".", {
		allowDirectory: true,
		allowFile: true,
	});
	const relativeTarget = path.relative(canonicalWorkspaceRoot, resolvedTarget.canonicalPath) || ".";
	const boundedResults = clampInt(maxResults, { min: 1, max: 2_000, fallback: 200 });

	const baseArgs = [
		"--line-number",
		"--no-heading",
		"--color",
		"never",
		"--max-count",
		String(boundedResults),
	];
	if (!caseSensitive) baseArgs.push("--ignore-case");
	baseArgs.push("--", safePattern, relativeTarget);

	const rgResult = await runProcess("rg", baseArgs, {
		cwd: canonicalWorkspaceRoot,
		env: process.env,
		timeoutMs: runtimeConfig.commandTimeoutMs,
	});

	if (!rgResult.error) {
		if (rgResult.timedOut) {
			return { isError: true, text: "grep timed out." };
		}
		if (rgResult.exitCode === 0) {
			const lines = `${rgResult.stdout}${rgResult.stderr}`.trim();
			return {
				isError: false,
				text: buildToolResultText({
					prefix: `[grep] ${relativeTarget}`,
					body: lines || "(no matches)",
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated grep output; refine pattern/path]",
				}),
			};
		}
		if (rgResult.exitCode === 1) {
			return { isError: false, text: `[grep] ${relativeTarget}\n(no matches)` };
		}
	}

	const fallbackArgs = ["-R", "-n", "--", safePattern, relativeTarget];
	const grepResult = await runProcess("grep", fallbackArgs, {
		cwd: canonicalWorkspaceRoot,
		env: process.env,
		timeoutMs: runtimeConfig.commandTimeoutMs,
	});
	if (grepResult.timedOut) {
		return { isError: true, text: "grep timed out." };
	}
	if (grepResult.error) {
		return {
			isError: true,
			text: `grep unavailable: ${grepResult.error.message}`,
		};
	}
	if (grepResult.exitCode === 1) {
		return { isError: false, text: `[grep] ${relativeTarget}\n(no matches)` };
	}
	if (grepResult.exitCode !== 0) {
		return {
			isError: true,
			text: `grep failed with exit code ${grepResult.exitCode}.`,
		};
	}
	const fallbackOutput = `${grepResult.stdout}${grepResult.stderr}`.trim();
	return {
		isError: false,
		text: buildToolResultText({
			prefix: `[grep] ${relativeTarget}`,
			body: fallbackOutput || "(no matches)",
			maxChars: runtimeConfig.maxOutputChars,
			continuationHint: "[truncated grep output; refine pattern/path]",
		}),
	};
}

const readToolDefinition = {
	name: "read",
	description: "Read a UTF-8 text file from the configured workspace.",
	parameters: Type.Object({
		path: Type.String({ description: "Workspace-relative file path." }),
		offset: Type.Optional(Type.Number({ description: "Character offset for partial reads.", minimum: 0 })),
		limit: Type.Optional(Type.Number({ description: "Maximum characters to return.", minimum: 1, maximum: 12000 })),
	}),
};

const writeToolDefinition = {
	name: "write",
	description: "Write or append UTF-8 text in a workspace file.",
	parameters: Type.Object({
		path: Type.String({ description: "Workspace-relative file path." }),
		content: Type.String({ description: "Text content to write." }),
		append: Type.Optional(Type.Boolean({ description: "Append content instead of replacing file." })),
	}),
};

const editToolDefinition = {
	name: "edit",
	description: "Apply a targeted string replacement in a workspace file.",
	parameters: Type.Object({
		path: Type.String({ description: "Workspace-relative file path." }),
		oldText: Type.String({ description: "Text to replace." }),
		newText: Type.String({ description: "Replacement text." }),
		replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences." })),
	}),
};

const grepToolDefinition = {
	name: "grep",
	description: "Search for text patterns in workspace files.",
	parameters: Type.Object({
		pattern: Type.String({ description: "Regex or plain-text pattern." }),
		path: Type.Optional(Type.String({ description: "Workspace-relative starting path. Defaults to workspace root." })),
		caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Defaults true." })),
		maxResults: Type.Optional(Type.Number({ description: "Maximum matches.", minimum: 1, maximum: 2000 })),
	}),
};

const findToolDefinition = {
	name: "find",
	description: "List workspace paths matching a pattern.",
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Workspace-relative starting path. Defaults to workspace root." })),
		pattern: Type.Optional(Type.String({ description: "Wildcard pattern (for example '*.ts')." })),
		type: Type.Optional(Type.String({ description: "Filter by 'file', 'directory', or 'any'." })),
		maxDepth: Type.Optional(Type.Number({ description: "Directory walk depth.", minimum: 0, maximum: 32 })),
		maxResults: Type.Optional(Type.Number({ description: "Maximum returned paths.", minimum: 1, maximum: 500 })),
		includeHidden: Type.Optional(Type.Boolean({ description: "Include hidden files/directories." })),
	}),
};

const lsToolDefinition = {
	name: "ls",
	description: "List a workspace directory.",
	parameters: Type.Object({
		path: Type.Optional(Type.String({ description: "Workspace-relative directory path. Defaults to '.'." })),
		maxEntries: Type.Optional(Type.Number({ description: "Maximum entries to return.", minimum: 1, maximum: 500 })),
		includeHidden: Type.Optional(Type.Boolean({ description: "Include hidden entries." })),
	}),
};

const bashToolDefinition = {
	name: "bash",
	description: "Run a workspace-scoped shell command with command timeout enforcement.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command to execute in workspace root." }),
	}),
};

const googleSearchToolDefinition = {
	name: "google_search",
	description: "Search the web with Google Custom Search and return top results.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		count: Type.Optional(Type.Number({ description: "Maximum number of results", minimum: 1, maximum: 10 })),
	}),
};

const memorySearchToolDefinition = {
	name: "memory_search",
	description: "Search durable memory files in the current workspace.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query for memory recall." }),
		limit: Type.Optional(Type.Number({ description: "Maximum results.", minimum: 1, maximum: 50 })),
	}),
};

const memoryGetToolDefinition = {
	name: "memory_get",
	description: "Read a specific memory file from the current workspace.",
	parameters: Type.Object({
		path: Type.String({ description: "Workspace-relative path, e.g. memory/2026-02-16.md or MEMORY.md." }),
		offset: Type.Optional(Type.Number({ description: "Character offset.", minimum: 0 })),
		limit: Type.Optional(Type.Number({ description: "Maximum characters.", minimum: 1, maximum: 50000 })),
	}),
};

const onboardingGetStateToolDefinition = {
	name: "onboarding_get_state",
	description: "Get onboarding lifecycle state and checkpoint progress.",
	parameters: Type.Object({}),
};

const onboardingSetWorkspaceRootToolDefinition = {
	name: "onboarding_set_workspace_root",
	description: "Set and validate the workspace root used during onboarding.",
	parameters: Type.Object({
		workspaceRoot: Type.String({ description: "Requested workspace root path." }),
	}),
};

const onboardingSaveProviderKeyToolDefinition = {
	name: "save_provider_key",
	description: "Save provider API key through secure session credential storage.",
	parameters: Type.Object({
		providerId: Type.String({ description: "Provider identifier." }),
		apiKey: Type.String({ description: "Provider API key." }),
	}),
};

const onboardingSetModelPreferencesToolDefinition = {
	name: "onboarding_set_model_preferences",
	description: "Persist onboarding model and tool-tier preferences.",
	parameters: Type.Object({
		providerId: Type.String({ description: "Provider identifier." }),
		modelId: Type.String({ description: "Model identifier." }),
		toolTier: Type.Optional(Type.String({ description: "Tool tier (none|standard|experimental)." })),
	}),
};

const onboardingCompleteToolDefinition = {
	name: "onboarding_complete",
	description: "Attempt onboarding completion after required checkpoints are satisfied.",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "Optional completion summary note." })),
	}),
};

const emitScreenToolDefinition = {
	name: "emit_screen",
	description:
		"Publish a full HTML snapshot for the current window. This is the canonical user-visible output channel.",
	parameters: Type.Object({
		html: Type.String({ description: "Full HTML snapshot for the current window content area." }),
		appContext: Type.Optional(Type.String({ description: "Optional app context id for diagnostics." })),
		revisionNote: Type.Optional(Type.String({ description: "Optional short note describing this revision." })),
		isFinal: Type.Optional(Type.Boolean({ description: "True when this is the intended final render for this turn." })),
	}),
};

const readScreenToolDefinition = {
	name: "read_screen",
	description: "Read current rendered screen state in bounded form for state-aware edits.",
	parameters: Type.Object({
		mode: Type.Optional(Type.String({ description: "Read mode: meta | outline | snippet." })),
		maxChars: Type.Optional(
			Type.Number({
				description: "Maximum snippet length for snippet mode.",
				minimum: 1,
				maximum: 4000,
			}),
		),
		recovery: Type.Optional(
			Type.Boolean({
				description: "Set true only for a second recovery read in the same turn.",
			}),
		),
	}),
};

export function buildToolDefinitions(toolTier, searchConfig = {}) {
	const onboardingRequired = Boolean(searchConfig.onboardingRequired);
	if (onboardingRequired) {
		return [
			emitScreenToolDefinition,
			readScreenToolDefinition,
			onboardingGetStateToolDefinition,
			onboardingSetWorkspaceRootToolDefinition,
			onboardingSaveProviderKeyToolDefinition,
			onboardingSetModelPreferencesToolDefinition,
			readToolDefinition,
			writeToolDefinition,
			editToolDefinition,
			onboardingCompleteToolDefinition,
		];
	}

	if (toolTier === "none") {
		return [emitScreenToolDefinition, readScreenToolDefinition];
	}
	const includeGoogleSearch = searchConfig.includeGoogleSearch !== false;
	const toolDefinitions = [
		emitScreenToolDefinition,
		readScreenToolDefinition,
		readToolDefinition,
		writeToolDefinition,
		editToolDefinition,
		grepToolDefinition,
		findToolDefinition,
		lsToolDefinition,
			bashToolDefinition,
			memorySearchToolDefinition,
			memoryGetToolDefinition,
		];
	if (includeGoogleSearch) {
		toolDefinitions.push(searchConfig.googleSearchToolDefinition || googleSearchToolDefinition);
	}
	return toolDefinitions;
}

export function buildPiToolGuidancePrompt(toolDefinitions = []) {
	const toolNames = [];
	for (const toolDefinition of Array.isArray(toolDefinitions) ? toolDefinitions : []) {
		const toolName = normalizeTextValue(toolDefinition?.name).trim();
		if (toolName) toolNames.push(toolName);
	}
	const uniqueToolNames = [...new Set(toolNames)];
	const piTools = uniqueToolNames.filter((toolName) =>
		Object.prototype.hasOwnProperty.call(PI_TOOL_PROMPT_DESCRIPTIONS, toolName),
	);
	if (!piTools.length) return "";

	const toolsList = piTools.map((toolName) => `- ${toolName}: ${PI_TOOL_PROMPT_DESCRIPTIONS[toolName]}`).join("\n");

	const guidelinesList = [];
	const hasBash = piTools.includes("bash");
	const hasEdit = piTools.includes("edit");
	const hasWrite = piTools.includes("write");
	const hasGrep = piTools.includes("grep");
	const hasFind = piTools.includes("find");
	const hasLs = piTools.includes("ls");
	const hasRead = piTools.includes("read");
	const hasEmitScreen = piTools.includes("emit_screen");
	const hasReadScreen = piTools.includes("read_screen");
	const hasMemorySearch = piTools.includes("memory_search");
	const hasOnboardingState = piTools.includes("onboarding_get_state");
	const hasOnboardingComplete = piTools.includes("onboarding_complete");

	if (hasEmitScreen) {
		guidelinesList.push("Use emit_screen to publish all user-visible UI output; do not rely on plain text output.");
	}
	if (hasReadScreen) {
		guidelinesList.push(
			"Default: do NOT call read_screen. Call it only when current screen state is required and cannot be inferred.",
		);
		guidelinesList.push("When reading screen state, use the lightest read mode first (meta, then outline, then snippet).");
		guidelinesList.push("Use at most one read_screen call per turn unless explicitly recovering from stale state.");
		guidelinesList.push("After read_screen, publish updated user-visible output with emit_screen in the same turn unless blocked.");
	}

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		guidelinesList.push("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		guidelinesList.push("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	if (hasRead && hasEdit) {
		guidelinesList.push("Use read to examine files before editing. You must use this tool instead of cat or sed.");
	}

	if (hasMemorySearch) {
		guidelinesList.push("Use memory_search before asking repeated preference questions.");
	}

	if (hasOnboardingState || hasOnboardingComplete) {
		guidelinesList.push("In onboarding mode, complete required checkpoints before calling onboarding_complete.");
	}

	if (hasEdit) {
		guidelinesList.push("Use edit for precise changes (old text must match exactly)");
	}

	if (hasWrite) {
		guidelinesList.push("Use write only for new files or complete rewrites");
	}

	if (hasEdit || hasWrite) {
		guidelinesList.push(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	guidelinesList.push("Be concise in your responses");
	guidelinesList.push("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
	return [
		"Available tools:",
		toolsList,
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		guidelines,
	].join("\n");
}

export function createWorkspaceToolRuntime(config = {}) {
	return {
		// TODO(neural-onboarding): bind workspace selection to first-run onboarding ownership.
		workspacePolicy: config.workspacePolicy,
		// TODO(neural-memory): integrate workspace tool traces with long-term memory indexing.
		runGoogleSearch: config.runGoogleSearch,
		maxOutputChars: clampInt(config.maxOutputChars, {
			min: 2_000,
			max: 200_000,
			fallback: DEFAULT_MAX_TOOL_OUTPUT_CHARS,
		}),
		maxReadChars: clampInt(config.maxReadChars, {
			min: 256,
			max: 50_000,
			fallback: DEFAULT_MAX_READ_CHARS,
		}),
		commandTimeoutMs: clampInt(config.commandTimeoutMs, {
			min: 1_000,
			max: 300_000,
			fallback: DEFAULT_COMMAND_TIMEOUT_MS,
		}),
	};
}

function isOnboardingMode(context) {
	return Boolean(context?.onboardingMode);
}

function isMemoryPath(relativePath) {
	const normalized = normalizeTextValue(relativePath).replace(/\\\\/g, "/").toLowerCase();
	return normalized === "memory.md" || normalized.startsWith("memory/");
}

function isOnboardingToolAllowed(toolName) {
	return ONBOARDING_ALLOWED_TOOLS.has(toolName);
}

function buildSecretWriteBlockedMessage() {
	return "Potential credential/secret content detected. Use save_provider_key for API keys.";
}

export async function executeToolCall(call, context) {
	const runtimeConfig = context?.runtimeConfig || context || {};
	const toolName = normalizeTextValue(call?.name).trim();
	const toolArgs = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};

	try {
		const workspace = await resolveWorkspaceContext(runtimeConfig, context || {});
		const canonicalWorkspaceRoot = workspace.canonicalWorkspaceRoot;
		const onboardingMode = isOnboardingMode(context);
		const onboardingHandlers = context?.onboardingHandlers || {};

		if (onboardingMode && !isOnboardingToolAllowed(toolName)) {
			return {
				isError: true,
				text: `Tool '${toolName}' is blocked during required onboarding. Use onboarding actions only.`,
			};
		}

		if (toolName === "onboarding_get_state") {
			if (typeof onboardingHandlers.getState !== "function") {
				return { isError: true, text: "onboarding_get_state handler is unavailable." };
			}
			const result = await onboardingHandlers.getState({ workspaceRoot: canonicalWorkspaceRoot });
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[onboarding_get_state] state",
					body: JSON.stringify(result || {}, null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated onboarding state]",
				}),
			};
		}

		if (toolName === "onboarding_set_workspace_root") {
			if (typeof onboardingHandlers.setWorkspaceRoot !== "function") {
				return { isError: true, text: "onboarding_set_workspace_root handler is unavailable." };
			}
			const requestedWorkspaceRoot = normalizeTextValue(toolArgs.workspaceRoot).trim();
			if (!requestedWorkspaceRoot) {
				return { isError: true, text: "onboarding_set_workspace_root requires workspaceRoot." };
			}
			const result = await onboardingHandlers.setWorkspaceRoot({
				workspaceRoot: requestedWorkspaceRoot,
				currentWorkspaceRoot: canonicalWorkspaceRoot,
			});
			return {
				isError: false,
				nextWorkspaceRoot: result?.workspaceRoot || canonicalWorkspaceRoot,
				text: buildToolResultText({
					prefix: "[onboarding_set_workspace_root] updated",
					body: JSON.stringify(result || {}, null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated onboarding workspace update]",
				}),
			};
		}

		if (toolName === "save_provider_key") {
			if (typeof onboardingHandlers.saveProviderKey !== "function") {
				return { isError: true, text: "save_provider_key handler is unavailable." };
			}
			const providerId = normalizeTextValue(toolArgs.providerId).trim();
			const apiKey = normalizeTextValue(toolArgs.apiKey).trim();
			if (!providerId || !apiKey) {
				return { isError: true, text: "save_provider_key requires providerId and apiKey." };
			}
			const result = await onboardingHandlers.saveProviderKey({
				providerId,
				apiKey,
				workspaceRoot: canonicalWorkspaceRoot,
			});
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[save_provider_key] stored",
					body: JSON.stringify(result || {}, null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated save_provider_key result]",
				}),
			};
		}

		if (toolName === "onboarding_set_model_preferences") {
			if (typeof onboardingHandlers.setModelPreferences !== "function") {
				return { isError: true, text: "onboarding_set_model_preferences handler is unavailable." };
			}
			const providerId = normalizeTextValue(toolArgs.providerId).trim();
			const modelId = normalizeTextValue(toolArgs.modelId).trim();
			const toolTier = normalizeTextValue(toolArgs.toolTier).trim();
			if (!providerId || !modelId) {
				return { isError: true, text: "onboarding_set_model_preferences requires providerId and modelId." };
			}
			const result = await onboardingHandlers.setModelPreferences({
				providerId,
				modelId,
				toolTier,
				workspaceRoot: canonicalWorkspaceRoot,
			});
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[onboarding_set_model_preferences] saved",
					body: JSON.stringify(result || {}, null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated onboarding model preferences result]",
				}),
			};
		}

		if (toolName === "onboarding_complete") {
			if (typeof onboardingHandlers.complete !== "function") {
				return { isError: true, text: "onboarding_complete handler is unavailable." };
			}
			const summary = normalizeTextValue(toolArgs.summary).trim();
			const result = await onboardingHandlers.complete({
				summary,
				workspaceRoot: canonicalWorkspaceRoot,
			});
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[onboarding_complete] completed",
					body: JSON.stringify(result || {}, null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated onboarding completion result]",
				}),
			};
		}

		if (toolName === "google_search") {
			if (typeof runtimeConfig.runGoogleSearch !== "function") {
				return { isError: true, text: "google_search runtime is unavailable." };
			}
			const query = normalizeTextValue(toolArgs.query).trim();
			const count = clampInt(toolArgs.count, { min: 1, max: 10, fallback: 5 });
			const result = await runtimeConfig.runGoogleSearch(
				query,
				context.googleSearchApiKey,
				context.googleSearchCx,
				count,
			);
			if (!result?.ok) {
				return {
					isError: true,
					text: normalizeTextValue(result?.message) || "google_search failed.",
				};
			}
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[google_search] results",
					body: JSON.stringify(result.items || [], null, 2),
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated search results; rerun with narrower query]",
				}),
			};
		}

		if (toolName === "read") {
			const target = await resolveWorkspacePathForRead(canonicalWorkspaceRoot, toolArgs.path, {
				allowDirectory: false,
				allowFile: true,
			});
			const offset = clampInt(toolArgs.offset, { min: 0, max: 50_000_000, fallback: 0 });
			const limit = clampInt(toolArgs.limit, {
				min: 1,
				max: runtimeConfig.maxReadChars,
				fallback: runtimeConfig.maxReadChars,
			});
			const source = await fs.promises.readFile(target.canonicalPath, "utf8");
			const start = Math.min(offset, source.length);
			const end = Math.min(start + limit, source.length);
			const chunk = source.slice(start, end);
			const continuationHint =
				end < source.length ? `[truncated file; continue with read(path=${target.relativePath}, offset=${end})]` : "";
			return {
				isError: false,
				text: buildToolResultText({
					prefix: `[read] ${target.relativePath}`,
					body: chunk,
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: continuationHint || "[truncated file output]",
				}),
			};
		}

		if (toolName === "memory_search") {
			const query = normalizeTextValue(toolArgs.query).trim();
			if (!query) {
				return { isError: true, text: "memory_search requires a non-empty query." };
			}
			const limit = clampInt(toolArgs.limit, { min: 1, max: 50, fallback: 5 });
			const results = await searchMemory({
				workspaceRoot: canonicalWorkspaceRoot,
				query,
				limit,
			});
			const body = results.length
				? results
						.map(
							(result, index) =>
								`${index + 1}. path=${result.path} score=${result.score}\n${result.snippet}`,
						)
						.join("\n\n")
				: "(no memory matches)";
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[memory_search] results",
					body,
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated memory search output; narrow query]",
				}),
			};
		}

		if (toolName === "memory_get") {
			const targetPath = normalizeTextValue(toolArgs.path).trim();
			if (!targetPath) {
				return { isError: true, text: "memory_get requires a non-empty path." };
			}
			const offset = clampInt(toolArgs.offset, { min: 0, max: 50_000_000, fallback: 0 });
			const limit = clampInt(toolArgs.limit, {
				min: 1,
				max: runtimeConfig.maxReadChars,
				fallback: runtimeConfig.maxReadChars,
			});
			const result = await readMemoryFile({
				workspaceRoot: canonicalWorkspaceRoot,
				relativePath: targetPath,
				offset,
				limit,
			});
			const continuationHint =
				result.end < result.totalChars
					? `[truncated file; continue with memory_get(path=${result.path}, offset=${result.end})]`
					: "";
			return {
				isError: false,
				text: buildToolResultText({
					prefix: `[memory_get] ${result.path}`,
					body: result.content,
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: continuationHint || "[truncated memory output]",
				}),
			};
		}

			if (toolName === "write") {
				const target = await resolveWorkspacePathForWrite(canonicalWorkspaceRoot, toolArgs.path, {
					ensureParentDir: true,
				});
				const append = Boolean(toolArgs.append);
				const content = normalizeTextValue(toolArgs.content);
				if (looksSensitiveSecret(content)) {
					return { isError: true, text: buildSecretWriteBlockedMessage() };
				}
				if (append) {
					await fs.promises.appendFile(target.canonicalPath, content, "utf8");
				} else {
					await fs.promises.writeFile(target.canonicalPath, content, "utf8");
				}
				if (
					onboardingMode &&
					isMemoryPath(target.relativePath) &&
					typeof onboardingHandlers.onMemoryFileWritten === "function"
				) {
					await onboardingHandlers.onMemoryFileWritten({
						workspaceRoot: canonicalWorkspaceRoot,
						path: target.relativePath,
						mode: append ? "append" : "write",
					});
				}
				return {
					isError: false,
					text: `[write] ${append ? "appended" : "wrote"} ${content.length} chars to ${target.relativePath}`,
				};
			}

		if (toolName === "edit") {
			const target = await resolveWorkspacePathForRead(canonicalWorkspaceRoot, toolArgs.path, {
				allowDirectory: false,
				allowFile: true,
			});
			const oldText = normalizeTextValue(toolArgs.oldText);
			const newText = normalizeTextValue(toolArgs.newText);
			const replaceAll = Boolean(toolArgs.replaceAll);
			if (!oldText) {
				return {
					isError: true,
					text: "edit requires non-empty oldText.",
				};
			}
				if (looksSensitiveSecret(newText)) {
					return { isError: true, text: buildSecretWriteBlockedMessage() };
				}
			const original = await fs.promises.readFile(target.canonicalPath, "utf8");
			let replacementCount = 0;
			let next = original;
			if (replaceAll) {
				replacementCount = original.split(oldText).length - 1;
				next = original.split(oldText).join(newText);
			} else {
				const firstIndex = original.indexOf(oldText);
				if (firstIndex >= 0) {
					replacementCount = 1;
					next = `${original.slice(0, firstIndex)}${newText}${original.slice(firstIndex + oldText.length)}`;
				}
			}
			if (replacementCount === 0) {
				return {
					isError: true,
					text: `edit could not find target text in ${target.relativePath}.`,
				};
				}
				await fs.promises.writeFile(target.canonicalPath, next, "utf8");
				if (
					onboardingMode &&
					isMemoryPath(target.relativePath) &&
					typeof onboardingHandlers.onMemoryFileWritten === "function"
				) {
					await onboardingHandlers.onMemoryFileWritten({
						workspaceRoot: canonicalWorkspaceRoot,
						path: target.relativePath,
						mode: "edit",
					});
				}
				return {
					isError: false,
					text: `[edit] ${target.relativePath} replacements=${replacementCount}`,
				};
		}

		if (toolName === "ls") {
			const includeHidden = Boolean(toolArgs.includeHidden);
			const maxEntries = clampInt(toolArgs.maxEntries, { min: 1, max: 500, fallback: 200 });
			const target = await resolveWorkspacePathForRead(
				canonicalWorkspaceRoot,
				normalizeRelativePath(toolArgs.path),
				{
					allowDirectory: true,
					allowFile: false,
				},
			);
			const entries = await fs.promises.readdir(target.canonicalPath, { withFileTypes: true });
			const sorted = entries
				.filter((entry) => includeHidden || !entry.name.startsWith("."))
				.sort((a, b) => {
					const aDir = a.isDirectory() ? 0 : 1;
					const bDir = b.isDirectory() ? 0 : 1;
					if (aDir !== bDir) return aDir - bDir;
					return a.name.localeCompare(b.name);
				});
			const rows = [];
			for (let index = 0; index < sorted.length && index < maxEntries; index += 1) {
				const entry = sorted[index];
				const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
				rows.push(`${kind}\t${entry.name}`);
			}
			if (sorted.length > maxEntries) {
				rows.push(`... (${sorted.length - maxEntries} more entries)`);
			}
			return {
				isError: false,
				text: buildToolResultText({
					prefix: `[ls] ${target.relativePath}`,
					body: rows.join("\n") || "(empty directory)",
					maxChars: runtimeConfig.maxOutputChars,
				}),
			};
		}

		if (toolName === "find") {
			const results = await runFind({
				canonicalWorkspaceRoot,
				startRelativePath: normalizeRelativePath(toolArgs.path),
				pattern: toolArgs.pattern,
				type: normalizeTextValue(toolArgs.type).toLowerCase() || "any",
				maxResults: toolArgs.maxResults,
				maxDepth: toolArgs.maxDepth,
				includeHidden: Boolean(toolArgs.includeHidden),
			});
			const body = results.lines.length ? results.lines.join("\n") : "(no matches)";
			return {
				isError: false,
				text: buildToolResultText({
					prefix: "[find] results",
					body,
					maxChars: runtimeConfig.maxOutputChars,
					continuationHint: "[truncated find output; narrow pattern/maxDepth]",
				}),
			};
		}

		if (toolName === "grep") {
			return await runGrep({
				runtimeConfig,
				canonicalWorkspaceRoot,
				pattern: toolArgs.pattern,
				targetPath: normalizeRelativePath(toolArgs.path),
				caseSensitive: toolArgs.caseSensitive !== false,
				maxResults: toolArgs.maxResults,
			});
		}

		if (toolName === "bash") {
			const command = normalizeTextValue(toolArgs.command).trim();
			if (!command) {
				return { isError: true, text: "bash requires a non-empty command." };
			}
			if (looksSensitiveSecret(command)) {
				return { isError: true, text: buildSecretWriteBlockedMessage() };
			}
			return await runBashCommand(command, canonicalWorkspaceRoot, runtimeConfig);
		}

		return {
			isError: true,
			text: `Unknown tool '${toolName}'.`,
		};
	} catch (error) {
		if (error instanceof WorkspacePolicyError) {
			return {
				isError: true,
				text: error.message,
				code: error.code,
				details: error.details,
			};
		}
		return {
			isError: true,
			text: error instanceof Error ? error.message : String(error),
		};
	}
}
