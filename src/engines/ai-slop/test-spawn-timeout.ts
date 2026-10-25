import ts from "typescript";
import { DEFAULT_SPAWN_WRAPPER_NAMES } from "../../config/schema.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { parseJavaScriptTest, suppressionPosition } from "./test-javascript-ast.js";
import { type MaskedTestFile, readMaskedTestFiles } from "./test-timing-scope.js";

// A literal kill bound on a real process is a machine-speed assumption: under a
// loaded runner a healthy child outlives it. Only direct numeric literals are
// matched; named constants and environment lookups are deliberately left alone.
// JavaScript call matching uses only the fixed structural callee surface below.

const NUMBER = String.raw`\d[\d_]*(?:\.\d+)?`;
const NUMBER_PRODUCT = String.raw`${NUMBER}(?:\s*\*\s*${NUMBER})*`;
const NUMBER_PRODUCT_RE = new RegExp(`^${NUMBER_PRODUCT}$`);

const PYTHON_MODULE_CALL_RE =
	/(?<![\p{ID_Continue}])subprocess\s*\.\s*(run|check_output|check_call|call)\s*\(/gu;
const PYTHON_POPEN_BINDING_RE =
	/(?:^|;|(?<!\\[ \t]*\r?)\n)[ \t]*([A-Za-z_]\w*)[ \t]*=\s*(?:subprocess\s*\.\s*)?Popen\s*\(/g;
const PYTHON_TIMEOUT_ARGUMENT_RE = new RegExp(String.raw`^timeout\s*=\s*(${NUMBER_PRODUCT})$`);
const PYTHON_LONE_NUMBER_RE = new RegExp(`^(${NUMBER_PRODUCT})$`);

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
	readonly position?: { line: number; character: number };
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

// Closed question: does an exact supported call have an options object argument
// whose last known timeout property is a positive numeric literal/product?
// Spreads, nonliteral timeout members, and unknown computed names reset it.
const isPositiveExpression = (expression: ts.Expression): boolean => {
	if (ts.isParenthesizedExpression(expression)) return isPositiveExpression(expression.expression);
	if (ts.isNumericLiteral(expression)) return Number(expression.text) > 0;
	return (
		ts.isBinaryExpression(expression) &&
		expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
		isPositiveExpression(expression.left) &&
		isPositiveExpression(expression.right)
	);
};

const isTimeoutName = (name: ts.PropertyName): boolean => {
	if (ts.isComputedPropertyName(name)) {
		return (
			(ts.isStringLiteral(name.expression) ||
				ts.isNoSubstitutionTemplateLiteral(name.expression)) &&
			name.expression.text === "time" + "out"
		);
	}
	return (
		(ts.isIdentifier(name) ||
			ts.isStringLiteral(name) ||
			ts.isNoSubstitutionTemplateLiteral(name)) &&
		name.text === "time" + "out"
	);
};

const isUnknownComputedName = (name: ts.PropertyName): boolean =>
	ts.isComputedPropertyName(name) &&
	!ts.isStringLiteral(name.expression) &&
	!ts.isNoSubstitutionTemplateLiteral(name.expression);

const objectTimeout = (
	object: ts.ObjectLiteralExpression,
	sourceFile: ts.SourceFile,
): string | null => {
	let effective: string | null = null;
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) effective = null;
		// A malformed key has no reliable identity. The parser marks it directly;
		// conservatively discard the earlier timeout rather than trust recovery text.
		else if (property.name.flags & ts.NodeFlags.ThisNodeHasError) effective = null;
		// A computed key that is not a string literal could evaluate to the timeout name at
		// runtime, so it makes the effective value undecidable, as a spread does.
		else if (isUnknownComputedName(property.name)) effective = null;
		else if (isTimeoutName(property.name)) {
			effective =
				ts.isPropertyAssignment(property) && isPositiveExpression(property.initializer)
					? property.initializer.getText(sourceFile)
					: null;
		}
	}
	return effective;
};

const spawnCallee = (expression: ts.Expression): string | null => {
	if (ts.isIdentifier(expression)) {
		return ["exec" + "Sync", "spawn" + "Sync", "execFile" + "Sync"].includes(expression.text)
			? expression.text
			: null;
	}
	if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression))
		return null;
	return ["child_" + "process", "child" + "Process"].includes(expression.expression.text) &&
		["ex" + "ec", "exec" + "File"].includes(expression.name.text)
		? expression.name.text
		: null;
};

const optionsObject = (
	callee: string,
	callArguments: ts.NodeArray<ts.Expression>,
): ts.ObjectLiteralExpression | null => {
	const first = callArguments[0];
	const second = callArguments[1];
	if (!first || ts.isSpreadElement(first) || !second) return null;
	if (ts.isObjectLiteralExpression(second)) return second;
	if (callee === "exec" + "Sync" || callee === "ex" + "ec") return null;
	const third = callArguments[2];
	return ts.isArrayLiteralExpression(second) && third && ts.isObjectLiteralExpression(third)
		? third
		: null;
};

const jsCandidates = (file: MaskedTestFile): Candidate[] => {
	const sourceFile = parseJavaScriptTest(file.relativePath, file.source, file.extension);
	const found: Candidate[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = spawnCallee(node.expression);
			if (callee !== null) {
				const options = optionsObject(callee, node.arguments);
				const literal = options ? objectTimeout(options, sourceFile) : null;
				if (literal !== null) {
					const offset = node.getStart(sourceFile);
					found.push({
						offset,
						openIndex: offset,
						callee,
						literal,
						position: suppressionPosition(sourceFile, offset),
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found;
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
				line: (candidate.position?.line ?? lineIndex) + 1,
				column: candidate.position
					? candidate.position.character + 1
					: candidate.offset - file.lineOffsets[lineIndex] + 1,
				category: "AI Slop",
				fixable: false,
			});
		}
	}
	return diagnostics;
};
