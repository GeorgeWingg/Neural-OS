import { describe, expect, it } from "vitest";
import { MANDATORY_OUTPUT_RULES } from "../constants";

describe("read_screen policy alignment", () => {
	it("keeps emit_screen as canonical output channel", () => {
		expect(MANDATORY_OUTPUT_RULES).toContain("emit_screen");
		expect(MANDATORY_OUTPUT_RULES).toContain("canonical output channel");
	});

	it("describes read_screen as optional and bounded", () => {
		expect(MANDATORY_OUTPUT_RULES).toContain("read_screen");
		expect(MANDATORY_OUTPUT_RULES).toContain("optional");
		expect(MANDATORY_OUTPUT_RULES).toContain("lightest mode first");
	});
});
