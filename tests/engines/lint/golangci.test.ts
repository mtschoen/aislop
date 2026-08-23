import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../src/engines/types.js";
import { runSubprocess } from "../../../src/utils/subprocess.js";
import { resolveToolBinary } from "../../../src/utils/tooling.js";

vi.mock("../../../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/utils/subprocess.js")>();
	return { ...actual, runSubprocess: vi.fn() };
});

vi.mock("../../../src/utils/tooling.js", () => ({
	resolveToolBinary: vi.fn(),
}));

const runSubprocessMock = vi.mocked(runSubprocess);
const resolveToolBinaryMock = vi.mocked(resolveToolBinary);

const context: EngineContext = {
	rootDirectory: "/repo",
	languages: ["go"],
	frameworks: [],
	installedTools: { go: true, "golangci-lint": true },
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
		expect(runSubprocessMock).toHaveBeenCalledWith(
			"golangci-lint",
			["run", "--output.json.path=stdout", "--show-stats=false", "./..."],
			expect.objectContaining({ cwd: context.rootDirectory }),
		);
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

	it("does not pass the v1-only --out-format flag golangci-lint v2 rejects", async () => {
		runSubprocessMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		await runGolangciLint(context);

		const args = runSubprocessMock.mock.calls[0][1] as string[];
		expect(args).not.toContain("--out-format=json");
		expect(args).toContain("--output.json.path=stdout");
		expect(args).toContain("--show-stats=false");
	});

	it("returns [] when go lint output is empty and exit code is 0", async () => {
		runSubprocessMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);
	});

	it("warns instead of silently swallowing non-zero exit code with empty stdout", async () => {
		runSubprocessMock.mockResolvedValueOnce({
			exitCode: 3,
			stdout: "",
			stderr: "level=error msg=\"[config_reader] can't read config\"",
		});
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("golangci-lint");
		expect(warnSpy.mock.calls[0][0]).toContain("can't read config");
		warnSpy.mockRestore();
	});

	it("warns instead of silently swallowing invalid JSON output", async () => {
		runSubprocessMock.mockResolvedValueOnce({ exitCode: 1, stdout: "not-json", stderr: "" });
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("golangci-lint");
		warnSpy.mockRestore();
	});

	it("warns instead of silently swallowing a subprocess failure", async () => {
		runSubprocessMock.mockRejectedValueOnce(new Error("exit status 3"));
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("golangci-lint");
		warnSpy.mockRestore();
	});

	it("stays silent when golangci-lint itself is missing (ENOENT)", async () => {
		const enoent = Object.assign(new Error("spawn golangci-lint ENOENT"), { code: "ENOENT" });
		runSubprocessMock.mockRejectedValueOnce(enoent);
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { runGolangciLint } = await import("../../../src/engines/lint/golangci.js");
		expect(await runGolangciLint(context)).toEqual([]);

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
