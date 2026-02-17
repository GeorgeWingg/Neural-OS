import crypto from "node:crypto";

const READ_SCREEN_MODES = new Set(["meta", "outline", "snippet"]);
const DEFAULT_SNIPPET_MAX_CHARS = 1200;
const MAX_SNIPPET_MAX_CHARS = 4000;
const OUTLINE_MAX_INTERACTION_IDS = 30;
const OUTLINE_MAX_HEADINGS = 12;
const OUTLINE_MAX_CONTROLS = 20;

function normalizeText(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function clampInt(value, { min, max, fallback }) {
	let next = Number(value);
	if (!Number.isFinite(next)) next = fallback;
	next = Math.floor(next);
	if (Number.isFinite(min)) next = Math.max(min, next);
	if (Number.isFinite(max)) next = Math.min(max, next);
	return next;
}

function stripHtmlTags(input) {
	return normalizeText(input)
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractInteractionIds(html) {
	const source = normalizeText(html);
	const regex = /data-interaction-id\s*=\s*["']([^"']+)["']/gi;
	const ids = [];
	const seen = new Set();
	let match = null;
	while ((match = regex.exec(source)) !== null) {
		const value = normalizeText(match[1]).trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		ids.push(value);
	}
	return ids;
}

function extractHeadings(html) {
	const source = normalizeText(html);
	const regex = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
	const headings = [];
	let match = null;
	while ((match = regex.exec(source)) !== null) {
		const text = stripHtmlTags(match[2]);
		if (!text) continue;
		headings.push(text);
	}
	return headings;
}

function extractControls(html) {
	const source = normalizeText(html);
	const regex = /<(button|input|select|textarea|a)\b([^>]*)>/gi;
	const controls = [];
	let match = null;
	while ((match = regex.exec(source)) !== null) {
		const tagName = normalizeText(match[1]).toLowerCase();
		const attrs = normalizeText(match[2]);
		const idMatch = attrs.match(/\sid\s*=\s*["']([^"']+)["']/i);
		const nameMatch = attrs.match(/\sname\s*=\s*["']([^"']+)["']/i);
		const typeMatch = attrs.match(/\stype\s*=\s*["']([^"']+)["']/i);
		const labelMatch = attrs.match(/\saria-label\s*=\s*["']([^"']+)["']/i);
		const parts = [tagName];
		if (idMatch?.[1]) parts.push(`#${idMatch[1]}`);
		if (nameMatch?.[1]) parts.push(`name=${nameMatch[1]}`);
		if (typeMatch?.[1]) parts.push(`type=${typeMatch[1]}`);
		if (labelMatch?.[1]) parts.push(`label=${labelMatch[1]}`);
		controls.push(parts.join(" "));
	}
	return controls;
}

function createHtmlHash(html) {
	return crypto.createHash("sha256").update(normalizeText(html), "utf8").digest("hex").slice(0, 16);
}

export function validateReadScreenArgs(args) {
	const source = args && typeof args === "object" ? args : {};
	const rawMode = normalizeText(source.mode).trim().toLowerCase();
	const mode = rawMode || "meta";
	if (!READ_SCREEN_MODES.has(mode)) {
		return {
			ok: false,
			error: `read_screen mode must be one of: ${Array.from(READ_SCREEN_MODES).join(", ")}.`,
		};
	}
	const maxChars = clampInt(source.maxChars, {
		min: 1,
		max: MAX_SNIPPET_MAX_CHARS,
		fallback: DEFAULT_SNIPPET_MAX_CHARS,
	});
	return {
		ok: true,
		value: {
			mode,
			maxChars,
			recovery: Boolean(source.recovery),
		},
	};
}

export function buildReadScreenPayload(input) {
	const source = input && typeof input === "object" ? input : {};
	const html = normalizeText(source.html);
	const mode = READ_SCREEN_MODES.has(source.mode) ? source.mode : "meta";
	const interactionIds = extractInteractionIds(html);
	const meta = {
		revision: Number.isFinite(source.revision) ? Number(source.revision) : 0,
		htmlChars: html.length,
		interactionIdCount: interactionIds.length,
		isFinal: Boolean(source.isFinal),
		hash: createHtmlHash(html),
		appContext: normalizeText(source.appContext).trim() || undefined,
	};

	const payload = { meta };
	if (mode === "outline") {
		payload.outline = {
			interactionIds: interactionIds.slice(0, OUTLINE_MAX_INTERACTION_IDS),
			headings: extractHeadings(html).slice(0, OUTLINE_MAX_HEADINGS),
			controls: extractControls(html).slice(0, OUTLINE_MAX_CONTROLS),
		};
	}
	if (mode === "snippet") {
		const maxChars = clampInt(source.maxChars, {
			min: 1,
			max: MAX_SNIPPET_MAX_CHARS,
			fallback: DEFAULT_SNIPPET_MAX_CHARS,
		});
		payload.snippet = html.slice(0, maxChars);
	}
	return payload;
}

export function formatReadScreenToolResult(payload) {
	return `[read_screen] ${JSON.stringify(payload || {}, null, 2)}`;
}
