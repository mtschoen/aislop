import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { AislopConfig } from "../src/config/schema.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Coverage, ProjectInfo } from "../src/utils/discover.js";
import type { Diagnostic, EngineResult } from "../src/engines/types.js";
import { scanCommand } from "../src/commands/scan.js";

const {
	appendHistoryMock,
	applyRuleSeveritiesMock,
	applySuppressionsMock,
	baseRefExistsMock,
	calculateScoreMock,
	buildJsonOutputMock,
	buildSarifLogMock,
	discoverProjectMock,
	filterProjectFilesMock,
	getChangedFilesMock,
	getStagedFilesMock,
	listProjectFilesMock,
	logErrorMock,
	logMutedMock,
	printEngineStatusMock,
	readAislopIgnorePatternsMock,
	renderCoverageNoticeMock,
	renderDiagnosticsMock,
	renderHeaderMock,
	runEnginesMock,
	buildScanRenderMock,
} = vi.hoisted(() => ({
	appendHistoryMock: vi.fn(),
	applyRuleSeveritiesMock: vi.fn(),
	applySuppressionsMock: vi.fn(),
	baseRefExistsMock: vi.fn(),
	calculateScoreMock: vi.fn(),
	buildJsonOutputMock: vi.fn(),
	buildSarifLogMock: vi.fn(),
	discoverProjectMock: vi.fn(),
	filterProjectFilesMock: vi.fn(),
	getChangedFilesMock: vi.fn(),
	getStagedFilesMock: vi.fn(),
	listProjectFilesMock: vi.fn(),
	logErrorMock: vi.fn(),
	logMutedMock: vi.fn(),
	printEngineStatusMock: vi.fn(),
	readAislopIgnorePatternsMock: vi.fn(),
	renderCoverageNoticeMock: vi.fn(),
	renderDiagnosticsMock: vi.fn(),
	renderHeaderMock: vi.fn(),
	runEnginesMock: vi.fn(),
	buildScanRenderMock: vi.fn(),
}));

vi.mock("../src/telemetry/index.js", () => ({
	withCommandLifecycle: async (_metadata: unknown, action: () => Promise<{ exitCode: number }>) =>
		action(),
}));

// History recording is skipped in CI environments; force a non-CI env so the
// behavior is testable regardless of the runner's environment variables.
vi.mock("../src/telemetry/env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/telemetry/env.js")>();
	return {
		...actual,
		isCiEnv: () => false,
	};
});

vi.mock("../src/engines/orchestrator.js", () => ({
	runEngines: runEnginesMock,
}));

vi.mock("../src/utils/discover.js", () => ({
	discoverProject: discoverProjectMock,
	detectSourceLanguages: () => ["typescript"],
	detectManifestLanguages: () => ["typescript"],
	detectLanguages: () => ["typescript"],
}));

vi.mock("../src/utils/git.js", () => ({
	baseRefExists: baseRefExistsMock,
	getChangedFiles: getChangedFilesMock,
	getChangedLineMap: () => new Map(),
	getStagedFiles: getStagedFilesMock,
}));

vi.mock("../src/utils/source-files.js", () => ({
	readAislopIgnorePatterns: readAislopIgnorePatternsMock,
}));

vi.mock("../src/utils/source-file-selection.js", () => ({
	listProjectFiles: listProjectFilesMock,
	filterEnumeratedProjectFiles: filterProjectFilesMock,
	filterEnumeratedTestFiles: () => [],
	filterProjectDeclarationFiles: () => [],
	filterDependencyAuditFiles: () => [],
}));

vi.mock("../src/utils/history.js", () => ({
	appendHistory: appendHistoryMock,
	isHistoryDisabled: () => false,
}));

vi.mock("../src/utils/suppress.js", () => ({
	applySuppressions: applySuppressionsMock,
}));

vi.mock("../src/scoring/index.js", () => ({
	calculateScore: calculateScoreMock,
}));

vi.mock("../src/output/terminal.js", () => ({
	printEngineStatus: printEngineStatusMock,
	renderDiagnostics: renderDiagnosticsMock,
}));

vi.mock("../src/ui/logger.js", () => ({
	log: {
		error: logErrorMock,
		muted: logMutedMock,
	},
}));

vi.mock("../src/commands/scan-render.js", () => ({
	buildScanRender: buildScanRenderMock,
}));

vi.mock("../src/commands/scan-coverage.js", () => ({
	renderCoverageNotice: renderCoverageNoticeMock,
}));

vi.mock("../src/output/json.js", () => ({
	buildJsonOutput: buildJsonOutputMock,
}));

vi.mock("../src/output/sarif.js", () => ({
	buildSarifLog: buildSarifLogMock,
}));

vi.mock("../src/scoring/rule-severity.js", () => ({
	applyRuleSeverities: applyRuleSeveritiesMock,
}));

vi.mock("../src/ui/header.js", () => ({
	renderHeader: renderHeaderMock,
}));

const warningDiagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
	filePath: "src/index.ts",
	engine: "lint",
	rule: "lint/warning-example",
	severity: "warning",
	message: "Example warning",
	help: "",
	line: 1,
	column: 1,
	category: "style",
	fixable: false,
	...overrides,
});

const engineResult = (diagnostics: Diagnostic[], overrides: Partial<EngineResult> = {}): EngineResult => ({
	engine: "lint",
	diagnostics,
	elapsed: 12,
	skipped: false,
	...overrides,
});

const makeCoverage = (overrides: Partial<Coverage> = {}): Coverage => ({
	supportedFiles: 4,
	unsupportedFiles: 0,
	dominantUnsupported: null,
	scoreable: true,
	...overrides,
});

const makeProjectInfo = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
	rootDirectory: "project",
	projectName: "sample",
	languages: ["typescript"],
	frameworks: [],
	sourceFileCount: 4,
	coverage: makeCoverage(),
	installedTools: {},
	...overrides,
});

describe("scanCommand", () => {
	let tmpDir: string;
	let capturedStdout: string;
	let capturedConsole: string[];

	const config: AislopConfig = {
		...structuredClone(DEFAULT_CONFIG),
		ci: {
			failBelow: 70,
			format: "json",
		},
		rules: {},
	};

	const setupSuccessfulRun = (projectOverrides: Partial<ProjectInfo> = {}): void => {
		baseRefExistsMock.mockReturnValue(true);
		runEnginesMock.mockImplementation(async (_context, _engines, onStart, onResult) => {
			onStart("format");
			onResult({
				engine: "format",
				diagnostics: [],
				elapsed: 10,
				skipped: true,
			});
			onResult(
				engineResult([
					warningDiagnostic({ message: "A warning", rule: "lint/warn" }),
				]),
			);
			return [
				engineResult([], { engine: "format", skipped: true }),
				engineResult([warningDiagnostic()], { engine: "lint", elapsed: 21 }),
			];
		});
		discoverProjectMock.mockResolvedValue(makeProjectInfo(projectOverrides));
		calculateScoreMock.mockReturnValue({ score: 92, label: "Good" });
		applyRuleSeveritiesMock.mockImplementation((diagnostics: Diagnostic[]) => diagnostics);
		applySuppressionsMock.mockImplementation((results) => ({ results, suppressedCount: 0 }));
		readAislopIgnorePatternsMock.mockReturnValue([]);
		listProjectFilesMock.mockReturnValue(["src/index.ts"]);
		filterProjectFilesMock.mockImplementation((_: string, files: string[]) => files);
		buildScanRenderMock.mockReturnValue("scan rendered");
	};
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-scan-command-"));
		capturedStdout = "";
		capturedConsole = [];

		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			capturedStdout += String(chunk);
			return true;
		});
		vi.spyOn(console, "log").mockImplementation((...args) => {
			capturedConsole.push(args.map(String).join(" "));
		});

		runEnginesMock.mockReset();
		discoverProjectMock.mockReset();
		baseRefExistsMock.mockReset();
		getChangedFilesMock.mockReset();
		getStagedFilesMock.mockReset();
		listProjectFilesMock.mockReset();
		filterProjectFilesMock.mockReset();
		readAislopIgnorePatternsMock.mockReset();
		applyRuleSeveritiesMock.mockReset();
		applySuppressionsMock.mockReset();
		appendHistoryMock.mockReset();
		calculateScoreMock.mockReset();
		printEngineStatusMock.mockReset();
		logErrorMock.mockReset();
		logMutedMock.mockReset();
		renderDiagnosticsMock.mockReset();
		renderCoverageNoticeMock.mockReset();
		buildScanRenderMock.mockReset();
		buildJsonOutputMock.mockReset();
		buildSarifLogMock.mockReset();
		renderHeaderMock.mockReset();
		buildJsonOutputMock.mockReturnValue({
			fileCount: 4,
			score: 92,
			scoreable: true,
		});
		buildSarifLogMock.mockReturnValue({ version: "2.1.0" });
		renderCoverageNoticeMock.mockReturnValue("coverage notice\n");
		renderDiagnosticsMock.mockReturnValue("diagnostics\n");
		renderHeaderMock.mockReturnValue("scan header\n");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns exit code 1 for a missing path", async () => {
		discoverProjectMock.mockResolvedValue(makeProjectInfo());
		const result = await scanCommand(path.join(tmpDir, "does-not-exist"), config, {
			changes: false,
			staged: false,
			verbose: false,
			json: true,
			sarif: false,
		});

		expect(result.exitCode).toBe(1);
		expect(capturedConsole.join("")).toContain("Path does not exist");
	});

	it("returns exit code 1 for a non-directory path", async () => {
		const filePath = path.join(tmpDir, "not-a-dir.txt");
		fs.writeFileSync(filePath, "ok\n");

		const result = await scanCommand(filePath, config, {
			changes: false,
			staged: false,
			verbose: false,
			json: false,
			sarif: false,
		});

		expect(result.exitCode).toBe(1);
		expect(logErrorMock).toHaveBeenCalled();
		expect(logErrorMock.mock.calls[0][0]).toContain("Not a directory");
	});

	it("returns exit code 1 when the requested base ref is missing", async () => {
		baseRefExistsMock.mockReturnValue(false);

		const result = await scanCommand(tmpDir, config, {
			changes: true,
			base: "origin/main",
			staged: false,
			verbose: false,
			json: false,
			sarif: false,
		});

		expect(result.exitCode).toBe(1);
		expect(logErrorMock.mock.calls[0][0]).toContain('Could not resolve base ref "origin/main"');
	});

	it("writes human output for full scope scans and records history", async () => {
		setupSuccessfulRun();
		applySuppressionsMock.mockImplementationOnce(() => ({
			results: [
				engineResult([], { engine: "format", skipped: true }),
				engineResult([warningDiagnostic({ message: "A warning", rule: "lint/warn" })], {
					engine: "lint",
				}),
			],
			suppressedCount: 2,
		}));

		const result = await scanCommand(tmpDir, config, {
			changes: false,
			staged: false,
			verbose: false,
			json: false,
			sarif: false,
			showHeader: true,
			printBrand: false,
		});

		expect(result).toMatchObject({
			exitCode: 0,
			score: 92,
			scoreable: true,
			findingCount: 1,
			errorCount: 0,
			warningCount: 1,
			fixableCount: 0,
			engineIssues: { format: 0, lint: 1 },
		});
		expect(result.engineTimings.format).toBeGreaterThan(0);
		expect(result.engineTimings.lint).toBeGreaterThan(0);
		expect(renderHeaderMock).toHaveBeenCalled();
		expect(appendHistoryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				directory: tmpDir,
				score: 92,
				errors: 0,
				warnings: 1,
				files: 1,
			}),
		);
		expect(buildScanRenderMock).toHaveBeenCalled();
		expect(printEngineStatusMock).toHaveBeenCalledTimes(2);
		expect(logMutedMock).toHaveBeenCalledWith("Suppressed 2 finding(s) via aislop-ignore directives");
		expect(capturedStdout).toContain("scan header");
		expect(capturedStdout).toContain("scan rendered");
		expect(capturedStdout).toContain("1 file(s) after exclusions");
	});

	it("writes scoped scope rows for staged file selection", async () => {
		setupSuccessfulRun();
		getStagedFilesMock.mockReturnValue(["src/staged.ts"]);

		await scanCommand(tmpDir, config, {
			changes: false,
			staged: true,
			verbose: false,
			json: false,
			sarif: false,
			showHeader: false,
		});

		expect(getStagedFilesMock).toHaveBeenCalledWith(tmpDir);
		expect(capturedStdout).toContain("1 staged file(s)");
	});

	it("writes scoped scope rows for changed-file selection", async () => {
		setupSuccessfulRun();
		getChangedFilesMock.mockReturnValue(["src/changed.ts"]);

		await scanCommand(tmpDir, config, {
			changes: true,
			base: "main",
			staged: false,
			verbose: false,
			json: false,
			sarif: false,
			showHeader: false,
		});

		expect(getChangedFilesMock).toHaveBeenCalledWith(tmpDir, "main");
		expect(capturedStdout).toContain("1 changed vs main file(s)");
	});

	it("returns JSON output when json mode is enabled", async () => {
		setupSuccessfulRun();

		const result = await scanCommand(tmpDir, config, {
			changes: false,
			staged: false,
			verbose: false,
			json: true,
			sarif: false,
		});

		expect(result.scoreable).toBe(true);
		expect(buildJsonOutputMock).toHaveBeenCalled();
		expect(capturedConsole[0]).toContain('"score": 92');
	});

	it("returns SARIF output when sarif mode is enabled", async () => {
		setupSuccessfulRun();

		const result = await scanCommand(tmpDir, config, {
			changes: false,
			staged: false,
			verbose: false,
			json: false,
			sarif: true,
		});

		expect(result.scoreable).toBe(true);
		expect(buildSarifLogMock).toHaveBeenCalled();
		expect(capturedConsole[0]).toContain('"version": "2.1.0"');
	});

	it("emits coverage notice and diagnostics when score is withheld", async () => {
		setupSuccessfulRun({
			// deriveScanCoverage recomputes scoreable from the counts, so the
			// fixture has to trip the real threshold (>= 10 unsupported files and
			// more than 3x the supported count), not just assert the flag.
			coverage: makeCoverage({
				supportedFiles: 0,
				unsupportedFiles: 40,
				scoreable: false,
				dominantUnsupported: "Swift",
			}),
		});
		applySuppressionsMock.mockImplementation(() => ({
			results: [engineResult([warningDiagnostic({ rule: "swift/warning" })], { engine: "lint" })],
			suppressedCount: 0,
		}));

		const result = await scanCommand(tmpDir, config, {
			changes: false,
			staged: false,
			verbose: true,
			json: false,
			sarif: false,
			showHeader: true,
		});

		expect(result.score).toBe(null);
		expect(renderCoverageNoticeMock).toHaveBeenCalled();
		expect(renderDiagnosticsMock).toHaveBeenCalled();
		expect(appendHistoryMock).not.toHaveBeenCalled();
		expect(capturedStdout).toContain("coverage notice");
		expect(capturedStdout).toContain("diagnostics");
	});
});
