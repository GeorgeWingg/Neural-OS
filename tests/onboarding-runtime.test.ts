import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	completeOnboarding,
	loadOnboardingState,
	reopenOnboarding,
	setOnboardingCheckpoint,
	setOnboardingProviderConfiguration,
	setOnboardingWorkspaceRoot,
	startOnboardingRun,
} from "../services/onboardingRuntime.mjs";

const tempRoots: string[] = [];

async function makeTempWorkspaceRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neural-computer-onboarding-"));
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

describe("onboarding runtime", () => {
	it("creates initial onboarding state on first load", async () => {
		const workspaceRoot = await makeTempWorkspaceRoot();
		const state = await loadOnboardingState(workspaceRoot);

		expect(state.completed).toBe(false);
		expect(state.lifecycle).toBe("pending");
		expect(state.workspaceRoot).toBe(path.resolve(workspaceRoot));
		expect(state.checkpoints.workspace_ready).toBe(true);
	});

	it("requires deterministic completion checkpoints before completion", async () => {
		const workspaceRoot = await makeTempWorkspaceRoot();
		await startOnboardingRun(workspaceRoot);

		await expect(completeOnboarding(workspaceRoot)).rejects.toThrow(/Missing checkpoints/);

		await setOnboardingCheckpoint(workspaceRoot, "memory_seeded", true);
		await expect(completeOnboarding(workspaceRoot)).rejects.toThrow(/Missing checkpoints/);

		await setOnboardingProviderConfiguration(workspaceRoot, {
			providerConfigured: true,
			providerReady: true,
			providerId: "google",
			modelId: "gemini-3-flash-preview",
			modelReady: true,
			toolTier: "standard",
		});
		const completed = await completeOnboarding(workspaceRoot);
		expect(completed.completed).toBe(true);
		expect(completed.lifecycle).toBe("completed");
		expect(completed.checkpoints.completed).toBe(true);
		expect(completed.checkpoints.provider_ready).toBe(true);
		expect(completed.checkpoints.model_ready).toBe(true);
	});

	it("migrates onboarding state when workspace root changes", async () => {
		const workspaceRoot = await makeTempWorkspaceRoot();
		const nextWorkspaceRoot = await makeTempWorkspaceRoot();
		const started = await startOnboardingRun(workspaceRoot);
		const migrated = await setOnboardingWorkspaceRoot(workspaceRoot, nextWorkspaceRoot);
		expect(migrated.workspaceRoot).toBe(path.resolve(nextWorkspaceRoot));
		expect(migrated.runId).toBe(started.runId);
		expect(migrated.checkpoints.workspace_ready).toBe(true);
	});

	it("reopen keeps completion history and switches lifecycle", async () => {
		const workspaceRoot = await makeTempWorkspaceRoot();
		await setOnboardingCheckpoint(workspaceRoot, "memory_seeded", true);
		await setOnboardingProviderConfiguration(workspaceRoot, {
			providerConfigured: true,
			providerReady: true,
			providerId: "google",
			modelId: "gemini-3-flash-preview",
			modelReady: true,
			toolTier: "standard",
		});
		await completeOnboarding(workspaceRoot);
		const reopened = await reopenOnboarding(workspaceRoot);
		expect(reopened.completed).toBe(true);
		expect(reopened.lifecycle).toBe("revisit");
		expect(Boolean(reopened.reopenedAt)).toBe(true);
	});

	it("produces deterministic checkpoint state for the same action sequence", async () => {
		const rootA = await makeTempWorkspaceRoot();
		const rootB = await makeTempWorkspaceRoot();

		const runSequence = async (workspaceRoot: string) => {
			await startOnboardingRun(workspaceRoot);
			await setOnboardingProviderConfiguration(workspaceRoot, {
				providerConfigured: true,
				providerId: "google",
				modelId: "gemini-3-flash-preview",
				toolTier: "standard",
			});
			await setOnboardingCheckpoint(workspaceRoot, "provider_ready", true);
			await setOnboardingCheckpoint(workspaceRoot, "model_ready", true);
			await setOnboardingCheckpoint(workspaceRoot, "memory_seeded", true);
			const state = await completeOnboarding(workspaceRoot);
			return {
				completed: state.completed,
				lifecycle: state.lifecycle,
				checkpoints: state.checkpoints,
				providerConfigured: state.providerConfigured,
				providerId: state.providerId,
				modelId: state.modelId,
				toolTier: state.toolTier,
			};
		};

		const resultA = await runSequence(rootA);
		const resultB = await runSequence(rootB);
		expect(resultA).toEqual(resultB);
	});
});
