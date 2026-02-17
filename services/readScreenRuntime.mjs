import { buildReadScreenPayload, formatReadScreenToolResult, validateReadScreenArgs } from "./readScreenTool.mjs";

export function createReadScreenUsageState() {
	return {
		readCount: 0,
		recoveryReadUsed: false,
	};
}

export function runReadScreenToolCall({ args, renderOutputState, usageState, appContext }) {
	const nextState =
		usageState && typeof usageState === "object"
			? {
					readCount: Number.isFinite(usageState.readCount) ? Number(usageState.readCount) : 0,
					recoveryReadUsed: Boolean(usageState.recoveryReadUsed),
				}
			: createReadScreenUsageState();

	const revision = Number(renderOutputState?.renderCount || 0);
	const html = typeof renderOutputState?.latestHtml === "string" ? renderOutputState.latestHtml : "";
	if (!revision || !html) {
		return {
			isError: true,
			text: "read_screen is unavailable before first emit_screen revision.",
			nextState,
		};
	}

	const validation = validateReadScreenArgs(args);
	if (!validation.ok) {
		return {
			isError: true,
			text: validation.error || "Invalid read_screen arguments.",
			nextState,
		};
	}

	const shouldUseRecovery = Boolean(validation.value.recovery);
	if (nextState.readCount >= 2) {
		return {
			isError: true,
			text: "read_screen call budget exceeded (max 2 calls per turn).",
			nextState,
		};
	}
	if (nextState.readCount === 1) {
		if (!shouldUseRecovery) {
			return {
				isError: true,
				text: "read_screen second call requires recovery=true.",
				nextState,
			};
		}
		if (nextState.recoveryReadUsed) {
			return {
				isError: true,
				text: "read_screen recovery call already used this turn.",
				nextState,
			};
		}
	}

	const payload = buildReadScreenPayload({
		revision,
		html,
		isFinal: Boolean(renderOutputState.lastIsFinal),
		appContext,
		mode: validation.value.mode,
		maxChars: validation.value.maxChars,
	});

	nextState.readCount += 1;
	if (shouldUseRecovery) {
		nextState.recoveryReadUsed = true;
	}

	return {
		isError: false,
		text: formatReadScreenToolResult(payload),
		nextState,
	};
}
