import { describe, expect, it } from "vitest";
import { buildReadScreenPayload, validateReadScreenArgs } from "../services/readScreenTool.mjs";

describe("read_screen tool helpers", () => {
	it("validateReadScreenArgs defaults to meta and rejects unknown mode", () => {
		const defaultArgs = validateReadScreenArgs({});
		expect(defaultArgs.ok).toBe(true);
		if (!defaultArgs.ok) {
			throw new Error("expected read_screen args to validate");
		}
		expect(defaultArgs.value.mode).toBe("meta");
		expect(defaultArgs.value.recovery).toBe(false);

		const invalid = validateReadScreenArgs({ mode: "full_html" });
		expect(invalid.ok).toBe(false);
		if (invalid.ok) {
			throw new Error("expected read_screen args validation failure");
		}
		expect(invalid.error).toContain("mode");
	});

	it("buildReadScreenPayload meta includes revision, hash, and interaction count", () => {
		const payload = buildReadScreenPayload({
			revision: 3,
			html: `
				<div>
					<button data-interaction-id="save">Save</button>
					<button data-interaction-id="open">Open</button>
				</div>
			`,
			mode: "meta",
			maxChars: 1200,
		});
		expect(payload.meta.revision).toBe(3);
		expect(payload.meta.interactionIdCount).toBe(2);
		expect(typeof payload.meta.hash).toBe("string");
		expect(payload.meta.hash.length).toBeGreaterThan(8);
		expect(payload.snippet).toBeUndefined();
		expect(payload.outline).toBeUndefined();
	});

	it("buildReadScreenPayload outline limits interaction IDs", () => {
		const manyButtons = Array.from({ length: 80 }, (_, index) => {
			return `<button data-interaction-id="action_${index}">Action ${index}</button>`;
		}).join("\n");
		const payload = buildReadScreenPayload({
			revision: 2,
			html: `<section><h1>Tools</h1>${manyButtons}</section>`,
			mode: "outline",
			maxChars: 1000,
		});
		expect(payload.outline).toBeDefined();
		if (!payload.outline) {
			throw new Error("expected outline payload");
		}
		expect(payload.outline.interactionIds.length).toBeLessThanOrEqual(30);
		expect(payload.outline.interactionIds[0]).toBe("action_0");
	});

	it("buildReadScreenPayload snippet clamps maxChars", () => {
		const html = `<div>${"x".repeat(2000)}</div>`;
		const payload = buildReadScreenPayload({
			revision: 1,
			html,
			mode: "snippet",
			maxChars: 120,
		});
		expect(payload.snippet).toBeDefined();
		if (!payload.snippet) {
			throw new Error("expected snippet payload");
		}
		expect(payload.snippet.length).toBeLessThanOrEqual(120);
	});
});
