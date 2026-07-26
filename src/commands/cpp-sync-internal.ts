import fs from "node:fs";
import path from "node:path";
import { requireComponentName } from "./scaffold.js";

interface CppSyncOptions {
	directory?: string;
}

interface FunctionDefinition {
	name: string;
	declaration: string;
	fragment: string;
}

// Words that can precede a `name(...) {` construct without it being a function
// definition we want to declare: control flow, type introducers, and the
// keywords that open a scope of their own.
const NON_DEFINITION_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"sizeof",
	"alignof",
	"decltype",
	"static_assert",
	"else",
	"do",
	"try",
	"struct",
	"class",
	"union",
	"enum",
	"namespace",
	"case",
	"new",
	"delete",
	"throw",
	"co_await",
	"co_return",
	"co_yield",
]);

// Specifiers that may sit between the parameter list and the body. Anything
// outside this set (or a trailing return type) means the construct is not a
// plain function definition.
const TRAILING_SPECIFIERS = new Set([
	"const",
	"volatile",
	"noexcept",
	"override",
	"final",
	"mutable",
	"constexpr",
]);

/**
 * Replaces comments and string/character literals with spaces, preserving
 * every byte offset so downstream index arithmetic stays valid. Preprocessor
 * lines are blanked too: a function-like macro body is not a definition, and
 * its braces would otherwise unbalance the scanner.
 */
const blankNonCode = (contents: string): string => {
	const output = contents.split("");
	let index = 0;
	const blankUntil = (end: number): void => {
		for (let cursor = index; cursor < end && cursor < output.length; cursor += 1) {
			if (output[cursor] !== "\n") output[cursor] = " ";
		}
		index = end;
	};
	let atLineStart = true;
	while (index < contents.length) {
		const char = contents[index];
		const next = contents[index + 1];
		if (char === "\n") {
			atLineStart = true;
			index += 1;
			continue;
		}
		if (atLineStart && /\s/.test(char ?? "")) {
			index += 1;
			continue;
		}
		if (atLineStart && char === "#") {
			let end = index;
			while (end < contents.length) {
				const lineEnd = contents.indexOf("\n", end);
				if (lineEnd === -1) {
					end = contents.length;
					break;
				}
				// A trailing backslash continues the directive onto the next line.
				if (!/\\\s*$/.test(contents.slice(end, lineEnd))) {
					end = lineEnd;
					break;
				}
				end = lineEnd + 1;
			}
			blankUntil(end);
			continue;
		}
		atLineStart = false;
		if (char === "/" && next === "/") {
			const lineEnd = contents.indexOf("\n", index);
			blankUntil(lineEnd === -1 ? contents.length : lineEnd);
			continue;
		}
		if (char === "/" && next === "*") {
			const close = contents.indexOf("*/", index + 2);
			blankUntil(close === -1 ? contents.length : close + 2);
			continue;
		}
		if (char === '"' || char === "'") {
			let cursor = index + 1;
			while (cursor < contents.length) {
				if (contents[cursor] === "\\") {
					cursor += 2;
					continue;
				}
				if (contents[cursor] === char || contents[cursor] === "\n") break;
				cursor += 1;
			}
			blankUntil(Math.min(cursor + 1, contents.length));
			continue;
		}
		index += 1;
	}
	return output.join("");
};

const findMatchingBrace = (contents: string, openIndex: number): number => {
	let depth = 0;
	for (let index = openIndex; index < contents.length; index += 1) {
		const char = contents[index];
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
};

/** Index just past the `)` that closes the parameter list opened at `openIndex`. */
const findParameterListEnd = (contents: string, openIndex: number): number => {
	let depth = 0;
	for (let index = openIndex; index < contents.length; index += 1) {
		const char = contents[index];
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
};

/**
 * Walks from the end of the parameter list to the body brace, accepting only
 * trailing specifiers, ref-qualifiers, a `noexcept(...)` operand, and a trailing
 * return type. Returns the index of the opening brace, or -1 when the construct
 * is a prototype or something other than a function definition.
 */
const findBodyBrace = (contents: string, afterParameters: number): number => {
	let index = afterParameters;
	while (index < contents.length) {
		const char = contents[index] ?? "";
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "{") return index;
		if (char === "&") {
			index += 1;
			continue;
		}
		if (char === "-" && contents[index + 1] === ">") {
			// Trailing return type: consume up to the body brace.
			const brace = contents.indexOf("{", index);
			const terminator = contents.slice(index).search(/[;}]/);
			if (brace === -1) return -1;
			if (terminator !== -1 && index + terminator < brace) return -1;
			return brace;
		}
		if (char === "(") {
			// noexcept(...) / alignas(...) operand.
			const end = findParameterListEnd(contents, index);
			if (end === -1) return -1;
			index = end;
			continue;
		}
		const word = /^[A-Za-z_]\w*/.exec(contents.slice(index))?.[0];
		if (word && TRAILING_SPECIFIERS.has(word)) {
			index += word.length;
			continue;
		}
		return -1;
	}
	return -1;
};

/**
 * Text between the previous statement boundary and the function name, i.e. the
 * return type plus any leading specifiers. Returns null when the construct sits
 * where a return type cannot legally appear (after `=`, a lambda capture, or a
 * `.`/`->` member access), which is how lambdas and call expressions are
 * rejected.
 */
const declarationStart = (contents: string, nameStart: number): number | null => {
	let index = nameStart - 1;
	while (index >= 0 && !"{};".includes(contents[index] ?? "")) index -= 1;
	const leading = contents.slice(index + 1, nameStart);
	// An assignment to the left means an initializer or a lambda, not a
	// definition whose return type we can lift into a declaration.
	if (/=\s*$/.test(leading)) return null;
	const trimmed = leading.trim();
	if (trimmed.length === 0) return null;
	const words = trimmed.match(/[A-Za-z_]\w*/g) ?? [];
	if (words.some((word) => NON_DEFINITION_KEYWORDS.has(word))) return null;
	return index + 1;
};

/**
 * `scanContents` has comments, literals, and preprocessor lines blanked so the
 * structure is unambiguous; `sourceContents` is the untouched text the emitted
 * declaration is sliced from. Offsets are identical between the two.
 */
const extractDefinitions = (
	fragment: string,
	scanContents: string,
	sourceContents: string,
): FunctionDefinition[] => {
	const definitions: FunctionDefinition[] = [];
	const namePattern = /([A-Za-z_]\w*)\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = namePattern.exec(scanContents)) !== null) {
		const name = match[1] ?? "";
		if (NON_DEFINITION_KEYWORDS.has(name)) continue;
		const nameStart = match.index;
		const openParen = namePattern.lastIndex - 1;
		const afterParameters = findParameterListEnd(scanContents, openParen);
		if (afterParameters === -1) continue;
		const bodyStart = findBodyBrace(scanContents, afterParameters);
		if (bodyStart === -1) continue;
		const start = declarationStart(scanContents, nameStart);
		if (start === null) continue;
		const bodyEnd = findMatchingBrace(scanContents, bodyStart);
		if (bodyEnd === -1) continue;
		const declaration = sourceContents.slice(start, bodyStart).replace(/\s+/g, " ").trim();
		definitions.push({ name, declaration: `${declaration};`, fragment });
		namePattern.lastIndex = bodyEnd + 1;
	}
	return definitions;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listFragments = (componentDirectory: string, componentName: string): string[] =>
	fs
		.readdirSync(componentDirectory)
		.filter(
			(entry) =>
				entry.startsWith(`${componentName}.`) &&
				entry.endsWith(".cpp") &&
				entry !== `${componentName}.cpp`,
		)
		.sort();

const referencesName = (contents: string, name: string): boolean =>
	new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(contents);

const renderSyncedInternalHeader = (componentName: string, declarations: string[]): string => {
	const body = declarations.length > 0 ? `${declarations.join("\n")}\n` : "";
	return `#pragma once

// Editor-only declarations for ${componentName} fragments. Regenerated by:
//   aislop cpp sync-internal ${componentName}

${body}`;
};

export const cppSyncInternalCommand = (component: string, options: CppSyncOptions = {}): void => {
	const parsedComponent = path.parse(component);
	const componentName = parsedComponent.name;
	requireComponentName(componentName);
	const rootDirectory = path.resolve(options.directory ?? ".");
	const componentDirectory = path.resolve(rootDirectory, parsedComponent.dir || ".");
	const fragments = listFragments(componentDirectory, componentName);
	const sourceContents = new Map(
		fragments.map((fragment) => [
			fragment,
			fs.readFileSync(path.join(componentDirectory, fragment), "utf-8"),
		]),
	);
	// Comments, literals, and preprocessor lines are blanked once and used for
	// both definition extraction and reference lookup, so a name that only
	// appears in a comment neither declares nor pulls in a declaration.
	const fragmentContents = new Map(
		fragments.map((fragment) => [fragment, blankNonCode(sourceContents.get(fragment) ?? "")]),
	);
	const definitions = fragments.flatMap((fragment) =>
		extractDefinitions(
			fragment,
			fragmentContents.get(fragment) ?? "",
			sourceContents.get(fragment) ?? "",
		),
	);
	const declarations = definitions
		.filter((definition) =>
			fragments.some(
				(fragment) =>
					fragment !== definition.fragment &&
					referencesName(fragmentContents.get(fragment) ?? "", definition.name),
			),
		)
		.map((definition) => definition.declaration)
		.filter((declaration, index, all) => all.indexOf(declaration) === index)
		.sort();
	fs.writeFileSync(
		path.join(componentDirectory, `${componentName}.internal.h`),
		renderSyncedInternalHeader(componentName, declarations),
		"utf-8",
	);
};
