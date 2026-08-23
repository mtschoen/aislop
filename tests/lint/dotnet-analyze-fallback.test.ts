import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/utils/subprocess.js")>();
	return { ...actual, runSubprocess };
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

	it("warns instead of silently reporting a clean scan when roslynator crashes at solution load and writes no report", async () => {
		// Simulates roslynator crashing while loading the .sln (e.g. the SDK 10
		// MissingFieldException): it exits non-zero and never writes the report
		// XML. With no restored .csproj on disk there is nothing to fall back to.
		runSubprocess.mockResolvedValueOnce({ stdout: "", stderr: "boom: MissingFieldException", exitCode: 1 });
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const diagnostics = await runDotnetLint(csharpContext(root));

		expect(diagnostics).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("roslynator"))).toBe(true);
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("no report written"))).toBe(
			true,
		);
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

		const diagnostics = await runDotnetLint(csharpContext(root));

		expect(runSubprocess).toHaveBeenCalledTimes(2);
		const secondCallArgs = runSubprocess.mock.calls[1][1] as string[];
		expect(secondCallArgs).toContain(csprojPath);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: "dotnet/AsyncFixer01",
			filePath: "Proj/Foo.cs",
		});
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("roslynator"))).toBe(true);
		warnSpy.mockRestore();
	});

	it("skips per-project fallback when solution-level analyze times out", async () => {
		writeRestoredProject(root, "Proj");
		runSubprocess.mockRejectedValueOnce(
			new Error("Command timed out after 180000ms: roslynator"),
		);
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const diagnostics = await runDotnetLint(csharpContext(root));

		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(diagnostics).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
		expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("timed out"))).toBe(true);
		warnSpy.mockRestore();
	});
});
