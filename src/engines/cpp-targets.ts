import fs from "node:fs";
import path from "node:path";
import { getSourceFiles, getSourceFilesForRoot } from "../utils/source-files.js";
import type { EngineContext } from "./types.js";

export const CPP_SOURCE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx",
]);

// Translation-unit extensions (have a definition; safe to pass to clang-tidy).
export const CPP_IMPL_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx"]);

const isCppExtension = (filePath: string): boolean =>
	CPP_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

export const findCppSources = (context: EngineContext): string[] =>
	getSourceFiles(context).filter(isCppExtension);

export const findCppSourcesForRoot = (rootDirectory: string): string[] =>
	getSourceFilesForRoot(rootDirectory).filter(isCppExtension);

// Directories CMake commonly writes compile_commands.json into. We never run a
// build ourselves; we only consume a database the project already produced.
export const findCompileCommandsDir = (
	context: Pick<EngineContext, "rootDirectory">,
): string | null => {
	const root = context.rootDirectory;
	const candidates = new Set<string>([root, path.join(root, "build")]);
	try {
		for (const name of fs.readdirSync(root)) {
			if (name === "build" || name === "out" || name.startsWith("cmake-build")) {
				candidates.add(path.join(root, name));
			}
		}
	} catch {
		// Unreadable root: fall through to the fixed candidates.
	}
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "compile_commands.json"))) return dir;
	}
	return null;
};
