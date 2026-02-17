import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolDefinitions, createWorkspaceToolRuntime, executeToolCall } from "../services/piToolRuntime.mjs";
import { createWorkspacePolicy } from "../services/workspaceSandbox.mjs";

const tempRoots: string[] = [];

async function makeTempWorkspaceRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neural-computer-pitool-"));
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

function createRuntimeConfig(root: string) {
	const workspacePolicy = createWorkspacePolicy({
		defaultWorkspaceRoot: root,
		allowedRoots: [root],
	});
	return createWorkspaceToolRuntime({ workspacePolicy });
}

describe("pi tool runtime onboarding policy", () => {
	it("returns onboarding-only tool definitions when onboarding is required", () => {
		const tools = buildToolDefinitions("standard", { onboardingRequired: true });
		const toolNames = tools.map((tool) => tool.name);
		expect(toolNames).toEqual([
			"emit_screen",
			"onboarding_get_state",
			"onboarding_set_workspace_root",
			"save_provider_key",
			"onboarding_set_model_preferences",
			"memory_append",
			"onboarding_complete",
		]);
	});

	it("blocks generic tools while onboarding is required", async () => {
		const root = await makeTempWorkspaceRoot();
		const result = await executeToolCall(
			{
				name: "read",
				arguments: { path: "README.md" },
			},
			{
				runtimeConfig: createRuntimeConfig(root),
				workspaceRoot: root,
				onboardingMode: true,
				onboardingHandlers: {},
			},
		);
		expect(result.isError).toBe(true);
		expect(String(result.text)).toContain("blocked during required onboarding");
	});

	it("delegates save_provider_key to onboarding handler", async () => {
		const root = await makeTempWorkspaceRoot();
		const result = await executeToolCall(
			{
				name: "save_provider_key",
				arguments: { providerId: "google", apiKey: "test-key" },
			},
			{
				runtimeConfig: createRuntimeConfig(root),
				workspaceRoot: root,
				onboardingMode: true,
				onboardingHandlers: {
					saveProviderKey: async ({ providerId }) => ({ ok: true, providerId }),
				},
			},
		);
		expect(result.isError).toBe(false);
		expect(String(result.text)).toContain("save_provider_key");
	});

	it("blocks secret-like content in generic write", async () => {
		const root = await makeTempWorkspaceRoot();
		const result = await executeToolCall(
			{
				name: "write",
				arguments: {
					path: "notes.txt",
					content: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
				},
			},
			{
				runtimeConfig: createRuntimeConfig(root),
				workspaceRoot: root,
				onboardingMode: false,
				onboardingHandlers: {},
			},
		);
		expect(result.isError).toBe(true);
		expect(String(result.text)).toContain("save_provider_key");
	});
});
