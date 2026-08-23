import type { Diagnostic, EngineContext } from "../types.js";
import { isInsideLoop, readMaskedTestFiles } from "./test-timing-scope.js";

// Spelled indirectly so aislop's own scan of this detector cannot match the
// patterns it defines.
const SLEEP = "sl" + "eep";
const SLEEP_FOR = `${SLEEP}_for`;
const SET_TIMEOUT = "set" + "Timeout";
const TASK_DELAY = `Task\\s*\\.\\s*${"De" + "lay"}`;
const THREAD_SLEEP = `Thread\\s*\\.\\s*${"S" + "leep"}`;
const TIME_SLEEP = `time\\s*\\.\\s*${"S" + "leep"}`;

const NUMBER = String.raw`\d[\d_]*(?:\.\d[\d_]*)?`;
const NUMBER_RE = new RegExp(NUMBER);

const GO_UNITS = "Nanosecond|Microsecond|Millisecond|Second|Minute";
const GO_DURATION = String.raw`(?:${NUMBER}\s*\*\s*time\s*\.\s*(?:${GO_UNITS})|time\s*\.\s*(?:${GO_UNITS}))`;
const CSHARP_DURATION = String.raw`(?:${NUMBER}|TimeSpan\s*\.\s*From\w+\s*\(\s*${NUMBER}\s*\))`;
const CPP_DURATION = String.raw`(?:std\s*::\s*)?chrono\s*::\s*\w+\s*\(\s*${NUMBER}\s*\)`;

interface SleepSpelling {
	// Global pattern whose first capture group is the delay expression.
	readonly pattern: RegExp;
	// Extra shape the whole line must have for the match to be a sleep.
	readonly lineMustMatch?: RegExp;
}

const JS_SPELLINGS: SleepSpelling[] = [
	{
		// `await new Promise((resolve) => setTimeout(resolve, 100))`: the timer
		// only reads as a sleep because a promise is built around it, so the
		// wrapper is required on the same line rather than inferred.
		pattern: new RegExp(
			String.raw`\b${SET_TIMEOUT}\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(${NUMBER})\s*\)`,
			"g",
		),
		lineMustMatch: /\bnew\s+Promise\s*\(/,
	},
	{
		// `await setTimeout(100)` is node:timers/promises: a single numeric
		// argument plus `await` has no other meaning.
		pattern: new RegExp(String.raw`\bawait\s+${SET_TIMEOUT}\s*\(\s*(${NUMBER})\s*\)`, "g"),
	},
];

const PYTHON_SPELLINGS: SleepSpelling[] = [
	{
		pattern: new RegExp(
			String.raw`\b(?:time|asyncio)\s*\.\s*${SLEEP}\s*\(\s*(${NUMBER})\s*\)`,
			"g",
		),
	},
];

const CSHARP_SPELLINGS: SleepSpelling[] = [
	{ pattern: new RegExp(String.raw`\b${THREAD_SLEEP}\s*\(\s*(${CSHARP_DURATION})\s*\)`, "g") },
	{ pattern: new RegExp(String.raw`\b${TASK_DELAY}\s*\(\s*(${CSHARP_DURATION})\s*\)`, "g") },
];

const GO_SPELLINGS: SleepSpelling[] = [
	{ pattern: new RegExp(String.raw`\b${TIME_SLEEP}\s*\(\s*(${GO_DURATION})\s*\)`, "g") },
];

const PHP_SPELLINGS: SleepSpelling[] = [
	{ pattern: new RegExp(String.raw`\bu?${SLEEP}\s*\(\s*(${NUMBER})\s*\)`, "g") },
];

const CPP_SPELLINGS: SleepSpelling[] = [
	{ pattern: new RegExp(String.raw`\b${SLEEP_FOR}\s*\(\s*(${CPP_DURATION})\s*\)`, "g") },
];

const SPELLINGS_BY_EXTENSION: Record<string, SleepSpelling[]> = {
	".ts": JS_SPELLINGS,
	".tsx": JS_SPELLINGS,
	".js": JS_SPELLINGS,
	".jsx": JS_SPELLINGS,
	".mjs": JS_SPELLINGS,
	".cjs": JS_SPELLINGS,
	".py": PYTHON_SPELLINGS,
	".cs": CSHARP_SPELLINGS,
	".go": GO_SPELLINGS,
	".php": PHP_SPELLINGS,
	".c": CPP_SPELLINGS,
	".cc": CPP_SPELLINGS,
	".cpp": CPP_SPELLINGS,
	".cxx": CPP_SPELLINGS,
	".h": CPP_SPELLINGS,
	".hh": CPP_SPELLINGS,
	".hpp": CPP_SPELLINGS,
	".hxx": CPP_SPELLINGS,
};

// A zero delay is a yield to the scheduler, not a wait on the wall clock. A
// duration written only as a named unit (`time.Second`) carries no literal to
// check and is always positive.
const isNonZeroDuration = (durationText: string): boolean => {
	const match = NUMBER_RE.exec(durationText);
	if (!match) return true;
	return Number(match[0].replace(/_/g, "")) > 0;
};

const sleepColumnInLine = (line: string, spellings: SleepSpelling[]): number | null => {
	for (const spelling of spellings) {
		if (spelling.lineMustMatch && !spelling.lineMustMatch.test(line)) continue;
		spelling.pattern.lastIndex = 0;
		let match = spelling.pattern.exec(line);
		while (match) {
			if (isNonZeroDuration(match[1])) return match.index;
			match = spelling.pattern.exec(line);
		}
	}
	return null;
};

export const detectTestSleeps = async (context: EngineContext): Promise<Diagnostic[]> => {
	const diagnostics: Diagnostic[] = [];
	for (const file of readMaskedTestFiles(context)) {
		const spellings = SPELLINGS_BY_EXTENSION[file.extension];
		if (!spellings) continue;
		for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
			const column = sleepColumnInLine(file.lines[lineIndex], spellings);
			if (column === null) continue;
			if (isInsideLoop(file, lineIndex, column)) continue;
			diagnostics.push({
				filePath: file.relativePath,
				engine: "ai-slop",
				rule: "ai-slop/test-sleep",
				severity: "warning",
				message: "Fixed delay in a test is either a hidden race or wasted wall-clock time.",
				help: "Poll the condition with a timeout, or mock the clock and assert on the call pattern instead. A delay that is genuinely part of what the test exercises can be kept with `// aislop-ignore-next-line ai-slop/test-sleep -- reason`.",
				line: lineIndex + 1,
				column: column + 1,
				category: "AI Slop",
				fixable: false,
			});
		}
	}
	return diagnostics;
};
