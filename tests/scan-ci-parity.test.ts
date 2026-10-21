import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { AislopConfig } from "../src/config/index.js";
import type { EngineResult } from "../src/engines/types.js";

const { runEnginesWithProgress } = vi.hoisted(() => ({
	runEnginesWithProgress: vi.fn(),
}));

vi.mock("../src/commands/scan-engine-runner.js", () => ({ runEnginesWithProgress }));

const { scanCommand } = await import("../src/commands/scan.js");
const { ciCommand } = await import("../src/commands/ci.js");

// A warning-tier jb finding, shaped like parseJbXml output for a real WARNING.
const jbWarningResult = (): EngineResult => ({
	engine: "lint",
	elapsed: 1,
	skipped: false,
	diagnostics: [
		{
			filePath: "Tests/DriveKeyTests.cs",
			engine: "lint",
			rule: "jb/RedundantAssignment",
			severity: "warning",
			message: "Value assigned is not used in any execution path",
			help: "",
			line: 176,
			column: 1,
			category: "C# Lint",
			fixable: false,
		},
	],
});

const diagnosticsOf = (output: string): unknown => {
	const report = JSON.parse(output) as { diagnostics: unknown[]; engines: { lint: unknown } };
	return { diagnostics: report.diagnostics, lint: report.engines.lint };
};

describe("scan and ci report the same diagnostics", () => {
	let rootDirectory: string;
	let written: string[];

	beforeEach(() => {
		rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-scan-ci-parity-"));
		fs.writeFileSync(path.join(rootDirectory, "App.csproj"), "<Project />\n", "utf-8");
		fs.mkdirSync(path.join(rootDirectory, "Tests"), { recursive: true });
		fs.writeFileSync(path.join(rootDirectory, "Tests/DriveKeyTests.cs"), "class A { }\n", "utf-8");
		runEnginesWithProgress.mockReset();
		runEnginesWithProgress.mockImplementation(async () => [jbWarningResult()]);
		written = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			written.push(String(line));
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(rootDirectory, { recursive: true, force: true });
	});

	it("keeps a warning-tier jb finding in both commands with identical diagnostics", async () => {
		const config: AislopConfig = {
			...DEFAULT_CONFIG,
			security: { ...DEFAULT_CONFIG.security, audit: false },
			telemetry: { enabled: false },
		};

		await scanCommand(rootDirectory, config, {
			changes: false,
			staged: false,
			verbose: false,
			json: true,
			showHeader: false,
			printBrand: false,
		});
		const scanOutput = written.join("");
		written.length = 0;
		await ciCommand(rootDirectory, config);
		const ciOutput = written.join("");

		const fromScan = diagnosticsOf(scanOutput);
		const fromCi = diagnosticsOf(ciOutput);
		expect((fromScan as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
		expect(fromCi).toEqual(fromScan);
	});
});
