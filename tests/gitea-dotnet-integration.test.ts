import { strict as assert } from "node:assert";
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const projectRoot = "tests/fixtures/dotnet/sample-project";
const assetsPath = `${projectRoot}/obj/project.assets.json`;
const tools = ["jb inspectcode", "roslynator"] as const;
const expectedFinding = {
	engine: "lint",
	filePath: "Bad.cs",
	rule: "dotnet/AsyncFixer03",
};
const skippedAdvisory = { engine: "lint", rule: "dotnet/projects-skipped" };

type ReportOptions = {
	diagnostics?: unknown;
	engines?: Record<string, unknown>;
	executions?: unknown;
	lint?: Record<string, unknown>;
	schemaVersion?: unknown;
};

type ResultOptions = {
	error?: Error;
	report?: unknown;
	signal?: string | null;
	status?: number | null;
	stderr?: string;
	stdout?: string;
};

type HarnessOptions = {
	assetsAfterRestore?: boolean;
	assetsInitiallyPresent?: boolean;
	build?: ResultOptions;
	negative?: ResultOptions;
	positive?: ResultOptions;
	restore?: ResultOptions;
};

const execution = (tool: string, overrides: Record<string, unknown> = {}) => ({
	tool,
	status: "ran",
	targets: ["Sample.csproj"],
	analyzedProjects: ["Sample.csproj"],
	excludedProjects: [],
	...overrides,
});

const healthyExecutions = () => tools.map((tool) => execution(tool));

const report = (options: ReportOptions = {}) => ({
	schemaVersion: options.schemaVersion === undefined ? "2" : options.schemaVersion,
	engines: {
		lint: {
			skipped: false,
			executions: options.executions === undefined ? healthyExecutions() : options.executions,
			...options.lint,
		},
		...options.engines,
	},
	diagnostics: options.diagnostics === undefined ? [expectedFinding] : options.diagnostics,
});

const unrestoredReport = (options: ReportOptions = {}) =>
	report({
		...options,
		executions:
			options.executions === undefined
				? tools.map((tool) =>
						execution(tool, {
							status: "not-selected",
							analyzedProjects: [],
							reason: "no restore evidence",
						}),
					)
				: options.executions,
		lint: { failed: true, ...options.lint },
		diagnostics: options.diagnostics === undefined ? [skippedAdvisory] : options.diagnostics,
	});

const embeddedProgram = () => {
	const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8"));
	const step = workflow.jobs["dotnet-lint"].steps.find((entry: { run?: string }) =>
		entry.run?.includes("node --input-type=commonjs <<'NODE'"),
	);
	expect(step, "the integration job embeds its CommonJS acceptance program").toBeDefined();
	const match = step.run.match(/node --input-type=commonjs <<'NODE'\n([\s\S]*?)\nNODE\s*$/);
	expect(match, "the heredoc is extractable without copying the acceptance logic").not.toBeNull();
	return match[1] as string;
};

const processResult = (options: ResultOptions, defaultReport: unknown, defaultStatus: number) => ({
	stdout:
		options.stdout ?? JSON.stringify(options.report === undefined ? defaultReport : options.report),
	stderr: options.stderr ?? "",
	status: options.status === undefined ? defaultStatus : options.status,
	signal: options.signal ?? null,
	error: options.error,
});

const executeWorkflow = (program: string, options: HarnessOptions = {}) => {
	let assetsPresent = options.assetsInitiallyPresent ?? false;
	const events: string[] = [];
	let stdout = "";
	let stderr = "";
	const scanCommand = `${projectRoot} --json`;
	const requireFake = (identifier: string) => {
		if (identifier === "node:assert/strict") return assert;
		if (identifier === "node:fs") {
			return {
				existsSync: (filePath: string) => {
					expect(filePath).toBe(assetsPath);
					events.push(`assets:${assetsPresent}`);
					return assetsPresent;
				},
			};
		}
		if (identifier === "node:child_process") {
			return {
				spawnSync: (command: string, arguments_: string[]) => {
					const invocation = `${command} ${arguments_.join(" ")}`;
					if (invocation.includes(scanCommand)) {
						events.push(`scan:${assetsPresent ? "restored" : "unrestored"}`);
						return assetsPresent
							? processResult(options.positive ?? {}, report(), 1)
							: processResult(options.negative ?? {}, unrestoredReport(), 1);
					}
					if (command === "dotnet" && arguments_[0] === "restore") {
						events.push(invocation);
						const result = processResult(options.restore ?? {}, {}, 0);
						if (result.status === 0 && !result.error && !result.signal) {
							assetsPresent = options.assetsAfterRestore ?? true;
						}
						return result;
					}
					if (command === "dotnet" && arguments_[0] === "build") {
						events.push(invocation);
						return processResult(options.build ?? {}, {}, 0);
					}
					throw new Error(`unexpected subprocess: ${invocation}`);
				},
			};
		}
		throw new Error(`unexpected import: ${identifier}`);
	};
	const processFake = {
		execPath: "/fake/node",
		stdout: {
			write: (chunk: unknown) => {
				stdout += String(chunk);
				return true;
			},
		},
		stderr: {
			write: (chunk: unknown) => {
				stderr += String(chunk);
				return true;
			},
		},
	};
	const consoleFake = {
		log: (message: unknown) => {
			stdout += `${String(message)}\n`;
		},
		error: (message: unknown) => {
			stderr += `${String(message)}\n`;
		},
	};
	vm.runInNewContext(program, {
		console: consoleFake,
		process: processFake,
		require: requireFake,
	});
	return { events, stdout, stderr };
};

const expectWorkflowFailure = (options: HarnessOptions, expected?: RegExp) => {
	const program = embeddedProgram();
	expect(() => executeWorkflow(program, options)).toThrow(expected);
};

describe("Gitea C# lint integration gate", () => {
	it("checks the jb version alongside the other baked tools", () => {
		const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8"));
		const step = workflow.jobs["dotnet-lint"].steps.find((entry: { run?: string }) =>
			entry.run?.includes("dotnet --version"),
		);
		expect(step.run).toContain("roslynator --version");
		expect(step.run).toContain("jb inspectcode --version");
	});

	it.each([0, 1])("runs the real negative-then-positive flow with scan exit %s", (status) => {
		const result = executeWorkflow(embeddedProgram(), { positive: { status } });
		expect(result.events).toEqual([
			"assets:false",
			"scan:unrestored",
			`dotnet restore ${projectRoot}/Sample.csproj --locked-mode`,
			`dotnet build ${projectRoot}/Sample.csproj --no-restore`,
			"assets:true",
			"scan:restored",
		]);
		expect(result.stdout).toContain("pre-restore");
		expect(result.stdout).toContain("post-build");
	});

	it.each([
		{ name: "issue 182 advisory-only findings", value: report({ diagnostics: [skippedAdvisory] }) },
		{ name: "missing execution", value: report({ executions: [execution("roslynator")] }) },
		{
			name: "duplicate execution",
			value: report({ executions: [execution("jb inspectcode"), ...healthyExecutions()] }),
		},
		{
			name: "failed jb execution",
			value: report({
				executions: [execution("jb inspectcode", { status: "failed" }), execution("roslynator")],
			}),
		},
		{
			name: "not-selected roslynator execution",
			value: report({
				executions: [
					execution("jb inspectcode"),
					execution("roslynator", { status: "not-selected" }),
				],
			}),
		},
		{
			name: "wrong analyzed project",
			value: report({
				executions: [
					execution("jb inspectcode", { analyzedProjects: ["Other.csproj"] }),
					execution("roslynator"),
				],
			}),
		},
		{
			name: "empty analyzed projects",
			value: report({
				executions: [
					execution("jb inspectcode", { analyzedProjects: [] }),
					execution("roslynator"),
				],
			}),
		},
		{
			name: "missing target",
			value: report({
				executions: [execution("jb inspectcode", { targets: [] }), execution("roslynator")],
			}),
		},
		{
			name: "excluded fixture",
			value: report({
				executions: [
					execution("jb inspectcode", { excludedProjects: ["Sample.csproj"] }),
					execution("roslynator"),
				],
			}),
		},
		{ name: "missing executions", value: report({ lint: { executions: undefined } }) },
		{ name: "missing diagnostics", value: report({ diagnostics: null }) },
		{ name: "wrong schema", value: report({ schemaVersion: "1" }) },
		{ name: "skipped lint", value: report({ lint: { skipped: true } }) },
		{ name: "failed engine", value: report({ lint: { failed: true } }) },
		{ name: "engine failures", value: report({ engines: { format: { failures: ["failed"] } } }) },
		{ name: "missing tools", value: report({ lint: { missingTools: ["jb"] } }) },
		{
			name: "missing exact finding",
			value: report({ diagnostics: [{ ...expectedFinding, rule: "dotnet/Other" }] }),
		},
	])("rejects a positive report with $name", ({ value }) => {
		expectWorkflowFailure({ positive: { report: value } });
	});

	it.each([
		{ name: "unexpectedly valid report", options: { report: report() } },
		{ name: "zero scan status", options: { status: 0 } },
		{
			name: "lint did not fail",
			options: { report: unrestoredReport({ lint: { failed: false } }) },
		},
		{
			name: "analyzer ran",
			options: { report: unrestoredReport({ executions: healthyExecutions() }) },
		},
		{
			name: "analyzed project",
			options: {
				report: unrestoredReport({
					executions: [
						execution("jb inspectcode", { status: "not-selected" }),
						execution("roslynator", { status: "not-selected" }),
					],
				}),
			},
		},
		{ name: "missing advisory", options: { report: unrestoredReport({ diagnostics: [] }) } },
		{ name: "malformed JSON", options: { stdout: "{" } },
		{ name: "empty JSON", options: { stdout: "" } },
		{ name: "unexpected exit", options: { status: 2 } },
		{ name: "spawn error", options: { error: new Error("spawn failed") } },
		{ name: "signal", options: { status: null, signal: "SIGTERM" } },
	])("rejects a negative control with $name", ({ options }) => {
		expectWorkflowFailure({ negative: options });
	});

	it.each([
		{ name: "malformed JSON", options: { stdout: "{" } },
		{ name: "empty JSON", options: { stdout: "" } },
		{ name: "unexpected exit", options: { status: 2 } },
		{ name: "spawn error", options: { error: new Error("spawn failed") } },
		{ name: "signal", options: { status: null, signal: "SIGTERM" } },
	])("rejects a positive scan with $name", ({ options }) => {
		expectWorkflowFailure({ positive: options });
	});

	it.each(["restore", "build"] as const)("stops when dotnet %s fails", (phase) => {
		expectWorkflowFailure({ [phase]: { status: 2 } });
	});

	it("rejects restore assets that already exist", () => {
		expectWorkflowFailure({ assetsInitiallyPresent: true }, /absent/);
	});

	it("rejects a restore that leaves no assets file", () => {
		expectWorkflowFailure({ assetsAfterRestore: false }, /assets/);
	});
});
