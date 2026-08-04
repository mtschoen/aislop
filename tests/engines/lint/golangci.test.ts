import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../src/engines/types.js";
import { runSubprocess } from "../../../src/utils/subprocess.js";
import { resolveToolBinary } from "../../../src/utils/tooling.js";

vi.mock("../../../src/utils/subprocess.js", () => ({
	runSubprocess: vi.fn(),
}));

vi.mock("../../../src/utils/tooling.js", () => ({
	resolveToolBinary: vi.fn(),
}));

const runSubprocessMock = vi.mocked(runSubprocess);
const resolveToolBinaryMock = vi.mocked(resolveToolBinary);

const context: EngineContext = {
	rootDirectory: "/repo",
	languages: ["go"],
	frameworks: [],
	installedTools: { go: true },
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
};

beforeEach(() => {
	runSubprocessMock.mockReset();
	resolveToolBinaryMock.mockReset();
	resolveToolBinaryMock.mockReturnValue("golangci-lint");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runGolangciLint", () => {
	it("parses json diagnostics into diagnostics with relative file paths", async () => {
		runSubprocessMock.mockResolvedValueOnce({
			exitCode: 1,
			stdout: JSON.stringify({
				Issues: [
					{
						FromLinter: "gocritic",
						Text: "avoid redefined import",
						Pos: { Filename: "/repo/main.go", Line: 12, Column: 4 },
					},
				],
			}),
			stderr: "",
		});

		const diagnostics = await import("../../../src/engines/lint/golangci.js").then((mod) =>
			mod.runGolangciLint(context),
		);

		expect(resolveToolBinaryMock).toHaveBeenCalledWith("golangci-lint");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			filePath: "main.go",
			rule: "go/gocritic",
			line: 12,
			column: 4,
			category: "Go Lint",
			engine: "lint",
		});
	});

	it("returns [] when go lint output is empty", async () => {
		runSubprocessMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);
	});

	it("returns [] when json output is invalid", async () => {
		runSubprocessMock.mockResolvedValueOnce({ exitCode: 1, stdout: "not-json", stderr: "" });

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);
	});

	it("returns [] when invocation fails", async () => {
		runSubprocessMock.mockRejectedValueOnce(new Error("tool missing"));

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);
	});
});
