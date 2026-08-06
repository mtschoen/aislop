import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { runSubprocess } from "../../src/utils/subprocess.js";
import type { EngineContext } from "../../src/engines/types.js";
import { fixGofmt, runGofmt } from "../../src/engines/format/gofmt.js";

const context: EngineContext = {
	rootDirectory: "/tmp",
	languages: ["go"],
	frameworks: [],
	installedTools: { gofmt: true },
	config: {
		quality: DEFAULT_CONFIG.quality,
		security: DEFAULT_CONFIG.security,
		lint: DEFAULT_CONFIG.lint,
	},
};

vi.mock("../../src/utils/subprocess.js", () => ({
	runSubprocess: vi.fn(),
}));

const mockRunSubprocess = vi.mocked(runSubprocess);

beforeEach(() => {
	vi.resetModules();
	mockRunSubprocess.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runGofmt", () => {
	it("returns no diagnostics when gofmt emits no filenames", async () => {
		mockRunSubprocess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

		expect(await runGofmt(context)).toEqual([]);
	});

	it("returns warnings for each path reported by gofmt", async () => {
		mockRunSubprocess.mockResolvedValue({
			exitCode: 0,
			stdout: "cmd/file-a.go\ncmd/file-b.go\n",
			stderr: "",
		});

		const findings = await runGofmt(context);

		expect(findings).toHaveLength(2);
		expect(findings[0]!.filePath).toMatch(/cmd\/file-a\.go$/);
		expect(findings[0]).toMatchObject({
			engine: "format",
			rule: "go-formatting",
		});
		expect(findings[1]!.filePath).toMatch(/cmd\/file-b\.go$/);
		expect(findings[1]).toMatchObject({
			engine: "format",
			rule: "go-formatting",
		});
	});

	it("returns [] when gofmt invocation throws", async () => {
		mockRunSubprocess.mockRejectedValue(new Error("missing gofmt"));

		expect(await runGofmt(context)).toEqual([]);
	});
});

describe("fixGofmt", () => {
	it("succeeds when gofmt exits cleanly", async () => {
		mockRunSubprocess.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
		await expect(fixGofmt(context.rootDirectory)).resolves.toBeUndefined();
	});

	it("throws when gofmt exits with failure", async () => {
		mockRunSubprocess.mockResolvedValue({
			exitCode: 3,
			stdout: "",
			stderr: "bad files",
		});

		await expect(fixGofmt(context.rootDirectory)).rejects.toThrow("bad files");
	});
});
