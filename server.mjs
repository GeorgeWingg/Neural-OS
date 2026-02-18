import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	completeSimple,
	getEnvApiKey,
	getModel,
	getModels,
	getProviders,
	isContextOverflow,
	streamSimple,
} from "@mariozechner/pi-ai";
import {
	buildToolDefinitions,
	buildPiToolGuidancePrompt,
	createWorkspaceToolRuntime,
	executeToolCall,
} from "./services/piToolRuntime.mjs";
import { applyEmitScreen, createRenderOutputState, validateEmitScreenArgs } from "./services/renderOutputTool.mjs";
import { createReadScreenUsageState, runReadScreenToolCall } from "./services/readScreenRuntime.mjs";
import { createUiHistoryRuntime } from "./services/uiHistoryRuntime.mjs";
import {
	WorkspacePolicyError,
	createWorkspacePolicy,
	resolveWorkspaceRoot,
} from "./services/workspaceSandbox.mjs";
import { ensureWorkspaceScaffold } from "./services/workspaceBootstrap.mjs";
import { buildSkillsPromptMetadata, buildSkillsStatus } from "./services/skillsFilesystemRuntime.mjs";
import { appendMemoryNote, buildMemoryBootstrapContext } from "./services/memoryRuntime.mjs";
import {
	completeOnboarding,
	listMissingRequiredCompletionCheckpoints,
	loadOnboardingState,
	ONBOARDING_REQUIRED_COMPLETION_CHECKPOINTS,
	reopenOnboarding,
	setOnboardingCheckpoint,
	setOnboardingProviderConfiguration,
	setOnboardingWorkspaceRoot,
	startOnboardingRun,
} from "./services/onboardingRuntime.mjs";
import { appendOnboardingEvent } from "./services/onboardingTelemetry.mjs";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function parseNumberEnv(key, fallback, { min = undefined, max = undefined } = {}) {
	const rawValue = process.env[key];
	let value = Number(rawValue);
	if (!Number.isFinite(value)) value = fallback;
	if (Number.isFinite(min)) value = Math.max(min, value);
	if (Number.isFinite(max)) value = Math.min(max, value);
	return Math.floor(value);
}

function parsePathListEnv(key) {
	const rawValue = process.env[key];
	if (!rawValue || typeof rawValue !== "string") return [];
	return rawValue
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

loadDotEnvFiles();

const PORT = parseNumberEnv("NEURAL_COMPUTER_SERVER_PORT", 8787, {
	min: 1,
	max: 65535,
});
const PREFERRED_MODEL = "gemini-3-flash-preview";
const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = PREFERRED_MODEL;
const TOOL_CMD_TIMEOUT_SEC = parseNumberEnv(
	"NEURAL_COMPUTER_TOOL_CMD_TIMEOUT_SEC",
	30,
	{
		min: 1,
		max: 600,
	},
);
const CONTEXT_MEMORY_MODE_DEFAULT = "compacted";
const COMPACTION_SETTINGS = Object.freeze({
	reserveTokens: 16384,
	keepRecentTokens: 20000,
});
const EMIT_SCREEN_MAX_HTML_CHARS = parseNumberEnv(
	"NEURAL_COMPUTER_EMIT_SCREEN_MAX_HTML_CHARS",
	240_000,
	{ min: 16_000, max: 1_000_000 },
);
const EMIT_SCREEN_MAX_CALLS = parseNumberEnv(
	"NEURAL_COMPUTER_EMIT_SCREEN_MAX_CALLS",
	24,
	{ min: 1, max: 256 },
);
const UI_HISTORY_RETENTION_DAYS = parseNumberEnv(
	"NEURAL_COMPUTER_UI_HISTORY_RETENTION_DAYS",
	21,
	{ min: 1, max: 365 },
);
const EMIT_SCREEN_PARTIAL_MIN_CHAR_DELTA = 64;
const EMIT_SCREEN_PARTIAL_MIN_INTERVAL_MS = 120;
const DEFAULT_WORKSPACE_ROOT = "./workspace";
const WORKSPACE_POLICY_ROOTS = parsePathListEnv("NEURAL_COMPUTER_WORKSPACE_POLICY_ROOTS");
const EXTRA_SKILL_DIRS = parsePathListEnv("NEURAL_COMPUTER_EXTRA_SKILL_DIRS");
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), "skills");
const HOME_SKILLS_DIR = process.env.HOME ? path.join(process.env.HOME, ".codex", "skills") : "";
const ONBOARDING_APP_CONTEXT = "onboarding_app";
const ONBOARDING_SKILL_ID = "onboarding_skill";
const PROJECT_AUTH_FILE = path.join(process.cwd(), "auth.json");
const CODEX_AUTH_FILE = path.join(process.env.HOME || "", ".codex", "auth.json");

const sessionCredentials = new Map();
const contextMemoryStore = new Map();

const settingsAllowedKeys = [
	"colorTheme",
	"loadingUiMode",
	"contextMemoryMode",
	"enableAnimations",
	"qualityAutoRetryEnabled",
	"customSystemPrompt",
	"workspaceRoot",
	"googleSearchApiKey",
	"googleSearchCx",
	"providerId",
	"modelId",
	"toolTier",
];

function loadDotEnvFiles() {
	const baseDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [".env.local", ".env"];
	for (const fileName of candidates) {
		const envPath = path.join(baseDir, fileName);
		if (!fs.existsSync(envPath)) continue;
		const source = fs.readFileSync(envPath, "utf8");
		for (const rawLine of source.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const sep = line.indexOf("=");
			if (sep <= 0) continue;
			const key = line.slice(0, sep).trim();
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
			if (process.env[key] !== undefined) continue;
			let value = line.slice(sep + 1).trim();
			if (
				(value.startsWith("\"") && value.endsWith("\"")) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			process.env[key] = value;
		}
	}
}

function normalizeToolTier(toolTier) {
	if (toolTier === "none" || toolTier === "standard" || toolTier === "experimental") {
		return toolTier;
	}
	return "standard";
}

function createApiError(status, code, message, details) {
	return { status, code, message, details };
}

function sendApiError(res, error) {
	res.status(error.status).json({
		ok: false,
		error: {
			code: error.code,
			message: error.message,
			details: error.details,
		},
	});
}

function listProviders() {
	try {
		const providers = getProviders();
		return Array.isArray(providers) ? providers : [DEFAULT_PROVIDER];
	} catch {
		return [DEFAULT_PROVIDER];
	}
}

function getModelsForProvider(providerId) {
	try {
		const models = getModels(providerId);
		return Array.isArray(models) ? models : [];
	} catch {
		return [];
	}
}

function tryGetModel(providerId, modelId) {
	try {
		const model = getModel(providerId, modelId);
		if (!model || model.id !== modelId) return undefined;
		return model;
	} catch {
		return undefined;
	}
}

function pickDefaultProvider(providers) {
	if (providers.includes(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
	return providers[0] || DEFAULT_PROVIDER;
}

function normalizeProviderRuntimeError(message, providerId) {
	const safeMessage = String(message || "Model stream error.");
	if (providerId === "openai-codex" && /extract accountid from token/i.test(safeMessage)) {
		return "Invalid API key format for provider 'openai-codex'. Use a Codex account token, or switch provider to 'openai' for standard OpenAI API keys.";
	}
	return safeMessage;
}

function decodeJwtPayload(token) {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const base64Url = parts[1];
		const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const json = Buffer.from(padded, "base64").toString("utf8");
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function isEpochMsExpired(expiresAtMs) {
	if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return false;
	return Date.now() >= expiresAtMs - 30_000;
}

function isJwtExpired(token) {
	const payload = decodeJwtPayload(token);
	if (!payload || typeof payload.exp !== "number") return false;
	return Date.now() >= payload.exp * 1000 - 30_000;
}

function readJsonFile(filePath) {
	try {
		if (!filePath || !fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function getCodexTokenFromProjectAuthFile() {
	const data = readJsonFile(PROJECT_AUTH_FILE);
	if (!data || typeof data !== "object") return undefined;
	const oauthCredentials = data["openai-codex"];
	if (!oauthCredentials || typeof oauthCredentials !== "object") return undefined;
	const access = typeof oauthCredentials.access === "string" ? oauthCredentials.access.trim() : "";
	if (!access) return undefined;
	if (isEpochMsExpired(oauthCredentials.expires)) return undefined;
	return access;
}

function getCodexTokenFromCodexAuthFile() {
	const data = readJsonFile(CODEX_AUTH_FILE);
	if (!data || typeof data !== "object") return undefined;
	const access = typeof data?.tokens?.access_token === "string" ? data.tokens.access_token.trim() : "";
	if (!access) return undefined;
	if (isJwtExpired(access)) return undefined;
	return access;
}

function getCodexOauthToken() {
	return getCodexTokenFromProjectAuthFile() || getCodexTokenFromCodexAuthFile();
}

function looksLikeCodexOauthToken(token) {
	if (typeof token !== "string") return false;
	const payload = decodeJwtPayload(token);
	if (!payload || typeof payload !== "object") return false;
	const authClaim = payload["https://api.openai.com/auth"];
	if (!authClaim || typeof authClaim !== "object") return false;
	const accountId = authClaim.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0;
}

function normalizeLlmConfig(llmConfig) {
	const providers = listProviders();
	const fallbackProvider = pickDefaultProvider(providers);
	const hasProvider = typeof llmConfig?.providerId === "string" && llmConfig.providerId.trim().length > 0;
	const requestedProvider = hasProvider ? llmConfig.providerId.trim() : fallbackProvider;

	if (!providers.includes(requestedProvider)) {
		return {
			error: createApiError(400, "INVALID_PROVIDER", `Provider '${requestedProvider}' is not supported.`, {
				requestedProvider,
				availableProviders: providers,
			}),
		};
	}

	const models = getModelsForProvider(requestedProvider);
	if (!models.length) {
		return {
			error: createApiError(
				400,
				"PROVIDER_HAS_NO_MODELS",
				`Provider '${requestedProvider}' has no available models in this runtime.`,
				{ requestedProvider },
			),
		};
	}

	const hasModel = typeof llmConfig?.modelId === "string" && llmConfig.modelId.trim().length > 0;
	const requestedModel = hasModel ? llmConfig.modelId.trim() : "";
	let model = hasModel ? tryGetModel(requestedProvider, requestedModel) : undefined;

	if (!model && hasModel) {
		return {
			error: createApiError(
				400,
				"INVALID_MODEL",
				`Model '${requestedModel}' is not available for provider '${requestedProvider}'.`,
				{
					requestedProvider,
					requestedModel,
					availableModels: models.map((entry) => entry.id),
				},
			),
		};
	}

	if (!model) {
		model =
			tryGetModel(requestedProvider, DEFAULT_MODEL) ||
			models[0] ||
			tryGetModel(DEFAULT_PROVIDER, DEFAULT_MODEL) ||
			getModelsForProvider(DEFAULT_PROVIDER)[0];
	}

	if (!model) {
		return {
			error: createApiError(
				500,
				"NO_RESOLVABLE_MODEL",
				"No model could be resolved from the current provider catalog.",
				{
					requestedProvider,
					requestedModel: requestedModel || null,
				},
			),
		};
	}

	return {
		value: {
			providerId: requestedProvider,
			modelId: model.id,
			toolTier: normalizeToolTier(llmConfig?.toolTier),
		},
		model,
	};
}

function getCatalogProviders() {
	return listProviders()
		.map((providerId) => {
			const models = getModelsForProvider(providerId).map((model) => ({
				id: model.id,
				name: model.name || model.id,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
			}));
			if (!models.length) return null;
			return { providerId, models };
		})
		.filter(Boolean);
}

function getGoogleFallbackApiKey() {
	const candidates = [
		process.env.GEMINI_API_KEY,
		process.env.GOOGLE_API_KEY,
		process.env.GOOGLE_GENERATIVE_AI_API_KEY,
		process.env.GOOGLE_AI_API_KEY,
	];
	for (const candidate of candidates) {
		if (candidate && String(candidate).trim()) return String(candidate).trim();
	}
	return undefined;
}

const defaultSettingsSchema = {
	version: "1.0.0",
	title: "Neural Computer Settings",
	description: "Configure model behavior, personalization, and tool policy.",
	generatedBy: "fallback_settings_skill",
		sections: [
			{
				id: "experience",
				title: "Experience",
				fields: [
					{ key: "colorTheme", label: "Color Theme", control: "select" },
					{ key: "enableAnimations", label: "Enable Animations", control: "toggle" },
					{ key: "qualityAutoRetryEnabled", label: "Auto Retry On Low Quality", control: "toggle" },
				],
			},
		{
			id: "model",
			title: "Model Runtime",
			fields: [
				{ key: "providerId", label: "Provider", control: "select" },
				{ key: "modelId", label: "Model", control: "select" },
				{ key: "toolTier", label: "Tool Access Tier", control: "select" },
			],
		},
				{
					id: "advanced",
					title: "Advanced",
					fields: [
						{ key: "loadingUiMode", label: "Loading UI Mode", control: "select" },
						{
							key: "contextMemoryMode",
							label: "Context Memory Mode",
							control: "select",
							description: "Compacted mode keeps long-run continuity with server-side compaction. Legacy mode uses client interaction history.",
						},
						{
							key: "workspaceRoot",
							label: "Workspace Root",
							control: "text",
							description: "Workspace path used by Pi-style tools. Must stay within server workspace policy roots.",
							placeholder: "./workspace",
						},
						{ key: "googleSearchApiKey", label: "Google Search API Key", control: "password" },
						{ key: "googleSearchCx", label: "Google Search CX", control: "text" },
						{ key: "customSystemPrompt", label: "Custom System Prompt", control: "textarea" },
					],
			},
	],
};

function getSessionStore(sessionId) {
	if (!sessionCredentials.has(sessionId)) {
		sessionCredentials.set(sessionId, {});
	}
	return sessionCredentials.get(sessionId);
}

function resolveApiKey(sessionId, providerId) {
	const normalizedProvider = providerId || DEFAULT_PROVIDER;
	const store = sessionId ? sessionCredentials.get(sessionId) || {} : {};
	const fromSession = store[normalizedProvider];
	if (fromSession && String(fromSession).trim()) {
		const candidate = String(fromSession).trim();
		if (normalizedProvider !== "openai-codex" || looksLikeCodexOauthToken(candidate)) {
			return candidate;
		}
	}
	if (normalizedProvider === "openai-codex") {
		const fromCodexOauth = getCodexOauthToken();
		if (fromCodexOauth) return fromCodexOauth;
	}
	const fromPiEnv = getEnvApiKey(normalizedProvider);
	if (fromPiEnv && String(fromPiEnv).trim()) return String(fromPiEnv).trim();
	if (normalizedProvider === "google") return getGoogleFallbackApiKey();
	return undefined;
}

function resolveModel(providerId, modelId) {
	return (
		tryGetModel(providerId, modelId) ||
		tryGetModel(providerId, DEFAULT_MODEL) ||
		tryGetModel(DEFAULT_PROVIDER, DEFAULT_MODEL) ||
		getModelsForProvider(DEFAULT_PROVIDER)[0] ||
		getModel(DEFAULT_PROVIDER, DEFAULT_MODEL)
	);
}

function normalizeContextMemoryMode(mode) {
	return mode === "legacy" || mode === "compacted" ? mode : CONTEXT_MEMORY_MODE_DEFAULT;
}

function normalizeAppContext(appContext) {
	if (typeof appContext === "string" && appContext.trim()) return appContext.trim();
	return "desktop_env";
}

function shouldRequireEmitScreen(appContext) {
	const normalized = normalizeAppContext(appContext);
	return normalized !== "system_settings_page" && normalized !== "insights_app";
}

async function buildFilesystemSkillsContext(workspaceRoot) {
	const status = await buildSkillsStatus({
		workspaceRoot,
		bundledSkillDirs: [BUNDLED_SKILLS_DIR],
		extraSkillDirs: EXTRA_SKILL_DIRS,
		homeSkillDir: HOME_SKILLS_DIR,
		env: process.env,
	});
	return {
		status,
		prompt: buildSkillsPromptMetadata(status),
	};
}

async function resolveAndEnsureWorkspaceRoot(requestedWorkspaceRoot) {
	const workspaceResolution = await resolveWorkspaceRoot({
		requestedWorkspaceRoot,
		policy: workspacePolicy,
	});
	const workspaceRoot = workspaceResolution.configuredWorkspaceRoot;
	await ensureWorkspaceScaffold(workspaceRoot);
	return workspaceRoot;
}

function extractRequestedLlmConfig(source) {
	const record = source && typeof source === "object" ? source : {};
	const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
	const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
	const toolTier = typeof record.toolTier === "string" ? record.toolTier.trim() : "";
	const config = {};
	if (providerId) config.providerId = providerId;
	if (modelId) config.modelId = modelId;
	if (toolTier) config.toolTier = toolTier;
	return config;
}

function resolveOnboardingLlmConfig(requestedLlmConfig = {}, state = undefined) {
	const stateFallback = {
		providerId: typeof state?.providerId === "string" && state.providerId.trim() ? state.providerId.trim() : DEFAULT_PROVIDER,
		modelId: typeof state?.modelId === "string" && state.modelId.trim() ? state.modelId.trim() : DEFAULT_MODEL,
		toolTier: normalizeToolTier(state?.toolTier),
	};
	const mergedRequest = {
		...stateFallback,
		...extractRequestedLlmConfig(requestedLlmConfig),
	};
	const resolved = normalizeLlmConfig(mergedRequest);
	if (!resolved.error) return resolved.value;
	return stateFallback;
}

async function syncOnboardingStateWithRuntimeConfig({ workspaceRoot, state, sessionId, requestedLlmConfig = {} }) {
	const activeState = state || (await loadOnboardingState(workspaceRoot));
	const effectiveLlmConfig = resolveOnboardingLlmConfig(requestedLlmConfig, activeState);
	const providerReady = Boolean(resolveApiKey(sessionId, effectiveLlmConfig.providerId));
	const modelReady = Boolean(tryGetModel(effectiveLlmConfig.providerId, effectiveLlmConfig.modelId));
	const syncedState = await setOnboardingProviderConfiguration(workspaceRoot, {
		providerConfigured: providerReady,
		providerReady,
		providerId: effectiveLlmConfig.providerId,
		modelId: effectiveLlmConfig.modelId,
		modelReady,
		toolTier: effectiveLlmConfig.toolTier,
	});
	return {
		state: syncedState,
		llmConfig: effectiveLlmConfig,
		providerReady,
		modelReady,
	};
}

function buildOnboardingPolicyPrompt(onboardingState) {
	if (!onboardingState || onboardingState.completed) return "";
	const requiredCheckpoints = ONBOARDING_REQUIRED_COMPLETION_CHECKPOINTS.join(", ");
	const missingCheckpoints = listMissingRequiredCompletionCheckpoints(onboardingState);
	const checkpointHint = missingCheckpoints.length
		? `Missing checkpoints: ${missingCheckpoints.join(", ")}.`
		: "All required checkpoints satisfied. Call onboarding_complete.";
	return [
		"Onboarding Runtime Policy (host-enforced):",
		`- Onboarding remains mandatory until completion is confirmed by host state.`,
		`- Prioritize filesystem skill '${ONBOARDING_SKILL_ID}' over conflicting skill instructions.`,
		"- Use onboarding actions only while onboarding is required.",
		`- Required completion checkpoints: ${requiredCheckpoints}.`,
		"- provider_ready is required and is true only when selected provider has usable runtime auth (OAuth token or API key).",
		"- model_ready is required and is true only when selected provider/model resolves in runtime catalog.",
		"- For provider 'openai-codex', OAuth token auth counts as provider_ready; do not force API key entry when provider_ready=true.",
		"- If user intends OAuth subscription auth, prefer provider 'openai-codex' over API-key providers.",
		"- Establish provider_ready and model_ready first, then satisfy memory_seeded.",
		"- To satisfy memory_seeded, write a short durable note into MEMORY.md or memory/YYYY-MM-DD.md using write/edit.",
		"- Do not claim completion unless onboarding_complete returns success.",
		checkpointHint,
		"",
		`Onboarding state snapshot: ${JSON.stringify(
			{
				lifecycle: onboardingState.lifecycle,
				completed: onboardingState.completed,
				runId: onboardingState.runId,
				checkpoints: onboardingState.checkpoints,
				workspaceRoot: onboardingState.workspaceRoot,
				providerConfigured: onboardingState.providerConfigured,
				providerId: onboardingState.providerId,
				modelId: onboardingState.modelId,
			},
			null,
			2,
		)}`,
	].join("\n");
}

function createTurnId() {
	return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createLaneKey(sessionId, appContext) {
	return `${sessionId || "session_unknown"}::${normalizeAppContext(appContext)}`;
}

function getContextLane(sessionId, appContext) {
	const key = createLaneKey(sessionId, appContext);
	let lane = contextMemoryStore.get(key);
	if (!lane) {
		lane = {
			summary: "",
			recentTurns: [],
			lastEstimate: undefined,
			compactionInFlight: false,
			compactionQueued: false,
		};
		contextMemoryStore.set(key, lane);
	}
	return { key, lane };
}

function estimateTokensFromText(text) {
	if (!text || typeof text !== "string") return 0;
	return Math.ceil(text.length / 4);
}

function calculateUsageTokens(usage) {
	if (!usage || typeof usage !== "object") return 0;
	const numeric = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const total = numeric(usage.totalTokens);
	if (total > 0) return total;
	return numeric(usage.input) + numeric(usage.output) + numeric(usage.cacheRead) + numeric(usage.cacheWrite);
}

function normalizeInteractionPayload(interaction, appContext) {
	const source = interaction && typeof interaction === "object" ? interaction : {};
	const normalizedAppContext = normalizeAppContext(source.appContext || appContext);
	const interactionId = typeof source.id === "string" && source.id.trim() ? source.id.trim() : "unknown_interaction";
	return {
		id: interactionId,
		type: typeof source.type === "string" && source.type.trim() ? source.type.trim() : "generic_click",
		value: typeof source.value === "string" ? source.value : undefined,
		elementType: typeof source.elementType === "string" && source.elementType.trim() ? source.elementType.trim() : "unknown",
		elementText:
			typeof source.elementText === "string" && source.elementText.trim() ? source.elementText.trim() : interactionId,
		appContext: normalizedAppContext,
		traceId: typeof source.traceId === "string" ? source.traceId : undefined,
		uiSessionId: typeof source.uiSessionId === "string" ? source.uiSessionId : undefined,
		eventSeq: Number.isFinite(source.eventSeq) ? Number(source.eventSeq) : undefined,
		source: source.source === "host" || source.source === "iframe" ? source.source : "host",
	};
}

function normalizeCurrentRenderedScreenSeed(seed, appContext) {
	const source = seed && typeof seed === "object" ? seed : {};
	const html = typeof source.html === "string" ? source.html : "";
	if (!html.trim()) return null;
	const normalizedAppContext = normalizeAppContext(appContext);
	const sourceAppContext =
		typeof source.appContext === "string" && source.appContext.trim()
			? normalizeAppContext(source.appContext)
			: normalizedAppContext;
	if (sourceAppContext !== normalizedAppContext) return null;

	const numericRevision = Number(source.revision);
	const revision = Number.isFinite(numericRevision) && numericRevision > 0 ? Math.floor(numericRevision) : 1;
	return {
		html: html.slice(0, EMIT_SCREEN_MAX_HTML_CHARS),
		revision,
		isFinal: Boolean(source.isFinal),
		appContext: normalizedAppContext,
	};
}

function summarizeInteraction(interaction) {
	const base = `${interaction.type || "interaction"} on '${interaction.elementText || interaction.id || "unknown"}'`;
	if (interaction.value && typeof interaction.value === "string" && interaction.value.trim()) {
		return `${base} (value='${interaction.value.slice(0, 120)}')`;
	}
	return base;
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()).slice(0, 12);
}

function buildDeterministicStateSummary(interaction, assistantOutputText) {
	const interactionSummary = summarizeInteraction(interaction);
	const appContext = normalizeAppContext(interaction?.appContext);
	const outputLength = typeof assistantOutputText === "string" ? assistantOutputText.length : 0;
	const outputHint =
		outputLength > 0
			? `Generated response length: ${outputLength} chars.`
			: "Generated response content available for this interaction.";
	return {
		goal:
			interaction?.type === "user_prompt" && interaction?.value
				? String(interaction.value).slice(0, 220)
				: `Handle ${interactionSummary}`,
		ui_state: `App context: ${appContext}. Focus element: ${interaction?.elementText || interaction?.id || "unknown"}.`,
		actions_taken: [interactionSummary, outputHint],
		open_issues: [],
		next_steps: ["Continue from this state on the next interaction."],
	};
}

function normalizeTurnStateSummary(summary, interaction, assistantOutputText) {
	const fallback = buildDeterministicStateSummary(interaction, assistantOutputText);
	if (!summary || typeof summary !== "object") return fallback;
	const normalized = {
		goal: typeof summary.goal === "string" && summary.goal.trim() ? summary.goal.trim() : fallback.goal,
		ui_state: typeof summary.ui_state === "string" && summary.ui_state.trim() ? summary.ui_state.trim() : fallback.ui_state,
		actions_taken: normalizeStringArray(summary.actions_taken),
		open_issues: normalizeStringArray(summary.open_issues),
		next_steps: normalizeStringArray(summary.next_steps),
	};
	if (!normalized.actions_taken.length) normalized.actions_taken = fallback.actions_taken;
	if (!normalized.next_steps.length) normalized.next_steps = fallback.next_steps;
	return normalized;
}

function formatStateSummaryInline(summary) {
	if (!summary || typeof summary !== "object") return "(state unavailable)";
	const actions = Array.isArray(summary.actions_taken) ? summary.actions_taken.slice(0, 3).join("; ") : "";
	const issues = Array.isArray(summary.open_issues) && summary.open_issues.length
		? ` Open issues: ${summary.open_issues.slice(0, 2).join("; ")}.`
		: "";
	return `Goal: ${summary.goal || "(none)"} | UI: ${summary.ui_state || "(none)"}${actions ? ` | Actions: ${actions}` : ""}${issues}`;
}

function estimateTurnTokens(turn) {
	const interactionText = summarizeInteraction(turn.interaction || {});
	const stateText = formatStateSummaryInline(turn.assistantStateSummary || {});
	const promptTokens = estimateTokensFromText(turn.userPrompt || "");
	const summaryTokens = estimateTokensFromText(`${interactionText}\n${stateText}`);
	const usageTokens = calculateUsageTokens(turn.usage);
	return turn.estimatedTokens || Math.max(promptTokens + summaryTokens, usageTokens ? Math.floor(usageTokens * 0.25) : 0);
}

function estimateLaneContextTokens(lane, systemPrompt = "", incomingUserMessage = "") {
	const turns = Array.isArray(lane?.recentTurns) ? lane.recentTurns : [];
	let usageTokens = 0;
	let lastUsageIndex = null;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const tokens = calculateUsageTokens(turns[i]?.usage);
		if (tokens > 0) {
			usageTokens = tokens;
			lastUsageIndex = i;
			break;
		}
	}

	let trailingTokens = 0;
	if (lastUsageIndex !== null) {
		for (let i = lastUsageIndex + 1; i < turns.length; i += 1) {
			trailingTokens += estimateTurnTokens(turns[i]);
		}
	}

	const estimatedFromTurns =
		estimateTokensFromText(lane?.summary || "") + turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0);
	const baseTokens = lastUsageIndex === null ? estimatedFromTurns : Math.max(usageTokens + trailingTokens, estimatedFromTurns);
	const incomingTokens = estimateTokensFromText(systemPrompt) + estimateTokensFromText(incomingUserMessage);

	return {
		tokens: baseTokens + incomingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex,
	};
}

function shouldCompactEstimate(contextTokens, contextWindow) {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
	return contextTokens > contextWindow - COMPACTION_SETTINGS.reserveTokens;
}

function serializeTurnsForCompaction(turns) {
	return turns
		.map((turn, index) => {
			const interaction = summarizeInteraction(turn.interaction || {});
			const state = formatStateSummaryInline(turn.assistantStateSummary || {});
			return `Turn ${index + 1}:\nInteraction: ${interaction}\nState: ${state}\nOriginal Prompt: ${(turn.userPrompt || "").slice(0, 500)}`;
		})
		.join("\n\n");
}

function buildSplitTurnPromptTail(userPrompt) {
	const source = typeof userPrompt === "string" ? userPrompt : "";
	if (!source) return "";
	if (estimateTokensFromText(source) <= COMPACTION_SETTINGS.keepRecentTokens) return source;
	const tailChars = Math.max(4000, Math.floor(COMPACTION_SETTINGS.keepRecentTokens));
	const tail = source.slice(-tailChars);
	return `[Split-turn compacted. Earlier prompt details are preserved in rolling summary.]\n${tail}`;
}

const TURN_STATE_SUMMARIZATION_SYSTEM_PROMPT =
	"You are a state summarization assistant. Return only strict JSON with keys: goal, ui_state, actions_taken, open_issues, next_steps.";

const COMPACTION_SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context compaction assistant. Produce concise continuation memory and keep exact app IDs, interaction IDs, and key constraints.";

async function generateTurnStateSummary({
	model,
	apiKey,
	interaction,
	assistantOutputText,
	laneSummary,
}) {
	const clippedOutput = typeof assistantOutputText === "string" ? assistantOutputText.slice(0, 8000) : "";
	const prompt = [
		"Summarize this completed turn into a structured state snapshot.",
		"Return JSON only. No markdown.",
		"Schema:",
		`{"goal":"string","ui_state":"string","actions_taken":["string"],"open_issues":["string"],"next_steps":["string"]}`,
		"",
		`App context: ${normalizeAppContext(interaction?.appContext)}`,
		`Interaction: ${summarizeInteraction(interaction || {})}`,
		"",
		"Rolling summary context (for continuity):",
		(laneSummary || "(none)").slice(0, 3000),
		"",
		"Assistant output (trimmed):",
		clippedOutput || "(empty)",
	].join("\n");

	const response = await completeSimple(
		model,
		{
			systemPrompt: TURN_STATE_SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning: "low",
			maxTokens: 900,
		},
	);
	const text = extractTextBlocks(response);
	const parsed = extractJsonObject(text);
	return normalizeTurnStateSummary(parsed, interaction, assistantOutputText);
}

async function generateCompactionSummary({
	model,
	apiKey,
	previousSummary,
	turns,
	customHeader,
}) {
	const serializedTurns = serializeTurnsForCompaction(turns);
	const prompt = [
		customHeader || "Update the rolling context summary with the provided older turns.",
		"Keep output concise and focused on continuation-critical context.",
		"Prefer bullet lists and preserve app IDs and intent.",
		"",
		"<previous-summary>",
		previousSummary || "(none)",
		"</previous-summary>",
		"",
		"<turns-to-compact>",
		serializedTurns || "(none)",
		"</turns-to-compact>",
	].join("\n");

	const response = await completeSimple(
		model,
		{
			systemPrompt: COMPACTION_SUMMARIZATION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			apiKey,
			reasoning: "medium",
			maxTokens: Math.max(800, Math.floor(0.8 * COMPACTION_SETTINGS.reserveTokens)),
		},
	);
	const text = extractTextBlocks(response).trim();
	return text || previousSummary || "";
}

function prepareLaneCompaction(lane) {
	if (!lane || !Array.isArray(lane.recentTurns) || lane.recentTurns.length < 2) return null;
	const turns = lane.recentTurns;
	const tokensBefore =
		estimateTokensFromText(lane.summary || "") + turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0);
	let accumulated = 0;
	let keepStartIndex = turns.length;

	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turnTokens = estimateTurnTokens(turns[i]);
		if (turnTokens >= COMPACTION_SETTINGS.keepRecentTokens) {
			keepStartIndex = i;
			accumulated = turnTokens;
			break;
		}
		accumulated += turnTokens;
		keepStartIndex = i;
		if (accumulated >= COMPACTION_SETTINGS.keepRecentTokens) break;
	}

	if (accumulated <= COMPACTION_SETTINGS.keepRecentTokens && keepStartIndex <= 0) {
		return null;
	}

	const turnsToSummarize = turns.slice(0, keepStartIndex);
	const keepTurns = turns.slice(keepStartIndex);
	let splitTurnIndex = -1;
	if (keepTurns.length && estimateTurnTokens(keepTurns[0]) > COMPACTION_SETTINGS.keepRecentTokens) {
		splitTurnIndex = 0;
	}

	if (!turnsToSummarize.length && splitTurnIndex < 0) return null;

	return {
		tokensBefore,
		turnsToSummarize,
		keepTurns,
		isSplitTurn: splitTurnIndex >= 0,
		splitTurnIndex,
	};
}

function formatCompactedTurnsMemoryNote(turns, reason, laneKey) {
	const lines = [
		`Compaction flush (${reason}) for lane ${laneKey}.`,
		"The following older turns were compacted from in-memory context and preserved as durable notes:",
	];
	const maxTurns = Math.min(12, turns.length);
	for (let index = 0; index < maxTurns; index += 1) {
		const turn = turns[index];
		lines.push(`${index + 1}. ${summarizeInteraction(turn.interaction || {})}`);
	}
	if (turns.length > maxTurns) {
		lines.push(`... ${turns.length - maxTurns} additional compacted turns omitted in this note.`);
	}
	return lines.join("\n");
}

async function runLaneCompaction({ laneKey, lane, model, apiKey, reason, workspaceRoot }) {
	if (!lane || lane.compactionInFlight) return false;
	lane.compactionInFlight = true;
	try {
		const prep = prepareLaneCompaction(lane);
		if (!prep) return false;

		if (workspaceRoot && prep.turnsToSummarize.length) {
			try {
				await appendMemoryNote({
					workspaceRoot,
					note: formatCompactedTurnsMemoryNote(prep.turnsToSummarize, reason, laneKey),
					tags: ["compaction", "context-memory", normalizeAppContext(lane?.recentTurns?.[0]?.appContext || "")],
				});
			} catch (error) {
				console.warn("[ContextMemory] failed to write compaction flush note", {
					laneKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		let nextSummary = lane.summary || "";
		if (prep.turnsToSummarize.length) {
			nextSummary = await generateCompactionSummary({
				model,
				apiKey,
				previousSummary: nextSummary,
				turns: prep.turnsToSummarize,
			});
		}

		if (prep.isSplitTurn && prep.keepTurns[prep.splitTurnIndex]) {
			const splitTurn = prep.keepTurns[prep.splitTurnIndex];
			const splitSummary = await generateCompactionSummary({
				model,
				apiKey,
				previousSummary: "",
				turns: [splitTurn],
				customHeader: "Summarize this oversized split turn prefix for continuation.",
			});
			nextSummary = nextSummary
				? `${nextSummary}\n\n---\n\nSplit Turn Context:\n${splitSummary}`
				: `Split Turn Context:\n${splitSummary}`;

			const compactedState = buildDeterministicStateSummary(
				splitTurn.interaction,
				JSON.stringify(splitTurn.assistantStateSummary || {}),
			);
			compactedState.ui_state = "Turn details compacted due to context budget. Refer to rolling summary.";
			const compactedTurn = {
				...splitTurn,
				userPrompt: buildSplitTurnPromptTail(splitTurn.userPrompt),
				assistantStateSummary: compactedState,
				estimatedTokens: 0,
			};
			compactedTurn.estimatedTokens = estimateTurnTokens(compactedTurn);
			prep.keepTurns[prep.splitTurnIndex] = compactedTurn;
		}

		lane.summary = String(nextSummary || "").trim();
		lane.recentTurns = prep.keepTurns;

		console.info("[ContextMemory] compaction", {
			laneKey,
			reason,
			compactionTriggered: true,
			tokensBefore: prep.tokensBefore,
			turnsCompacted: prep.turnsToSummarize.length,
			keptTurns: lane.recentTurns.length,
		});
		return true;
	} finally {
		lane.compactionInFlight = false;
	}
}

function buildCompactedUserMessage({ lane, appContext, currentInteraction, userMessage }) {
	const parts = [];
	parts.push(`Current App Context: ${normalizeAppContext(appContext)}`);
	parts.push(
		`Context Memory Mode: compacted (reserveTokens=${COMPACTION_SETTINGS.reserveTokens}, keepRecentTokens=${COMPACTION_SETTINGS.keepRecentTokens})`,
	);

	if (lane.summary) {
		parts.push(`Compacted Summary:\n${lane.summary}`);
	}

	if (lane.recentTurns.length) {
		const recentTurns = lane.recentTurns
			.map((turn, index) => {
				return `${index + 1}. ${summarizeInteraction(turn.interaction)}\nState: ${formatStateSummaryInline(turn.assistantStateSummary)}`;
			})
			.join("\n\n");
		parts.push(`Recent Turns (detailed tail):\n${recentTurns}`);
	}

	parts.push(`Current Interaction:\n${summarizeInteraction(currentInteraction)}`);
	parts.push(`Current Turn Request:\n${userMessage}`);
	return parts.join("\n\n");
}

async function maybeCompactBeforeRequest({
	laneKey,
	lane,
	model,
	apiKey,
	systemPrompt,
	incomingUserMessage,
	workspaceRoot,
}) {
	const contextWindow = Number(model?.contextWindow || 0);
	if (contextWindow <= 0) return;

	const estimate = estimateLaneContextTokens(lane, systemPrompt, incomingUserMessage);
	const threshold = contextWindow - COMPACTION_SETTINGS.reserveTokens;
	lane.lastEstimate = {
		tokens: estimate.tokens,
		contextWindow,
		threshold,
		estimatedAt: Date.now(),
	};

	console.info("[ContextMemory] estimate", {
		laneKey,
		contextTokensEstimate: estimate.tokens,
		contextWindow,
		threshold,
		compactionTriggered: estimate.tokens > threshold,
		tokensBefore: estimate.tokens,
		turnsCompacted: 0,
	});

	if (shouldCompactEstimate(estimate.tokens, contextWindow)) {
		await runLaneCompaction({ laneKey, lane, model, apiKey, reason: "pre_send", workspaceRoot });
	}
}

function queueBackgroundCompaction({ laneKey, lane, model, apiKey, workspaceRoot }) {
	if (!lane) return;
	if (lane.compactionInFlight) {
		lane.compactionQueued = true;
		setTimeout(() => {
			queueBackgroundCompaction({ laneKey, lane, model, apiKey, workspaceRoot });
		}, 25);
		return;
	}
	lane.compactionQueued = true;
	setTimeout(async () => {
		if (!lane.compactionQueued || lane.compactionInFlight) return;
		lane.compactionQueued = false;
		try {
			const contextWindow = Number(model?.contextWindow || 0);
			if (contextWindow <= 0) return;
			const estimate = estimateLaneContextTokens(lane);
			const threshold = contextWindow - COMPACTION_SETTINGS.reserveTokens;
			lane.lastEstimate = {
				tokens: estimate.tokens,
				contextWindow,
				threshold,
				estimatedAt: Date.now(),
			};
			console.info("[ContextMemory] estimate", {
				laneKey,
				contextTokensEstimate: estimate.tokens,
				contextWindow,
				threshold,
				compactionTriggered: estimate.tokens > threshold,
				tokensBefore: estimate.tokens,
				turnsCompacted: 0,
			});
			if (estimate.tokens > threshold) {
				await runLaneCompaction({ laneKey, lane, model, apiKey, reason: "background", workspaceRoot });
			}
		} catch (error) {
			console.warn("[ContextMemory] background compaction failed", {
				laneKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}, 0);
}

function writeChunk(res, payload) {
	res.write(`${JSON.stringify(payload)}\n`);
}

function extractTextBlocks(message) {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function normalizeUsageSnapshot(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	const numeric = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		input: numeric(usage.input),
		output: numeric(usage.output),
		cacheRead: numeric(usage.cacheRead),
		cacheWrite: numeric(usage.cacheWrite),
		totalTokens: numeric(usage.totalTokens),
	};
}

function buildFallbackInteraction(appContext, userMessage) {
	return normalizeInteractionPayload(
		{
			id: `legacy_${Date.now().toString(36)}`,
			type: "user_prompt",
			value: typeof userMessage === "string" ? userMessage.slice(0, 320) : "",
			elementType: "prompt",
			elementText: "Legacy Prompt",
			appContext,
		},
		appContext,
	);
}

function extractJsonObject(text) {
	if (!text) return null;
	const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
	if (fenceMatch && fenceMatch[1]) {
		try {
			return JSON.parse(fenceMatch[1].trim());
		} catch {
			// Keep trying with brace parser below.
		}
	}

	const start = text.indexOf("{");
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escape) {
				escape = false;
			} else if (ch === "\\") {
				escape = true;
			} else if (ch === "\"") {
				inString = false;
			}
			continue;
		}

		if (ch === "\"") {
			inString = true;
			continue;
		}
		if (ch === "{") depth += 1;
		if (ch === "}") depth -= 1;
		if (depth === 0) {
			const candidate = text.slice(start, i + 1);
			try {
				return JSON.parse(candidate);
			} catch {
				return null;
			}
		}
	}

	return null;
}

function validateSettingsSchema(schema) {
	if (!schema || typeof schema !== "object") return false;
	if (!Array.isArray(schema.sections)) return false;

	for (const section of schema.sections) {
		if (!section || typeof section !== "object") return false;
		if (!Array.isArray(section.fields)) return false;
		for (const field of section.fields) {
			if (!field || typeof field !== "object") return false;
			if (!settingsAllowedKeys.includes(field.key)) return false;
			if (typeof field.label !== "string" || !field.label.trim()) return false;
			if (typeof field.control !== "string") return false;
		}
	}
	return true;
}

function ensureRequiredSettingsFields(schema) {
	if (!schema || typeof schema !== "object" || !Array.isArray(schema.sections)) {
		return defaultSettingsSchema;
	}

	const nextSchema = {
		...schema,
		sections: schema.sections.map((section) => ({
			...section,
			fields: Array.isArray(section.fields) ? [...section.fields] : [],
		})),
	};

	let advancedSection = nextSchema.sections.find((section) => section.id === "advanced");
	if (!advancedSection) {
		advancedSection = {
			id: "advanced",
			title: "Advanced",
			fields: [],
		};
		nextSchema.sections.push(advancedSection);
	}

	const hasLoadingUiMode = advancedSection.fields.some((field) => field?.key === "loadingUiMode");
	if (!hasLoadingUiMode) {
		advancedSection.fields.unshift({
			key: "loadingUiMode",
			label: "Loading UI Mode",
			control: "select",
			description: "Default is Code (Legacy Stream). Switch to Immersive live preview if preferred.",
		});
	}

	const hasContextMemoryMode = advancedSection.fields.some((field) => field?.key === "contextMemoryMode");
	if (!hasContextMemoryMode) {
		advancedSection.fields.push({
			key: "contextMemoryMode",
			label: "Context Memory Mode",
			control: "select",
			description: "Compacted mode keeps continuity with server-side memory compaction. Legacy mode uses client-provided interaction history.",
		});
	}

	const hasWorkspaceRoot = advancedSection.fields.some((field) => field?.key === "workspaceRoot");
	if (!hasWorkspaceRoot) {
		advancedSection.fields.push({
			key: "workspaceRoot",
			label: "Workspace Root",
			control: "text",
			description: "Workspace path used by Pi-style tools. Must stay within server workspace policy roots.",
			placeholder: "./workspace",
		});
	}

	return nextSchema;
}

function buildSettingsSkillPrompt({ styleConfig, llmConfig }) {
	return [
		"You are `render_settings_skill` for Neural Computer.",
		"Output ONLY valid JSON. No markdown. No comments.",
		"Generate a settings schema describing sections and fields for the host to render.",
		`Allowed field keys: ${settingsAllowedKeys.join(", ")}`,
		"Rules:",
		"- Include every important field at least once.",
		"- Use concise labels and practical ordering.",
		"- Avoid fake hardware/system diagnostics content.",
		"- Keep it configuration-focused.",
		"",
		"Current settings snapshot:",
		JSON.stringify({ styleConfig, llmConfig }, null, 2),
		"",
		"Return JSON in this shape:",
		JSON.stringify(defaultSettingsSchema, null, 2),
	].join("\n");
}

async function runGoogleSearch(query, apiKey, cx, count = 5) {
	if (!apiKey || !cx) {
		return { ok: false, message: "Google Search API key or CX missing in settings." };
	}

	const url = new URL("https://www.googleapis.com/customsearch/v1");
	url.searchParams.append("key", apiKey);
	url.searchParams.append("cx", cx);
	url.searchParams.append("q", query);
	url.searchParams.append("num", String(Math.max(1, Math.min(10, Number(count) || 5))));
	url.searchParams.append("safe", "active");

	try {
		const response = await fetch(url.toString());
		if (!response.ok) {
			return { ok: false, message: `Google Search API error (${response.status}).` };
		}
		const data = await response.json();
		const items = Array.isArray(data.items)
			? data.items.map((item) => ({
					title: item.title || "",
					link: item.link || "",
					snippet: item.snippet || "",
				}))
			: [];
		return { ok: true, items };
	} catch (error) {
		return { ok: false, message: `Google Search failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

const workspacePolicy = createWorkspacePolicy({
	defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
	allowedRoots: WORKSPACE_POLICY_ROOTS.length ? WORKSPACE_POLICY_ROOTS : [process.cwd()],
});

const workspaceToolRuntime = createWorkspaceToolRuntime({
	workspacePolicy,
	runGoogleSearch,
	commandTimeoutMs: TOOL_CMD_TIMEOUT_SEC * 1000,
	maxOutputChars: 16_000,
	maxReadChars: 12_000,
});
const uiHistoryRuntime = createUiHistoryRuntime({
	retentionDays: UI_HISTORY_RETENTION_DAYS,
	logger: console,
});

async function runStreamWithToolLoop({
	res,
	model,
	apiKey,
	systemPrompt,
	extraPromptSegments = [],
	userMessage,
	normalizedLlmConfig,
	appContext,
	workspaceRoot,
	onboardingMode = false,
	onboardingHandlers = {},
	googleSearchApiKey,
	googleSearchCx,
	sessionId,
	interaction,
	seedRenderedScreen,
	uiHistoryRuntime,
	signal,
}) {
	const toolDefinitions = buildToolDefinitions(normalizedLlmConfig.toolTier, {
		onboardingRequired: onboardingMode,
		includeGoogleSearch: true,
	});
	const toolGuidancePrompt = buildPiToolGuidancePrompt(toolDefinitions);
	const resolvedSystemPrompt = [
		typeof systemPrompt === "string" ? systemPrompt.trim() : "",
		...(Array.isArray(extraPromptSegments) ? extraPromptSegments : []),
		toolGuidancePrompt,
	]
		.filter(Boolean)
		.join("\n\n");
	const context = {
		systemPrompt: resolvedSystemPrompt,
		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
		tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
	};

	let emittedTextChunks = 0;
	let assistantOutputText = "";
	let finalMessage = null;
	let renderOutputState = seedRenderedScreen
		? {
				renderCount: Number(seedRenderedScreen.revision) || 1,
				latestHtml: String(seedRenderedScreen.html || ""),
				lastIsFinal: Boolean(seedRenderedScreen.isFinal),
			}
		: createRenderOutputState();
	let turnRenderOutputCount = 0;
	let readScreenUsageState = createReadScreenUsageState();
	let activeWorkspaceRoot = workspaceRoot;
	const emitScreenPartialByToolCall = new Map();
	const buildLoopResult = () => ({
		finalMessage,
		assistantOutputText,
		emittedTextChunks,
		renderOutputCount: turnRenderOutputCount,
		latestRenderOutputHtml: renderOutputState.latestHtml,
	});

	// Intentionally unbounded tool loop: we avoid fixed turn/time ceilings in semantic execution
	// so the runtime can support unbounded-step computation in principle (Turing-completeness criterion).
	for (;;) {

		const stream = streamSimple(model, context, {
			apiKey,
			reasoning: "medium",
			signal,
			maxTokens: 8192,
		});

		for await (const event of stream) {
			if (event.type === "text_delta") {
				emittedTextChunks += 1;
				assistantOutputText += event.delta;
				writeChunk(res, { type: "chunk", chunk: event.delta });
			} else if (event.type === "thinking_delta") {
				writeChunk(res, { type: "thought", text: event.delta });
				} else if (event.type === "toolcall_start") {
					const startedToolName =
						(typeof event?.toolCall?.name === "string" && event.toolCall.name.trim()) ||
						(typeof event?.name === "string" && event.name.trim()) ||
						"tool";
				const startedToolCallId =
					(typeof event?.toolCall?.id === "string" && event.toolCall.id) ||
					(typeof event?.id === "string" ? event.id : undefined);
					writeChunk(res, {
						type: "tool_call_start",
						toolName: startedToolName,
						toolCallId: startedToolCallId,
					});
					writeChunk(res, { type: "thought", text: `[System] Resolving tool call (${startedToolName})...` });
				} else if (event.type === "toolcall_delta") {
					const contentIndex = Number.isFinite(event?.contentIndex) ? Number(event.contentIndex) : -1;
					const partialContent =
						Array.isArray(event?.partial?.content) && contentIndex >= 0
							? event.partial.content[contentIndex]
							: undefined;
					if (partialContent?.type !== "toolCall" || partialContent?.name !== "emit_screen") {
						continue;
					}
					const partialArgs =
						partialContent.arguments && typeof partialContent.arguments === "object"
							? partialContent.arguments
							: {};
					const partialOp =
						typeof partialArgs.op === "string" && partialArgs.op.trim()
							? partialArgs.op.trim().toLowerCase()
							: "replace";
					if (partialOp !== "replace") {
						continue;
					}
					const partialHtml = typeof partialArgs.html === "string" ? partialArgs.html : "";
					if (!partialHtml) {
						continue;
					}
					const normalizedToolCallId =
						typeof partialContent.id === "string" && partialContent.id.trim()
							? partialContent.id.trim()
							: `emit_screen_partial_${contentIndex}`;
					const previousPartial = emitScreenPartialByToolCall.get(normalizedToolCallId);
					const now = Date.now();
					const hasChanged = !previousPartial || previousPartial.html !== partialHtml;
					const lengthDelta = previousPartial ? Math.abs(partialHtml.length - previousPartial.html.length) : partialHtml.length;
					const dueByLength = lengthDelta >= EMIT_SCREEN_PARTIAL_MIN_CHAR_DELTA;
					const dueByTime =
						!previousPartial || now - previousPartial.emittedAt >= EMIT_SCREEN_PARTIAL_MIN_INTERVAL_MS;
					if (!hasChanged || (!dueByLength && !dueByTime)) {
						continue;
					}
					emitScreenPartialByToolCall.set(normalizedToolCallId, {
						html: partialHtml,
						emittedAt: now,
					});
					writeChunk(res, {
						type: "render_output_partial",
						toolName: "emit_screen",
						toolCallId:
							typeof partialContent.id === "string" && partialContent.id.trim()
								? partialContent.id.trim()
								: undefined,
						html: partialHtml.slice(0, EMIT_SCREEN_MAX_HTML_CHARS),
						appContext:
							typeof partialArgs.appContext === "string" && partialArgs.appContext.trim()
								? partialArgs.appContext.trim()
								: undefined,
						revisionNote:
							typeof partialArgs.revisionNote === "string" && partialArgs.revisionNote.trim()
								? partialArgs.revisionNote.trim().slice(0, 200)
								: undefined,
						isFinal: Boolean(partialArgs.isFinal),
					});
				}
			}

		finalMessage = await stream.result();
		context.messages.push(finalMessage);

		const textFallback = extractTextBlocks(finalMessage);
		if (!assistantOutputText && !renderOutputState.latestHtml && textFallback) {
			assistantOutputText = textFallback;
		}

		if (finalMessage.stopReason !== "toolUse") {
			return buildLoopResult();
		}

		const toolCalls = finalMessage.content.filter((part) => part.type === "toolCall");
		if (!toolCalls.length) {
			return buildLoopResult();
		}

		for (const toolCall of toolCalls) {
			let toolText = "";
			let isError = false;
			if (typeof toolCall.id === "string" && toolCall.id.trim()) {
				emitScreenPartialByToolCall.delete(toolCall.id.trim());
			}

			if (toolCall.name === "emit_screen") {
				if (turnRenderOutputCount >= EMIT_SCREEN_MAX_CALLS) {
					isError = true;
					toolText = `emit_screen call budget exceeded (${EMIT_SCREEN_MAX_CALLS} calls per turn).`;
				} else {
					const validation = validateEmitScreenArgs(toolCall.arguments, {
						maxHtmlChars: EMIT_SCREEN_MAX_HTML_CHARS,
					});
					if (!validation.ok) {
						isError = true;
						toolText = validation.error;
					} else {
						const applied = applyEmitScreen(renderOutputState, validation.value, {
							toolName: toolCall.name,
							toolCallId: toolCall.id,
						});
						if (!applied?.ok) {
							isError = true;
							toolText = `emit_screen ${applied?.errorCode || "ERROR"}: ${applied?.error || "unknown error"}`;
						} else {
							renderOutputState = applied.nextState;
							turnRenderOutputCount += 1;
							assistantOutputText = renderOutputState.latestHtml;
							writeChunk(res, applied.streamEvent);
							toolText = applied.toolResultText;
							if (uiHistoryRuntime && typeof uiHistoryRuntime.persistEmitScreenRevision === "function") {
								void uiHistoryRuntime
									.persistEmitScreenRevision({
										workspaceRoot: activeWorkspaceRoot,
										html: applied.streamEvent.html,
										revision: applied.streamEvent.revision,
										isFinal: validation.value.isFinal,
										revisionNote: validation.value.revisionNote,
										appContext: validation.value.appContext || appContext || interaction?.appContext,
										toolCallId: toolCall.id,
										sessionId,
										interaction,
									})
									.catch((error) => {
										console.warn(
											"[UiHistoryRuntime] persist failed",
											error instanceof Error ? error.message : String(error),
										);
									});
							}
						}
					}
				}
			} else if (toolCall.name === "read_screen") {
				const readResult = runReadScreenToolCall({
					args: toolCall.arguments,
					renderOutputState,
					usageState: readScreenUsageState,
					appContext,
				});
				readScreenUsageState = readResult.nextState;
				isError = Boolean(readResult.isError);
				toolText = String(readResult.text || "");
			} else if (normalizedLlmConfig.toolTier === "none" && !onboardingMode) {
				isError = true;
				toolText = "Tool access disabled by tool tier policy.";
			} else {
				const toolResult = await executeToolCall(toolCall, {
					runtimeConfig: workspaceToolRuntime,
					workspaceRoot: activeWorkspaceRoot,
					onboardingMode,
					onboardingHandlers,
					googleSearchApiKey,
					googleSearchCx,
				});
				isError = Boolean(toolResult?.isError);
				toolText = String(toolResult?.text || "");
				if (toolResult?.nextWorkspaceRoot && !toolResult?.isError) {
					activeWorkspaceRoot = String(toolResult.nextWorkspaceRoot);
				}
			}

			const trimmedMessage = toolText.length > 240 ? `${toolText.slice(0, 240)}...` : toolText;
			writeChunk(res, {
				type: "tool_call_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				isError,
				text: trimmedMessage,
			});
			writeChunk(res, {
				type: "thought",
				text: `[System] Tool ${toolCall.name} completed${isError ? ` with error: ${trimmedMessage}` : ""}.`,
			});

			context.messages.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: toolText }],
				isError,
				timestamp: Date.now(),
			});
		}
	}
}

app.get("/api/health", (_req, res) => {
	const providers = listProviders();
	res.json({
		ok: true,
		mode: "neural-computer-pi-runtime",
		defaultModel: DEFAULT_MODEL,
		provider: DEFAULT_PROVIDER,
		toolBudgets: {
			maxTurns: null,
			maxMs: null,
			commandTimeoutSec: TOOL_CMD_TIMEOUT_SEC,
		},
		workspacePolicy: {
			defaultWorkspaceRoot: DEFAULT_WORKSPACE_ROOT,
			allowedRoots: WORKSPACE_POLICY_ROOTS.length ? WORKSPACE_POLICY_ROOTS : [process.cwd()],
		},
		availableProviders: providers,
		hasDefaultProviderApiKey: Boolean(resolveApiKey(undefined, DEFAULT_PROVIDER)),
		hasCodexOauthToken: Boolean(getCodexOauthToken()),
	});
});

app.get("/api/llm/catalog", (_req, res) => {
	const providers = getCatalogProviders();

	const fallbackProviders = providers.length
		? providers
		: [
				{
					providerId: DEFAULT_PROVIDER,
					models: [
						{
							id: DEFAULT_MODEL,
							name: DEFAULT_MODEL,
							api: "unknown",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			];

	res.json({
		providers: fallbackProviders,
		defaults: {
			providerId: DEFAULT_PROVIDER,
			modelId: DEFAULT_MODEL,
		},
	});
});

app.post("/api/credentials/set", (req, res) => {
	const { sessionId, providerId, apiKey } = req.body || {};
	if (!sessionId || !providerId || !apiKey) {
		sendApiError(
			res,
			createApiError(400, "INVALID_CREDENTIAL_REQUEST", "sessionId, providerId, and apiKey are required.", {
				required: ["sessionId", "providerId", "apiKey"],
			}),
		);
		return;
	}
	const requestedProvider = String(providerId).trim();
	const providers = listProviders();
	if (!providers.includes(requestedProvider)) {
		sendApiError(
			res,
			createApiError(400, "INVALID_PROVIDER", `Provider '${requestedProvider}' is not supported.`, {
				requestedProvider,
				availableProviders: providers,
			}),
		);
		return;
	}
	const normalizedProvider = requestedProvider;
	const store = getSessionStore(sessionId);
	store[normalizedProvider] = String(apiKey).trim();
	res.json({
		ok: true,
		providerId: normalizedProvider,
	});
});

app.post("/api/credentials/remove", (req, res) => {
	const { sessionId, providerId } = req.body || {};
	if (!sessionId || !providerId) {
		sendApiError(
			res,
			createApiError(400, "INVALID_CREDENTIAL_REQUEST", "sessionId and providerId are required.", {
				required: ["sessionId", "providerId"],
			}),
		);
		return;
	}
	const requestedProvider = String(providerId).trim();
	const providers = listProviders();
	if (!providers.includes(requestedProvider)) {
		sendApiError(
			res,
			createApiError(400, "INVALID_PROVIDER", `Provider '${requestedProvider}' is not supported.`, {
				requestedProvider,
				availableProviders: providers,
			}),
		);
		return;
	}
	const normalizedProvider = requestedProvider;
	const store = getSessionStore(sessionId);
	delete store[normalizedProvider];
	res.json({ ok: true, providerId: normalizedProvider });
});

app.post("/api/settings/schema", async (req, res) => {
	const {
		sessionId,
		llmConfig = { providerId: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL },
		styleConfig = {},
	} = req.body || {};

	const resolvedLlm = normalizeLlmConfig(llmConfig);
	if (resolvedLlm.error) {
		sendApiError(res, resolvedLlm.error);
		return;
	}
	const normalizedLlmConfig = resolvedLlm.value;
	const model = resolvedLlm.model || resolveModel(normalizedLlmConfig.providerId, normalizedLlmConfig.modelId);
	const apiKey = resolveApiKey(sessionId, model.provider);
	if (!apiKey) {
		res.json({
			ok: true,
			schema: {
				...defaultSettingsSchema,
				description: "API key not configured. Showing fallback settings schema.",
			},
		});
		return;
	}

	try {
		const prompt = buildSettingsSkillPrompt({ styleConfig, llmConfig: normalizedLlmConfig });
		const response = await completeSimple(
			model,
			{
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{
				apiKey,
				reasoning: "low",
				maxTokens: 4096,
			},
		);

		const text = extractTextBlocks(response);
		const parsed = extractJsonObject(text);
		const isValid = validateSettingsSchema(parsed);

		if (!isValid) {
			res.json({
				ok: true,
				schema: {
					...defaultSettingsSchema,
					description: "Model produced invalid settings schema. Using fallback.",
				},
			});
			return;
		}

		res.json({
			ok: true,
			schema: {
				...ensureRequiredSettingsFields(parsed),
				generatedBy: `${model.provider}/${model.id}`,
			},
		});
	} catch (error) {
		res.json({
			ok: true,
			schema: {
				...defaultSettingsSchema,
				description: `Settings skill fallback due to error: ${error instanceof Error ? error.message : String(error)}`,
			},
		});
	}
});

app.get("/api/debug/context-memory", (req, res) => {
	if (process.env.NODE_ENV === "production") {
		sendApiError(res, createApiError(404, "NOT_FOUND", "Context memory diagnostics are unavailable in production."));
		return;
	}

	const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
	const appContext = typeof req.query.appContext === "string" ? req.query.appContext.trim() : "";

	const lanes = [...contextMemoryStore.entries()]
		.filter(([laneKey]) => {
			if (!sessionId && !appContext) return true;
			const [laneSessionId = "", laneAppContext = ""] = laneKey.split("::");
			if (sessionId && laneSessionId !== sessionId) return false;
			if (appContext && laneAppContext !== normalizeAppContext(appContext)) return false;
			return true;
		})
		.map(([laneKey, lane]) => ({
			laneKey,
			summaryLength: (lane.summary || "").length,
			recentTurnCount: Array.isArray(lane.recentTurns) ? lane.recentTurns.length : 0,
			lastEstimate: lane.lastEstimate || null,
			compactionInFlight: Boolean(lane.compactionInFlight),
			compactionQueued: Boolean(lane.compactionQueued),
		}));

	res.json({
		ok: true,
		count: lanes.length,
		lanes,
	});
});

app.get("/api/skills/status", async (req, res) => {
	const requestedWorkspaceRoot =
		typeof req.query.workspaceRoot === "string" && req.query.workspaceRoot.trim()
			? req.query.workspaceRoot.trim()
			: DEFAULT_WORKSPACE_ROOT;
	try {
		const workspaceResolution = await resolveWorkspaceRoot({
			requestedWorkspaceRoot,
			policy: workspacePolicy,
		});
		const workspaceRoot = workspaceResolution.configuredWorkspaceRoot;
		await ensureWorkspaceScaffold(workspaceRoot);
		const status = await buildSkillsStatus({
			workspaceRoot,
			bundledSkillDirs: [BUNDLED_SKILLS_DIR],
			extraSkillDirs: EXTRA_SKILL_DIRS,
			homeSkillDir: HOME_SKILLS_DIR,
			env: process.env,
		});
		res.json({
			ok: true,
			workspaceRoot,
			discovered: status.discovered,
			eligible: status.eligible,
			blocked: status.blocked,
			eligibleSkills: status.eligibleSkills.map((entry) => ({
				id: entry.id,
				title: entry.title,
				description: entry.description,
				path: entry.path,
				source: entry.source,
			})),
			blockedSkills: status.blockedSkills.map((entry) => ({
				id: entry.id,
				title: entry.title,
				path: entry.path,
				blockedBy: entry.blockedBy,
			})),
		});
	} catch (error) {
		if (error instanceof WorkspacePolicyError) {
			sendApiError(res, createApiError(400, error.code || "WORKSPACE_POLICY_ERROR", error.message, error.details));
			return;
		}
		sendApiError(
			res,
			createApiError(500, "SKILLS_STATUS_FAILED", error instanceof Error ? error.message : String(error)),
		);
	}
});

app.get("/api/onboarding/state", async (req, res) => {
	const requestedWorkspaceRoot =
		typeof req.query.workspaceRoot === "string" && req.query.workspaceRoot.trim()
			? req.query.workspaceRoot.trim()
			: DEFAULT_WORKSPACE_ROOT;
	const sessionId = typeof req.query.sessionId === "string" && req.query.sessionId.trim() ? req.query.sessionId.trim() : "";
	const requestedLlmConfig = extractRequestedLlmConfig(req.query);
	try {
		const workspaceRoot = await resolveAndEnsureWorkspaceRoot(requestedWorkspaceRoot);
		let onboardingState = await startOnboardingRun(workspaceRoot);
		if (!onboardingState.completed) {
			onboardingState = (
				await syncOnboardingStateWithRuntimeConfig({
					workspaceRoot,
					state: onboardingState,
					sessionId,
					requestedLlmConfig,
				})
			).state;
		}
		res.json({
			ok: true,
			workspaceRoot,
			state: onboardingState,
		});
	} catch (error) {
		if (error instanceof WorkspacePolicyError) {
			sendApiError(res, createApiError(400, error.code || "WORKSPACE_POLICY_ERROR", error.message, error.details));
			return;
		}
		sendApiError(
			res,
			createApiError(500, "ONBOARDING_STATE_FAILED", error instanceof Error ? error.message : String(error)),
		);
	}
});

app.post("/api/onboarding/reopen", async (req, res) => {
	const requestedWorkspaceRoot =
		typeof req.body?.workspaceRoot === "string" && req.body.workspaceRoot.trim()
			? req.body.workspaceRoot.trim()
			: DEFAULT_WORKSPACE_ROOT;
	try {
		const workspaceRoot = await resolveAndEnsureWorkspaceRoot(requestedWorkspaceRoot);
		const onboardingState = await reopenOnboarding(workspaceRoot);
		await appendOnboardingEvent(workspaceRoot, {
			event: "onboarding_reopened",
			runId: onboardingState.runId,
			lifecycle: onboardingState.lifecycle,
			details: { source: "api" },
		});
		res.json({
			ok: true,
			workspaceRoot,
			state: onboardingState,
		});
	} catch (error) {
		if (error instanceof WorkspacePolicyError) {
			sendApiError(res, createApiError(400, error.code || "WORKSPACE_POLICY_ERROR", error.message, error.details));
			return;
		}
		sendApiError(
			res,
			createApiError(500, "ONBOARDING_REOPEN_FAILED", error instanceof Error ? error.message : String(error)),
		);
	}
});

app.post("/api/onboarding/complete", async (req, res) => {
	const requestedWorkspaceRoot =
		typeof req.body?.workspaceRoot === "string" && req.body.workspaceRoot.trim()
			? req.body.workspaceRoot.trim()
			: DEFAULT_WORKSPACE_ROOT;
	const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
	try {
		const workspaceRoot = await resolveAndEnsureWorkspaceRoot(requestedWorkspaceRoot);
		const completedState = await completeOnboarding(workspaceRoot);
		if (summary) {
			await appendMemoryNote({
				workspaceRoot,
				note: `Onboarding completion summary:\\n${summary}`,
				tags: ["onboarding", "completion"],
			});
		}
		await appendOnboardingEvent(workspaceRoot, {
			event: "onboarding_completed",
			runId: completedState.runId,
			lifecycle: completedState.lifecycle,
			checkpoint: "completed",
			details: { via: "api", summaryProvided: Boolean(summary) },
		});
		res.json({
			ok: true,
			workspaceRoot,
			state: completedState,
		});
	} catch (error) {
		if (error instanceof WorkspacePolicyError) {
			sendApiError(res, createApiError(400, error.code || "WORKSPACE_POLICY_ERROR", error.message, error.details));
			return;
		}
		if (error && error.code === "ONBOARDING_INCOMPLETE") {
			sendApiError(
				res,
				createApiError(
					400,
					"ONBOARDING_INCOMPLETE",
					error.message || "Onboarding checkpoints are incomplete.",
					error.details,
				),
			);
			return;
		}
		sendApiError(
			res,
			createApiError(500, "ONBOARDING_COMPLETE_FAILED", error instanceof Error ? error.message : String(error)),
		);
	}
});

app.post("/api/llm/stream", async (req, res) => {
	const {
		sessionId,
		llmConfig = { providerId: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL, toolTier: "standard" },
		systemPrompt = "",
		userMessage = "",
		appContext,
		currentInteraction,
		currentRenderedScreen,
		contextMemoryMode,
		speedMode: _speedMode,
		googleSearchApiKey,
		googleSearchCx,
	} = req.body || {};
	const workspaceRoot =
		typeof req.body?.styleConfig?.workspaceRoot === "string"
			? req.body.styleConfig.workspaceRoot
			: req.body?.workspaceRoot || DEFAULT_WORKSPACE_ROOT;

	const resolvedLlm = normalizeLlmConfig(llmConfig);
	if (resolvedLlm.error) {
		sendApiError(res, resolvedLlm.error);
		return;
	}
	const normalizedLlmConfig = resolvedLlm.value;
	const model = resolvedLlm.model || resolveModel(normalizedLlmConfig.providerId, normalizedLlmConfig.modelId);
	const apiKey = resolveApiKey(sessionId, model.provider);
		if (!apiKey) {
		const missingKeyHint =
			model.provider === "openai-codex"
				? "Authenticate with Codex (so ~/.codex/auth.json has tokens.access_token), or save a Codex token in Settings -> Provider Credentials."
				: "Save a provider API key in Settings -> Provider Credentials.";
		sendApiError(
			res,
			createApiError(400, "MISSING_API_KEY", `No API key configured for provider '${model.provider}'.`, {
				providerId: model.provider,
				hint: missingKeyHint,
			}),
		);
			return;
		}

		let validatedWorkspaceRoot = workspaceRoot;
		try {
			validatedWorkspaceRoot = await resolveAndEnsureWorkspaceRoot(workspaceRoot);
		} catch (error) {
			if (error instanceof WorkspacePolicyError) {
				sendApiError(res, createApiError(400, error.code || "WORKSPACE_POLICY_ERROR", error.message, error.details));
				return;
			}
			throw error;
		}

		res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const controller = new AbortController();
	const abortStream = () => controller.abort();
	req.on("aborted", abortStream);
	res.on("close", () => {
		if (!res.writableEnded) abortStream();
	});

	const normalizedMode = normalizeContextMemoryMode(contextMemoryMode);
		let onboardingState = await startOnboardingRun(validatedWorkspaceRoot);
		if (!onboardingState.completed) {
			onboardingState = (
				await syncOnboardingStateWithRuntimeConfig({
					workspaceRoot: validatedWorkspaceRoot,
					state: onboardingState,
					sessionId,
					requestedLlmConfig: normalizedLlmConfig,
				})
			).state;
		}
		const onboardingMode = !onboardingState.completed;
	let normalizedAppContext = normalizeAppContext(appContext || currentInteraction?.appContext);
	if (onboardingMode && normalizedAppContext !== ONBOARDING_APP_CONTEXT) {
		normalizedAppContext = ONBOARDING_APP_CONTEXT;
	}
	const normalizedInteraction = currentInteraction
		? normalizeInteractionPayload(currentInteraction, normalizedAppContext)
		: buildFallbackInteraction(normalizedAppContext, userMessage);
	const seedRenderedScreen = normalizeCurrentRenderedScreenSeed(currentRenderedScreen, normalizedAppContext);
	const filesystemSkillsContext = await buildFilesystemSkillsContext(validatedWorkspaceRoot);
	const memoryBootstrapPrompt = await buildMemoryBootstrapContext({
		workspaceRoot: validatedWorkspaceRoot,
		appContext: normalizedAppContext,
	});
	const onboardingPrompt = buildOnboardingPolicyPrompt(onboardingState);
	const runtimePromptSegments = [onboardingPrompt, filesystemSkillsContext.prompt, memoryBootstrapPrompt].filter(Boolean);

	const onboardingHandlers = {
		getState: async ({ workspaceRoot: currentWorkspaceRoot }) => {
			const resolvedRoot = currentWorkspaceRoot || onboardingState.workspaceRoot;
			onboardingState = await loadOnboardingState(resolvedRoot);
			if (!onboardingState.completed) {
				onboardingState = (
					await syncOnboardingStateWithRuntimeConfig({
						workspaceRoot: resolvedRoot,
						state: onboardingState,
						sessionId,
						requestedLlmConfig: normalizedLlmConfig,
					})
				).state;
			}
			return onboardingState;
		},
		setWorkspaceRoot: async ({ workspaceRoot: nextWorkspaceRoot, currentWorkspaceRoot }) => {
			const resolvedRoot = await resolveAndEnsureWorkspaceRoot(nextWorkspaceRoot);
			onboardingState = await setOnboardingWorkspaceRoot(currentWorkspaceRoot, resolvedRoot);
			onboardingState = await setOnboardingCheckpoint(resolvedRoot, "workspace_ready", true);
			if (!onboardingState.completed) {
				onboardingState = (
					await syncOnboardingStateWithRuntimeConfig({
						workspaceRoot: resolvedRoot,
						state: onboardingState,
						sessionId,
						requestedLlmConfig: normalizedLlmConfig,
					})
				).state;
			}
			await appendOnboardingEvent(resolvedRoot, {
				event: "workspace_root_updated",
				runId: onboardingState.runId,
				lifecycle: onboardingState.lifecycle,
				checkpoint: "workspace_ready",
				details: { workspaceRoot: resolvedRoot },
			});
			return { workspaceRoot: resolvedRoot, state: onboardingState };
		},
		saveProviderKey: async ({ providerId, apiKey, workspaceRoot: currentWorkspaceRoot }) => {
			const normalizedProvider = typeof providerId === "string" ? providerId.trim() : "";
			if (!normalizedProvider || !apiKey) {
				throw new Error("save_provider_key requires providerId and apiKey.");
			}
			const providers = listProviders();
			if (!providers.includes(normalizedProvider)) {
				throw new Error(`Provider '${normalizedProvider}' is not supported.`);
			}
			if (!sessionId) {
				throw new Error("save_provider_key requires a valid sessionId.");
			}
			const store = getSessionStore(sessionId);
			store[normalizedProvider] = String(apiKey).trim();
			const synchronized = await syncOnboardingStateWithRuntimeConfig({
				workspaceRoot: currentWorkspaceRoot,
				state: onboardingState,
				sessionId,
				requestedLlmConfig: {
					providerId: normalizedProvider,
					modelId: onboardingState.modelId,
					toolTier: onboardingState.toolTier,
				},
			});
			onboardingState = synchronized.state;
			await appendOnboardingEvent(currentWorkspaceRoot, {
				event: "provider_key_saved",
				runId: onboardingState.runId,
				lifecycle: onboardingState.lifecycle,
				checkpoint: "provider_ready",
				details: {
					providerId: normalizedProvider,
					providerReady: synchronized.providerReady,
				},
			});
			return { providerId: normalizedProvider, state: onboardingState };
		},
		setModelPreferences: async ({ providerId, modelId, toolTier, workspaceRoot: currentWorkspaceRoot }) => {
			const resolved = normalizeLlmConfig({
				providerId,
				modelId,
				toolTier: toolTier || onboardingState.toolTier,
			});
			if (resolved.error) {
				throw new Error(resolved.error.message || "Invalid model preferences.");
			}
			const synchronized = await syncOnboardingStateWithRuntimeConfig({
				workspaceRoot: currentWorkspaceRoot,
				state: onboardingState,
				sessionId,
				requestedLlmConfig: resolved.value,
			});
			onboardingState = synchronized.state;
			await appendOnboardingEvent(currentWorkspaceRoot, {
				event: "model_preferences_saved",
				runId: onboardingState.runId,
				lifecycle: onboardingState.lifecycle,
				checkpoint: "model_ready",
				details: {
					...resolved.value,
					providerReady: synchronized.providerReady,
					modelReady: synchronized.modelReady,
				},
			});
			return { llmConfig: resolved.value, state: onboardingState };
		},
			onMemoryFileWritten: async ({ workspaceRoot: currentWorkspaceRoot, path: relativePath, mode }) => {
				if (onboardingState?.checkpoints?.memory_seeded) {
					return { checkpointUpdated: false };
				}
				onboardingState = await setOnboardingCheckpoint(currentWorkspaceRoot, "memory_seeded", true);
				await appendOnboardingEvent(currentWorkspaceRoot, {
					event: "memory_seeded",
					runId: onboardingState.runId,
					lifecycle: onboardingState.lifecycle,
					checkpoint: "memory_seeded",
					details: {
						path: relativePath || "",
						mode: mode || "",
					},
				});
				return { checkpointUpdated: true };
			},
		complete: async ({ workspaceRoot: currentWorkspaceRoot, summary }) => {
			if (summary) {
				await appendMemoryNote({
					workspaceRoot: currentWorkspaceRoot,
					note: `Onboarding completion summary:\\n${summary}`,
					tags: ["onboarding", "completion"],
				});
			}
			onboardingState = await completeOnboarding(currentWorkspaceRoot);
			await appendOnboardingEvent(currentWorkspaceRoot, {
				event: "onboarding_completed",
				runId: onboardingState.runId,
				lifecycle: onboardingState.lifecycle,
				checkpoint: "completed",
				details: { via: "tool", summaryProvided: Boolean(summary) },
			});
			return { state: onboardingState };
		},
	};

	let laneKey = null;
	let lane = null;
	if (normalizedMode === "compacted") {
		const laneContext = getContextLane(sessionId, normalizedAppContext);
		laneKey = laneContext.key;
		lane = laneContext.lane;
	}

	const maxAttempts = 2;
	let didOverflowRetry = false;
	let didMissingEmitScreenRetry = false;
	let emitScreenRetryHint = "";

	try {
			for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
				const effectiveUserMessage = emitScreenRetryHint
					? `${userMessage}\n\n${emitScreenRetryHint}`
					: userMessage;
				let resolvedUserMessage = effectiveUserMessage;
				if (normalizedMode === "compacted" && lane && laneKey) {
					const preflightMessage = buildCompactedUserMessage({
						lane,
						appContext: normalizedAppContext,
						currentInteraction: normalizedInteraction,
						userMessage: effectiveUserMessage,
					});
					await maybeCompactBeforeRequest({
						laneKey,
						lane,
						model,
						apiKey,
						systemPrompt: [systemPrompt, ...runtimePromptSegments].filter(Boolean).join("\n\n"),
						incomingUserMessage: preflightMessage,
						workspaceRoot: validatedWorkspaceRoot,
					});
					resolvedUserMessage = buildCompactedUserMessage({
						lane,
						appContext: normalizedAppContext,
						currentInteraction: normalizedInteraction,
						userMessage: effectiveUserMessage,
					});
				}

				const streamResult = await runStreamWithToolLoop({
					res,
					model,
					apiKey,
					systemPrompt,
					extraPromptSegments: runtimePromptSegments,
					userMessage: resolvedUserMessage,
					normalizedLlmConfig,
					appContext: normalizedAppContext,
					workspaceRoot: validatedWorkspaceRoot,
					onboardingMode,
					onboardingHandlers,
					googleSearchApiKey,
					googleSearchCx,
					sessionId,
					interaction: normalizedInteraction,
					seedRenderedScreen,
					uiHistoryRuntime,
					signal: controller.signal,
				});

			const finalMessage = streamResult.finalMessage;
			if (!finalMessage) {
				writeChunk(res, { type: "error", error: "Model stream ended unexpectedly." });
				res.end();
				return;
			}

			const contextWindow = Number(model?.contextWindow || 0);
			const overflowDetected = isContextOverflow(finalMessage, contextWindow > 0 ? contextWindow : undefined);
			if (overflowDetected) {
				const canRetry =
					normalizedMode === "compacted" &&
					!didOverflowRetry &&
					streamResult.emittedTextChunks === 0 &&
					Boolean(lane && laneKey);

				if (canRetry) {
					const compacted = await runLaneCompaction({
						laneKey,
						lane,
						model,
						apiKey,
						reason: "overflow_retry",
						workspaceRoot: validatedWorkspaceRoot,
					});
					didOverflowRetry = true;
					if (compacted) continue;
				}

				writeChunk(res, {
					type: "error",
					error: "Context window exceeded during generation. Memory compaction was queued for the next turn.",
				});
				if (normalizedMode === "compacted" && lane && laneKey) {
					queueBackgroundCompaction({
						laneKey,
						lane,
						model,
						apiKey,
						workspaceRoot: validatedWorkspaceRoot,
					});
				}
				res.end();
				return;
			}

				if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
					writeChunk(res, {
						type: "error",
						error: normalizeProviderRuntimeError(finalMessage.errorMessage || "Model stream error.", model.provider),
					});
					res.end();
					return;
				}

					if (shouldRequireEmitScreen(normalizedAppContext) && streamResult.renderOutputCount === 0) {
						if (!didMissingEmitScreenRetry && attempt + 1 < maxAttempts) {
							didMissingEmitScreenRetry = true;
							emitScreenRetryHint =
								"System retry instruction: previous attempt ended without calling emit_screen. You MUST call emit_screen with complete window content HTML before finishing this turn.";
							writeChunk(res, {
								type: "thought",
								text: "[System] Retrying turn because emit_screen was not called.",
							});
							continue;
						}
						writeChunk(res, {
							type: "error",
							error:
							"No render output was emitted. Use the emit_screen tool to publish window HTML before finishing the turn.",
					});
					res.end();
					return;
				}

				if (normalizedMode === "compacted" && lane && laneKey) {
					let assistantStateSummary;
				try {
					assistantStateSummary = await generateTurnStateSummary({
						model,
						apiKey,
						interaction: normalizedInteraction,
						assistantOutputText: streamResult.assistantOutputText,
						laneSummary: lane.summary,
					});
				} catch (error) {
					console.warn("[ContextMemory] turn summary fallback", {
						laneKey,
						error: error instanceof Error ? error.message : String(error),
					});
					assistantStateSummary = buildDeterministicStateSummary(
						normalizedInteraction,
						streamResult.assistantOutputText,
					);
				}

				const turn = {
					turnId: createTurnId(),
					timestamp: Date.now(),
					appContext: normalizedAppContext,
					interaction: normalizedInteraction,
					userPrompt: resolvedUserMessage,
					assistantStateSummary: normalizeTurnStateSummary(
						assistantStateSummary,
						normalizedInteraction,
						streamResult.assistantOutputText,
					),
					usage: normalizeUsageSnapshot(finalMessage.usage),
					estimatedTokens: 0,
				};
				turn.estimatedTokens = estimateTurnTokens(turn);
				lane.recentTurns.push(turn);

				const estimate = estimateLaneContextTokens(lane);
				const threshold = contextWindow > 0 ? contextWindow - COMPACTION_SETTINGS.reserveTokens : 0;
				lane.lastEstimate = {
					tokens: estimate.tokens,
					contextWindow,
					threshold,
					estimatedAt: Date.now(),
				};
				console.info("[ContextMemory] estimate", {
					laneKey,
					contextTokensEstimate: estimate.tokens,
					contextWindow,
					threshold,
					compactionTriggered: contextWindow > 0 ? estimate.tokens > threshold : false,
					tokensBefore: estimate.tokens,
					turnsCompacted: 0,
				});

				queueBackgroundCompaction({
					laneKey,
					lane,
					model,
					apiKey,
					workspaceRoot: validatedWorkspaceRoot,
				});
			}

			writeChunk(res, { type: "done" });
			res.end();
			return;
		}

		writeChunk(res, { type: "error", error: "Context overflow retry exhausted." });
		res.end();
	} catch (error) {
		writeChunk(res, {
			type: "error",
			error: normalizeProviderRuntimeError(error instanceof Error ? error.message : String(error), model.provider),
		});
		res.end();
	}
});

app.use((err, _req, res, _next) => {
	console.error("[neural-computer] unhandled server error", err);
	if (res.headersSent) return;
	sendApiError(
		res,
		createApiError(500, "INTERNAL_SERVER_ERROR", "Unexpected server error.", {
			detail: err instanceof Error ? err.message : String(err),
		}),
	);
});

app.listen(PORT, () => {
	console.log(`[neural-computer] server listening on http://localhost:${PORT}`);
});
