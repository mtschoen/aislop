import { DEFAULT_SPAWN_WRAPPER_NAMES } from "../../config/schema.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { type MaskedTestFile, readMaskedTestFiles } from "./test-timing-scope.js";

// A literal kill bound on a real process is a machine-speed assumption: under a
// loaded runner a healthy child outlives it. Only direct numeric literals are
// matched; a named constant, an environment lookup, or a receiver the file does
// not visibly bind to a process is deliberately left alone.

const NUMBER = String.raw`\d[\d_]*(?:\.\d+)?`;
const NUMBER_PRODUCT = String.raw`${NUMBER}(?:\s*\*\s*${NUMBER})*`;
const NUMBER_PRODUCT_RE = new RegExp(`^${NUMBER_PRODUCT}$`);

const PYTHON_MODULE_CALL_RE =
	/(?<![\p{ID_Continue}])subprocess\s*\.\s*(run|check_output|check_call|call)\s*\(/gu;
const PYTHON_POPEN_BINDING_RE =
	/(?:^|;|(?<!\\[ \t]*\r?)\n)[ \t]*([A-Za-z_]\w*)[ \t]*=\s*(?:subprocess\s*\.\s*)?Popen\s*\(/g;
const PYTHON_TIMEOUT_ARGUMENT_RE = new RegExp(String.raw`^timeout\s*=\s*(${NUMBER_PRODUCT})$`);
const PYTHON_LONE_NUMBER_RE = new RegExp(`^(${NUMBER_PRODUCT})$`);

const JS_IDENTIFIER_PREFIX = String.raw`(?<![\p{ID_Continue}$\u200C\u200D]|\\u\{[\da-fA-F]+\})`;
const JS_SYNC_CALL_RE = new RegExp(
	String.raw`${JS_IDENTIFIER_PREFIX}(execSync|spawnSync|execFileSync)\s*\(`,
	"gu",
);
const JS_ASYNC_CALL_RE = new RegExp(
	String.raw`${JS_IDENTIFIER_PREFIX}(?:child_process|childProcess)\s*\.\s*(exec|execFile)\s*\(`,
	"gu",
);
const ACCESSOR_PREFIX_RE = /^(?:async(?=\s|\*|\[|['"]))?\s*\*?\s*(?:(?:get|set)(?=\s|\[|['"]))?\s*/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isPositive = (expression: string): boolean =>
	NUMBER_PRODUCT_RE.test(expression) &&
	expression.split("*").every((factor) => Number(factor.trim().replace(/_/g, "")) > 0);

// Span between the parenthesis at `openIndex` and its partner. Strings and
// comments are already blanked, so counting parentheses is safe.
const argumentSpan = (masked: string, openIndex: number): [number, number] | null => {
	let depth = 0;
	for (let index = openIndex; index < masked.length; index++) {
		const character = masked[index];
		if (character === "(") depth++;
		if (character !== ")") continue;
		depth--;
		if (depth === 0) return [openIndex + 1, index];
	}
	return null;
};

const trimSpan = (text: string, start: number, end: number): [number, number] => {
	let left = start;
	let right = end;
	while (left < right && /\s/.test(text[left])) left++;
	while (right > left && /\s/.test(text[right - 1])) right--;
	return [left, right];
};

// Top-level comma split: nested calls, lists, and dicts stay in one piece.
const splitSpans = (masked: string, start: number, end: number): Array<[number, number]> => {
	const spans: Array<[number, number]> = [];
	let depth = 0;
	let segmentStart = start;
	for (let index = start; index < end; index++) {
		const character = masked[index];
		if ("([{".includes(character)) depth++;
		else if (")]}".includes(character)) depth--;
		else if (character === "," && depth === 0) {
			const trimmed = trimSpan(masked, segmentStart, index);
			if (trimmed[0] < trimmed[1]) spans.push(trimmed);
			segmentStart = index + 1;
		}
	}
	const tail = trimSpan(masked, segmentStart, end);
	if (tail[0] < tail[1]) spans.push(tail);
	return spans;
};

const objectInteriorSpan = (
	masked: string,
	span: [number, number] | undefined,
): [number, number] | null => {
	if (!span) return null;
	const [start, end] = span;
	if (masked[start] !== "{" || masked[end - 1] !== "}") return null;
	let depth = 0;
	for (let index = start; index < end; index++) {
		const character = masked[index];
		if ("([{".includes(character)) depth++;
		else if (")]}".includes(character)) {
			depth--;
			if (depth === 0 && index < end - 1) return null;
		}
	}
	return depth === 0 ? [start + 1, end - 1] : null;
};

const jsOptionsInterior = (
	masked: string,
	callee: string,
	argsSpan: [number, number],
): [number, number] | null => {
	const parts = splitSpans(masked, argsSpan[0], argsSpan[1]);
	if (callee === "execSync" || callee === "exec") {
		return objectInteriorSpan(masked, parts[1]);
	}
	return objectInteriorSpan(masked, parts[1]) ?? objectInteriorSpan(masked, parts[2]);
};

const isQuotedLiteral = (maskedKey: string): boolean =>
	maskedKey.length >= 2 &&
	(maskedKey[0] === "'" || maskedKey[0] === '"') &&
	maskedKey[maskedKey.length - 1] === maskedKey[0] &&
	maskedKey.slice(1, -1).trim() === "";

const ESCAPE_SEQUENCE_RE =
	/\\(?:\r?\n|[\r\u2028\u2029]|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|([^uxbfnrtv0-7\r\n\u2028\u2029]))/g;

const decodeEscapes = (text: string): string | null => {
	let valid = true;
	const decoded = text.replace(
		ESCAPE_SEQUENCE_RE,
		(_match, braceHex, fixedHex, hexByte, octal, identity) => {
			if (braceHex !== undefined) {
				const codePoint = Number.parseInt(braceHex, 16);
				if (codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
				valid = false;
				return "";
			}
			if (fixedHex !== undefined) return String.fromCharCode(Number.parseInt(fixedHex, 16));
			if (hexByte !== undefined) return String.fromCharCode(Number.parseInt(hexByte, 16));
			if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
			return identity ?? "";
		},
	);
	return valid ? decoded : null;
};

type KeyStatus = "timeout" | "other" | "unknown";

const UNQUOTED_KEY_RE = /^[^\s'"`[\]()]+$/;

const resolveKeyStatus = (file: MaskedTestFile, start: number, end: number): KeyStatus => {
	let keyStart = start;
	let keyEnd = end;
	if (file.masked[keyStart] === "[" && file.masked[keyEnd - 1] === "]") {
		[keyStart, keyEnd] = trimSpan(file.masked, keyStart + 1, keyEnd - 1);
		if (!isQuotedLiteral(file.masked.slice(keyStart, keyEnd))) return "unknown";
	}
	const maskedKey = file.masked.slice(keyStart, keyEnd);
	const quoted = isQuotedLiteral(maskedKey);
	if (!quoted && !UNQUOTED_KEY_RE.test(maskedKey)) return "unknown";
	const rawKey = quoted ? file.source.slice(keyStart + 1, keyEnd - 1) : maskedKey;
	const decoded = decodeEscapes(rawKey);
	if (decoded === null) return "unknown";
	return decoded === "timeout" ? "timeout" : "other";
};

const stripAccessorPrefix = (masked: string, start: number, end: number): number =>
	end - masked.slice(start, end).replace(ACCESSOR_PREFIX_RE, "").length;

const jsLiteralTimeout = (
	file: MaskedTestFile,
	callee: string,
	argsSpan: [number, number],
): string | null => {
	const interior = jsOptionsInterior(file.masked, callee, argsSpan);
	if (interior === null) return null;
	let effective: string | null = null;
	for (const [entryStart, entryEnd] of splitSpans(file.masked, interior[0], interior[1])) {
		if (file.masked.slice(entryStart, entryStart + 3) === "...") {
			effective = null;
			continue;
		}
		let depth = 0;
		let delimiterIndex = -1;
		let delimiter = "";
		for (let index = entryStart; index < entryEnd; index++) {
			const character = file.masked[index];
			if (depth === 0 && (character === ":" || character === "(")) {
				delimiterIndex = index;
				delimiter = character;
				break;
			}
			if ("([{".includes(character)) depth++;
			else if (")]}".includes(character) && depth > 0) depth--;
		}
		const rawKeyEnd = delimiterIndex === -1 ? entryEnd : delimiterIndex;
		const keyPrefixStart =
			delimiter === "(" ? stripAccessorPrefix(file.masked, entryStart, rawKeyEnd) : entryStart;
		const [keyStart, keyEnd] = trimSpan(file.masked, keyPrefixStart, rawKeyEnd);
		const keyStatus = resolveKeyStatus(file, keyStart, keyEnd);
		if (keyStatus === "other") continue;
		if (keyStatus === "timeout" && delimiter === ":") {
			const value = file.masked.slice(delimiterIndex + 1, entryEnd).trim();
			effective = isPositive(value) ? value : null;
		} else {
			effective = null;
		}
	}
	return effective;
};

const pythonLiteralTimeout = (
	masked: string,
	argsSpan: [number, number],
	positionalWait: boolean,
): string | null => {
	const parts = splitSpans(masked, argsSpan[0], argsSpan[1]).map(([start, end]) =>
		masked.slice(start, end),
	);
	for (const part of parts) {
		const match = PYTHON_TIMEOUT_ARGUMENT_RE.exec(part);
		if (match && isPositive(match[1])) return match[1];
	}
	if (positionalWait && parts.length === 1) {
		const match = PYTHON_LONE_NUMBER_RE.exec(parts[0]);
		if (match && isPositive(match[1])) return match[1];
	}
	return null;
};

interface Candidate {
	readonly offset: number;
	readonly openIndex: number;
	readonly callee: string;
	readonly literal: string;
}

const isDefinition = (masked: string, offset: number): boolean =>
	/\bdef\s+$/.test(masked.slice(Math.max(0, offset - 12), offset));

const collect = (
	masked: string,
	pattern: RegExp,
	read: (match: RegExpExecArray, argsSpan: [number, number], openIndex: number) => Candidate | null,
): Candidate[] => {
	const found: Candidate[] = [];
	pattern.lastIndex = 0;
	let match = pattern.exec(masked);
	while (match) {
		const openIndex = match.index + match[0].length - 1;
		const argsSpan = argumentSpan(masked, openIndex);
		const candidate =
			argsSpan === null || isDefinition(masked, match.index)
				? null
				: read(match, argsSpan, openIndex);
		if (candidate) found.push(candidate);
		match = pattern.exec(masked);
	}
	return found;
};

const deduplicateByOpenIndex = (candidates: readonly Candidate[]): Candidate[] => {
	const seen = new Set<number>();
	const unique: Candidate[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.openIndex)) continue;
		seen.add(candidate.openIndex);
		unique.push(candidate);
	}
	return unique;
};

const wrapperPattern = (names: readonly string[]): RegExp | null => {
	const alternatives = names.map(escapeRegExp).join("|");
	return alternatives === ""
		? null
		: new RegExp(String.raw`(?<![\p{ID_Continue}$])(${alternatives})\s*\(`, "gu");
};

const pythonCandidates = (file: MaskedTestFile, wrapperNames: readonly string[]): Candidate[] => {
	const { masked } = file;
	const found = collect(masked, PYTHON_MODULE_CALL_RE, (match, argsSpan, openIndex) => {
		const literal = pythonLiteralTimeout(masked, argsSpan, false);
		return literal
			? { offset: match.index, openIndex, callee: `subprocess.${match[1]}`, literal }
			: null;
	});
	PYTHON_POPEN_BINDING_RE.lastIndex = 0;
	const receivers = new Set<string>();
	let depth = 0;
	let depthCursor = 0;
	let binding = PYTHON_POPEN_BINDING_RE.exec(masked);
	while (binding) {
		while (depthCursor < binding.index) {
			const character = masked[depthCursor++];
			if ("([{".includes(character)) depth++;
			else if (")]}".includes(character) && depth > 0) depth--;
		}
		if (depth === 0) receivers.add(binding[1]);
		binding = PYTHON_POPEN_BINDING_RE.exec(masked);
	}
	for (const receiver of receivers) {
		const methodCall = new RegExp(
			String.raw`(?<![\p{ID_Continue}.])${escapeRegExp(receiver)}\s*\.\s*(communicate|wait)\s*\(`,
			"gu",
		);
		found.push(
			...collect(masked, methodCall, (match, argsSpan, openIndex) => {
				const literal = pythonLiteralTimeout(masked, argsSpan, match[1] === "wait");
				return literal
					? { offset: match.index, openIndex, callee: `${receiver}.${match[1]}`, literal }
					: null;
			}),
		);
	}
	const wrappers = wrapperPattern(wrapperNames);
	if (wrappers) {
		found.push(
			...collect(masked, wrappers, (match, argsSpan, openIndex) => {
				const literal = pythonLiteralTimeout(masked, argsSpan, false);
				return literal ? { offset: match.index, openIndex, callee: match[1], literal } : null;
			}),
		);
	}
	return deduplicateByOpenIndex(found);
};

const jsCandidates = (file: MaskedTestFile): Candidate[] => {
	const read = (
		match: RegExpExecArray,
		argsSpan: [number, number],
		openIndex: number,
	): Candidate | null => {
		const literal = jsLiteralTimeout(file, match[1], argsSpan);
		return literal ? { offset: match.index, openIndex, callee: match[1], literal } : null;
	};
	return deduplicateByOpenIndex([
		...collect(file.masked, JS_SYNC_CALL_RE, read),
		...collect(file.masked, JS_ASYNC_CALL_RE, read),
	]);
};

const SPAWN_EXTENSIONS: Record<string, "python" | "javascript"> = {
	".py": "python",
	".ts": "javascript",
	".tsx": "javascript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
};

const lineIndexOf = (file: MaskedTestFile, offset: number): number => {
	let low = 0;
	let high = file.lineOffsets.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (file.lineOffsets[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return low;
};

export const detectTestSpawnTimeouts = async (context: EngineContext): Promise<Diagnostic[]> => {
	const settings = context.config.aiSlop?.testSpawnTimeout;
	const wrapperNames = settings?.wrapperNames ?? DEFAULT_SPAWN_WRAPPER_NAMES;
	const helperPaths = settings?.helperPaths ?? [];
	const diagnostics: Diagnostic[] = [];
	for (const file of readMaskedTestFiles(context)) {
		const language = SPAWN_EXTENSIONS[file.extension];
		if (!language) continue;
		if (helperPaths.some((helperPath) => file.relativePath.includes(helperPath))) continue;
		const candidates =
			language === "python" ? pythonCandidates(file, wrapperNames) : jsCandidates(file);
		for (const candidate of candidates) {
			const lineIndex = lineIndexOf(file, candidate.offset);
			diagnostics.push({
				filePath: file.relativePath,
				engine: "ai-slop",
				rule: "ai-slop/test-spawn-timeout-literal",
				severity: "warning",
				message: `${candidate.callee}(...) kills a real process after a literal timeout of ${candidate.literal}, which fires on healthy runs when the machine is loaded.`,
				help: "In order: run the logic in-process and drop the spawn; if the subject really is an external program, mark the test as integration tier and take the bound from one shared test helper instead of a per-call literal; if the test is about timeout handling, fake the timeout outcome rather than waiting out a real expiry. A bound that is the point of the test can be kept with `// aislop-ignore-next-line ai-slop/test-spawn-timeout-literal -- reason`.",
				line: lineIndex + 1,
				column: candidate.offset - file.lineOffsets[lineIndex] + 1,
				category: "AI Slop",
				fixable: false,
			});
		}
	}
	return diagnostics;
};
