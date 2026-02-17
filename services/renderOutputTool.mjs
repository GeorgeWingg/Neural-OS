const DEFAULT_MAX_HTML_CHARS = 240_000;
const DEFAULT_MAX_REVISION_NOTE_CHARS = 200;

function normalizeString(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

export function createRenderOutputState() {
	return {
		renderCount: 0,
		latestHtml: "",
		lastIsFinal: false,
	};
}

export function validateEmitScreenArgs(args, options = {}) {
	const source = args && typeof args === "object" ? args : {};
	const maxHtmlChars = Number.isFinite(options.maxHtmlChars)
		? Math.max(1_000, Math.floor(options.maxHtmlChars))
		: DEFAULT_MAX_HTML_CHARS;
	const maxRevisionNoteChars = Number.isFinite(options.maxRevisionNoteChars)
		? Math.max(32, Math.floor(options.maxRevisionNoteChars))
		: DEFAULT_MAX_REVISION_NOTE_CHARS;

	const html = normalizeString(source.html);
	if (!html.trim()) {
		return { ok: false, error: "emit_screen requires a non-empty html field." };
	}
	if (html.length > maxHtmlChars) {
		return {
			ok: false,
			error: `emit_screen html exceeds max length (${maxHtmlChars} chars).`,
		};
	}

	const appContext = normalizeString(source.appContext).trim();
	const revisionNoteSource = normalizeString(source.revisionNote).trim();
	const revisionNote = revisionNoteSource.slice(0, maxRevisionNoteChars);
	const isFinal = Boolean(source.isFinal);

	return {
		ok: true,
		value: {
			html,
			appContext: appContext || undefined,
			revisionNote: revisionNote || undefined,
			isFinal,
		},
	};
}

export function applyEmitScreen(state, payload, metadata = {}) {
	const previous = state && typeof state === "object" ? state : createRenderOutputState();
	const revision = previous.renderCount + 1;
	const toolName = metadata.toolName || "emit_screen";
	const toolCallId = typeof metadata.toolCallId === "string" ? metadata.toolCallId : undefined;

	const nextState = {
		renderCount: revision,
		latestHtml: payload.html,
		lastIsFinal: Boolean(payload.isFinal),
	};

	const streamEvent = {
		type: "render_output",
		toolName,
		toolCallId,
		revision,
		html: payload.html,
		isFinal: Boolean(payload.isFinal),
		appContext: payload.appContext,
		revisionNote: payload.revisionNote,
	};

	const finalHint = payload.isFinal ? ", final" : "";
	const noteHint = payload.revisionNote ? ` note='${payload.revisionNote}'` : "";
	const toolResultText = `[emit_screen] rendered revision ${revision} (${payload.html.length} chars${finalHint})${noteHint}`;

	return {
		nextState,
		streamEvent,
		toolResultText,
	};
}
