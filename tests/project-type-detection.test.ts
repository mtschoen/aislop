import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageLabelFor } from "../src/commands/doctor-plan.js";
import { planFormatForTest, planLintForTest, planSecurityForTest } from "../src/commands/doctor.js";
import { detectLanguages, detectSourceLanguages, discoverProject } from "../src/utils/discover.js";
import { stripAnsi } from "./helpers/ansi.js";

const { runEnginesWithProgress } = vi.hoisted(() => ({
	runEnginesWithProgress: vi.fn(),
}));

vi.mock("../src/commands/scan-engine-runner.js", () => ({ runEnginesWithProgress }));

let projectDir: string;

const writeProjectFile = (relativePath: string, content = ""): void => {
	const target = path.join(projectDir, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf-8");
};

const writeToolPinManifest = (): void => {
	writeProjectFile(
		"package.json",
		`${JSON.stringify({ name: "mftlib-ci-tooling", devDependencies: { aislop: "0.14.1" } }, null, 2)}\n`,
	);
};

const writeCsharpCppProject = (): void => {
	writeProjectFile("MFTLib.sln", "Microsoft Visual Studio Solution File\n");
	writeProjectFile("src/MFTLib/MFTLib.csproj", "<Project></Project>\n");
	for (let i = 0; i < 50; i++) {
		writeProjectFile(`src/MFTLib/Class${i}.cs`, `class Class${i} { }\n`);
	}
	for (let i = 0; i < 15; i++) {
		writeProjectFile(`src/native/native${i}.cpp`, `int fn${i}() { return ${i}; }\n`);
		writeProjectFile(`src/native/native${i}.h`, `int fn${i}();\n`);
	}
};

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-project-type-"));
	execFileSync("git", ["init", "-q"], { cwd: projectDir });
	runEnginesWithProgress.mockReset();
	runEnginesWithProgress.mockResolvedValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("detectSourceLanguages frequency ordering", () => {
	it("orders languages by source file count descending", () => {
		const files = [
			"scripts/ci.js",
			"src/A.cs",
			"src/B.cs",
			"src/C.cs",
			"src/native.cpp",
			"src/native.h",
		];
		const langs = detectSourceLanguages(files);
		expect(langs).toEqual(["csharp", "cpp", "javascript"]);
	});
});

describe("detectLanguages manifest separation", () => {
	it("does not add javascript to detected languages when non-empty source files are all C# and C++", () => {
		writeToolPinManifest();
		writeCsharpCppProject();
		const sourceFiles = fs
			.readdirSync(path.join(projectDir, "src/MFTLib"))
			.filter((f) => f.endsWith(".cs"))
			.map((f) => path.join(projectDir, "src/MFTLib", f));
		const langs = detectLanguages(projectDir, sourceFiles);
		expect(langs).toEqual(["csharp"]);
		expect(langs).not.toContain("javascript");
	});

	it("detects csharp before javascript for manifest-only repos with .sln and tooling package.json", () => {
		writeToolPinManifest();
		writeProjectFile("MySolution.sln", "Microsoft Visual Studio Solution File\n");
		const langs = detectLanguages(projectDir, []);
		expect(langs[0]).toBe("csharp");
	});
});

describe("discoverProject with tooling package.json", () => {
	it("detects csharp and cpp without javascript for a C#/C++ repo with root package.json", async () => {
		writeToolPinManifest();
		writeCsharpCppProject();
		const info = await discoverProject(projectDir);
		expect(info.languages).toContain("csharp");
		expect(info.languages).toContain("cpp");
		expect(info.languages).not.toContain("javascript");
	});
});

describe("languageLabelFor multi-language projects", () => {
	it("labels a C#/C++ project as csharp (mixed)", () => {
		const label = languageLabelFor({
			rootDirectory: projectDir,
			projectName: "MFTLib",
			languages: ["csharp", "cpp"],
			frameworks: ["none"],
			sourceFileCount: 65,
			coverage: { supportedFiles: 65, unsupportedFiles: 0, dominantUnsupported: null, scoreable: true },
			installedTools: {},
		});
		expect(label).toBe("csharp (mixed)");
	});

	it("labels a single-language C# project as csharp", () => {
		const label = languageLabelFor({
			rootDirectory: projectDir,
			projectName: "MFTLib",
			languages: ["csharp"],
			frameworks: ["none"],
			sourceFileCount: 65,
			coverage: { supportedFiles: 65, unsupportedFiles: 0, dominantUnsupported: null, scoreable: true },
			installedTools: {},
		});
		expect(label).toBe("csharp");
	});
});

describe("doctor tool planning with multiple languages", () => {
	it("plans C# tools rather than biome when csharp is primary even if javascript is in languages", () => {
		const formatDecision = planFormatForTest({
			languages: ["csharp", "javascript"],
			installedTools: { dotnet: true },
			projectEvaluation: true,
		});
		expect(formatDecision.tool).toBe("dotnet format whitespace (system)");

		const lintDecision = planLintForTest({
			languages: ["csharp", "javascript"],
			installedTools: { jb: true, roslynator: false },
			projectEvaluation: true,
		});
		expect(lintDecision.tool).toBe("jb inspectcode (system)");
	});

	it("plans dotnet security audit rather than npm audit when csharp is primary", () => {
		const decision = planSecurityForTest({
			languages: ["csharp"],
			installedTools: { dotnet: true },
			projectEvaluation: true,
		});
		expect(decision.tool).toBe("dotnet list package --vulnerable (system)");
	});
});

describe("scanCommand reporting for C#/C++ project with tooling package.json", () => {
	it("reports csharp (mixed) and does not report javascript in scan result header", async () => {
		writeToolPinManifest();
		writeCsharpCppProject();
		const { scanCommand } = await import("../src/commands/scan.js");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.js");
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await scanCommand(projectDir, DEFAULT_CONFIG, { printBrand: false, verbose: false });
		const out = stripAnsi(
			vi
				.mocked(process.stdout.write)
				.mock.calls.map(([chunk]) => String(chunk))
				.join(""),
		);
		expect(out).toContain("Scan result");
		expect(out).toContain("csharp");
		expect(out).not.toContain("javascript");
	});
});

