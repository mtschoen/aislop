import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../src/engines/types.js";
import { runSubprocess } from "../../src/utils/subprocess.js";
import { fixExpoDependencies } from "../../src/commands/fix-expo.js";

vi.mock("../../src/utils/subprocess.js", () => ({
	runSubprocess: vi.fn(),
}));

const runSubprocessMock = vi.mocked(runSubprocess);

const context: EngineContext = {
	rootDirectory: "/tmp/repo",
	languages: ["javascript"],
	frameworks: ["expo"],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
};

beforeEach(() => {
	runSubprocessMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fixExpoDependencies", () => {
	it("runs install --fix and exits without check when changes were fixed", async () => {
		const onProgress = vi.fn();
		runSubprocessMock
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "",
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "",
				stderr: "",
			});

		await expect(fixExpoDependencies(context, onProgress)).resolves.toBeUndefined();

		expect(runSubprocessMock).toHaveBeenCalledTimes(2);
		expect(runSubprocessMock).toHaveBeenNthCalledWith(1, "npx", ["--yes", "expo-doctor", "/tmp/repo"], {
			cwd: "/tmp/repo",
			timeout: 30 * 60 * 1000,
		});
		expect(runSubprocessMock).toHaveBeenNthCalledWith(2, "npx", ["--yes", "expo", "install", "--fix"], {
			cwd: "/tmp/repo",
			timeout: 30 * 60 * 1000,
		});
		expect(onProgress).toHaveBeenCalledWith(
			"Expo dependency alignment · running expo install --fix (can take a few minutes)",
		);
	});

	it("uninstalls disallowed packages and throws when check still fails", async () => {
		const onProgress = vi.fn();
		runSubprocessMock
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'The package "legacy" should not be installed directly\n',
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: "",
				stderr: "",
			})
			.mockResolvedValueOnce({
				exitCode: 1,
				stdout: "",
				stderr: "dependency issue remains",
			})
			.mockResolvedValueOnce({
				exitCode: 1,
				stdout: "",
				stderr: "expo install --check still failing",
			});

		await expect(fixExpoDependencies(context, onProgress)).rejects.toThrow(
			"expo install --check still failing",
		);

		expect(runSubprocessMock).toHaveBeenCalledTimes(4);
		expect(runSubprocessMock).toHaveBeenNthCalledWith(2, "npm", ["uninstall", "legacy"], {
			cwd: "/tmp/repo",
			timeout: 30 * 60 * 1000,
		});
		expect(runSubprocessMock).toHaveBeenNthCalledWith(3, "npx", ["--yes", "expo", "install", "--fix"], {
			cwd: "/tmp/repo",
			timeout: 30 * 60 * 1000,
		});
		expect(onProgress).toHaveBeenCalledWith("Expo dependency alignment · uninstalling 1 package(s)");
		expect(onProgress).toHaveBeenCalledWith("Expo dependency alignment · checking remaining issues");
	});

	it("continues with install --fix when expo-doctor fails", async () => {
		runSubprocessMock
			.mockRejectedValueOnce(new Error("expo-doctor missing"))
			.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

		await expect(fixExpoDependencies(context)).resolves.toBeUndefined();
		expect(runSubprocessMock).toHaveBeenCalledTimes(2);
		expect(runSubprocessMock).toHaveBeenNthCalledWith(
			2,
			"npx",
			["--yes", "expo", "install", "--fix"],
			{
				cwd: "/tmp/repo",
				timeout: 30 * 60 * 1000,
			},
		);
	});
});
