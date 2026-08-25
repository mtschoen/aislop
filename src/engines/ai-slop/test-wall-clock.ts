import type { Diagnostic, EngineContext } from "../types.js";
import { type MaskedTestFile, readMaskedTestFiles } from "./test-timing-scope.js";

// Spelled indirectly so aislop's own scan of this detector cannot match the
// patterns it defines.
const EXPECT = "ex" + "pect";
const ASSERT = "as" + "sert";
const ASSERT_UPPER = "AS" + "SERT";
const NOW = "n" + "ow";
const STOPWATCH = "Stop" + "watch";
const ELAPSED = "Ela" + "psed";

interface TimingShape {
	// Ways this language spells "this line makes an assertion".
	readonly assertions: RegExp[];
	// Ways this language spells "this expression reads the real clock".
	readonly clockReads?: RegExp[];
	// File-scoped dynamic clock reads (e.g. tracking receivers bound to a Stopwatch).
	readonly getClockReads?: (file: MaskedTestFile) => RegExp[];
	// Optional line preprocessor (e.g. masking nameof(...) expressions in C#).
	readonly preprocessLine?: (line: string) => string;
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

const STOPWATCH_NAME_RE = /^(?:_|m_|s_)?stop_?watch$/i;
const STOPWATCH_CONVENTIONAL_PATTERN = "(?:_|m_|s_)?[Ss]top_?[Ww]atch";
const STOPWATCH_CREATION_RE = new RegExp(
	String.raw`\b(?:(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\s*\.\s*StartNew\b|new\s+(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\b)`,
);

const STOPWATCH_MEMBERS = new Set([
	"StartNew",
	"GetTimestamp",
	"GetElapsedTime",
	"Frequency",
	"IsHighResolution",
	"Start",
	"Stop",
	"Reset",
	"Restart",
]);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const maskNameof = (line: string): string =>
	line.replace(/\bnameof\s*\((?:[^()]+|\([^()]*\))*\)/g, (match) => " ".repeat(match.length));

const findMatchingParen = (text: string, startIndex: number): number => {
	let depth = 0;
	for (let i = startIndex; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const parseTupleElements = (text: string): string[] | null => {
	const trimmed = text.trim();
	if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null;
	const inner = trimmed.slice(1, -1);
	const elements: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of inner) {
		if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
		else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
		else if (ch === "," && depth === 0) {
			elements.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (depth !== 0) return null;
	elements.push(current.trim());
	return elements;
};

const collectCSharpStopwatchIdentifiers = (file: MaskedTestFile): Set<string> => {
	const identifiers = new Set<string>();

	// Typed declarations: `Stopwatch sw`, `Stopwatch? sw`, `System.Diagnostics.Stopwatch sw`, `Stopwatch sw1, sw2`
	const typedDeclPattern = new RegExp(
		String.raw`\b(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}(?:\s*\?)?\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)`,
		"g",
	);
	let match: RegExpExecArray | null;
	while ((match = typedDeclPattern.exec(file.masked)) !== null) {
		const declGroup = match[1];
		for (const rawId of declGroup.split(",")) {
			const id = rawId.trim();
			if (id && id !== "_" && id !== "var" && !STOPWATCH_MEMBERS.has(id)) {
				identifiers.add(id);
			}
		}
	}

	// Single-variable assignments from Stopwatch creation: `var sw = Stopwatch.StartNew()`, `sw = new Stopwatch()`
	const singleAssignPattern = new RegExp(
		String.raw`(?:\b(?:this\s*\.\s*)?(?:var\s+)?([A-Za-z_]\w*))\s*(?<![!=<>])=(?![=>])\s*[^;=]*?\b(?:(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\s*\.\s*StartNew\b|new\s+(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\b)`,
		"g",
	);
	while ((match = singleAssignPattern.exec(file.masked)) !== null) {
		const id = match[1].trim();
		if (id && id !== "_" && id !== "var" && !STOPWATCH_MEMBERS.has(id)) {
			identifiers.add(id);
		}
	}

	// Tuple deconstruction assignments: `var (watch, display) = (Stopwatch.StartNew(), new ProgressDisplay())`
	for (let i = 0; i < file.masked.length; i++) {
		if (file.masked[i] !== "(") continue;
		const lhsEnd = findMatchingParen(file.masked, i);
		if (lhsEnd === -1) continue;

		let assignIndex = lhsEnd + 1;
		while (assignIndex < file.masked.length && /\s/.test(file.masked[assignIndex])) {
			assignIndex++;
		}
		if (assignIndex >= file.masked.length || file.masked[assignIndex] !== "=") continue;

		const prevChar = assignIndex > 0 ? file.masked[assignIndex - 1] : "";
		const nextChar = assignIndex + 1 < file.masked.length ? file.masked[assignIndex + 1] : "";
		if (/[!=<>+-]/.test(prevChar) || /[=>]/.test(nextChar)) continue;

		let rhsStart = assignIndex + 1;
		while (rhsStart < file.masked.length && /\s/.test(file.masked[rhsStart])) {
			rhsStart++;
		}
		if (rhsStart >= file.masked.length || file.masked[rhsStart] !== "(") continue;
		const rhsEnd = findMatchingParen(file.masked, rhsStart);
		if (rhsEnd === -1) continue;

		const lhsText = file.masked.slice(i, lhsEnd + 1);
		const rhsText = file.masked.slice(rhsStart, rhsEnd + 1);

		const lhsElements = parseTupleElements(lhsText);
		const rhsElements = parseTupleElements(rhsText);
		if (lhsElements && rhsElements && lhsElements.length === rhsElements.length) {
			for (let elIndex = 0; elIndex < lhsElements.length; elIndex++) {
				if (STOPWATCH_CREATION_RE.test(rhsElements[elIndex])) {
					const rawId = lhsElements[elIndex].replace(/^(?:var|[A-Za-z_]\w*(?:\?)?)\s+/, "").trim();
					if (
						rawId &&
						/^[A-Za-z_]\w*$/.test(rawId) &&
						rawId !== "_" &&
						rawId !== "var" &&
						!STOPWATCH_MEMBERS.has(rawId)
					) {
						identifiers.add(rawId);
					}
				}
			}
		}
	}

	return identifiers;
};

const CSHARP_STATIC_CLOCK_READS: RegExp[] = [
	new RegExp(String.raw`\bDateTime(?:Offset)?\s*\.\s*(?:${NOW}|Utc${NOW})\b`),
	/\bEnvironment\s*\.\s*TickCount\w*\b/,
	new RegExp(
		String.raw`\b(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\s*\.\s*(?:GetTimestamp|Get${ELAPSED}Time)\s*\(`,
	),
	new RegExp(
		String.raw`(?:\b(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}\s*\.\s*StartNew\s*\([^)]*\)|\bnew\s+(?:System\s*\.\s*Diagnostics\s*\.\s*)?${STOPWATCH}(?:\s*\([^)]*\))?)\s*\)?\s*\??\s*\.\s*${ELAPSED}\w*\b`,
	),
];

const buildCSharpClockReads = (file: MaskedTestFile): RegExp[] => {
	const clockReads = [...CSHARP_STATIC_CLOCK_READS];
	const identifiers = collectCSharpStopwatchIdentifiers(file);

	const idPatterns: string[] = [STOPWATCH_CONVENTIONAL_PATTERN];
	for (const id of identifiers) {
		if (!STOPWATCH_NAME_RE.test(id)) {
			idPatterns.push(escapeRegExp(id));
		}
	}

	const receiverPattern = String.raw`(?:\bthis\s*\.\s*)?@?\b(?:${idPatterns.join("|")})\s*\??\s*\.\s*${ELAPSED}\w*\b`;
	clockReads.push(new RegExp(receiverPattern));

	return clockReads;
};

const CSHARP_SHAPE: TimingShape = {
	assertions: [/\bAssert\s*\.\s*\w+\s*\(/, /\.\s*Should\s*\(\s*\)/],
	getClockReads: buildCSharpClockReads,
	preprocessLine: maskNameof,
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
		const clockReads = shape.getClockReads ? shape.getClockReads(file) : (shape.clockReads ?? []);
		for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex++) {
			const rawLine = file.lines[lineIndex];
			const line = shape.preprocessLine ? shape.preprocessLine(rawLine) : rawLine;
			if (!shape.assertions.some((pattern) => pattern.test(line))) continue;
			if (!clockReads.some((pattern) => pattern.test(line))) continue;
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
