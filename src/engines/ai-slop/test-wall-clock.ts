import type { Diagnostic, EngineContext } from "../types.js";
import { readMaskedTestFiles } from "./test-timing-scope.js";

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

const CSHARP_SHAPE: TimingShape = {
	assertions: [/\bAssert\s*\.\s*\w+\s*\(/, /\.\s*Should\s*\(\s*\)/],
	clockReads: [
		/\bDateTime(?:Offset)?\s*\.\s*(?:Now|UtcNow)\b/,
		/\.\s*Elapsed\w*\b/,
		/\bEnvironment\s*\.\s*TickCount\w*\b/,
		/\bStopwatch\s*\.\s*GetTimestamp\s*\(/,
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

const SHAPE_BY_EXTENSION: Record<string, TimingShape> = {
	".ts": JS_SHAPE,
	".tsx": JS_SHAPE,
	".js": JS_SHAPE,
	".jsx": JS_SHAPE,
	".mjs": JS_SHAPE,
	".cjs": JS_SHAPE,
	".py": PYTHON_SHAPE,
	".cs": CSHARP_SHAPE,
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

export const detectTestWallClockAssertions = async (
	context: EngineContext,
): Promise<Diagnostic[]> => {
	const diagnostics: Diagnostic[] = [];
	for (const file of readMaskedTestFiles(context)) {
		const shape = SHAPE_BY_EXTENSION[file.extension];
		if (!shape) continue;
		for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
			const line = file.lines[lineIndex];
			if (!shape.assertions.some((pattern) => pattern.test(line))) continue;
			if (!shape.clockReads.some((pattern) => pattern.test(line))) continue;
			diagnostics.push({
				filePath: file.relativePath,
				engine: "ai-slop",
				rule: "ai-slop/test-wall-clock-assertion",
				severity: "warning",
				message: "Assertion depends on the real clock, so it passes locally and fails under load.",
				help: "Freeze the clock or inject it as a dependency and assert on the value the code computed. Where only completion matters, awaiting the operation already proves it finished; the test runner's own timeout catches a hang.",
				line: lineIndex + 1,
				column: 1,
				category: "AI Slop",
				fixable: false,
			});
		}
	}
	return diagnostics;
};
