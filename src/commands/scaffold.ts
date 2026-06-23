import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const FRAGMENT_MARKER = "AISLOP_TU_FRAGMENT";
const CLANGD_DEFINE = `-D${FRAGMENT_MARKER}`;

interface ScaffoldComponentOptions {
	directory?: string;
	fragments?: string[];
}

interface CppSyncOptions {
	directory?: string;
}

interface FunctionDefinition {
	name: string;
	declaration: string;
	fragment: string;
}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fragmentNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

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

const requireComponentName = (name: string): void => {
	if (!identifierPattern.test(name)) {
		throw new Error(`Invalid component name: ${name}`);
	}
};

const ensureNewFile = (filePath: string, contents: string): void => {
	if (fs.existsSync(filePath)) {
		throw new Error(`${path.basename(filePath)} already exists`);
	}
	fs.writeFileSync(filePath, contents, "utf-8");
};

const renderPublicHeader = (componentName: string): string => `#pragma once

// Public API for the ${componentName} component.
`;

const renderInternalHeader = (componentName: string): string => `#pragma once

// Editor-only declarations for ${componentName} fragments. Regenerate with:
//   aislop cpp sync-internal ${componentName}
`;

const renderFragment = (componentName: string, fragment: string): string => `// Part of the ${componentName} component. Included by ${componentName}.cpp; do not compile directly.
#ifndef ${FRAGMENT_MARKER}
#error "${componentName}.${fragment}.cpp is a fragment included by ${componentName}.cpp; do not compile it directly"
#endif

#include "${componentName}.internal.h"

namespace {

}
`;

const renderOwner = (componentName: string, fragments: string[]): string => {
	const includes = fragments.map((fragment) => `#include "${componentName}.${fragment}.cpp"`).join("\n");
	const fragmentBlock = fragments.length > 0 ? `\n#define ${FRAGMENT_MARKER}\n${includes}\n#undef ${FRAGMENT_MARKER}\n` : "";
	return `#include "${componentName}.h"\n${fragmentBlock}\n// Public API definitions for the ${componentName} component.\n`;
};

const mergeClangd = (rootDirectory: string): void => {
	const clangdPath = path.join(rootDirectory, ".clangd");
	const existing = fs.existsSync(clangdPath) ? fs.readFileSync(clangdPath, "utf-8") : "";
	const parsed = existing.trim().length > 0 ? YAML.parse(existing) : {};
	const document = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
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

export const scaffoldComponentCommand = (
	name: string,
	options: ScaffoldComponentOptions = {},
): void => {
	requireComponentName(name);
	const rootDirectory = path.resolve(options.directory ?? ".");
	const fragments = normalizeFragments(options.fragments);
	fs.mkdirSync(rootDirectory, { recursive: true });

	ensureNewFile(path.join(rootDirectory, `${name}.h`), renderPublicHeader(name));
	ensureNewFile(path.join(rootDirectory, `${name}.internal.h`), renderInternalHeader(name));
	for (const fragment of fragments) {
		ensureNewFile(path.join(rootDirectory, `${name}.${fragment}.cpp`), renderFragment(name, fragment));
	}
	ensureNewFile(path.join(rootDirectory, `${name}.cpp`), renderOwner(name, fragments));
	mergeClangd(rootDirectory);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listFragments = (componentDirectory: string, componentName: string): string[] =>
	fs
		.readdirSync(componentDirectory)
		.filter((entry) =>
			entry.startsWith(`${componentName}.`) &&
			entry.endsWith(".cpp") &&
			entry !== `${componentName}.cpp`,
		)
		.sort();

const readFragment = (componentDirectory: string, fragment: string): string =>
	fs.readFileSync(path.join(componentDirectory, fragment), "utf-8");

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

const extractDefinitions = (fragment: string, contents: string): FunctionDefinition[] => {
	const definitions: FunctionDefinition[] = [];
	const pattern = /(^|\n)([A-Za-z_][\w:\s*&<>~,.]+?\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?)\{/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(contents)) !== null) {
		const name = match[3] ?? "";
		if (["if", "for", "while", "switch", "catch"].includes(name)) continue;
		const declaration = (match[2] ?? "").replace(/\s+/g, " ").trim();
		const bodyStart = pattern.lastIndex - 1;
		const bodyEnd = findMatchingBrace(contents, bodyStart);
		if (bodyEnd === -1) continue;
		definitions.push({ name, declaration: `${declaration};`, fragment });
	}
	return definitions;
};

const referencesName = (contents: string, name: string): boolean =>
	new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(contents);

const renderSyncedInternalHeader = (
	componentName: string,
	declarations: string[],
): string => {
	const body = declarations.length > 0 ? `${declarations.join("\n")}\n` : "";
	return `#pragma once

// Editor-only declarations for ${componentName} fragments. Regenerated by:
//   aislop cpp sync-internal ${componentName}

${body}`;
};

export const cppSyncInternalCommand = (
	component: string,
	options: CppSyncOptions = {},
): void => {
	const parsedComponent = path.parse(component);
	const componentName = parsedComponent.name;
	requireComponentName(componentName);
	const rootDirectory = path.resolve(options.directory ?? ".");
	const componentDirectory = path.resolve(rootDirectory, parsedComponent.dir || ".");
	const fragments = listFragments(componentDirectory, componentName);
	const fragmentContents = new Map(
		fragments.map((fragment) => [fragment, readFragment(componentDirectory, fragment)]),
	);
	const definitions = fragments.flatMap((fragment) =>
		extractDefinitions(fragment, fragmentContents.get(fragment) ?? ""),
	);
	const declarations = definitions
		.filter((definition) =>
			fragments.some((fragment) =>
				fragment !== definition.fragment && referencesName(fragmentContents.get(fragment) ?? "", definition.name),
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
