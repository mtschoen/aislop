import fs from "node:fs";
import path from "node:path";
import { maskComments, maskStringsAndComments } from "../../utils/source-masker.js";

const NOLINT_RE = /\/\/\s*nolint(?::([\w,-]+))?/g;
const PACKAGE_RE = /^package\s+(\w+)/m;
const NON_ERROR_BASIC_TYPES = new Set([
	"bool",
	"string",
	"byte",
	"rune",
	"int",
	"int8",
	"int16",
	"int32",
	"int64",
	"uint",
	"uint8",
	"uint16",
	"uint32",
	"uint64",
	"uintptr",
	"float32",
	"float64",
	"complex64",
	"complex128",
]);
const NON_ERROR_COMPOSITE_RE = /^(?:\[\d*\]|map\[|chan\b|<-\s*chan\b|func\s*\()/;

interface GoResult {
	path: string;
	type: string | null;
}

type GoSignatures = Map<string, GoResult[]>;
export type GoPackageSources = Map<string, Map<string | null, GoSignatures>>;

const maskGo = (source: string): string => maskStringsAndComments(source, ".go");

const packageName = (maskedSource: string): string | null =>
	PACKAGE_RE.exec(maskedSource)?.[1] ?? null;

const packageSources = (
	filePath: string,
	cache: GoPackageSources,
): Map<string | null, GoSignatures> => {
	const directory = path.dirname(filePath);
	const cached = cache.get(directory);
	if (cached) return cached;
	const sources = new Map<string | null, GoSignatures>();
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!name.endsWith(".go")) continue;
		const sourcePath = path.join(directory, name);
		try {
			const masked = maskGo(fs.readFileSync(sourcePath, "utf-8"));
			const name = packageName(masked);
			const signatures = sources.get(name) ?? new Map<string, GoResult[]>();
			for (const [functionName, results] of declaredLastResults(masked, sourcePath)) {
				signatures.set(functionName, [...(signatures.get(functionName) ?? []), ...results]);
			}
			sources.set(name, signatures);
		} catch {
			// An unreadable sibling cannot provide a signature; its calls remain unresolved.
		}
	}
	cache.set(directory, sources);
	return sources;
};

const closingParen = (source: string, openIndex: number): number => {
	let depth = 0;
	for (let i = openIndex; i < source.length; i += 1) {
		if (source[i] === "(") depth += 1;
		else if (source[i] === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const closingBracket = (source: string, openIndex: number): number => {
	let depth = 0;
	for (let i = openIndex; i < source.length; i += 1) {
		if (source[i] === "[") depth += 1;
		else if (source[i] === "]") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const closingBrace = (source: string, openIndex: number): number => {
	let depth = 0;
	for (let i = openIndex; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
};

const skipGoCompositeType = (source: string, i: number): number => {
	if (source.slice(i).startsWith("<-")) {
		let afterArrow = i + 2;
		while (afterArrow < source.length && /\s/.test(source[afterArrow])) afterArrow += 1;
		if (source.slice(afterArrow).startsWith("chan")) {
			return skipGoType(source, afterArrow + 4);
		}
		return -1;
	}

	if (/^chan\b/.test(source.slice(i))) {
		let afterChan = i + 4;
		while (afterChan < source.length && /\s/.test(source[afterChan])) afterChan += 1;
		if (source.slice(afterChan).startsWith("<-")) {
			afterChan += 2;
		}
		return skipGoType(source, afterChan);
	}

	if (/^map\b/.test(source.slice(i))) {
		let afterMap = i + 3;
		while (afterMap < source.length && /\s/.test(source[afterMap])) afterMap += 1;
		if (afterMap >= source.length || source[afterMap] !== "[") return -1;
		const closeBracket = closingBracket(source, afterMap);
		if (closeBracket === -1) return -1;
		return skipGoType(source, closeBracket + 1);
	}

	if (/^struct\b/.test(source.slice(i))) {
		let afterStruct = i + 6;
		while (afterStruct < source.length && /\s/.test(source[afterStruct])) afterStruct += 1;
		if (afterStruct >= source.length || source[afterStruct] !== "{") return -1;
		const closeBrace = closingBrace(source, afterStruct);
		if (closeBrace === -1) return -1;
		return closeBrace + 1;
	}

	if (/^interface\b/.test(source.slice(i))) {
		let afterInterface = i + 9;
		while (afterInterface < source.length && /\s/.test(source[afterInterface])) afterInterface += 1;
		if (afterInterface >= source.length || source[afterInterface] !== "{") return -1;
		const closeBrace = closingBrace(source, afterInterface);
		if (closeBrace === -1) return -1;
		return closeBrace + 1;
	}

	if (/^func\b/.test(source.slice(i))) {
		let afterFunc = i + 4;
		while (afterFunc < source.length && /\s/.test(source[afterFunc])) afterFunc += 1;
		if (afterFunc >= source.length || source[afterFunc] !== "(") return -1;
		const closeParen = closingParen(source, afterFunc);
		if (closeParen === -1) return -1;
		let cursor = closeParen + 1;
		while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
		if (cursor < source.length && source[cursor] === "(") {
			const resultsClose = closingParen(source, cursor);
			if (resultsClose === -1) return -1;
			return resultsClose + 1;
		}
		if (cursor < source.length && source[cursor] === "{") {
			return closeParen + 1;
		}
		const nextTypeEnd = skipGoType(source, cursor);
		return nextTypeEnd !== -1 ? nextTypeEnd : closeParen + 1;
	}

	return -1;
};

const skipGoType = (source: string, fromIndex: number): number => {
	let i = fromIndex;
	while (i < source.length && /\s/.test(source[i])) i += 1;
	if (i >= source.length) return -1;

	if (source[i] === "*") return skipGoType(source, i + 1);

	if (source[i] === "[") {
		const closeBracket = closingBracket(source, i);
		return closeBracket === -1 ? -1 : skipGoType(source, closeBracket + 1);
	}

	if (source[i] === "(") {
		const closeParen = closingParen(source, i);
		return closeParen === -1 ? -1 : closeParen + 1;
	}

	const compositeEnd = skipGoCompositeType(source, i);
	if (compositeEnd !== -1) return compositeEnd;

	const identMatch = /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/.exec(source.slice(i));
	if (identMatch) {
		let afterIdent = i + identMatch[0].length;
		while (afterIdent < source.length && /\s/.test(source[afterIdent])) afterIdent += 1;
		if (afterIdent < source.length && source[afterIdent] === "[") {
			const closeBracket = closingBracket(source, afterIdent);
			if (closeBracket !== -1) return closeBracket + 1;
		}
		return i + identMatch[0].length;
	}

	return -1;
};

const splitTopLevel = (list: string): string[] => {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i += 1) {
		const char = list[i];
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(list.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(list.slice(start));
	return parts.map((part) => part.trim()).filter(Boolean);
};

const resultTypeOf = (result: string): string => {
	const named = /^\w+\s+(\S.*)$/.exec(result);
	if (named && !/^(?:map|chan|func)$/.test(result.split(/\s/)[0])) return named[1].trim();
	return result;
};

const isKnownNonError = (type: string): boolean =>
	NON_ERROR_BASIC_TYPES.has(type) || NON_ERROR_COMPOSITE_RE.test(type);

const lastResultType = (source: string, paramsEnd: number): string | null => {
	const rest = source.slice(paramsEnd + 1);
	const trimmed = rest.trimStart();
	if (trimmed.startsWith("(")) {
		const offset = paramsEnd + 1 + (rest.length - trimmed.length);
		const end = closingParen(source, offset);
		if (end === -1) return null;
		const last = splitTopLevel(source.slice(offset + 1, end)).at(-1);
		return last ? resultTypeOf(last) : null;
	}
	const bodyStart = trimmed.indexOf("{");
	if (bodyStart === -1) return null;
	return trimmed.slice(0, bodyStart).trim() || null;
};

const declaredLastResults = (maskedSource: string, filePath: string): GoSignatures => {
	const declaration = /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/gm;
	const results: GoSignatures = new Map();
	for (const match of maskedSource.matchAll(declaration)) {
		const paramsEnd = closingParen(maskedSource, match.index + match[0].length - 1);
		const declarations = results.get(match[1]) ?? [];
		declarations.push({
			path: filePath,
			type: paramsEnd === -1 ? null : lastResultType(maskedSource, paramsEnd),
		});
		results.set(match[1], declarations);
	}
	return results;
};

const enclosingScopeBefore = (maskedSource: string, index: number): string => {
	const before = maskedSource.slice(0, index);
	const funcStart = before.lastIndexOf("\nfunc ");
	return before.slice(funcStart === -1 ? 0 : funcStart);
};

const bindsName = (parameterList: string, name: string): boolean => {
	const pending: string[] = [];
	for (const parameter of splitTopLevel(parameterList)) {
		if (/^\w+$/.test(parameter)) {
			pending.push(parameter);
			continue;
		}
		const named = /^(\w+)\s+\S/.exec(parameter);
		if (named && !/^(?:chan|map|func|struct|interface)$/.test(named[1])) {
			if (named[1] === name || pending.includes(name)) return true;
		}
		pending.length = 0;
	}
	return false;
};

const functionBodyStart = (
	scope: string,
	cursor: number,
): { bodyOpen: number; resultsSlice: string | null } | null => {
	if (scope[cursor] === "{") {
		return { bodyOpen: cursor, resultsSlice: null };
	}
	if (scope[cursor] === "(") {
		const resultsEnd = closingParen(scope, cursor);
		if (resultsEnd === -1) return null;
		let afterResults = resultsEnd + 1;
		while (afterResults < scope.length && /\s/.test(scope[afterResults])) afterResults += 1;
		if (afterResults < scope.length && scope[afterResults] === "{") {
			return { bodyOpen: afterResults, resultsSlice: scope.slice(cursor + 1, resultsEnd) };
		}
		return null;
	}
	const typeEnd = skipGoType(scope, cursor);
	if (typeEnd === -1) return null;
	let afterType = typeEnd;
	while (afterType < scope.length && /\s/.test(scope[afterType])) afterType += 1;
	if (afterType < scope.length && scope[afterType] === "{") {
		return { bodyOpen: afterType, resultsSlice: null };
	}
	return null;
};

const shadowedInFunctions = (scope: string, name: string): boolean => {
	const functions = /\bfunc\s+(?:\([^)]*\)\s*)?(?!func\b)\w+(?:\[[^\]]*\])?\s*\(|\bfunc\s*\(/g;
	let signatureEnd = 0;
	for (const match of scope.matchAll(functions)) {
		if (match.index < signatureEnd) continue;
		const open = match.index + match[0].length - 1;
		const end = closingParen(scope, open);
		if (end === -1) continue;
		let cursor = end + 1;
		while (cursor < scope.length && /\s/.test(scope[cursor])) cursor += 1;
		if (cursor >= scope.length) continue;

		const body = functionBodyStart(scope, cursor);
		// Nested function types belong to this signature, never to its following body.
		signatureEnd = body?.bodyOpen ?? Math.max(end + 1, skipGoType(scope, match.index));
		if (!body) continue;

		let depth = 0;
		let closed = false;
		for (let i = body.bodyOpen; i < scope.length; i += 1) {
			if (scope[i] === "{") {
				depth += 1;
			} else if (scope[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					closed = true;
					break;
				}
			}
		}
		if (!closed && depth > 0) {
			if (bindsName(scope.slice(open + 1, end), name)) return true;
			if (body.resultsSlice && bindsName(body.resultsSlice, name)) return true;
		}
	}
	return false;
};

const isShadowed = (scope: string, name: string): boolean => {
	if (new RegExp(`\\bvar\\s+${name}\\b`).test(scope)) return true;
	if (shadowedInFunctions(scope, name)) return true;
	for (const line of scope.split("\n")) {
		const assign = line.indexOf(":=");
		if (assign === -1) continue;
		const lhs = line.slice(0, assign).replace(/^\s*(?:for|if|switch)\s+/, "");
		if (lhs.split(",").some((part) => part.trim() === name)) return true;
	}
	return false;
};

const isCommentText = (line: string, commentMaskedLine: string, index: number): boolean =>
	line[index] !== commentMaskedLine[index];

const startsLineComment = (line: string, commentMaskedLine: string, index: number): boolean => {
	if (commentMaskedLine.slice(index, index + 2).trim() !== "") return false;
	let previous = index - 1;
	while (previous >= 0 && /\s/.test(line[previous])) previous -= 1;
	if (previous < 0) return true;
	if (line.slice(previous - 1, previous + 1) === "*/") return true;
	return !isCommentText(line, commentMaskedLine, previous);
};

const hasNolintErrcheck = (line: string, commentMaskedLine: string): boolean => {
	for (const match of line.matchAll(NOLINT_RE)) {
		if (!startsLineComment(line, commentMaskedLine, match.index)) continue;
		if (!match[1]) return true;
		if (match[1].split(",").some((linter) => linter === "errcheck" || linter === "all")) {
			return true;
		}
	}
	return false;
};

const lineAt = (source: string, index: number): string => {
	const start = source.lastIndexOf("\n", index) + 1;
	const end = source.indexOf("\n", index);
	return source.slice(start, end === -1 ? undefined : end);
};

export const createGoDroppedErrorCheck = (
	content: string,
	filePath: string,
	cache: GoPackageSources,
): ((matchIndex: number, functionName: string) => boolean) => {
	const masked = maskGo(content);
	const commentMasked = maskComments(content, ".go");
	const ownPackage = packageName(masked);
	const ownSignatures = declaredLastResults(masked, filePath);
	return (matchIndex, functionName) => {
		if (hasNolintErrcheck(lineAt(content, matchIndex), lineAt(commentMasked, matchIndex))) {
			return false;
		}
		if (isShadowed(enclosingScopeBefore(masked, matchIndex), functionName)) return true;
		const siblings = packageSources(filePath, cache).get(ownPackage)?.get(functionName) ?? [];
		const results = [
			...(ownSignatures.get(functionName) ?? []),
			...siblings.filter((result) => result.path !== filePath),
		];
		if (results.length === 0) return true;
		return !results.every(({ type }) => type !== null && isKnownNonError(type));
	};
};
