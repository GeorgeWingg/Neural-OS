import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceScaffold } from "../services/workspaceBootstrap.mjs";

const tempRoots: string[] = [];

async function makeTempWorkspaceRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neural-computer-workspace-"));
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

describe("workspace bootstrap scaffold", () => {
	it("creates baseline workspace files and a daily memory note", async () => {
		const root = await makeTempWorkspaceRoot();
		const fixedNow = new Date("2026-02-16T12:00:00Z");

		const result = await ensureWorkspaceScaffold(root, { now: fixedNow });

		expect(result.workspaceRoot).toBe(path.resolve(root));
			expect(result.created).toContain("AGENTS.md");
			expect(result.created).toContain("SOUL.md");
			expect(result.created).toContain("USER.md");
			expect(result.created).toContain("TOOLS.md");
			expect(result.created).toContain("IDENTITY.md");
			expect(result.created).toContain("HEARTBEAT.md");
			expect(result.created).toContain("MEMORY.md");
			expect(result.created).toContain("memory/2026-02-16.md");
			expect(result.existing).toHaveLength(0);

			const createdFiles = [
				"AGENTS.md",
				"SOUL.md",
				"USER.md",
				"TOOLS.md",
				"IDENTITY.md",
				"HEARTBEAT.md",
				"MEMORY.md",
				"memory/2026-02-16.md",
			];
		for (const relativePath of createdFiles) {
			const content = await fs.readFile(path.join(root, relativePath), "utf8");
			expect(content.trim().length).toBeGreaterThan(0);
		}
	});

	it("is idempotent and does not overwrite existing file contents", async () => {
		const root = await makeTempWorkspaceRoot();
		const fixedNow = new Date("2026-02-16T12:00:00Z");

		await ensureWorkspaceScaffold(root, { now: fixedNow });
		await fs.writeFile(path.join(root, "SOUL.md"), "custom soul content\n");

		const result = await ensureWorkspaceScaffold(root, { now: fixedNow });

		expect(result.created).toHaveLength(0);
			expect(result.existing).toContain("AGENTS.md");
			expect(result.existing).toContain("SOUL.md");
			expect(result.existing).toContain("USER.md");
			expect(result.existing).toContain("TOOLS.md");
			expect(result.existing).toContain("IDENTITY.md");
			expect(result.existing).toContain("HEARTBEAT.md");
			expect(result.existing).toContain("MEMORY.md");
			expect(result.existing).toContain("memory/2026-02-16.md");

		const soulContent = await fs.readFile(path.join(root, "SOUL.md"), "utf8");
		expect(soulContent).toBe("custom soul content\n");
	});
});
