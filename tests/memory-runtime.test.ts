import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendMemoryNote,
	buildMemoryBootstrapContext,
	listMemoryRelativePaths,
	readMemoryFile,
	searchMemory,
} from "../services/memoryRuntime.mjs";

const tempRoots = [];

async function makeTempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neural-computer-memory-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0, tempRoots.length).map(async (root) => {
			await fs.rm(root, { recursive: true, force: true });
		}),
	);
});

describe("memory runtime", () => {
	it("appends memory notes into daily markdown files", async () => {
		const workspaceRoot = await makeTempRoot();
		const now = new Date("2026-02-16T10:00:00Z");
		const result = await appendMemoryNote({
			workspaceRoot,
			note: "User prefers concise answers.",
			tags: ["style", "user-preference"],
			now,
		});

		expect(result.path).toBe("memory/2026-02-16.md");
		const content = await fs.readFile(path.join(workspaceRoot, result.path), "utf8");
		expect(content).toContain("User prefers concise answers.");
		expect(content).toContain("style, user-preference");
	});

	it("searches memory files and returns ranked snippets", async () => {
		const workspaceRoot = await makeTempRoot();
		await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "User prefers concise answers and direct output.\n", "utf8");
		await fs.mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
		await fs.writeFile(path.join(workspaceRoot, "memory", "2026-02-16.md"), "Today we discussed onboarding contracts.\n", "utf8");

		const results = await searchMemory({
			workspaceRoot,
			query: "concise output",
			limit: 3,
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].path).toBe("MEMORY.md");
		expect(results[0].snippet.toLowerCase()).toContain("concise");
	});

	it("builds memory bootstrap context from soul and memory files", async () => {
		const workspaceRoot = await makeTempRoot();
		await fs.writeFile(path.join(workspaceRoot, "SOUL.md"), "Always prefer practical, concrete guidance.\n", "utf8");
		await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "User likes model-driven onboarding.\n", "utf8");

		const bootstrap = await buildMemoryBootstrapContext({
			workspaceRoot,
			appContext: "desktop_env",
		});

		expect(bootstrap).toContain("Workspace Memory Context");
		expect(bootstrap).toContain("Soul Guidance");
		expect(bootstrap).toContain("model-driven onboarding");
	});

	it("reads memory file slices with offsets", async () => {
		const workspaceRoot = await makeTempRoot();
		await fs.mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
		await fs.writeFile(path.join(workspaceRoot, "memory", "2026-02-16.md"), "abcdef", "utf8");
		const slice = await readMemoryFile({
			workspaceRoot,
			relativePath: "memory/2026-02-16.md",
			offset: 2,
			limit: 3,
		});
		expect(slice.content).toBe("cde");
		const files = await listMemoryRelativePaths(workspaceRoot);
		expect(files).toEqual(["memory/2026-02-16.md"]);
	});
});
