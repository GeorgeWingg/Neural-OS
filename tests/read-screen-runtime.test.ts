import { describe, expect, it } from "vitest";
import { createReadScreenUsageState, runReadScreenToolCall } from "../services/readScreenRuntime.mjs";

describe("read_screen runtime policy", () => {
	const renderOutputState = {
		renderCount: 2,
		latestHtml: `
			<section>
				<h2>Dashboard</h2>
				<button data-interaction-id="refresh">Refresh</button>
			</section>
		`,
		lastIsFinal: false,
	};

	it("returns an error when no render output exists", () => {
		const result = runReadScreenToolCall({
			args: { mode: "meta" },
			renderOutputState: { renderCount: 0, latestHtml: "", lastIsFinal: false },
			usageState: createReadScreenUsageState(),
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("before first emit_screen");
	});

	it("allows one default read per turn", () => {
		const result = runReadScreenToolCall({
			args: { mode: "meta" },
			renderOutputState,
			usageState: createReadScreenUsageState(),
		});
		expect(result.isError).toBe(false);
		expect(result.nextState.readCount).toBe(1);
		expect(result.text).toContain("[read_screen]");
	});

	it("requires recovery=true for the second read", () => {
		let usageState = createReadScreenUsageState();
		const first = runReadScreenToolCall({
			args: { mode: "meta" },
			renderOutputState,
			usageState,
		});
		expect(first.isError).toBe(false);
		usageState = first.nextState;

		const second = runReadScreenToolCall({
			args: { mode: "outline" },
			renderOutputState,
			usageState,
		});
		expect(second.isError).toBe(true);
		expect(second.text).toContain("recovery=true");
	});

	it("blocks a third read call in the same turn", () => {
		let usageState = createReadScreenUsageState();
		const first = runReadScreenToolCall({
			args: { mode: "meta" },
			renderOutputState,
			usageState,
		});
		expect(first.isError).toBe(false);
		usageState = first.nextState;

		const second = runReadScreenToolCall({
			args: { mode: "outline", recovery: true },
			renderOutputState,
			usageState,
		});
		expect(second.isError).toBe(false);
		usageState = second.nextState;

		const third = runReadScreenToolCall({
			args: { mode: "snippet", recovery: true },
			renderOutputState,
			usageState,
		});
		expect(third.isError).toBe(true);
		expect(third.text).toContain("budget exceeded");
	});

	it("does not mutate emit_screen revision state", () => {
		const state = {
			renderCount: renderOutputState.renderCount,
			latestHtml: renderOutputState.latestHtml,
			lastIsFinal: renderOutputState.lastIsFinal,
		};
		const before = JSON.stringify(state);
		const result = runReadScreenToolCall({
			args: { mode: "snippet", maxChars: 100 },
			renderOutputState: state,
			usageState: createReadScreenUsageState(),
		});
		expect(result.isError).toBe(false);
		expect(JSON.stringify(state)).toBe(before);
		expect(state.renderCount).toBe(2);
	});
});
