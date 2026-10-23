import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ciCommand } from "../src/commands/ci.js";
import { scanCommand } from "../src/commands/scan.js";
import { runEnginesWithProgress } from "../src/commands/scan-engine-runner.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { lintEngine } from "../src/engines/lint/index.js";
import { printEngineStatus } from "../src/output/terminal.js";
import { LiveGrid } from "../src/ui/live-grid.js";
import { log } from "../src/ui/logger.js";

const { subprocess, tools } = vi.hoisted(() => ({ subprocess: vi.fn(), tools: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/subprocess.js")>()),
	runSubprocess: (await import("./helpers/dotnet-solution-list.js")).withDotnetSolutionList(
		subprocess,
	),
}));
vi.mock("../src/utils/discovery-tools.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/discovery-tools.js")>()),
	checkInstalledTools: tools,
}));
vi.mock("../src/utils/tooling.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tooling.js")>()),
	resolveToolBinary: (name: string) => name,
	resolveBundledAnalyzerAssemblies: () => [],
	resolveBundledJbSettings: () => null,
}));
vi.mock("../src/utils/paths.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/paths.js")>();
	return {
		...original,
		// The only seam that makes the otherwise total regex parser throw on a complete-looking report.
		projectRelativePosix: (rootDirectory: string, filePath: string) => {
			if (filePath.includes("UNPARSEABLE")) throw new Error(`cannot relativize ${filePath}`);
			return original.projectRelativePosix(rootDirectory, filePath);
		},
	};
});
vi.mock("../src/telemetry/index.js", () => ({
	withCommandLifecycle: async (_metadata: unknown, action: () => Promise<unknown>) => action(),
}));

describe("C# analyzer execution at the CI boundary", () => {
	let root: string;
	let configuration: typeof DEFAULT_CONFIG;
	let messages: string[];
	let stderr: string[];
	beforeEach(() => {
		vi.resetAllMocks();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csharp-ci-"));
		fs.writeFileSync(path.join(root, "App.sln"), "");
		for (const name of ["One", "Two"]) {
			fs.mkdirSync(path.join(root, name, "obj"), { recursive: true });
			fs.writeFileSync(path.join(root, name, `${name}.csproj`), "<Project />");
			fs.writeFileSync(path.join(root, name, "obj", "project.assets.json"), "{}");
			fs.writeFileSync(path.join(root, name, "Code.cs"), "public class Code {}\n");
		}
		configuration = structuredClone(DEFAULT_CONFIG);
		configuration.engines = {
			format: false,
			lint: true,
			"code-quality": false,
			"ai-slop": false,
			architecture: false,
			security: false,
		};
		configuration.lint.csharp = {
			projectEvaluation: true,
			roslynator: true,
			jb: false,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};
		configuration.ci.failBelow = 0;
		tools.mockResolvedValue({ roslynator: true, jb: true });
		subprocess.mockResolvedValue({ stdout: "", stderr: "load failed", exitCode: 0 });
		messages = [];
		stderr = [];
		vi.spyOn(console, "log").mockImplementation((message) => {
			messages.push(String(message));
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("fails CI when the solution and every fallback produce no report", async () => {
		const result = await ciCommand(root, configuration);
		expect(subprocess).toHaveBeenCalledTimes(3);
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(messages.at(-1)!);
		expect(output.engines.lint.failures).toEqual([
			expect.objectContaining({ tool: "roslynator", target: "One/One.csproj" }),
			expect.objectContaining({ tool: "roslynator", target: "Two/Two.csproj" }),
		]);
		expect(stderr.join("")).toContain("roslynator not-run for One/One.csproj");
		expect(output.diagnostics).toEqual([]);
		expect(output.score).toBe(100);
	});

	it("leaves CI unaffected when every project fallback succeeds", async () => {
		subprocess.mockImplementation(async (_command: string, arguments_: string[]) => {
			if (arguments_[1].endsWith(".csproj")) {
				fs.writeFileSync(arguments_[arguments_.indexOf("--output") + 1], "<Roslynator />");
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		expect((await ciCommand(root, configuration)).exitCode).toBe(0);
		expect(subprocess).toHaveBeenCalledTimes(3);
		const output = JSON.parse(messages.at(-1)!);
		expect(output.engines.lint.failures).toBeUndefined();
		expect(output.score).toBe(100);
		expect(stderr.join("")).not.toContain("not-run");
	});

	it.each(["MSB4166: child node exited", "MFTLibNative.dll (Debug, x64) not found"])(
		"fails C# jb independently of successful Roslynator: %s",
		async (reason) => {
			configuration.lint.csharp.jb = true;
			subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
				if (command === "roslynator") {
					fs.writeFileSync(arguments_[arguments_.indexOf("--output") + 1], "<Roslynator />");
				}
				return { stdout: "", stderr: reason, exitCode: 2 };
			});
			expect((await ciCommand(root, configuration)).exitCode).toBe(1);
			expect(JSON.parse(messages.at(-1)!).engines.lint.failures).toEqual([
				expect.objectContaining({
					tool: "jb inspectcode",
					target: "App.sln",
					reason: expect.stringContaining(reason),
				}),
			]);
			expect(stderr.join("")).toContain("jb inspectcode not-run for App.sln");
		},
	);

	it("fails CI when a complete-looking jb report cannot be parsed", async () => {
		configuration.lint.csharp.jb = true;
		configuration.lint.csharp.roslynator = false;
		subprocess.mockImplementation(async (_command: string, arguments_: string[]) => {
			const output = arguments_.find((value) => value.startsWith("--output="))!;
			fs.writeFileSync(
				output.slice("--output=".length),
				'<Report><Issues><Project Name="App"><Issue TypeId="X" File="UNPARSEABLE.cs" Line="1" Message="m" /></Project></Issues></Report>',
			);
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const result = await ciCommand(root, configuration);
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(messages.at(-1)!);
		expect(output.diagnostics).toEqual([]);
		expect(output.engines.lint.failures).toEqual([
			expect.objectContaining({
				tool: "jb inspectcode",
				target: "App.sln",
				reason: expect.stringContaining("cannot relativize UNPARSEABLE.cs"),
			}),
		]);
		expect(stderr.join("")).toContain("jb inspectcode not-run for App.sln");
	});

	it("reports scan as incomplete without inventing source findings", async () => {
		expect(
			(
				await scanCommand(root, configuration, {
					changes: false,
					staged: false,
					verbose: false,
					json: true,
				})
			).exitCode,
		).toBe(1);
		const output = JSON.parse(messages.at(-1)!);
		expect(output.engines.lint.failures).toHaveLength(2);
		expect(output.engines.lint.issues).toBe(0);
		expect(stderr.join("")).toContain("Scan incomplete");
	});

	it("records unsuccessful SARIF invocations without fake source results", async () => {
		expect((await ciCommand(root, configuration, { sarif: true })).exitCode).toBe(1);
		const run = JSON.parse(messages.at(-1)!).runs[0];
		expect(run.results).toEqual([]);
		expect(run.invocations[0].executionSuccessful).toBe(false);
		expect(run.invocations[0].toolExecutionNotifications[0].message.text).toContain(
			"roslynator not-run for One/One.csproj",
		);
	});

	it.each(["missing", "disabled"])("keeps optional tool %s behavior", async (mode) => {
		if (mode === "missing") tools.mockResolvedValue({ roslynator: false, jb: false });
		else configuration.lint.csharp.projectEvaluation = false;
		expect((await ciCommand(root, configuration)).exitCode).toBe(0);
		expect(subprocess).not.toHaveBeenCalled();
	});

	it("does not print a clean terminal status for incomplete analysis", () => {
		const success = vi.spyOn(log, "success").mockImplementation(() => {});
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		printEngineStatus({
			engine: "lint",
			diagnostics: [],
			elapsed: 0,
			skipped: false,
			failures: [{ tool: "roslynator", target: "App.sln", reason: "no report" }],
		});
		expect(success).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(expect.stringContaining("not-run"));
	});

	it("marks live progress failed rather than showing zero issues", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
		Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
		vi.stubEnv("CI", "");
		vi.spyOn(LiveGrid.prototype, "start").mockImplementation(() => {});
		vi.spyOn(LiveGrid.prototype, "stop").mockImplementation(() => {});
		const update = vi.spyOn(LiveGrid.prototype, "update").mockImplementation(() => {});
		try {
			await runEnginesWithProgress(
				{
					rootDirectory: root,
					languages: ["csharp"],
					frameworks: [],
					installedTools: { roslynator: true },
					config: {
						quality: configuration.quality,
						security: configuration.security,
						lint: configuration.lint,
					},
				},
				configuration.engines,
				false,
			);
			expect(update).toHaveBeenCalledWith(
				"lint",
				expect.objectContaining({
					status: "done",
					outcome: "fail",
					summary: "2 target(s) not-run",
				}),
			);
		} finally {
			vi.unstubAllEnvs();
			if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
			else Reflect.deleteProperty(process.stderr, "isTTY");
		}
	});

	it("collects mixed-language jb failure once", async () => {
		const result = await lintEngine.run({
			rootDirectory: root,
			languages: ["csharp", "cpp"],
			frameworks: [],
			installedTools: { jb: true },
			config: {
				quality: configuration.quality,
				security: configuration.security,
				lint: {
					...configuration.lint,
					csharp: { ...configuration.lint.csharp, jb: true, roslynator: false },
					cpp: {
						cppcheck: false,
						clangTidy: false,
						cppcheckEnable: "warning",
						jb: true,
						jbSeverityFloor: "WARNING",
						jbExcludeTypes: [],
					},
				},
			},
		});
		expect(result.failures).toEqual([
			expect.objectContaining({ tool: "jb inspectcode", target: "App.sln" }),
		]);
		expect(result.failed).toBe(true);
	});
});
