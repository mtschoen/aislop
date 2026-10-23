import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/utils/subprocess.js")>();
	const { withDotnetSolutionList } = await import("../helpers/dotnet-solution-list.js");
	return { ...actual, runSubprocess: withDotnetSolutionList(runSubprocess) };
});

const { runDotnetLint } = await import("../../src/engines/lint/dotnet.js");

const csharpContext = (rootDirectory: string): EngineContext => ({
	rootDirectory,
	languages: ["csharp"],
	frameworks: [],
	installedTools: { roslynator: true },
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: {
			typecheck: false,
			expoDoctor: false,
			csharp: {
				projectEvaluation: true,
				jb: false,
				roslynator: true,
				jbSeverityFloor: "WARNING",
				jbExcludeTypes: [],
			},
		},
	},
});

// A restored project (obj/project.assets.json present) so the fallback path
// considers it a valid per-project analyze target.
const writeRestoredProject = (root: string, name: string): string => {
	const projectDirectory = path.join(root, name);
	fs.mkdirSync(projectDirectory, { recursive: true });
	const csprojPath = path.join(projectDirectory, `${name}.csproj`);
	fs.writeFileSync(csprojPath, "<Project />\n");
	fs.mkdirSync(path.join(projectDirectory, "obj"), { recursive: true });
	fs.writeFileSync(path.join(projectDirectory, "obj", "project.assets.json"), "{}\n");
	return csprojPath;
};

const outputPathFromArgs = (args: string[]): string => {
	const index = args.indexOf("--output");
	if (index === -1) throw new Error("--output not found in roslynator args");
	return args[index + 1];
};

const roslynatorXml = (absoluteFilePath: string): string =>
	[
		"<Roslynator><CodeAnalysis><Diagnostics>",
		'<Diagnostic Id="AsyncFixer01">',
		"<Severity>Warning</Severity>",
		"<Message>Unnecessary async/await usage.</Message>",
		`<FilePath>${absoluteFilePath}</FilePath>`,
		'<Location Line="3" Character="5" />',
		"</Diagnostic>",
		"</Diagnostics></CodeAnalysis></Roslynator>",
	].join("");

describe("runDotnetLint - solution-level analyze failure (regression for #dotnet-analyze-swallowed)", () => {
	let root: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-dotnet-fallback-"));
		fs.writeFileSync(path.join(root, "App.sln"), "");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each(["cold", "capped"])("retains solution failure when fallback is %s", async (mode) => {
		writeRestoredProject(root, "Warm");
		if (mode === "cold") {
			fs.mkdirSync(path.join(root, "Cold"));
			fs.writeFileSync(path.join(root, "Cold", "Cold.csproj"), "<Project />");
		} else {
			for (let index = 0; index < 32; index++) writeRestoredProject(root, `Project${index}`);
		}
		runSubprocess.mockImplementation(async (_command: string, arguments_: string[]) => {
			if (arguments_[1].endsWith(".csproj"))
				fs.writeFileSync(outputPathFromArgs(arguments_), "<Roslynator />");
			return { stdout: "", stderr: "load failed", exitCode: 0 };
		});
		const result = await runDotnetLint(csharpContext(root));
		expect(result.failures).toEqual([
			expect.objectContaining({ tool: "roslynator", target: "App.sln" }),
		]);
	});

	it("retains good fallback findings alongside failed targets", async () => {
		writeRestoredProject(root, "One");
		writeRestoredProject(root, "Two");
		runSubprocess.mockImplementation(async (_command: string, arguments_: string[]) => {
			if (arguments_[1].endsWith(`${path.sep}One.csproj`)) {
				fs.writeFileSync(
					outputPathFromArgs(arguments_),
					roslynatorXml(path.join(root, "One", "Foo.cs")),
				);
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const result = await runDotnetLint(csharpContext(root));
		expect(result.diagnostics).toEqual([expect.objectContaining({ rule: "dotnet/AsyncFixer01" })]);
		expect(result.failures).toEqual([expect.objectContaining({ target: "Two/Two.csproj" })]);
	});

	it.each(["missing-binary", "unreadable", "direct-project", "setup-error"])(
		"retains %s failures",
		async (mode) => {
			if (mode === "direct-project") {
				fs.unlinkSync(path.join(root, "App.sln"));
				writeRestoredProject(root, "Direct");
			}
			const originalMkdtempSync = fs.mkdtempSync;
			if (mode === "setup-error") {
				vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix) => {
					if (typeof prefix === "string" && prefix.includes("aislop-roslynator-")) {
						throw new Error("ENOSPC: no space left on device, mkdtemp");
					}
					return originalMkdtempSync(prefix);
				});
			}
			try {
				runSubprocess.mockImplementation(async (_command: string, arguments_: string[]) => {
					if (mode === "unreadable") {
						fs.mkdirSync(outputPathFromArgs(arguments_));
						return { stdout: "", stderr: "", exitCode: 0 };
					}
					throw new Error(
						mode === "missing-binary" ? "spawn roslynator ENOENT" : "workspace load failed",
					);
				});
				const result = await runDotnetLint(csharpContext(root));
				expect(result.failures).toEqual([
					expect.objectContaining({
						tool: "roslynator",
						target: mode === "direct-project" ? "Direct/Direct.csproj" : "App.sln",
						reason: expect.any(String),
					}),
				]);
			} finally {
				vi.restoreAllMocks();
			}
		},
	);

	it("warns instead of silently reporting a clean scan when roslynator crashes at solution load and writes no report", async () => {
		// Simulates roslynator crashing while loading the .sln (e.g. the SDK 10
		// MissingFieldException): it exits non-zero and never writes the report
		// XML. With no restored .csproj on disk there is nothing to fall back to.
		runSubprocess.mockResolvedValueOnce({
			stdout: "",
			stderr: "boom: MissingFieldException",
			exitCode: 1,
		});
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { diagnostics, failures } = await runDotnetLint(csharpContext(root));

		expect(diagnostics).toEqual([]);
		expect(failures).toEqual([
			expect.objectContaining({
				tool: "roslynator",
				target: "App.sln",
				reason: expect.stringContaining(
					"no report written (exit code 1): boom: MissingFieldException",
				),
			}),
		]);
		// The final failure block reports it once; no per-target stderr line duplicates it.
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("falls back to per-project analyze and recovers findings when solution-level analyze fails", async () => {
		const csprojPath = writeRestoredProject(root, "Proj");
		const filePath = path.join(root, "Proj", "Foo.cs");

		runSubprocess
			// Solution-level pass: crashes, no report written.
			.mockResolvedValueOnce({ stdout: "", stderr: "boom: MissingFieldException", exitCode: 1 })
			// Per-project fallback pass: succeeds and writes a real report.
			.mockImplementationOnce(async (_command: string, args: string[]) => {
				fs.writeFileSync(outputPathFromArgs(args), roslynatorXml(filePath), "utf-8");
				return { stdout: "", stderr: "", exitCode: 0 };
			});
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { diagnostics, failures, executions } = await runDotnetLint(csharpContext(root));
		expect(failures).toEqual([]);
		expect(executions?.[0]?.targets).toEqual(["App.sln", "Proj/Proj.csproj"]);
		expect(executions?.[0]?.analyzedProjects).toEqual(["Proj/Proj.csproj"]);
		expect(executions?.[0]?.status).toBe("ran");

		expect(runSubprocess).toHaveBeenCalledTimes(2);
		const secondCallArgs = runSubprocess.mock.calls[1][1] as string[];
		expect(secondCallArgs).toContain(csprojPath);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: "dotnet/AsyncFixer01",
			filePath: "Proj/Foo.cs",
		});
		expect(
			warnSpy.mock.calls.some(
				(call) =>
					String(call[0]).includes("falling back") &&
					String(call[0]).includes("MissingFieldException"),
			),
		).toBe(true);
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("was skipped"))).toBe(false);
		warnSpy.mockRestore();
	});

	// roslynator writes --output only when it found a diagnostic, so a clean analysis
	// exits 0, prints the zero summary on stdout, and leaves no report behind.
	const cleanRunStdout = [
		"Loading solution 'App.sln'...",
		"Analyze 'App'",
		"Analyzed project 'App.csproj' (in 4.0 s)",
		"",
		"0 diagnostics found",
		"",
	].join("\r\n");

	it("records a clean run when roslynator exits 0 with its zero summary and no report", async () => {
		writeRestoredProject(root, "App");
		runSubprocess.mockResolvedValue({ stdout: cleanRunStdout, stderr: "", exitCode: 0 });

		const { diagnostics, failures, executions } = await runDotnetLint(csharpContext(root));

		expect(failures).toEqual([]);
		expect(diagnostics).toEqual([]);
		expect(executions?.[0]?.status).toBe("ran");
		expect(runSubprocess).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ label: "a nonzero exit", stdout: cleanRunStdout, exitCode: 2 },
		{ label: "a nonzero count", stdout: "Analyze 'App'\r\n10 diagnostics found\r\n", exitCode: 0 },
		{ label: "no summary line", stdout: "Analyze 'App'\r\n", exitCode: 0 },
	])("keeps a missing report as a failure with $label", async ({ stdout, exitCode }) => {
		runSubprocess.mockResolvedValue({ stdout, stderr: "", exitCode });

		const { failures } = await runDotnetLint(csharpContext(root));

		expect(failures).toEqual([
			expect.objectContaining({
				tool: "roslynator",
				target: "App.sln",
				reason: expect.stringContaining(`no report written (exit code ${exitCode})`),
			}),
		]);
	});

	it("truncates tool output copied into a failure reason", async () => {
		runSubprocess.mockResolvedValueOnce({ stdout: "", stderr: "x".repeat(5000), exitCode: 1 });
		const { failures } = await runDotnetLint(csharpContext(root));
		expect(failures).toHaveLength(1);
		expect(failures[0].reason.length).toBeLessThan(500);
		expect(failures[0].reason).toContain("[truncated 4700 characters]");
	});

	it("skips per-project fallback when solution-level analyze times out", async () => {
		writeRestoredProject(root, "Proj");
		runSubprocess.mockRejectedValueOnce(new Error("Command timed out after 180000ms: roslynator"));
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { diagnostics, failures } = await runDotnetLint(csharpContext(root));
		expect(failures).toEqual([
			expect.objectContaining({ reason: expect.stringContaining("timed out") }),
		]);

		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(diagnostics).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
