import fs from "node:fs/promises";
import path from "node:path";

export const ONBOARDING_STATE_VERSION = "1";

export const ONBOARDING_CHECKPOINTS = Object.freeze([
	"workspace_ready",
	"provider_ready",
	"model_ready",
	"memory_seeded",
	"completed",
]);

function nowIso(now = new Date()) {
	return (now instanceof Date ? now : new Date(now)).toISOString();
}

function createEmptyCheckpoints() {
	return {
		workspace_ready: false,
		provider_ready: false,
		model_ready: false,
		memory_seeded: false,
		completed: false,
	};
}

function normalizeToolTier(toolTier) {
	if (toolTier === "none" || toolTier === "standard" || toolTier === "experimental") {
		return toolTier;
	}
	return "standard";
}

function normalizeLifecycle(lifecycle, completed) {
	if (lifecycle === "revisit") return "revisit";
	if (completed) return "completed";
	if (lifecycle === "pending" || lifecycle === "active" || lifecycle === "revisit") {
		return lifecycle;
	}
	return "pending";
}

function normalizeCheckpoints(input, completed, workspaceReady) {
	const output = createEmptyCheckpoints();
	if (input && typeof input === "object") {
		for (const key of ONBOARDING_CHECKPOINTS) {
			if (typeof input[key] === "boolean") output[key] = input[key];
		}
	}
	if (workspaceReady) output.workspace_ready = true;
	if (completed) {
		output.workspace_ready = true;
		output.provider_ready = true;
		output.model_ready = true;
		output.memory_seeded = true;
		output.completed = true;
	}
	return output;
}

function normalizeState(raw, workspaceRoot) {
	const canonicalWorkspaceRoot = path.resolve(String(workspaceRoot || ".").trim() || ".");
	const completed = Boolean(raw?.completed);
	const checkpoints = normalizeCheckpoints(raw?.checkpoints, completed, true);
	return {
		version: ONBOARDING_STATE_VERSION,
		completed,
		lifecycle: normalizeLifecycle(raw?.lifecycle, completed),
		runId: typeof raw?.runId === "string" && raw.runId.trim() ? raw.runId.trim() : "",
		startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : "",
		completedAt: typeof raw?.completedAt === "string" ? raw.completedAt : "",
		reopenedAt: typeof raw?.reopenedAt === "string" ? raw.reopenedAt : "",
		workspaceRoot: canonicalWorkspaceRoot,
		providerConfigured: Boolean(raw?.providerConfigured) || checkpoints.provider_ready,
		providerId: typeof raw?.providerId === "string" ? raw.providerId : "",
		modelId: typeof raw?.modelId === "string" ? raw.modelId : "",
		toolTier: normalizeToolTier(raw?.toolTier),
		checkpoints,
		lastError: typeof raw?.lastError === "string" ? raw.lastError : "",
	};
}

function createDefaultState(workspaceRoot, now = new Date()) {
	const canonicalWorkspaceRoot = path.resolve(String(workspaceRoot || ".").trim() || ".");
	const checkpoints = createEmptyCheckpoints();
	checkpoints.workspace_ready = true;
	return {
		version: ONBOARDING_STATE_VERSION,
		completed: false,
		lifecycle: "pending",
		runId: "",
		startedAt: nowIso(now),
		completedAt: "",
		reopenedAt: "",
		workspaceRoot: canonicalWorkspaceRoot,
		providerConfigured: false,
		providerId: "",
		modelId: "",
		toolTier: "standard",
		checkpoints,
		lastError: "",
	};
}

function createRunId(now = Date.now()) {
	return `onboard_${Number(now).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveOnboardingStatePath(workspaceRoot) {
	const canonicalWorkspaceRoot = path.resolve(String(workspaceRoot || ".").trim() || ".");
	return {
		workspaceRoot: canonicalWorkspaceRoot,
		stateDir: path.join(canonicalWorkspaceRoot, ".neural"),
		statePath: path.join(canonicalWorkspaceRoot, ".neural", "onboarding-state.json"),
	};
}

export async function loadOnboardingState(workspaceRoot) {
	const paths = resolveOnboardingStatePath(workspaceRoot);
	await fs.mkdir(paths.stateDir, { recursive: true });
	try {
		const raw = await fs.readFile(paths.statePath, "utf8");
		const parsed = JSON.parse(raw);
		const normalized = normalizeState(parsed, paths.workspaceRoot);
		await fs.writeFile(paths.statePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
		return normalized;
	} catch (error) {
		if (error && error.code !== "ENOENT") {
			const fallback = createDefaultState(paths.workspaceRoot);
			fallback.lastError = `State read failed: ${error.message || String(error)}`;
			await fs.writeFile(paths.statePath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
			return fallback;
		}
		const initial = createDefaultState(paths.workspaceRoot);
		await fs.writeFile(paths.statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
		return initial;
	}
}

export async function saveOnboardingState(workspaceRoot, nextState) {
	const paths = resolveOnboardingStatePath(workspaceRoot);
	await fs.mkdir(paths.stateDir, { recursive: true });
	const normalized = normalizeState(nextState || {}, paths.workspaceRoot);
	await fs.writeFile(paths.statePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	return normalized;
}

export async function startOnboardingRun(workspaceRoot, options = {}) {
	const now = options.now instanceof Date ? options.now : new Date();
	const state = await loadOnboardingState(workspaceRoot);
	if (state.completed && !options.forceRevisit) {
		return state;
	}
	const nextLifecycle = options.forceRevisit ? "revisit" : "active";
	const next = {
		...state,
		lifecycle: nextLifecycle,
		runId: state.runId || createRunId(now.getTime()),
		startedAt: state.startedAt || nowIso(now),
		reopenedAt: options.forceRevisit ? nowIso(now) : state.reopenedAt,
		lastError: "",
	};
	if (!next.completed) {
		next.checkpoints.workspace_ready = true;
	}
	return saveOnboardingState(state.workspaceRoot, next);
}

export async function reopenOnboarding(workspaceRoot, options = {}) {
	const now = options.now instanceof Date ? options.now : new Date();
	const state = await loadOnboardingState(workspaceRoot);
	const next = {
		...state,
		lifecycle: "revisit",
		runId: createRunId(now.getTime()),
		reopenedAt: nowIso(now),
		lastError: "",
	};
	return saveOnboardingState(state.workspaceRoot, next);
}

export async function setOnboardingCheckpoint(workspaceRoot, checkpoint, value = true) {
	if (!ONBOARDING_CHECKPOINTS.includes(checkpoint)) {
		throw new Error(`Unknown onboarding checkpoint '${checkpoint}'.`);
	}
	const state = await loadOnboardingState(workspaceRoot);
	const next = {
		...state,
		checkpoints: {
			...state.checkpoints,
			[checkpoint]: Boolean(value),
		},
	};
	if (checkpoint === "completed" && value) {
		next.completed = true;
		next.lifecycle = "completed";
		next.completedAt = nowIso();
	}
	return saveOnboardingState(state.workspaceRoot, next);
}

export async function setOnboardingProviderConfiguration(workspaceRoot, payload = {}) {
	const state = await loadOnboardingState(workspaceRoot);
	const providerId = typeof payload.providerId === "string" ? payload.providerId.trim() : "";
	const modelId = typeof payload.modelId === "string" ? payload.modelId.trim() : "";
	const next = {
		...state,
		providerConfigured: payload.providerConfigured === undefined ? state.providerConfigured : Boolean(payload.providerConfigured),
		providerId: providerId || state.providerId,
		modelId: modelId || state.modelId,
		toolTier: normalizeToolTier(payload.toolTier || state.toolTier),
		checkpoints: {
			...state.checkpoints,
			provider_ready: payload.providerConfigured === undefined ? state.checkpoints.provider_ready : Boolean(payload.providerConfigured),
			model_ready: modelId ? true : state.checkpoints.model_ready,
		},
	};
	if (!next.completed && next.lifecycle === "pending") {
		next.lifecycle = "active";
	}
	return saveOnboardingState(state.workspaceRoot, next);
}

export async function setOnboardingWorkspaceRoot(currentWorkspaceRoot, nextWorkspaceRoot) {
	const currentState = await loadOnboardingState(currentWorkspaceRoot);
	const nextPaths = resolveOnboardingStatePath(nextWorkspaceRoot);
	const migrated = {
		...currentState,
		workspaceRoot: nextPaths.workspaceRoot,
		checkpoints: {
			...currentState.checkpoints,
			workspace_ready: true,
		},
		lastError: "",
	};
	await saveOnboardingState(nextPaths.workspaceRoot, migrated);
	return normalizeState(migrated, nextPaths.workspaceRoot);
}

function hasRequiredCompletionCheckpoints(state) {
	return Boolean(
		state?.checkpoints?.workspace_ready &&
			state?.checkpoints?.provider_ready &&
			state?.checkpoints?.model_ready &&
			state?.checkpoints?.memory_seeded,
	);
}

export async function completeOnboarding(workspaceRoot, options = {}) {
	const now = options.now instanceof Date ? options.now : new Date();
	const state = await loadOnboardingState(workspaceRoot);
	if (!hasRequiredCompletionCheckpoints(state)) {
		const missing = ONBOARDING_CHECKPOINTS.filter((checkpoint) => checkpoint !== "completed" && !state.checkpoints[checkpoint]);
		const message = `Cannot complete onboarding. Missing checkpoints: ${missing.join(", ")}.`;
		const failed = {
			...state,
			lastError: message,
		};
		await saveOnboardingState(state.workspaceRoot, failed);
		const error = new Error(message);
		error.code = "ONBOARDING_INCOMPLETE";
		error.details = { missingCheckpoints: missing };
		throw error;
	}

	const next = {
		...state,
		completed: true,
		lifecycle: "completed",
		completedAt: nowIso(now),
		lastError: "",
		checkpoints: {
			...state.checkpoints,
			completed: true,
		},
	};
	return saveOnboardingState(state.workspaceRoot, next);
}
