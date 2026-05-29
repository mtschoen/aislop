import fs from "node:fs";
import path from "node:path";
import type { EngineContext } from "./types.js";

// Prefer a solution; fall back to the first .csproj. Returns null if neither exists.
export const findDotnetTarget = (context: EngineContext): string | null => {
	const root = context.rootDirectory;
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return null;
	}
	const solution = entries.find((name) => name.endsWith(".sln"));
	if (solution) return path.join(root, solution);
	const project = entries.find((name) => name.endsWith(".csproj"));
	return project ? path.join(root, project) : null;
};
