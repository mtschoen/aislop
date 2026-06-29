import fs from "node:fs";
import path from "node:path";
import { dropGitIgnoredPaths } from "../utils/git-ignore.js";
import type { EngineContext } from "./types.js";

// Build-output and vendor directories that never hold first-party project files.
const IGNORED_DIRECTORIES = new Set(["bin", "obj", "node_modules", ".git", ".vs"]);

// Recursively collect every .csproj under `root`, skipping the directories above.
export const findCsprojFiles = (root: string): string[] => {
	const results: string[] = [];
	const walk = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) walk(fullPath);
			} else if (entry.name.endsWith(".csproj")) {
				results.push(fullPath);
			}
		}
	};
	walk(root);
	// Honor .gitignore: the raw walk would otherwise lint projects under ignored
	// directories (spikes, scratch checkouts) that the git-aware file discovery skips.
	return dropGitIgnoredPaths(root, results);
};

// Targets for the Roslynator lint pass. Prefer a classic .sln — roslynator loads
// it natively in a single pass with full project-reference context. Otherwise fall
// back to every .csproj in the tree: a lone .slnx is not a reliable roslynator
// target (MSBuild's solution parser fails to load .slnx on some SDKs, notably
// .NET 10), and projects routinely live in subdirectories rather than at the root.
export const findDotnetTargets = (context: Pick<EngineContext, "rootDirectory">): string[] => {
	const root = context.rootDirectory;
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const solution = entries.find((name) => name.endsWith(".sln"));
	if (solution) return dropGitIgnoredPaths(root, [path.join(root, solution)]);
	return findCsprojFiles(root);
};

// Targets for the jb (ReSharper CLT) lint pass. Unlike roslynator, jb inspectcode
// loads a .slnx solution natively, so prefer a single solution target - .sln
// first, then .slnx - for full project-reference context. Inspecting projects one
// at a time loses cross-project symbol resolution and floods CSharpErrors
// ("Cannot resolve symbol", "has no constructors defined"). Fall back to every
// .csproj only when no solution file exists.
export const findJbTargets = (context: Pick<EngineContext, "rootDirectory">): string[] => {
	const root = context.rootDirectory;
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const solution =
		entries.find((name) => name.endsWith(".sln")) ?? entries.find((name) => name.endsWith(".slnx"));
	if (solution) return dropGitIgnoredPaths(root, [path.join(root, solution)]);
	return findCsprojFiles(root);
};
