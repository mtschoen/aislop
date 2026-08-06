import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { terminalLink } from "../../src/ui/link.js";

describe("terminalLink", () => {
	let originalIsTTY: boolean | undefined;
	let originalTerm: string | undefined;

	beforeEach(() => {
		originalIsTTY = process.stdout.isTTY as boolean | undefined;
		originalTerm = process.env.TERM;
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, "isTTY", {
			configurable: true,
			value: originalIsTTY,
		});
		process.env.TERM = originalTerm;
	});

	it("returns plain label when output is not a tty", () => {
		Object.defineProperty(process.stdout, "isTTY", {
			configurable: true,
			value: false,
		});
		process.env.TERM = "";

		expect(terminalLink("https://example.com", "Example")).toBe("Example");
	});

	it("returns OSC link when output is a tty", () => {
		Object.defineProperty(process.stdout, "isTTY", {
			configurable: true,
			value: true,
		});
		process.env.TERM = "xterm-256color";
		expect(terminalLink("https://example.com", "Example")).toContain("https://example.com");
		expect(terminalLink("https://example.com", "Example")).toContain("Example");
	});
});
