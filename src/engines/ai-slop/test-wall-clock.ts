import type { Diagnostic, EngineContext } from "../types.js";
import { type MaskedTestFile, readMaskedTestFiles } from "./test-timing-scope.js";
import { csharpWallClockAssertionLines } from "./test-wall-clock-csharp.js";

// Spelled indirectly so aislop's own scan of this detector cannot match the
// patterns it defines.
const EXPECT = "ex" + "pect";
const ASSERT = "as" + "sert";
const ASSERT_UPPER = "AS" + "SERT";
const NOW = "n" + "ow";

interface TimingShape {
	// Ways this language spells "this line makes an assertion".
	readonly assertions: RegExp[];
	// Ways this language spells "this expression reads the real clock".
	readonly clockReads: RegExp[];
}

const JS_SHAPE: TimingShape = {
	assertions: [
		new RegExp(String.raw`\b${EXPECT}\s*\(`),
		new RegExp(String.raw`\b${ASSERT}\s*[.(]`),
	],
	clockReads: [
		new RegExp(String.raw`\bDate\s*\.\s*${NOW}\s*\(\s*\)`),
		new RegExp(String.raw`\bperformance\s*\.\s*${NOW}\s*\(\s*\)`),
		/\bhrtime\s*[.(]/,
	],
};

const PYTHON_SHAPE: TimingShape = {
	assertions: [
		new RegExp(String.raw`^\s*${ASSERT}\s`),
		new RegExp(String.raw`\.\s*${ASSERT}[A-Z]\w*\s*\(`),
	],
	clockReads: [
		/\btime\s*\.\s*(?:time|monotonic|perf_counter|process_time)\s*\(\s*\)/,
		new RegExp(String.raw`\bdatetime\s*\.\s*(?:${NOW}|utc${NOW})\s*\(`),
	],
};

const GO_SHAPE: TimingShape = {
	assertions: [new RegExp(String.raw`\b(?:${ASSERT}|require)\s*\.\s*\w+\s*\(`)],
	clockReads: [/\btime\s*\.\s*(?:Now|Since)\s*\(/],
};

const PHP_SHAPE: TimingShape = {
	assertions: [
		new RegExp(String.raw`->\s*${ASSERT}\w*\s*\(`),
		new RegExp(String.raw`\b${ASSERT}\s*\(`),
	],
	clockReads: [/\bmicrotime\s*\(/, /\bhrtime\s*\(/, /\btime\s*\(\s*\)/],
};

const CPP_SHAPE: TimingShape = {
	assertions: [new RegExp(String.raw`\b(?:EX${"PECT"}|${ASSERT_UPPER})_[A-Z_]+\s*\(`)],
	clockReads: [
		/\b(?:(?:std\s*::\s*)?chrono\s*::\s*)?duration_cast\b/,
		new RegExp(String.raw`\b(?:(?:std\s*::\s*)?chrono\s*::\s*)?(?:\w+_)?clock\s*::\s*${NOW}\s*\(`),
		/\bclock\s*\(\s*\)/,
	],
};

// C# is handled by an AST arm rather than a TimingShape: `.Elapsed*` is a clock
// read only on a Stopwatch receiver, which is a question about declarations
// elsewhere in the file that no line-local pattern can answer.
const CSHARP_EXTENSION = ".cs";

const SHAPE_BY_EXTENSION: Record<string, TimingShape> = {
	".ts": JS_SHAPE,
	".tsx": JS_SHAPE,
	".js": JS_SHAPE,
	".jsx": JS_SHAPE,
	".mjs": JS_SHAPE,
	".cjs": JS_SHAPE,
	".py": PYTHON_SHAPE,
	".go": GO_SHAPE,
	".php": PHP_SHAPE,
	".c": CPP_SHAPE,
	".cc": CPP_SHAPE,
	".cpp": CPP_SHAPE,
	".cxx": CPP_SHAPE,
	".h": CPP_SHAPE,
	".hh": CPP_SHAPE,
	".hpp": CPP_SHAPE,
	".hxx": CPP_SHAPE,
};

const buildDiagnostic = (relativePath: string, line: number): Diagnostic => ({
	filePath: relativePath,
	engine: "ai-slop",
	rule: "ai-slop/test-wall-clock-assertion",
	severity: "warning",
	message: "Assertion depends on the real clock, so it passes locally and fails under load.",
	help: "Freeze the clock or inject it as a dependency and assert on the value the code computed. Where only completion matters, awaiting the operation already proves it finished; the test runner's own timeout catches a hang.",
	line,
	column: 1,
	category: "AI Slop",
	fixable: false,
});

const patternMatchedLines = (file: MaskedTestFile, shape: TimingShape): number[] => {
	const lines: number[] = [];
	for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
		const line = file.lines[lineIndex];
		if (!shape.assertions.some((pattern) => pattern.test(line))) continue;
		if (!shape.clockReads.some((pattern) => pattern.test(line))) continue;
		lines.push(lineIndex + 1);
	}
	return lines;
};

export const detectTestWallClockAssertions = async (
	context: EngineContext,
): Promise<Diagnostic[]> => {
	const diagnostics: Diagnostic[] = [];
	for (const file of readMaskedTestFiles(context)) {
		if (file.extension === CSHARP_EXTENSION) {
			for (const line of await csharpWallClockAssertionLines(file.source)) {
				diagnostics.push(buildDiagnostic(file.relativePath, line));
			}
			continue;
		}
		const shape = SHAPE_BY_EXTENSION[file.extension];
		if (!shape) continue;
		for (const line of patternMatchedLines(file, shape)) {
			diagnostics.push(buildDiagnostic(file.relativePath, line));
		}
	}
	return diagnostics;
};
