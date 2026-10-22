import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
	buildExecution,
	type CsharpProjectInventory,
	getSolutionIndex,
	resolveReportedProject,
} from "../src/engines/lint/csharp-execution.js";
import { runDotnetLint } from "../src/engines/lint/dotnet.js";
import { lintEngine } from "../src/engines/lint/index.js";
import type { EngineContext, EngineResult } from "../src/engines/types.js";
import { buildJsonOutput } from "../src/output/json.js";
import { buildSarifLog } from "../src/output/sarif.js";

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

const JB_REPORT =
	'<Report><Issues><Project Name="DisplayName"></Project><Project Name="Two"></Project><Project Name="App"></Project><Project Name="CppApp"></Project></Issues></Report>';

const outputFlag = (arguments_: string[]): string => {
	const equals = arguments_.find((value) => value.startsWith("--output="));
	return equals ? equals.slice("--output=".length) : arguments_[arguments_.indexOf("--output") + 1];
};

const createProject = (root: string, directory: string, projectFile: string) => {
	fs.mkdirSync(path.join(root, directory, "obj"), { recursive: true });
	fs.writeFileSync(path.join(root, directory, projectFile), "<Project />");
	fs.writeFileSync(path.join(root, directory, "obj", "project.assets.json"), "{}");
};

describe("C# pass execution record", () => {
	let root: string;
	let context: EngineContext;
	const toolRecord = (result: EngineResult, tool: string) =>
		result.executions?.find((execution) => execution.tool === tool);

	beforeEach(() => {
		vi.resetAllMocks();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-pass-record-"));
		createProject(root, "One", "One.csproj");
		createProject(root, "Two", "Two.csproj");
		createProject(root, "A", "App.csproj");
		createProject(root, "B", "App.csproj");
		createProject(root, "Orphan", "Orphan.csproj");
		fs.writeFileSync(
			path.join(root, "App.sln"),
			[
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DisplayName", "One\\One.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Two", "Two\\Two.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
				'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "B\\App.csproj", "{33333333-3333-3333-3333-333333333333}"\nEndProject',
				'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "CppApp", "Cpp\\Cpp.vcxproj", "{44444444-4444-4444-4444-444444444444}"\nEndProject',
			].join("\n"),
		);
		const configuration = structuredClone(DEFAULT_CONFIG);
		configuration.lint.csharp = {
			projectEvaluation: true,
			roslynator: true,
			jb: true,
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
		subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
			fs.writeFileSync(outputFlag(arguments_), command === "jb" ? JB_REPORT : "<Roslynator />");
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	const jsonLint = (result: EngineResult) =>
		buildJsonOutput([result], { score: 100, label: "Excellent" }, 0, 1, {
			scoreable: true,
		} as never).engines.lint;

	it.each([
		[
			"standard .sln with commented orphan, root managed alias, and mixed-language collisions (issue 118 findings 2, 3, 4, 7)",
			"App.sln",
			(testRoot: string) => {
				createProject(testRoot, "", "App.csproj");
				createProject(testRoot, "Managed", "Managed.csproj");
				createProject(testRoot, "Native", "Native.vcxproj");
				createProject(testRoot, "Native", "App.vcxproj");
				return [
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DisplayName", "One\\One.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Two", "Two\\Two.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Managed", "App.csproj", "{33333333-3333-3333-3333-333333333333}"\nEndProject',
					'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "App", "Native\\Native.vcxproj", "{44444444-4444-4444-4444-444444444444}"\nEndProject',
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Collide", "Managed\\Managed.csproj", "{55555555-5555-5555-5555-555555555555}"\nEndProject',
					'Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "NativeOther", "Native\\Collide.vcxproj", "{66666666-6666-6666-6666-666666666666}"\nEndProject',
					'# Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Orphan", "Orphan\\Orphan.csproj", "{77777777-7777-7777-7777-777777777777}"\n# EndProject',
				].join("\n");
			},
			'<Report><Issues><Project Name="DisplayName"></Project><Project Name="Two"></Project><Project Name="App"></Project><Project Name="Collide"></Project></Issues></Report>',
			["App.csproj", "Managed/Managed.csproj", "One/One.csproj", "Two/Two.csproj"],
			["App.csproj", "Managed/Managed.csproj", "One/One.csproj", "Two/Two.csproj"],
		],
		[
			"single-quoted .slnx (issue 118 finding 4)",
			"App.slnx",
			() =>
				"<Solution><Project Path='One/One.csproj' DisplayName='DisplayName' /><Project Path='Two/Two.csproj' DisplayName='Two' /></Solution>",
			'<Report><Issues><Project Name="DisplayName"></Project><Project Name="Two"></Project></Issues></Report>',
			["One/One.csproj", "Two/Two.csproj"],
			["One/One.csproj", "Two/Two.csproj"],
		],
		[
			"cross-index display-name and basename collision in .sln (issue 118 finding 6)",
			"App.sln",
			(testRoot: string) => {
				createProject(testRoot, "A", "Different.csproj");
				createProject(testRoot, "B", "App.csproj");
				return [
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "One", "One\\One.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "A\\Different.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Second", "B\\App.csproj", "{33333333-3333-3333-3333-333333333333}"\nEndProject',
				].join("\n");
			},
			'<Report><Issues><Project Name="One"></Project><Project Name="App"></Project></Issues></Report>',
			["A/Different.csproj", "B/App.csproj", "One/One.csproj"],
			["A/Different.csproj", "B/App.csproj", "One/One.csproj"],
		],
		[
			"whitespace around equals, XML numeric entities, supplementary code points, and escaped attributes in .slnx (issue 118 findings 5, 6, 7, 8, 9, 10, 11)",
			"App.slnx",
			(testRoot: string) => {
				createProject(testRoot, "A&B", "App.csproj");
				createProject(testRoot, "Old", "App.csproj");
				createProject(testRoot, "\u{1F680}Dec", "App.csproj");
				createProject(testRoot, "\u{1F680}Hex", "App.csproj");
				createProject(testRoot, "&#x41;Dir", "App.csproj");
				createProject(testRoot, "&amp;Dec", "App.csproj");
				createProject(testRoot, "&amp;Hex", "App.csproj");
				return [
					"<Solution>",
					'  <!-- <Project Path="Old/App.csproj" DisplayName="Esc&amp;App" /> -->',
					'  <Project Path = "One/One.csproj" DisplayName = "DisplayName" />',
					'  <Project Path = "Two/Two.csproj" DisplayName = "Two" />',
					'  <Project Path = "A&amp;B/App.csproj" DisplayName = "Esc&amp;App" />',
					'  <Project Path="&#128640;Dec/App.csproj" DisplayName="RocketDec" />',
					'  <Project Path="&#x1F680;Hex/App.csproj" DisplayName="RocketHex" />',
					'  <Project Path="&#38;#x41;Dir/App.csproj" DisplayName="EscapedIntroducer" />',
					'  <Project Path="&#38;amp;Dec/App.csproj" DisplayName="NumericAmpDec" />',
					'  <Project Path="&#x26;amp;Hex/App.csproj" DisplayName="NumericAmpHex" />',
					"</Solution>",
				].join("\n");
			},
			'<Report><Issues><Project Name="DisplayName"></Project><Project Name="Two"></Project><Project Name="Esc&amp;App"></Project><Project Name="RocketDec"></Project><Project Name="RocketHex"></Project><Project Name="EscapedIntroducer"></Project><Project Name="NumericAmpDec"></Project><Project Name="NumericAmpHex"></Project></Issues></Report>',
			[
				"&#x41;Dir/App.csproj",
				"&amp;Dec/App.csproj",
				"&amp;Hex/App.csproj",
				"A&B/App.csproj",
				"One/One.csproj",
				"Two/Two.csproj",
				"\u{1F680}Dec/App.csproj",
				"\u{1F680}Hex/App.csproj",
			],
			[
				"&#x41;Dir/App.csproj",
				"&amp;Dec/App.csproj",
				"&amp;Hex/App.csproj",
				"A&B/App.csproj",
				"One/One.csproj",
				"Two/Two.csproj",
				"\u{1F680}Dec/App.csproj",
				"\u{1F680}Hex/App.csproj",
			],
		],
	])(
		"records a successful zero with targets and analyzed projects for %s",
		async (_label, solutionFilename, getSolutionContent, jbReportXml, expectedJbAnalyzed, expectedRoslynatorAnalyzed) => {
			if (fs.existsSync(path.join(root, "App.sln"))) fs.unlinkSync(path.join(root, "App.sln"));
			if (fs.existsSync(path.join(root, "App.slnx"))) fs.unlinkSync(path.join(root, "App.slnx"));
			fs.writeFileSync(path.join(root, solutionFilename), getSolutionContent(root));
			subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
				fs.writeFileSync(outputFlag(arguments_), command === "jb" ? jbReportXml : "<Roslynator />");
				return { stdout: "", stderr: "", exitCode: 0 };
			});

			const result = await lintEngine.run(context);
			const lint = jsonLint(result);
			expect(lint.issues).toBe(0);
			const jb = toolRecord(result, "jb inspectcode");
			expect(jb).toEqual(
				expect.objectContaining({
					tool: "jb inspectcode",
					status: "ran",
					targets: [solutionFilename],
					analyzedProjects: expectedJbAnalyzed,
					excludedProjects: [],
					elapsed: expect.any(Number),
				}),
			);
			expect(jb).not.toHaveProperty("reason");

			const roslynator = toolRecord(result, "roslynator");
			expect(roslynator?.status).toBe("ran");
			if (solutionFilename.endsWith(".sln")) {
				expect(roslynator).toEqual(
					expect.objectContaining({
						tool: "roslynator",
						status: "ran",
						targets: [solutionFilename],
						analyzedProjects: expectedRoslynatorAnalyzed,
					}),
				);
			}

			// Scaling guard covering jb and roslynator (issue 118 findings 1, 2, 8, 10, 11, 12)
			const guardCount = 32;
			const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-scaling-guard-"));
			try {
				const projectPaths: string[] = [];
				const slnLines: string[] = [];
				for (let i = 0; i < guardCount; i++) {
					const projRel = `P${i}/P${i}.csproj`;
					createProject(guardRoot, `P${i}`, `P${i}.csproj`);
					projectPaths.push(projRel);
					slnLines.push(
						`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "P${i}", "P${i}\\P${i}.csproj", "{${String(i).padStart(8, "0")}-0000-0000-0000-000000000000}"\nEndProject`,
					);
				}
				const slnPath = path.join(guardRoot, "Scaling.sln");
				fs.writeFileSync(slnPath, slnLines.join("\n"));

				let visibleArrayReads = 0;
				const instrumentedVisible = new Proxy([...projectPaths], {
					get(target, prop, receiver) {
						if (typeof prop === "string" && !Number.isNaN(Number(prop))) {
							visibleArrayReads++;
						}
						return Reflect.get(target, prop, receiver);
					},
				});
				const scalingInventory: CsharpProjectInventory = {
					rootDirectory: guardRoot,
					allProjects: projectPaths,
					visibleProjects: instrumentedVisible,
					visibleProjectsSet: new Set(projectPaths),
					excludedProjects: [],
					excludedProjectsSet: new Set(),
					gitIgnoredProjects: [],
					solutionCache: new Map(),
				};

				for (let i = 0; i < guardCount; i++) {
					const resolved = resolveReportedProject(scalingInventory, "Scaling.sln", `P${i}`);
					expect(resolved).toBe(`P${i}/P${i}.csproj`);
				}
				expect(visibleArrayReads).toBe(0);

				// Real adapter invocation asserting execution record and membership bound (finding 12)
				const guardContext: EngineContext = {
					...context,
					rootDirectory: guardRoot,
				};
				const dotnetResult = await runDotnetLint(guardContext, scalingInventory);
				expect(dotnetResult.executions?.[0]).toEqual(
					expect.objectContaining({
						tool: "roslynator",
						status: "ran",
						targets: ["Scaling.sln"],
						analyzedProjects: [...projectPaths].sort(),
					}),
				);
				expect(visibleArrayReads).toBe(0);

				// Scaling guard with repeated ambiguous display names and candidate-read accounting (finding 1)
				let nameCandidateReads = 0;
				const ambiguousNameSlnLines: string[] = [];
				for (let i = 0; i < guardCount; i++) {
					ambiguousNameSlnLines.push(
						`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "AmbiguousDisplay", "P${i}\\P${i}.csproj", "{${String(i).padStart(8, "0")}-1111-0000-0000-000000000000}"\nEndProject`,
					);
				}
				fs.writeFileSync(
					path.join(guardRoot, "AmbiguousName.sln"),
					ambiguousNameSlnLines.join("\n"),
				);
				const nameSolutionIndex = getSolutionIndex(scalingInventory, "AmbiguousName.sln");
				const rawNameGroup = nameSolutionIndex.byName.get("AmbiguousDisplay")!;
				nameSolutionIndex.byName.set(
					"AmbiguousDisplay",
					new Proxy(rawNameGroup, {
						get(target, prop, receiver) {
							if (typeof prop === "string" && !Number.isNaN(Number(prop))) {
								nameCandidateReads++;
							}
							return Reflect.get(target, prop, receiver);
						},
					}),
				);
				for (let i = 0; i < guardCount; i++) {
					const resolved = resolveReportedProject(
						scalingInventory,
						"AmbiguousName.sln",
						"AmbiguousDisplay",
					);
					expect(resolved).toBeNull();
				}
				expect(nameCandidateReads).toBe(0);

				// Scaling guard with repeated ambiguous basenames and candidate-read accounting (finding 2)
				let basenameCandidateReads = 0;
				const ambiguousBaseSlnLines: string[] = [];
				for (let i = 0; i < guardCount; i++) {
					createProject(guardRoot, `Dir${i}`, "SameBase.csproj");
					ambiguousBaseSlnLines.push(
						`Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Name${i}", "Dir${i}\\SameBase.csproj", "{${String(i).padStart(8, "0")}-2222-0000-0000-000000000000}"\nEndProject`,
					);
				}
				fs.writeFileSync(
					path.join(guardRoot, "AmbiguousBase.sln"),
					ambiguousBaseSlnLines.join("\n"),
				);
				const baseSolutionIndex = getSolutionIndex(scalingInventory, "AmbiguousBase.sln");
				const rawBaseGroup = baseSolutionIndex.byBasename.get("SameBase")!;
				baseSolutionIndex.byBasename.set(
					"SameBase",
					new Proxy(rawBaseGroup, {
						get(target, prop, receiver) {
							if (typeof prop === "string" && !Number.isNaN(Number(prop))) {
								basenameCandidateReads++;
							}
							return Reflect.get(target, prop, receiver);
						},
					}),
				);
				for (let i = 0; i < guardCount; i++) {
					const resolved = resolveReportedProject(
						scalingInventory,
						"AmbiguousBase.sln",
						"SameBase",
					);
					expect(resolved).toBeNull();
				}
				expect(basenameCandidateReads).toBe(0);
			} finally {
				fs.rmSync(guardRoot, { recursive: true, force: true });
			}
		},
	);

	describe("clean and scoped jb solution reports", () => {
		const CLEAN_REPORT = "<Report><IssueTypes /><Issues /></Report>";
		const runWithJb = async (jbOutput: string | null, exitCode: number | null = 0) => {
			subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
				if (command === "jb") {
					if (jbOutput !== null) fs.writeFileSync(outputFlag(arguments_), jbOutput);
				} else {
					fs.writeFileSync(outputFlag(arguments_), "<Roslynator />");
				}
				return { stdout: "", stderr: "", exitCode: command === "jb" ? exitCode : 0 };
			});
			return lintEngine.run(context);
		};

		it("records a clean solution report as ran with every solution member analyzed", async () => {
			const result = await runWithJb(CLEAN_REPORT);
			expect(result.failures ?? []).toEqual([]);
			expect(toolRecord(result, "jb inspectcode")).toMatchObject({
				status: "ran",
				targets: ["App.sln"],
				analyzedProjects: ["B/App.csproj", "One/One.csproj", "Two/Two.csproj"],
			});
			expect(toolRecord(result, "jb inspectcode")).not.toHaveProperty("reason");
		});

		it.each([
			["no --project scope", undefined, true],
			["a matching --project scope", "On?;Other*", true],
			["a nonmatching --project scope", "Other*", false],
		])("records a clean per-project report under %s", async (_label, jbProjects, credited) => {
			fs.unlinkSync(path.join(root, "App.sln"));
			context.config.lint.csharp = { ...context.config.lint.csharp, jbProjects };
			const result = await runWithJb(CLEAN_REPORT);
			const jb = toolRecord(result, "jb inspectcode");
			expect(jb?.status).toBe("ran");
			if (credited) {
				expect(jb?.analyzedProjects).toEqual(expect.arrayContaining(["One/One.csproj"]));
			} else {
				expect(jb?.analyzedProjects).not.toContain("One/One.csproj");
			}
		});

		it.each([
			["T?o;Display*", ["One/One.csproj", "Two/Two.csproj"]],
			["Nothing*", []],
		])(
			"records the intersection of the --project scope %s and the solution members",
			async (jbProjects, analyzedProjects) => {
				context.config.lint.csharp = { ...context.config.lint.csharp, jbProjects };
				const result = await runWithJb(CLEAN_REPORT);
				expect(toolRecord(result, "jb inspectcode")).toMatchObject({
					status: "ran",
					analyzedProjects,
				});
			},
		);

		it.each([
			["a truncated report", "<Report><IssueTypes /><Iss"],
			["garbage output", "not xml at all"],
			["a report without an Issues section", "<Report><IssueTypes /></Report>"],
			["a report cut off inside the Issues tag", "<Report><IssueTypes /><Issues"],
			["a report without a closing Report tag", "<Report><IssueTypes /><Issues />"],
			["a report with an unclosed Issues section", "<Report><IssueTypes /><Issues>"],
			[
				"a report whose Issues section never closes",
				"<Report><IssueTypes /><Issues></Report>",
			],
			["a comment-only report", "<!-- <Report><Issues /></Report> -->"],
			["a report hidden in a comment", "<!-- <Report><Issues -->"],
		])("records %s as failed", async (_label, report) => {
			const result = await runWithJb(report);
			const jb = toolRecord(result, "jb inspectcode");
			expect(jb?.status).toBe("failed");
			expect(jb?.analyzedProjects).toEqual([]);
			expect(result.failures).toContainEqual(expect.objectContaining({ tool: "jb inspectcode" }));
		});

		it.each([
			["a missing report", 1, null],
			["a clean report", 1, CLEAN_REPORT],
			["a clean report", 4, CLEAN_REPORT],
			["a clean report", null, CLEAN_REPORT],
		])("records %s after exit code %s as failed", async (_label, exitCode, report) => {
			const result = await runWithJb(report, exitCode);
			expect(toolRecord(result, "jb inspectcode")).toMatchObject({
				status: "failed",
				analyzedProjects: [],
			});
			expect(result.failures).toContainEqual(expect.objectContaining({ tool: "jb inspectcode" }));
		});
	});

	it("records a jb report that was never written as failed", async () => {
		fs.unlinkSync(path.join(root, "App.sln"));
		subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
			if (command !== "jb") {
				fs.writeFileSync(outputFlag(arguments_), "<Roslynator />");
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			const target = arguments_[1].replace(/\\/g, "/");
			if (target.endsWith("A/App.csproj")) {
				return { stdout: "", stderr: "boom", exitCode: 1 };
			}
			fs.writeFileSync(
				outputFlag(arguments_),
				'<Report><Issues><Project Name="App"></Project></Issues></Report>',
			);
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const result = await lintEngine.run(context);
		const jb = toolRecord(result, "jb inspectcode");
		expect(jb).toMatchObject({
			status: "failed",
			targets: expect.arrayContaining(["A/App.csproj", "B/App.csproj"]),
			analyzedProjects: expect.arrayContaining(["B/App.csproj"]),
			reason: expect.stringContaining("A/App.csproj"),
		});
		expect(jb?.analyzedProjects).not.toContain("A/App.csproj");
		expect(result.failures).toContainEqual(
			expect.objectContaining({
				tool: "jb inspectcode",
				target: "A/App.csproj",
			}),
		);
		expect(toolRecord(result, "roslynator")?.status).toBe("ran");
		expect(jsonLint(result).failures).toHaveLength(1);
	});

	it.each([
		["tool not installed", { jb: false, roslynator: false }, "jb tool missing"],
		["projectEvaluation false", { jb: true, roslynator: true }, "projectEvaluation disabled"],
	])("records not-selected for %s", async (label, installed, jbReason) => {
		context.installedTools = installed;
		if (label === "projectEvaluation false") {
			context.config.lint.csharp!.projectEvaluation = false;
		}
		const result = await lintEngine.run(context);
		expect(subprocess).not.toHaveBeenCalled();
		expect(toolRecord(result, "jb inspectcode")).toMatchObject({
			status: "not-selected",
			reason: jbReason,
			targets: [],
			analyzedProjects: [],
		});
		expect(toolRecord(result, "roslynator")?.status).toBe("not-selected");
		expect(jsonLint(result).executions).toHaveLength(2);
	});

	it("carries the same records in SARIF invocation properties", async () => {
		const result = await lintEngine.run(context);
		const invocation = buildSarifLog([result]).runs[0].invocations?.[0];
		expect(invocation?.executionSuccessful).toBe(true);
		expect(invocation?.properties?.analyzerExecutions).toEqual(result.executions);
		expect(result.executions).toHaveLength(2);
	});

	it.each([
		[
			"duplicate display names in separate virtual solution folders with root project (findings 1 & 3)",
			"display-name-root",
		],
		["duplicate basenames with root project (findings 5 & 10)", "basename-root"],
		["duplicate display names (issue 118 finding 1)", "display-name"],
		["duplicate basenames (issue 118 finding 10)", "basename"],
	])(
		"pins jb on the whole solution and roslynator per project when a project is excluded with %s",
		async (_label, ambiguityType) => {
			let expectedExcluded = "A/App.csproj";
			let expectedVisible = "B/App.csproj";
			if (ambiguityType === "display-name-root") {
				createProject(root, "", "App.csproj");
				fs.writeFileSync(
					path.join(root, "App.sln"),
					[
						'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Folder1", "Folder1", "{11111111-0000-0000-0000-000000000001}"\nEndProject',
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "App.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
						'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Folder2", "Folder2", "{22222222-0000-0000-0000-000000000002}"\nEndProject',
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "B\\App.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					].join("\n"),
				);
				context.excludePatterns = ["B/**"];
				expectedExcluded = "B/App.csproj";
				expectedVisible = "App.csproj";
			} else if (ambiguityType === "basename-root") {
				createProject(root, "", "App.csproj");
				fs.writeFileSync(
					path.join(root, "App.sln"),
					[
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "First", "App.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Second", "B\\App.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					].join("\n"),
				);
				context.excludePatterns = ["B/**"];
				expectedExcluded = "B/App.csproj";
				expectedVisible = "App.csproj";
			} else if (ambiguityType === "display-name") {
				fs.writeFileSync(
					path.join(root, "App.sln"),
					[
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "A\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "B\\App.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					].join("\n"),
				);
				context.excludePatterns = ["A/**"];
			} else {
				fs.writeFileSync(
					path.join(root, "App.sln"),
					[
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "First", "A\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject',
						'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Second", "B\\App.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject',
					].join("\n"),
				);
				context.excludePatterns = ["A/**"];
			}

			subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
				fs.writeFileSync(
					outputFlag(arguments_),
					command === "jb"
						? '<Report><Issues><Project Name="App"></Project></Issues></Report>'
						: "<Roslynator />",
				);
				return { stdout: "", stderr: "", exitCode: 0 };
			});

			const result = await lintEngine.run(context);
			const jb = toolRecord(result, "jb inspectcode");
			expect(jb?.targets).toEqual(["App.sln"]);
			expect(jb?.excludedProjects).toContain(expectedExcluded);
			// Membership comes from the solution index, so an ambiguous report name
			// "App" cannot hide a visible member or credit an excluded one.
			expect(jb?.analyzedProjects).toContain(expectedVisible);
			expect(jb?.analyzedProjects).not.toContain(expectedExcluded);

			const roslynator = toolRecord(result, "roslynator");
			expect(roslynator?.targets).toContain(expectedVisible);
			expect(roslynator?.analyzedProjects).toContain(expectedVisible);
			expect(roslynator?.excludedProjects).toContain(expectedExcluded);

			// Scaling guard covering both adapters (issue 118 finding 9)
			const scalingIdentities = Array.from(
				{ length: 32 },
				(_, i) => `Project${i}/Project${i}.csproj`,
			);
			const scalingExclusions = Array.from(
				{ length: 32 },
				(_, i) => `Excluded${i}/Excluded${i}.csproj`,
			);
			let excludedArrayReads = 0;
			const instrumentedExcludedArray = new Proxy([...scalingExclusions], {
				get(target, prop, receiver) {
					if (typeof prop === "string" && !Number.isNaN(Number(prop))) {
						excludedArrayReads++;
					}
					return Reflect.get(target, prop, receiver);
				},
			});
			const scalingInventory: CsharpProjectInventory = {
				rootDirectory: root,
				allProjects: [...scalingIdentities, ...scalingExclusions],
				visibleProjects: scalingIdentities,
				visibleProjectsSet: new Set(scalingIdentities),
				excludedProjects: instrumentedExcludedArray,
				excludedProjectsSet: new Set(scalingExclusions),
				gitIgnoredProjects: [],
				solutionCache: new Map(),
			};
			buildExecution(context, {
				tool: "jb inspectcode",
				failureReasons: [],
				targets: ["App.sln"],
				analyzedProjects: scalingIdentities,
				elapsed: 10,
				inventory: scalingInventory,
			});
			buildExecution(context, {
				tool: "roslynator",
				failureReasons: [],
				targets: ["App.sln"],
				analyzedProjects: scalingIdentities,
				elapsed: 10,
				inventory: scalingInventory,
			});
			expect(excludedArrayReads).toBe(0);
		},
	);
});
