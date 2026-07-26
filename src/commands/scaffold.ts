import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const FRAGMENT_MARKER = "AISLOP_TU_FRAGMENT";
const CLANGD_DEFINE = `-D${FRAGMENT_MARKER}`;

interface ScaffoldComponentOptions {
	directory?: string;
	fragments?: string[];
	adopt?: boolean;
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fragmentNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// A line that can still belong to the leading include preamble of a .cpp file.
const preambleLinePattern = /^\s*(?:#|\/\/|\/\*|\*|$)/;

const normalizeFragments = (fragments: string[] | undefined): string[] => {
	const unique: string[] = [];
	for (const fragment of fragments ?? []) {
		if (!fragmentNamePattern.test(fragment)) {
			throw new Error(`Invalid fragment name: ${fragment}`);
		}
		if (!unique.includes(fragment)) unique.push(fragment);
	}
	return unique;
};

export const requireComponentName = (name: string): void => {
	if (!identifierPattern.test(name)) {
		throw new Error(`Invalid component name: ${name}`);
	}
};

const renderPublicHeader = (componentName: string): string => `#pragma once

// Public API for the ${componentName} component.
`;

const renderInternalHeader = (componentName: string): string => `#pragma once

// Editor-only declarations for ${componentName} fragments. Regenerate with:
//   aislop cpp sync-internal ${componentName}
`;

const renderFragmentPreamble = (
	componentName: string,
	fragment: string,
	withInternalInclude: boolean,
): string => {
	const guard = `// Part of the ${componentName} component. Included by ${componentName}.cpp; do not compile directly.
#ifndef ${FRAGMENT_MARKER}
#error "${componentName}.${fragment}.cpp is a fragment included by ${componentName}.cpp; do not compile it directly"
#endif
`;
	return withInternalInclude ? `${guard}\n#include "${componentName}.internal.h"\n` : guard;
};

const renderFragment = (componentName: string, fragment: string): string =>
	`${renderFragmentPreamble(componentName, fragment, true)}
namespace {

}
`;

const fragmentIncludeLine = (componentName: string, fragment: string): string =>
	`#include "${componentName}.${fragment}.cpp"`;

const renderOwner = (componentName: string, fragments: string[]): string => {
	const includes = fragments
		.map((fragment) => fragmentIncludeLine(componentName, fragment))
		.join("\n");
	const fragmentBlock =
		fragments.length > 0
			? `\n#define ${FRAGMENT_MARKER}\n${includes}\n#undef ${FRAGMENT_MARKER}\n`
			: "";
	return `#include "${componentName}.h"\n${fragmentBlock}\n// Public API definitions for the ${componentName} component.\n`;
};

const mergeClangd = (rootDirectory: string): void => {
	const clangdPath = path.join(rootDirectory, ".clangd");
	const existing = fs.existsSync(clangdPath) ? fs.readFileSync(clangdPath, "utf-8") : "";
	const parsed = existing.trim().length > 0 ? YAML.parse(existing) : {};
	const document =
		typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const compileFlags =
		typeof document.CompileFlags === "object" && document.CompileFlags !== null
			? (document.CompileFlags as Record<string, unknown>)
			: {};
	const currentAdd = compileFlags.Add;
	const addList = Array.isArray(currentAdd)
		? currentAdd.map((entry) => String(entry))
		: typeof currentAdd === "string"
			? [currentAdd]
			: [];
	if (!addList.includes(CLANGD_DEFINE)) addList.push(CLANGD_DEFINE);
	document.CompileFlags = { ...compileFlags, Add: addList };
	fs.writeFileSync(clangdPath, YAML.stringify(document), "utf-8");
};

const writeIfMissing = (filePath: string, contents: string): void => {
	if (fs.existsSync(filePath)) return;
	fs.writeFileSync(filePath, contents, "utf-8");
};

/** Index just past the last `#include` of the leading preamble. */
const preambleEnd = (lines: string[]): number => {
	let end = 0;
	for (const [index, line] of lines.entries()) {
		if (!preambleLinePattern.test(line)) break;
		if (/^\s*#\s*include\b/.test(line)) end = index + 1;
	}
	return end;
};

/**
 * Folds an existing translation unit into the owner role: keeps every line it
 * already has and threads the fragment include block in after its preamble, so
 * fragments are visible to the definitions that follow. Re-running only adds
 * includes the block does not already carry.
 */
const adoptOwner = (filePath: string, componentName: string, fragments: string[]): void => {
	const lines = fs.readFileSync(filePath, "utf-8").split("\n");
	const headerInclude = `#include "${componentName}.h"`;
	if (!lines.some((line) => line.trim() === headerInclude)) lines.unshift(headerInclude);
	const defineLine = `#define ${FRAGMENT_MARKER}`;
	const undefLine = `#undef ${FRAGMENT_MARKER}`;
	const includes = fragments.map((fragment) => fragmentIncludeLine(componentName, fragment));
	const defineIndex = lines.findIndex((line) => line.trim() === defineLine);
	const undefIndex = lines.findIndex((line) => line.trim() === undefLine);
	if (defineIndex !== -1 && undefIndex > defineIndex) {
		const present = new Set(lines.slice(defineIndex + 1, undefIndex).map((line) => line.trim()));
		lines.splice(undefIndex, 0, ...includes.filter((include) => !present.has(include)));
	} else if (includes.length > 0) {
		lines.splice(preambleEnd(lines), 0, "", defineLine, ...includes, undefLine);
	}
	fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
};

/**
 * Folds an existing source into the fragment role by prepending the guard that
 * keeps it out of the build on its own. The body is untouched, and a file that
 * already carries the guard is left byte-for-byte alone.
 */
const adoptFragment = (filePath: string, componentName: string, fragment: string): void => {
	const existing = fs.readFileSync(filePath, "utf-8");
	if (existing.includes(`#ifndef ${FRAGMENT_MARKER}`)) return;
	const hasInternalInclude = existing.includes(`#include "${componentName}.internal.h"`);
	const preamble = renderFragmentPreamble(componentName, fragment, !hasInternalInclude);
	fs.writeFileSync(filePath, `${preamble}\n${existing}`, "utf-8");
};

const requireAbsent = (filePath: string): void => {
	if (!fs.existsSync(filePath)) return;
	throw new Error(
		`${path.basename(filePath)} already exists. Re-run with --adopt to fold the existing sources into the component instead of writing new ones.`,
	);
};

export const scaffoldComponentCommand = (
	name: string,
	options: ScaffoldComponentOptions = {},
): void => {
	requireComponentName(name);
	const rootDirectory = path.resolve(options.directory ?? ".");
	const fragments = normalizeFragments(options.fragments);
	fs.mkdirSync(rootDirectory, { recursive: true });

	const publicHeader = path.join(rootDirectory, `${name}.h`);
	const internalHeader = path.join(rootDirectory, `${name}.internal.h`);
	const owner = path.join(rootDirectory, `${name}.cpp`);
	const fragmentPaths = fragments.map((fragment) =>
		path.join(rootDirectory, `${name}.${fragment}.cpp`),
	);

	if (options.adopt !== true) {
		// Checked up front so a collision leaves the directory as it was found.
		for (const target of [publicHeader, internalHeader, ...fragmentPaths, owner]) {
			requireAbsent(target);
		}
	}

	writeIfMissing(publicHeader, renderPublicHeader(name));
	writeIfMissing(internalHeader, renderInternalHeader(name));
	for (const [index, fragment] of fragments.entries()) {
		const fragmentPath = fragmentPaths[index] ?? "";
		if (fs.existsSync(fragmentPath)) adoptFragment(fragmentPath, name, fragment);
		else fs.writeFileSync(fragmentPath, renderFragment(name, fragment), "utf-8");
	}
	if (fs.existsSync(owner)) adoptOwner(owner, name, fragments);
	else fs.writeFileSync(owner, renderOwner(name, fragments), "utf-8");
	mergeClangd(rootDirectory);
};
