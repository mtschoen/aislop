import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ciCommand } from "../src/commands/ci.js";
import { scanCommand } from "../src/commands/scan.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { lintEngine } from "../src/engines/lint/index.js";
import { runOxlint } from "../src/engines/lint/oxlint.js";
import { runTypecheck } from "../src/engines/lint/typecheck.js";
import type { EngineContext } from "../src/engines/types.js";

const subprocess = vi.hoisted(() => ({
	runSubprocess: vi.fn(),
	isToolInstalled: vi.fn(async () => false),
}));
vi.mock("../src/utils/subprocess.js", () => subprocess);

let temporaryDirectory: string;

const contextFor = (): EngineContext => ({
	rootDirectory: temporaryDirectory,
	languages: ["typescript"],
	frameworks: [],
	files: [path.join(temporaryDirectory, "source.ts")],
	installedTools: {},
	config: {
		quality: DEFAULT_CONFIG.quality,
		security: DEFAULT_CONFIG.security,
		lint: { ...DEFAULT_CONFIG.lint, typecheck: true },
	},
});

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-lint-failure-"));
	fs.writeFileSync(path.join(temporaryDirectory, "source.ts"), "export const value = 1;\n");
	fs.writeFileSync(path.join(temporaryDirectory, "tsconfig.json"), "{}\n");
});

afterEach(() => {
	subprocess.runSubprocess.mockReset();
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("lint tool failures are not clean zero findings", () => {
	it.each([
		["empty stdout", "", "", 0],
		["stderr only", "", "worker failed", 2],
		["invalid JSON", "not JSON", "worker failed", 1],
		["missing diagnostics", "{}", "worker failed", 0],
		["null report", "null", "", null],
		["non-array diagnostics", '{"diagnostics":{}}', "", 0],
	])("rejects oxlint %s (issue 109)", async (_description, stdout, stderr, exitCode) => {
		subprocess.runSubprocess.mockResolvedValue({ stdout, stderr, exitCode });
		await expect(runOxlint(contextFor())).rejects.toThrow(
			`oxlint exited with code ${exitCode} without parseable diagnostics: stdout: ${stdout}; stderr: ${stderr}`,
		);
	});

	it.each([
		["oxlint", runOxlint, '{"diagnostics":[]}'],
		["tsc", runTypecheck, ""],
	] as const)("keeps a valid clean %s run clean", async (_tool, run, stdout) => {
		subprocess.runSubprocess.mockResolvedValue({ stdout, stderr: "", exitCode: 0 });
		await expect(run(contextFor())).resolves.toEqual([]);
	});

	it.each([new Error("spawn failed"), new Error("timed out"), "process rejected"])(
		"rejects tsc subprocess failure %s with the tsconfig (issue 109)",
		async (error) => {
			subprocess.runSubprocess.mockRejectedValue(error);
			const reason = error instanceof Error ? error.message : error;
			await expect(runTypecheck(contextFor())).rejects.toThrow(
				`tsc failed for tsconfig.json: ${reason}`,
			);
		},
	);

	it.each(["oxlint", "tsc"])(
		"surfaces %s failure through the lint engine (issue 109)",
		async (tool) => {
			subprocess.runSubprocess.mockImplementation(async (_executable, args: string[]) => {
				const isTypecheck = args.includes("--noEmit");
				if (tool === "tsc" && isTypecheck) throw new Error("spawn failed");
				return {
					stdout: isTypecheck || tool === "oxlint" ? "" : '{"diagnostics":[]}',
					stderr: "",
					exitCode: 0,
				};
			});
			const result = await lintEngine.run(contextFor());
			expect(result.failed).toBe(true);
			expect(result.skipReason).toContain(tool);
			expect(result.failures).toEqual([
				{
					tool,
					target: ".",
					reason: expect.stringContaining(tool),
				},
			]);
			expect(result.diagnostics).toEqual([]);

			const configuration = structuredClone(DEFAULT_CONFIG);
			configuration.engines = {
				format: false,
				lint: true,
				"code-quality": false,
				"ai-slop": false,
				architecture: false,
				security: false,
			};
			configuration.lint.typecheck = true;
			configuration.ci.failBelow = 100;
			configuration.telemetry.enabled = false;
			const messages: string[] = [];
			const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
				messages.push(String(message));
			});
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const jsonScan = await scanCommand(temporaryDirectory, configuration, {
					changes: false,
					staged: false,
					verbose: false,
					json: true,
				});
				expect(jsonScan.exitCode).toBe(1);
				expect(JSON.parse(messages.at(-1)!).engines.lint).toMatchObject({
					failed: true,
					failures: [
						{
							tool,
							target: ".",
							reason: expect.stringContaining(tool),
						},
					],
				});

				const sarifCi = await ciCommand(temporaryDirectory, configuration, { sarif: true });
				expect(sarifCi.exitCode).toBe(1);
				const invocation = JSON.parse(messages.at(-1)!).runs[0].invocations[0];
				expect(invocation.executionSuccessful).toBe(false);
				expect(invocation.toolExecutionNotifications[0].message.text).toContain(
					`${tool} not-run for .:`,
				);
			} finally {
				logSpy.mockRestore();
				stderrSpy.mockRestore();
			}
		},
	);
});
