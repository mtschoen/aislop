import fs from "node:fs";
import path from "node:path";
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
	return results;
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
	if (solution) return [path.join(root, solution)];
	return findCsprojFiles(root);
};
