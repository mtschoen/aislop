import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeScanExitCode } from "../src/commands/scan-exit-code.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
	checkSolutionCoverage,
	listSolutionMembersWithDotnet,
	type SolutionMemberLister,
} from "../src/engines/lint/csharp-coverage.js";
import {
	type CsharpProjectInventory,
	createCsharpProjectInventory,
} from "../src/engines/lint/csharp-execution.js";
import { runDotnetLint } from "../src/engines/lint/dotnet.js";
import type { EngineContext } from "../src/engines/types.js";

const { subprocess } = vi.hoisted(() => ({ subprocess: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	// Only the end-to-end tests below opt into the mock; the real-dotnet test
	// calls actual.runSubprocess through the "real" switch.
	return {
		...actual,
		runSubprocess: (...callArguments: Parameters<typeof actual.runSubprocess>) =>
			subprocess.getMockImplementation()
				? subprocess(...callArguments)
				: actual.runSubprocess(...callArguments),
	};
});
vi.mock("../src/utils/tooling.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tooling.js")>()),
	resolveToolBinary: (name: string) => name,
	resolveBundledAnalyzerAssemblies: () => [],
}));

const CLEAN_RUN = { stdout: "0 diagnostics found", stderr: "", exitCode: 0 };
const dotnetAvailable = spawnSync("dotnet", ["--version"], { stdio: "ignore" }).status === 0;

const members =
	(...projects: string[]): SolutionMemberLister =>
	async () => ({ ok: true, projects });

const inventoryWith = (overrides: Partial<CsharpProjectInventory> = {}): CsharpProjectInventory =>
	({
		rootDirectory: "/repo",
		allProjects: [],
		visibleProjects: [],
		visibleProjectsSet: new Set(),
		excludedProjects: [],
		excludedProjectsSet: new Set(),
		gitIgnoredProjects: [],
		solutionCache: new Map(),
		...overrides,
	}) as CsharpProjectInventory;

const coverage = (analyzed: string[], lister: SolutionMemberLister, inventory = inventoryWith()) =>
	checkSolutionCoverage({
		tool: "roslynator",
		rootDirectory: path.resolve("/repo"),
		solutionPath: path.resolve("/repo/App.sln"),
		inventory,
		analyzedProjects: analyzed,
		lister,
	});

describe("C# pass solution coverage guard", () => {
	it("passes when every solution project was analyzed", async () => {
		expect(
			await coverage(
				["One/One.csproj", "Two/Two.csproj"],
				members("One/One.csproj", "Two/Two.csproj"),
			),
		).toBeNull();
	});

	it("fails naming the one project the pass did not analyze", async () => {
		const failure = await coverage(["One/One.csproj"], members("One/One.csproj", "Two/Two.csproj"));
		expect(failure).toEqual({
			tool: "roslynator",
			target: "App.sln",
			reason: expect.stringContaining("Two/Two.csproj"),
		});
		expect(failure?.reason).not.toContain("One/One.csproj");
	});

	it("does not count user-excluded or gitignored projects as missing", async () => {
		const inventory = inventoryWith({
			excludedProjects: ["Excluded/Excluded.csproj"],
			gitIgnoredProjects: ["Ignored/Ignored.csproj"],
		});
		const lister = members("One/One.csproj", "Excluded/Excluded.csproj", "Ignored/Ignored.csproj");
		expect(await coverage(["One/One.csproj"], lister, inventory)).toBeNull();
	});

	it("ignores members that are not C# projects", async () => {
		expect(
			await coverage(
				["One/One.csproj"],
				members("One/One.csproj", "Native/Native.vcxproj", "Db/Db.sqlproj"),
			),
		).toBeNull();
	});

	it("fails closed when the solution members cannot be listed", async () => {
		const failure = await coverage(["One/One.csproj"], async () => ({
			ok: false,
			reason: "dotnet sln list exited 1: Invalid solution",
		}));
		expect(failure?.reason).toContain("completeness unverified");
		expect(failure?.reason).toContain("Invalid solution");
	});

	it("honors the inScope narrowing", async () => {
		const failure = await coverage(["One/One.csproj"], members("One/One.csproj", "Two/Two.csproj"));
		expect(failure).not.toBeNull();
		const scoped = await checkSolutionCoverage({
			tool: "jb inspectcode",
			rootDirectory: path.resolve("/repo"),
			solutionPath: path.resolve("/repo/App.sln"),
			inventory: inventoryWith(),
			analyzedProjects: ["One/One.csproj"],
			inScope: (project) => project.startsWith("One/"),
			lister: members("One/One.csproj", "Two/Two.csproj"),
		});
		expect(scoped).toBeNull();
	});

	it("is a scan failure that does not touch the score gate", () => {
		expect(
			computeScanExitCode({
				hasErrors: false,
				hasEngineFailures: true,
				scoreable: true,
				score: 100,
				failBelow: 0,
			}),
		).toBe(1);
	});
});

describe("dotnet sln list member reader", () => {
	afterEach(() => {
		subprocess.mockReset();
	});

	const solutionPath = path.resolve("/repo/src/App.sln");

	it("maps listed paths to repository-relative POSIX paths", async () => {
		subprocess.mockResolvedValue({
			stdout: "Project(s)\n----------\nOne\\One.csproj\nTwo/Two.csproj\n",
			stderr: "",
			exitCode: 0,
		});
		expect(await listSolutionMembersWithDotnet(solutionPath, path.resolve("/repo"))).toEqual({
			ok: true,
			projects: ["src/One/One.csproj", "src/Two/Two.csproj"],
		});
		const options = subprocess.mock.calls[0][2];
		expect(options.timeout).toBeGreaterThan(0);
	});

	it("reads an empty solution", async () => {
		subprocess.mockResolvedValue({
			stdout: "No projects found in the solution.",
			stderr: "",
			exitCode: 0,
		});
		expect(await listSolutionMembersWithDotnet(solutionPath, path.resolve("/repo"))).toEqual({
			ok: true,
			projects: [],
		});
	});

	it.each([
		["a nonzero exit", { stdout: "", stderr: "boom", exitCode: 1 }],
		["unrecognized output", { stdout: "something else entirely", stderr: "", exitCode: 0 }],
		["dashed garbage without heading (finding 1)", { stdout: "garbage\n----------\n", stderr: "", exitCode: 0 }],
		[
			"misleading empty-solution prefix (finding 2)",
			{ stdout: "No projects found but not a recognized SDK message", stderr: "", exitCode: 0 },
		],
	])("fails closed on %s", async (_label, result) => {
		subprocess.mockResolvedValue(result);
		expect((await listSolutionMembersWithDotnet(solutionPath, path.resolve("/repo"))).ok).toBe(
			false,
		);
	});

	it("fails closed when the subprocess rejects (missing dotnet or timeout)", async () => {
		subprocess.mockRejectedValue(new Error("Command timed out after 60000ms: dotnet"));
		const result = await listSolutionMembersWithDotnet(solutionPath, path.resolve("/repo"));
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("timed out") });
	});
});

describe("roslynator pass against a solution with an unanalyzed member", () => {
	let root: string;
	let context: EngineContext;
	beforeEach(() => {
		subprocess.mockReset();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-coverage-"));
		for (const name of ["One", "Two"]) {
			fs.mkdirSync(path.join(root, name, "obj"), { recursive: true });
			fs.writeFileSync(path.join(root, name, `${name}.csproj`), "<Project />");
			fs.writeFileSync(path.join(root, name, "obj", "project.assets.json"), "{}");
		}
		// The text reader sees only One; the SDK parser sees both.
		fs.writeFileSync(
			path.join(root, "App.sln"),
			'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "One", "One/One.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject\n',
		);
		const configuration = structuredClone(DEFAULT_CONFIG);
		configuration.lint.csharp = {
			projectEvaluation: true,
			roslynator: true,
			jb: false,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};
		context = {
			rootDirectory: root,
			languages: ["csharp"],
			frameworks: [],
			installedTools: { roslynator: true },
			config: {
				quality: configuration.quality,
				security: configuration.security,
				lint: configuration.lint,
			},
		};
		subprocess.mockImplementation(async (command: string) => {
			if (command === "dotnet") {
				return {
					stdout: "Project(s)\n----------\nOne/One.csproj\nTwo/Two.csproj\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return CLEAN_RUN;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reports the pass failed with an engine failure naming the missing project", async () => {
		const result = await runDotnetLint(context);
		expect(result.failures).toEqual([
			{
				tool: "roslynator",
				target: "App.sln",
				reason: expect.stringContaining("Two/Two.csproj"),
			},
		]);
		expect(result.diagnostics).toEqual([]);
		expect(result.executions?.[0]).toMatchObject({ status: "failed" });
		expect(result.executions?.[0].reason).toContain("Two/Two.csproj");
	});

	it("fails closed when dotnet sln list fails", async () => {
		subprocess.mockImplementation(async (command: string) => {
			if (command === "dotnet") return { stdout: "", stderr: "bad solution", exitCode: 1 };
			return CLEAN_RUN;
		});
		const result = await runDotnetLint(context);
		expect(result.failures[0].reason).toContain("completeness unverified");
		expect(result.executions?.[0].status).toBe("failed");
	});

	it("passes when the excluded project is the only unanalyzed member", async () => {
		subprocess.mockImplementation(async (command: string) => {
			if (command === "dotnet") {
				return {
					stdout: "Project(s)\n----------\nOne/One.csproj\nTwo/Two.csproj\nVendor/Missing.csproj\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return CLEAN_RUN;
		});
		const excludedContext: EngineContext = {
			...context,
			excludePatterns: ["Two/**", "Vendor/**"],
		};
		const result = await runDotnetLint(excludedContext);
		expect(result.failures).toEqual([]);
		expect(result.executions?.[0]).toMatchObject({
			status: "ran",
			excludedProjects: ["Two/Two.csproj"],
		});
	});

	it("passes when the unanalyzed member is gitignored", async () => {
		subprocess.mockImplementation(async (command: string) => {
			if (command === "dotnet") {
				return {
					stdout: "Project(s)\n----------\nOne/One.csproj\nTwo/Two.csproj\nVendor/Missing.csproj\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return CLEAN_RUN;
		});
		spawnSync("git", ["init", "-q"], { cwd: root });
		fs.writeFileSync(path.join(root, ".gitignore"), "Two/\nVendor/\n");
		const inventory = createCsharpProjectInventory(context);
		expect(inventory.gitIgnoredProjects).toEqual(["Two/Two.csproj"]);
		const result = await runDotnetLint(context, inventory);
		expect(result.failures).toEqual([]);
		expect(result.executions?.[0].status).toBe("ran");
	});
});

describe.skipIf(!dotnetAvailable)("real dotnet sln list", () => {
	let root: string;
	beforeEach(() => {
		subprocess.mockReset();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-real-sln-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reads .slnx single-quoted Path and whitespace around =", async () => {
		for (const name of ["One", "Two", "Three"]) {
			fs.mkdirSync(path.join(root, name), { recursive: true });
			fs.writeFileSync(
				path.join(root, name, `${name}.csproj`),
				'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
			);
		}
		fs.writeFileSync(
			path.join(root, "App.slnx"),
			[
				"<Solution>",
				"  <Project Path='One/One.csproj' />",
				'  <Project Path = "Two/Two.csproj" />',
				'  <Folder Name="/Group/">',
				"    <Project Path  =  'Three/Three.csproj' />",
				"  </Folder>",
				"</Solution>",
			].join("\n"),
		);
		const result = await listSolutionMembersWithDotnet(path.join(root, "App.slnx"), root);
		expect(result).toEqual({
			ok: true,
			projects: expect.arrayContaining(["One/One.csproj", "Two/Two.csproj", "Three/Three.csproj"]),
		});
		const failure = await checkSolutionCoverage({
			tool: "jb inspectcode",
			rootDirectory: root,
			solutionPath: path.join(root, "App.slnx"),
			inventory: createCsharpProjectInventory({ rootDirectory: root }),
			analyzedProjects: ["One/One.csproj", "Two/Two.csproj"],
		});
		expect(failure?.reason).toContain("Three/Three.csproj");
	}, 60000);

	it("fails closed on a solution the SDK cannot read", async () => {
		fs.writeFileSync(path.join(root, "Broken.slnx"), "<Solution><Project");
		const result = await listSolutionMembersWithDotnet(path.join(root, "Broken.slnx"), root);
		expect(result.ok).toBe(false);
	}, 60000);
});
