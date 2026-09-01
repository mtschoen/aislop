import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { EngineContext } from "../../src/engines/types.js";
import { fixRuffFormat, runRuffFormat } from "../../src/engines/format/ruff-format.js";

vi.mock("../../src/utils/subprocess.js", () => ({
	runSubprocess: vi.fn(),
}));
vi.mock("../../src/engines/python-targets.js", () => ({
	getPythonTargets: vi.fn(),
	getRuffDiagnosticPath: vi.fn((rootDir: string, filePath: string) => `${rootDir}/${filePath}`),
}));
vi.mock("../../src/utils/tooling.js", () => ({
	resolveToolBinary: vi.fn(),
}));

import { getPythonTargets } from "../../src/engines/python-targets.js";
import { resolveToolBinary } from "../../src/utils/tooling.js";
import { runSubprocess } from "../../src/utils/subprocess.js";

const context: EngineContext = {
	rootDirectory: "/tmp",
	languages: ["python"],
	frameworks: [],
	installedTools: { ruff: true },
	config: {
		quality: DEFAULT_CONFIG.quality,
		security: DEFAULT_CONFIG.security,
		lint: DEFAULT_CONFIG.lint,
	},
};

const runSubprocessMock = vi.mocked(runSubprocess);
const getPythonTargetsMock = vi.mocked(getPythonTargets);
const resolveToolBinaryMock = vi.mocked(resolveToolBinary);

beforeEach(() => {
	runSubprocessMock.mockReset();
	getPythonTargetsMock.mockReset();
	resolveToolBinaryMock.mockReset();
	resolveToolBinaryMock.mockReturnValue("ruff");
	getPythonTargetsMock.mockReturnValue(["src/main.py", "src/utils.py"]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runRuffFormat", () => {
	it("returns [] when there are no python targets", async () => {
		getPythonTargetsMock.mockReturnValue([]);

		expect(await runRuffFormat(context)).toEqual([]);
	});

	it("returns [] when ruff reports no formatting changes", async () => {
		runSubprocessMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		expect(await runRuffFormat(context)).toEqual([]);
	});

	it("returns diagnostics from ruff --check diff output", async () => {
		runSubprocessMock.mockResolvedValue({
			exitCode: 1,
			stdout: "--- src/main.py\n" +
				"+++ b/src/main.py\n" +
				"@@ -1,2 +1,2 @@\n" +
				"--- src/utils.py\n" +
				"+++ b/src/utils.py\n",
			stderr: "",
		});

		const findings = await runRuffFormat(context);

		expect(findings).toHaveLength(2);
		expect(findings[0]).toMatchObject({ filePath: "/tmp/src/main.py", rule: "python-formatting" });
		expect(findings[1]).toMatchObject({ filePath: "/tmp/src/utils.py", rule: "python-formatting" });
	});

	it("returns [] when ruff invocation fails", async () => {
		runSubprocessMock.mockRejectedValue(new Error("ruff not present"));

		expect(await runRuffFormat(context)).toEqual([]);
	});
});

describe("fixRuffFormat", () => {
	it("resolves the tool and succeeds on exit code 0", async () => {
		runSubprocessMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		await expect(fixRuffFormat(context)).resolves.toBeUndefined();
		expect(resolveToolBinaryMock).toHaveBeenCalledWith("ruff");
		expect(runSubprocessMock).toHaveBeenCalledWith("ruff", ["format", "/tmp"], {
			cwd: "/tmp",
			timeout: 60000,
		});
	});

	it("throws when ruff exits with an error", async () => {
		runSubprocessMock.mockResolvedValue({
			exitCode: 12,
			stdout: "",
			stderr: "ruff failed",
		});

		await expect(fixRuffFormat(context)).rejects.toThrow("ruff failed");
	});
});
