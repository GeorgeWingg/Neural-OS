const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9]{20,}\b/,
	/\bAIza[0-9A-Za-z\-_]{20,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
	/\b(?:api[_-]?key|access[_-]?token|secret|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i,
];

function normalizeText(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function hasHighEntropyToken(source) {
	const text = normalizeText(source);
	const tokenMatches = text.match(/[A-Za-z0-9_\-]{32,}/g) || [];
	for (const token of tokenMatches) {
		const uniqueChars = new Set(token.split(""));
		if (uniqueChars.size >= 18) {
			return true;
		}
	}
	return false;
}

export function looksSensitiveSecret(value) {
	const text = normalizeText(value);
	if (!text) return false;
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(text)) return true;
	}
	return hasHighEntropyToken(text);
}
