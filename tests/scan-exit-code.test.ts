import { describe, expect, it } from "vitest";
import { computeScanExitCode } from "../src/commands/scan-exit-code.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { Diagnostic } from "../src/engines/types.js";
import { calculateScore } from "../src/scoring/index.js";

describe("computeScanExitCode", () => {
	it.each(["warning", "info"] as const)(
		"issue 145: failBelow 100 rejects one %s in 400 effective source files",
		(severity) => {
			const diagnostic: Diagnostic = {
				filePath: "src/example.ts",
				engine: "lint",
				rule: "some/rule",
				severity,
				message: "Finding with a nonzero score deduction",
				help: "Fix the finding",
				line: 1,
				column: 0,
				category: "Lint",
				fixable: false,
			};
			const { weights, thresholds, smoothing, maxPerRule } = DEFAULT_CONFIG.scoring;
			const { score } = calculateScore(
				[diagnostic],
				weights,
				thresholds,
				400,
				smoothing,
				maxPerRule,
			);
			expect(
				computeScanExitCode({ hasErrors: false, scoreable: true, score, failBelow: 100 }),
			).toBe(1);
		},
	);

	it.each([true, false])(
		"fails target failures regardless of scoreability (%s) or baseline",
		(scoreable) => {
			expect(
				computeScanExitCode({
					hasErrors: false,
					hasEngineFailures: true,
					scoreable,
					score: 100,
					failBelow: 0,
					newFindings: 0,
				}),
			).toBe(1);
		},
	);
	it("fails on error diagnostics even when the score is withheld", () => {
		expect(computeScanExitCode({ hasErrors: true, scoreable: false, score: 0, failBelow: 70 })).toBe(1);
	});

	it("fails on error diagnostics when scoreable", () => {
		expect(computeScanExitCode({ hasErrors: true, scoreable: true, score: 100, failBelow: 70 })).toBe(1);
	});

	it("does not gate on a withheld score below the threshold", () => {
		expect(computeScanExitCode({ hasErrors: false, scoreable: false, score: 0, failBelow: 70 })).toBe(0);
	});

	it("fails a scoreable run below the threshold", () => {
		expect(computeScanExitCode({ hasErrors: false, scoreable: true, score: 50, failBelow: 70 })).toBe(1);
	});

	it("passes a scoreable run at or above the threshold", () => {
		expect(computeScanExitCode({ hasErrors: false, scoreable: true, score: 80, failBelow: 70 })).toBe(0);
	});

	it("ignores missing tools by default", () => {
		expect(
			computeScanExitCode({
				hasErrors: false,
				scoreable: true,
				score: 100,
				failBelow: 70,
				missingTools: true,
			}),
		).toBe(0);
	});

	it("fails on missing tools when failOnMissingTools is set", () => {
		expect(
			computeScanExitCode({
				hasErrors: false,
				scoreable: true,
				score: 100,
				failBelow: 70,
				missingTools: true,
				failOnMissingTools: true,
			}),
		).toBe(1);
	});
});
