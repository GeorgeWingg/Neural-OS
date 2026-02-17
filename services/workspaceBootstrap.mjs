import fs from "node:fs/promises";
import path from "node:path";

const BASE_FILES = Object.freeze([
	{
		relativePath: "AGENTS.md",
		content: [
			"# Agent Workspace",
			"",
			"This directory stores long-lived agent behavior and memory artifacts.",
			"Edit these files carefully; they are read by the runtime.",
			"",
		].join("\n"),
	},
	{
		relativePath: "SOUL.md",
		content: [
			"# Soul",
			"",
			"Describe preferred collaboration style, tone, and high-level operating principles.",
			"",
		].join("\n"),
	},
	{
		relativePath: "USER.md",
		content: [
			"# User",
			"",
			"Capture stable user profile notes, preferences, and recurring constraints.",
			"",
		].join("\n"),
	},
	{
		relativePath: "TOOLS.md",
		content: [
			"# Tools",
			"",
			"Document local environment setup notes, installed CLIs, and tool quirks.",
			"",
		].join("\n"),
	},
	{
		relativePath: "IDENTITY.md",
		content: [
			"# Identity",
			"",
			"Record agent identity, role boundaries, and operating commitments.",
			"",
		].join("\n"),
	},
	{
		relativePath: "HEARTBEAT.md",
		content: [
			"# Heartbeat",
			"",
			"Maintain startup and periodic operational checklist items.",
			"",
		].join("\n"),
	},
	{
		relativePath: "MEMORY.md",
		content: [
			"# Memory",
			"",
			"Store durable user preferences, constraints, and recurring workflows.",
			"",
		].join("\n"),
	},
]);

function formatDateForFileName(now = new Date()) {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function buildDailyMemoryContent(dateString) {
	return [`# ${dateString}`, "", "Daily durable memory notes.", ""].join("\n");
}

async function ensureFileOnce(targetPath, content) {
	try {
		await fs.writeFile(targetPath, content, { flag: "wx" });
		return true;
	} catch (error) {
		if (error && error.code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

export async function resolveDefaultWorkspaceRoot() {
	return path.resolve(process.cwd(), "workspace");
}

export async function ensureWorkspaceScaffold(workspaceRoot, options = {}) {
	const now = options.now instanceof Date ? options.now : new Date();
	const canonicalWorkspaceRoot = path.resolve(String(workspaceRoot || "").trim() || ".");
	const created = [];
	const existing = [];

	await fs.mkdir(canonicalWorkspaceRoot, { recursive: true });
	await fs.mkdir(path.join(canonicalWorkspaceRoot, "memory"), { recursive: true });

	for (const file of BASE_FILES) {
		const targetPath = path.join(canonicalWorkspaceRoot, file.relativePath);
		const didCreate = await ensureFileOnce(targetPath, file.content);
		if (didCreate) created.push(file.relativePath);
		else existing.push(file.relativePath);
	}

	const dailyFileName = `${formatDateForFileName(now)}.md`;
	const dailyRelativePath = path.posix.join("memory", dailyFileName);
	const dailyTargetPath = path.join(canonicalWorkspaceRoot, "memory", dailyFileName);
	const didCreateDaily = await ensureFileOnce(dailyTargetPath, buildDailyMemoryContent(formatDateForFileName(now)));
	if (didCreateDaily) created.push(dailyRelativePath);
	else existing.push(dailyRelativePath);

	return {
		workspaceRoot: canonicalWorkspaceRoot,
		created,
		existing,
	};
}
