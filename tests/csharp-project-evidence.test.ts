import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { runDotnetLint } from "../src/engines/lint/dotnet.js";
import { runJbLint } from "../src/engines/lint/jb.js";
import type { EngineContext } from "../src/engines/types.js";

const { subprocess } = vi.hoisted(() => ({ subprocess: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/subprocess.js")>()),
	runSubprocess: subprocess,
}));
vi.mock("../src/utils/tooling.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tooling.js")>()),
	resolveToolBinary: (name: string) => name,
	resolveBundledAnalyzerAssemblies: () => [],
	resolveBundledJbSettings: () => null,
}));

describe.each(["jb inspectcode", "roslynator"] as const)(
	"%s project evidence (issue 144)",
	(tool) => {
		let root: string;
		let context: EngineContext;
		let projects: string[];
		let stdout: string;
		let listFailure: boolean;
		const evidence = (name: string) =>
			tool === "jb inspectcode" ? `Inspecting ${name}.csproj` : `Analyze '${name}' 1/3`;
		const run = () =>
			tool === "jb inspectcode"
				? runJbLint(context, { includeCsharp: true, includeCpp: false })
				: runDotnetLint(context);
		const writeSolution = (members: string[]) =>
			fs.writeFileSync(
				path.join(root, "App.sln"),
				members
					.map(
						(project, index) =>
							`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${path.basename(project, ".csproj")}", "${project}", "{${String(index).padStart(8, "0")}-1111-1111-1111-111111111111}"\nEndProject\n`,
					)
					.join(""),
			);
		const createProject = (directory: string, projectFile: string) => {
			fs.mkdirSync(path.join(root, directory, "obj"), { recursive: true });
			fs.writeFileSync(path.join(root, directory, projectFile), "<Project />");
			fs.writeFileSync(path.join(root, directory, "obj/project.assets.json"), "{}");
		};

		beforeEach(() => {
			subprocess.mockReset();
			root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-project-evidence-"));
			projects = ["Good/Good.csproj", "Clean/Clean.csproj", "Broken/Broken.csproj"];
			for (const project of projects) {
				fs.mkdirSync(path.join(root, path.dirname(project), "obj"), { recursive: true });
				fs.writeFileSync(path.join(root, project), "<Project />");
				fs.writeFileSync(path.join(root, path.dirname(project), "obj/project.assets.json"), "{}");
			}
			writeSolution(projects);
			const configuration = structuredClone(DEFAULT_CONFIG);
			configuration.lint.csharp = {
				projectEvaluation: true,
				jb: true,
				roslynator: true,
				jbSeverityFloor: "WARNING",
				jbExcludeTypes: [],
			};
			context = {
				rootDirectory: root,
				languages: ["csharp"],
				frameworks: [],
				installedTools: { jb: true, roslynator: true },
				config: {
					quality: configuration.quality,
					security: configuration.security,
					lint: configuration.lint,
				},
			};
			stdout = [evidence("Good"), evidence("Clean"), evidence("Broken")].join("\r\n");
			listFailure = false;
			subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
				if (command === "dotnet")
					return listFailure
						? { stdout: "", stderr: "bad solution", exitCode: 1 }
						: {
								stdout: `Project(s)\n----------\n${projects.join("\n")}\n`,
								stderr: "",
								exitCode: 0,
							};
				const output =
					arguments_.find((argument) => argument.startsWith("--output="))?.slice(9) ??
					arguments_[arguments_.indexOf("--output") + 1];
				fs.writeFileSync(
					output,
					command === "jb" ? "<Report><Issues /></Report>" : "<Roslynator />",
				);
				return { stdout, stderr: "", exitCode: 0 };
			});
		});
		afterEach(() => {
			fs.rmSync(root, { recursive: true, force: true });
		});

		it.each(["single-target", "multi-target", "parenthesized-name"])(
			"credits every SDK-listed %s member with evidence (issue 144)",
			async (targeting) => {
				if (targeting === "multi-target") {
					fs.renameSync(path.join(root, "Clean"), path.join(root, "Multi"));
					fs.renameSync(path.join(root, "Multi/Clean.csproj"), path.join(root, "Multi/Multi.csproj"));
					projects[1] = "Multi/Multi.csproj";
					stdout =
						tool === "roslynator"
							? [
									evidence("Good"),
									"Analyze 'Multi(net9.0)' 2/3",
									"Analyze 'Multi(net10.0)' 3/3",
									evidence("Broken"),
								].join("\n")
							: [evidence("Good"), evidence("Multi"), evidence("Multi"), evidence("Broken")].join("\n");
				} else if (targeting === "parenthesized-name") {
					fs.renameSync(path.join(root, "Clean"), path.join(root, "Foo(Bar)"));
					fs.renameSync(
						path.join(root, "Foo(Bar)/Clean.csproj"),
						path.join(root, "Foo(Bar)/Foo(Bar).csproj"),
					);
					projects[1] = "Foo(Bar)/Foo(Bar).csproj";
					stdout = [evidence("Good"), evidence("Foo(Bar)"), evidence("Broken")].join("\n");
				}
				// Deliberately lists only Good: the SDK member list must be authoritative.
				writeSolution([projects[0]]);
				const result = await run();
				expect(result.failures).toEqual([]);
				expect(result.executions?.[0]).toMatchObject({
					status: "ran",
					analyzedProjects: [...projects].sort(),
				});
				const analyzerCalls = subprocess.mock.calls.filter(([command]) => command !== "dotnet");
				expect(analyzerCalls).toHaveLength(1);
				if (tool === "roslynator")
					expect(analyzerCalls[0][1]).toEqual(expect.arrayContaining(["--verbosity", "detailed"]));
			},
		);

		it.each([
			[
				"absent analysis line",
				() => [
					evidence("Good"),
					evidence("Clean"),
					"Analyzing Broken.csproj",
					"Analyzed project 'Broken'",
				],
				["Clean/Clean.csproj", "Good/Good.csproj"],
				"Broken/Broken.csproj",
			],
			[
				"parenthesized sibling collision (issue 144)",
				() => {
					createProject("Foo", "Foo.csproj");
					createProject("Foo(Bar)", "Foo(Bar).csproj");
					projects.push("Foo/Foo.csproj", "Foo(Bar)/Foo(Bar).csproj");
					return [evidence("Good"), evidence("Clean"), evidence("Broken"), evidence("Foo(Bar)")];
				},
				tool === "roslynator"
					? ["Broken/Broken.csproj", "Clean/Clean.csproj", "Good/Good.csproj"]
					: [
							"Broken/Broken.csproj",
							"Clean/Clean.csproj",
							"Foo(Bar)/Foo(Bar).csproj",
							"Good/Good.csproj",
						],
				"Foo/Foo.csproj",
			],
		])("fails when a member is uncredited via %s", async (_label, buildLines, expectedAnalyzed, missingProject) => {
			stdout = buildLines().join("\n");
			const result = await run();
			expect(result.executions?.[0]).toMatchObject({
				status: "failed",
				analyzedProjects: expectedAnalyzed,
			});
			expect(result.failures).toContainEqual(
				expect.objectContaining({ tool, reason: expect.stringContaining(missingProject) }),
			);
		});

		it("fails naming the tool when no per-project evidence is present", async () => {
			stdout = "0 diagnostics found";
			const result = await run();
			expect(result.executions?.[0]).toMatchObject({ status: "failed", analyzedProjects: [] });
			expect(
				result.failures.some((failure) =>
					failure.reason.includes(`no per-project evidence in ${tool} output`),
				),
			).toBe(true);
		});

		it("rejects duplicate project file names as unattributable", async () => {
			projects.push("Other/Good.csproj");
			writeSolution(projects);
			fs.mkdirSync(path.join(root, "Other/obj"), { recursive: true });
			fs.writeFileSync(path.join(root, "Other/Good.csproj"), "<Project />");
			fs.writeFileSync(path.join(root, "Other/obj/project.assets.json"), "{}");
			const result = await run();
			expect(result.executions?.[0]).toMatchObject({
				status: "failed",
				analyzedProjects: ["Broken/Broken.csproj", "Clean/Clean.csproj"],
			});
			expect(result.executions?.[0].reason).toContain("duplicate project file names");
			expect(result.executions?.[0].reason).toContain("Other/Good.csproj");
		});

		it("preserves the guard failure when SDK member listing fails", async () => {
			listFailure = true;
			const result = await run();
			expect(result.executions?.[0]).toMatchObject({ status: "failed", analyzedProjects: [] });
			expect(result.executions?.[0].reason).toContain("completeness unverified");
		});

		it("ignores absent gitignored members before checking duplicate file names", async () => {
			expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
			fs.writeFileSync(path.join(root, ".gitignore"), "Vendor/\n");
			projects.push("Vendor/Good.csproj");
			const result = await run();
			expect(result.failures).toEqual([]);
			expect(result.executions?.[0]).toMatchObject({
				status: "ran",
				analyzedProjects: ["Broken/Broken.csproj", "Clean/Clean.csproj", "Good/Good.csproj"],
			});
		});

		it.each(["/", "\\"])("handles MSBuild failure paths with %s separators", async (separator) => {
			const brokenPath = path.join(root, "Broken/Broken.csproj").replace(/[/\\]/g, separator);
			if (tool === "roslynator")
				stdout = [
					evidence("Good"),
					evidence("Clean"),
					"Analyze 'Broken(net9.0)' 3/4",
					"Analyze 'Broken(net10.0)' 4/4",
				].join("\n");
			stdout += `\n  Msbuild failed when processing the file '${brokenPath}' with message: The referenced project Missing/Missing.csproj does not exist.`;
			const result = await run();
			if (tool === "roslynator") {
				expect(result.executions?.[0]).toMatchObject({
					status: "failed",
					analyzedProjects: ["Clean/Clean.csproj", "Good/Good.csproj"],
				});
				expect(result.executions?.[0].reason).toContain("Broken/Broken.csproj");
			} else {
				// jb inspection proves coverage, not dependency health.
				expect(result.failures).toEqual([]);
				expect(result.executions?.[0].analyzedProjects).toEqual([...projects].sort());
			}
		});
	},
);
