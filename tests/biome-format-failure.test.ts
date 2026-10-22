import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { runBiomeFormat } from "../src/engines/format/biome.js";
import { formatEngine } from "../src/engines/format/index.js";
import type { EngineContext } from "../src/engines/types.js";

const subprocess = vi.hoisted(() => ({ runSubprocess: vi.fn() }));
vi.mock("../src/utils/subprocess.js", () => subprocess);

let tmpDir: string;

const contextFor = (): EngineContext => ({
	rootDirectory: tmpDir,
	languages: ["typescript"],
	frameworks: [],
	files: [path.join(tmpDir, "source.ts")],
	installedTools: {},
	config: {
		quality: DEFAULT_CONFIG.quality,
		security: DEFAULT_CONFIG.security,
		lint: DEFAULT_CONFIG.lint,
	},
});

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-biome-failure-"));
	fs.writeFileSync(path.join(tmpDir, "biome.json"), "{}\n");
	fs.writeFileSync(path.join(tmpDir, "source.ts"), "export const value = 1;\n");
});

afterEach(() => {
	subprocess.runSubprocess.mockReset();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("biome format failures are not laundered into zero findings", () => {
	it("rejects when the subprocess cannot be spawned or times out", async () => {
		subprocess.runSubprocess.mockRejectedValue(new Error("spawn failed"));
		await expect(runBiomeFormat(contextFor())).rejects.toThrow("spawn failed");
	});

	it("rejects when biome exits non-zero with no output", async () => {
		subprocess.runSubprocess.mockResolvedValue({ stdout: "", stderr: "", exitCode: null });
		await expect(runBiomeFormat(contextFor())).rejects.toThrow(/no output/);
	});

	const PARTIAL_DIAGNOSTICS_REPORT = JSON.stringify({
		diagnostics: [
			{
				location: { path: "source.ts", start: { line: 1, column: 1 } },
				message: "File is not formatted correctly",
			},
		],
	});

	it.each([
		["unparseable output on crash", "boom", "", 2],
		["exit-1 configuration error shape", "", "formatter.indentStyle: invalid", 1],
		["partial diagnostics with exit code 2", PARTIAL_DIAGNOSTICS_REPORT, "", 2],
		["partial diagnostics with signal termination (null)", PARTIAL_DIAGNOSTICS_REPORT, "", null],
	])(
		"rejects when biome crashes or fails without a recognized report (%s)",
		async (_description, stdout, stderr, exitCode) => {
			subprocess.runSubprocess.mockResolvedValue({ stdout, stderr, exitCode });
			await expect(runBiomeFormat(contextFor())).rejects.toThrow(/without parseable diagnostics/);
		},
	);

	it("still returns no findings for a clean exit with no output", async () => {
		subprocess.runSubprocess.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
		await expect(runBiomeFormat(contextFor())).resolves.toEqual([]);
	});

	it.each([
		["single-language failure", ["typescript"], {}, "spawn failed"],
		["mixed-language failure with missing tool", ["typescript", "python"], {}, "spawn failed"],
	])(
		"reports the format engine as failed with the reason (%s)",
		async (_description, languages, installedTools, failureMessage) => {
			subprocess.runSubprocess.mockRejectedValue(new Error(failureMessage));
			const context: EngineContext = {
				...contextFor(),
				languages: languages as ("typescript" | "python")[],
				installedTools,
			};
			const result = await formatEngine.run(context);
			expect(result.failed).toBe(true);
			expect(result.skipped).toBe(true);
			expect(result.skipReason).toContain(failureMessage);
			if (languages.includes("python")) {
				expect(result.missingTools).toContain("ruff");
			}
		},
	);
});
