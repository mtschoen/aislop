import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, EngineResult } from "../src/engines/types.js";

const { logMock } = vi.hoisted(() => ({
	logMock: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../src/ui/logger.js", () => ({ log: logMock }));

const { printEngineStatus } = await import("../src/output/terminal.js");

const diagnostic = (severity: Diagnostic["severity"]): Diagnostic => ({
	filePath: "src/example.ts",
	engine: "ai-slop",
	rule: "ai-slop/example",
	severity,
	message: "Example issue",
	help: "",
	line: 1,
	column: 1,
	category: "AI Slop",
	fixable: false,
});

const resultWith = (severities: Diagnostic["severity"][]): EngineResult => ({
	engine: "ai-slop",
	diagnostics: severities.map(diagnostic),
	elapsed: 574,
	skipped: false,
});

const printedLines = (): string[] =>
	[logMock.success, logMock.error, logMock.warn, logMock.info].flatMap((mock) =>
		mock.mock.calls.map(([line]) => String(line)),
	);

describe("printEngineStatus", () => {
	beforeEach(() => {
		for (const mock of Object.values(logMock)) mock.mockReset();
	});

	it.each([
		["one finding", ["info"] as Diagnostic["severity"][], "1 info, "],
		["three findings", ["info", "info", "info"] as Diagnostic["severity"][], "3 info, "],
	])(
		"reports the info count, not an empty segment, when every finding is info (%s)",
		(_name, severities, expectedCount) => {
			printEngineStatus(resultWith(severities));

			const [line] = printedLines();
			expect(line).not.toContain("(,");
			expect(line).toContain(expectedCount);
			expect(logMock.info).toHaveBeenCalledTimes(1);
			expect(logMock.warn).not.toHaveBeenCalled();
		},
	);

	it("reports zero findings as a success line", () => {
		printEngineStatus(resultWith([]));

		expect(logMock.success).toHaveBeenCalledWith(expect.stringContaining("done (0 issues, "));
	});

	it("lists every severity present and logs at the highest one", () => {
		printEngineStatus(resultWith(["info", "warning", "warning", "error"]));

		const [line] = printedLines();
		expect(line).toContain("1 error, 2 warnings, 1 info, ");
		expect(logMock.error).toHaveBeenCalledTimes(1);
		expect(logMock.warn).not.toHaveBeenCalled();
	});

	it("logs a warning-only engine as a warning", () => {
		printEngineStatus(resultWith(["warning", "info"]));

		expect(printedLines()[0]).toContain("1 warning, 1 info, ");
		expect(logMock.warn).toHaveBeenCalledTimes(1);
	});
});
