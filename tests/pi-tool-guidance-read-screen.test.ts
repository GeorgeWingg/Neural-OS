import { describe, expect, it } from "vitest";
import { buildPiToolGuidancePrompt, buildToolDefinitions } from "../services/piToolRuntime.mjs";

describe("pi tool guidance for read_screen", () => {
	it("includes read_screen usage policy when tool present", () => {
		const tools = buildToolDefinitions("standard", { includeGoogleSearch: false });
		const prompt = buildPiToolGuidancePrompt(tools);
		expect(prompt).toContain("read_screen");
		expect(prompt).toContain("Default: do NOT call read_screen");
		expect(prompt).toContain("lightest read mode first");
	});

	it("does not force read_screen every turn", () => {
		const tools = buildToolDefinitions("standard", { includeGoogleSearch: false });
		const prompt = buildPiToolGuidancePrompt(tools);
		expect(prompt).not.toContain("Always call read_screen");
		expect(prompt).not.toContain("must call read_screen on every turn");
	});
});
