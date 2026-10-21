import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanCommand } from "../src/commands/scan.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const { subprocess, tools } = vi.hoisted(() => ({ subprocess: vi.fn(), tools: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/subprocess.js")>()),
	runSubprocess: subprocess,
}));
vi.mock("../src/utils/discovery-tools.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/discovery-tools.js")>()),
	checkInstalledTools: tools,
}));
vi.mock("../src/utils/tooling.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tooling.js")>()),
	resolveToolBinary: (name: string) => name,
	resolveBundledJbSettings: () => null,
}));
vi.mock("../src/telemetry/index.js", () => ({
	withCommandLifecycle: async (_metadata: unknown, action: () => Promise<unknown>) => action(),
}));

const inspectionReport = (excludedFile: string, count: number): string => `
<Report><IssueTypes><IssueType Id="UnusedAutoPropertyAccessor.Global" Severity="WARNING" /></IssueTypes>
<Issues><Project Name="App">
<Issue TypeId="UnusedAutoPropertyAccessor.Global" File="App/Own.cs" Line="1" Message="unused accessor" />
</Project><Project Name="MFTLib">
${Array.from({ length: count }, (_, index) => `<Issue TypeId="UnusedAutoPropertyAccessor.Global" File="${excludedFile}" Line="${index + 1}" Message="unused accessor" />`).join("\n")}
</Project></Issues></Report>`;

describe("jb excluded findings through scan and scoring", () => {
	let root: string;
	let configuration: typeof DEFAULT_CONFIG;
	let messages: string[];
	let stderr: string[];
	let report: string;
	beforeEach(() => {
		vi.resetAllMocks();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-jb-excluded-"));
		fs.writeFileSync(path.join(root, "App.sln"), "");
		for (const directory of ["App", "external/MFTLib/MFTLib"]) {
			fs.mkdirSync(path.join(root, directory), { recursive: true });
			fs.writeFileSync(
				path.join(root, directory, directory === "App" ? "Own.cs" : "Excluded.cs"),
				"public class Code {}\n",
			);
		}
		configuration = structuredClone(DEFAULT_CONFIG);
		configuration.exclude = ["external/MFTLib/**"];
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
			roslynator: false,
			jb: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};
		tools.mockResolvedValue({ jb: true });
		subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
			if (command !== "jb") throw new Error(`Unexpected command: ${command}`);
			const output = arguments_.find((argument) => argument.startsWith("--output="));
			if (!output) throw new Error("Expected jb XML report output argument");
			fs.writeFileSync(output.slice("--output=".length), report);
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		messages = [];
		stderr = [];
		vi.spyOn(console, "log").mockImplementation((message) => {
			messages.push(String(message));
		});
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

	it.each([
		"external\\MFTLib\\MFTLib\\Excluded.cs",
		"external/MFTLib/MFTLib/Excluded.cs",
		"./external/MFTLib/MFTLib/Excluded.cs",
		"App/../external/MFTLib/MFTLib/Excluded.cs",
	])(
		"drops 110 excluded jb findings before scoring and prints the count: %s",
		async (excludedFile) => {
			report = inspectionReport(excludedFile, 110);
			const options = { changes: false, staged: false, verbose: false, json: true };
			await scanCommand(root, configuration, options);
			const output = JSON.parse(messages.at(-1)!);
			expect(subprocess).toHaveBeenCalledTimes(1);
			expect(
				output.diagnostics.map((diagnostic: { filePath: string }) => diagnostic.filePath),
			).toEqual(["App/Own.cs"]);
			expect(output.engines.lint.issues).toBe(1);
			expect(stderr.join("")).toContain("Suppressed 110 finding(s) under excluded paths");

			report = inspectionReport(excludedFile, 0);
			stderr.length = 0;
			await scanCommand(root, configuration, options);
			const ownOnly = JSON.parse(messages.at(-1)!);
			expect(output.score).toBe(ownOnly.score);
			expect(stderr.join("")).not.toContain("under excluded paths");
		},
	);
});
