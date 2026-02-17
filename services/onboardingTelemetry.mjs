import fs from "node:fs/promises";
import path from "node:path";

function nowIso(now = new Date()) {
	return (now instanceof Date ? now : new Date(now)).toISOString();
}

function normalizeText(value) {
	if (typeof value === "string") return value.trim();
	if (value === null || value === undefined) return "";
	return String(value).trim();
}

function eventPathForWorkspace(workspaceRoot) {
	const canonicalWorkspaceRoot = path.resolve(String(workspaceRoot || ".").trim() || ".");
	const dir = path.join(canonicalWorkspaceRoot, ".neural");
	return {
		workspaceRoot: canonicalWorkspaceRoot,
		directory: dir,
		path: path.join(dir, "onboarding-events.jsonl"),
	};
}

export async function appendOnboardingEvent(workspaceRoot, event = {}, options = {}) {
	const now = options.now instanceof Date ? options.now : new Date();
	const target = eventPathForWorkspace(workspaceRoot);
	await fs.mkdir(target.directory, { recursive: true });
	const payload = {
		timestamp: nowIso(now),
		event: normalizeText(event.event) || "unknown_event",
		runId: normalizeText(event.runId),
		lifecycle: normalizeText(event.lifecycle),
		checkpoint: normalizeText(event.checkpoint),
		workspaceRoot: target.workspaceRoot,
		details: event.details && typeof event.details === "object" ? event.details : {},
	};
	await fs.appendFile(target.path, `${JSON.stringify(payload)}\n`, "utf8");
	return payload;
}
