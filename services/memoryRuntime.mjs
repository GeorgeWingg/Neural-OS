import fs from "node:fs/promises";
import path from "node:path";

const MAX_SEARCH_FILE_CHARS = 120_000;
const DEFAULT_MEMORY_SEARCH_LIMIT = 5;
const CORE_MEMORY_FILES = Object.freeze([
	"AGENTS.md",
	"SOUL.md",
	"USER.md",
	"TOOLS.md",
	"IDENTITY.md",
	"HEARTBEAT.md",
	"MEMORY.md",
]);

function normalizeText(value) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function sanitizeRelativePath(relativePath) {
	const source = normalizeText(relativePath).trim();
	if (!source) return "";
	return source.replace(/\\/g, "/");
}

function dateKey(now = new Date()) {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function ensureInsideWorkspace(candidatePath, workspaceRoot) {
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const canonicalCandidatePath = path.resolve(candidatePath);
	if (
		canonicalCandidatePath !== canonicalWorkspaceRoot &&
		!canonicalCandidatePath.startsWith(`${canonicalWorkspaceRoot}${path.sep}`)
	) {
		throw new Error("Path escapes workspace root.");
	}
	return canonicalCandidatePath;
}

function normalizeWords(query) {
	return normalizeText(query)
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.map((word) => word.trim())
		.filter((word) => word.length >= 2);
}

function scoreContent(content, words) {
	const source = content.toLowerCase();
	let score = 0;
	let firstMatchIndex = -1;
	for (const word of words) {
		let index = source.indexOf(word);
		while (index >= 0) {
			score += 1;
			if (firstMatchIndex < 0 || index < firstMatchIndex) firstMatchIndex = index;
			index = source.indexOf(word, index + word.length);
		}
	}
	return { score, firstMatchIndex };
}

function buildSnippet(content, firstMatchIndex, maxChars = 420) {
	const source = normalizeText(content);
	if (!source) return "";
	if (source.length <= maxChars) return source;
	if (firstMatchIndex < 0) return source.slice(0, maxChars);
	const half = Math.floor(maxChars / 2);
	const start = Math.max(0, firstMatchIndex - half);
	const end = Math.min(source.length, start + maxChars);
	return source.slice(start, end);
}

export async function listMemoryRelativePaths(workspaceRoot) {
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const files = [];

	for (const relativePath of CORE_MEMORY_FILES) {
		const absolutePath = path.join(canonicalWorkspaceRoot, relativePath);
		try {
			// eslint-disable-next-line no-await-in-loop
			await fs.access(absolutePath);
			files.push(relativePath);
		} catch {
			// Ignore missing core file.
		}
	}

	const memoryDir = path.join(canonicalWorkspaceRoot, "memory");
	try {
		const items = await fs.readdir(memoryDir, { withFileTypes: true });
		for (const item of items) {
			if (!item.isFile()) continue;
			if (!item.name.toLowerCase().endsWith(".md")) continue;
			files.push(`memory/${item.name}`);
		}
	} catch {
		// Ignore missing memory directory.
	}

	return files.sort((a, b) => a.localeCompare(b));
}

export async function readMemoryFile({ workspaceRoot, relativePath, offset = 0, limit = 12_000 }) {
	const normalizedRelativePath = sanitizeRelativePath(relativePath);
	if (!normalizedRelativePath) {
		throw new Error("memory_get requires a non-empty relativePath.");
	}
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const target = ensureInsideWorkspace(path.join(canonicalWorkspaceRoot, normalizedRelativePath), canonicalWorkspaceRoot);
	const source = await fs.readFile(target, "utf8");
	const boundedOffset = Math.max(0, Math.min(Number(offset) || 0, source.length));
	const boundedLimit = Math.max(1, Math.min(50_000, Number(limit) || 12_000));
	const end = Math.min(source.length, boundedOffset + boundedLimit);
	return {
		path: normalizedRelativePath,
		content: source.slice(boundedOffset, end),
		offset: boundedOffset,
		end,
		totalChars: source.length,
	};
}

export async function appendMemoryNote({ workspaceRoot, note, tags = [], now = new Date() }) {
	const normalizedNote = normalizeText(note).trim();
	if (!normalizedNote) {
		throw new Error("appendMemoryNote requires non-empty note text.");
	}
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const memoryDir = path.join(canonicalWorkspaceRoot, "memory");
	await fs.mkdir(memoryDir, { recursive: true });
	const dailyFileName = `${dateKey(now)}.md`;
	const target = path.join(memoryDir, dailyFileName);
	const timestamp = now.toISOString();
	const normalizedTags = Array.isArray(tags)
		? tags.map((tag) => normalizeText(tag).trim()).filter(Boolean).slice(0, 12)
		: [];

	const lines = [`## ${timestamp}`];
	if (normalizedTags.length) lines.push(`Tags: ${normalizedTags.join(", ")}`);
	lines.push(normalizedNote);
	lines.push("");
	await fs.appendFile(target, `${lines.join("\n")}\n`, "utf8");

	return {
		path: `memory/${dailyFileName}`,
		charsAppended: lines.join("\n").length + 1,
		timestamp,
	};
}

export async function searchMemory({ workspaceRoot, query, limit = DEFAULT_MEMORY_SEARCH_LIMIT }) {
	const words = normalizeWords(query);
	if (!words.length) {
		return [];
	}
	const files = await listMemoryRelativePaths(workspaceRoot);
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const results = [];
	for (const relativePath of files) {
		const absolutePath = ensureInsideWorkspace(path.join(canonicalWorkspaceRoot, relativePath), canonicalWorkspaceRoot);
		let source = "";
		try {
			// eslint-disable-next-line no-await-in-loop
			source = await fs.readFile(absolutePath, "utf8");
		} catch {
			continue;
		}
		const boundedSource = source.length > MAX_SEARCH_FILE_CHARS ? source.slice(0, MAX_SEARCH_FILE_CHARS) : source;
		const scored = scoreContent(boundedSource, words);
		if (scored.score <= 0) continue;
		results.push({
			path: relativePath,
			score: scored.score,
			snippet: buildSnippet(boundedSource, scored.firstMatchIndex),
		});
	}
	results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return results.slice(0, Math.max(1, Math.min(50, Number(limit) || DEFAULT_MEMORY_SEARCH_LIMIT)));
}

export async function buildMemoryBootstrapContext({
	workspaceRoot,
	appContext,
	maxChars = 4_000,
}) {
	const canonicalWorkspaceRoot = path.resolve(workspaceRoot);
	const chunks = [];

	const safeRead = async (relativePath, label, readLimit) => {
		try {
			const result = await readMemoryFile({
				workspaceRoot: canonicalWorkspaceRoot,
				relativePath,
				offset: 0,
				limit: readLimit,
			});
			if (result.content.trim()) {
				chunks.push(`${label} (${relativePath}):\n${result.content.trim()}`);
			}
		} catch {
			// Ignore missing file.
		}
	};

	await safeRead("AGENTS.md", "Agent Instructions", 1_200);
	await safeRead("SOUL.md", "Soul Guidance", 900);
	await safeRead("USER.md", "User Profile", 900);
	await safeRead("TOOLS.md", "Tool Notes", 700);
	await safeRead("IDENTITY.md", "Identity", 700);
	await safeRead("HEARTBEAT.md", "Heartbeat", 700);
	await safeRead("MEMORY.md", "Durable Memory", 1_700);

	if (!chunks.length) return "";
	const header = [
		"Workspace Memory Context:",
		appContext ? `Current app context: ${appContext}` : "",
	].filter(Boolean);
	const combined = `${header.join("\n")}\n\n${chunks.join("\n\n")}`;
	if (combined.length <= maxChars) return combined;
	return combined.slice(0, maxChars);
}
