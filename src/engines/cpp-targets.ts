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

// Extensions that only appear in C++ (never plain C). Their presence means the
// tree is C++, so headers (.h is ambiguous) should be analyzed as C++ too.
export const CPP_ONLY_EXTENSIONS = new Set([".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);

const isCppExtension = (filePath: string): boolean =>
	CPP_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

export const findCppSources = (context: EngineContext): string[] =>
	getSourceFiles(context).filter(isCppExtension);

export const findCppSourcesForRoot = (rootDirectory: string): string[] =>
	getSourceFilesForRoot(rootDirectory).filter(isCppExtension);

// True when the source set is C++ (not pure C). cppcheck defaults `.h` files to
// the C language and rejects C++ constructs in them ("Code 'std::vector' is
// invalid C code."); knowing the tree is C++ lets the runner pass --language=c++.
export const hasCppOnlySources = (sources: string[]): boolean =>
	sources.some((f) => CPP_ONLY_EXTENSIONS.has(path.extname(f).toLowerCase()));

// Compare file paths across the OS path quirks that separate clang-tidy's argv
// from compile_commands.json entries: separator direction and (on Windows) case.
const canonicalPath = (filePath: string): string => {
	const resolved = path.resolve(filePath).split(path.sep).join("/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// Directories CMake commonly writes compile_commands.json into. We never run a
// build ourselves; we only consume a database the project already produced. CMake
// multi-config and out-of-tree layouts nest it a level down (build/lint,
// build/Debug), so scan one level under each build-like directory too.
export const findCompileCommandsDir = (
	context: Pick<EngineContext, "rootDirectory">,
): string | null => {
	const root = context.rootDirectory;
	const buildLikeDirs: string[] = [];
	try {
		for (const name of fs.readdirSync(root)) {
			if (name === "build" || name === "out" || name.startsWith("cmake-build")) {
				buildLikeDirs.push(path.join(root, name));
			}
		}
	} catch {
		// Unreadable root: fall through to the fixed candidates.
	}
	const candidates = new Set<string>([root, path.join(root, "build"), ...buildLikeDirs]);
	for (const dir of buildLikeDirs) {
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) candidates.add(path.join(dir, entry.name));
			}
		} catch {
			// Unreadable build dir: skip its children.
		}
	}
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "compile_commands.json"))) return dir;
	}
	return null;
};

// The set of translation units a compile_commands.json actually describes, as
// canonical absolute paths. clang-tidy can only analyze files it has a compile
// command for; running it on sources outside the database makes it guess flags
// and emit spurious clang-diagnostic-error (e.g. a POSIX-only .cpp that includes
// <unistd.h> failing on a Windows database). Returns [] when the database is
// missing or unparseable so callers fall back to skipping clang-tidy.
export const readCompileCommandsFiles = (compileCommandsDir: string): string[] => {
	try {
		const raw = fs.readFileSync(path.join(compileCommandsDir, "compile_commands.json"), "utf8");
		const entries = JSON.parse(raw) as Array<{ file?: unknown; directory?: unknown }>;
		if (!Array.isArray(entries)) return [];
		const files: string[] = [];
		for (const entry of entries) {
			if (typeof entry?.file !== "string") continue;
			const base =
				path.isAbsolute(entry.file) || typeof entry.directory !== "string"
					? entry.file
					: path.resolve(entry.directory, entry.file);
			files.push(canonicalPath(base));
		}
		return files;
	} catch {
		return [];
	}
};

// Keep only the sources the database describes. Falls back to all sources when
// the database lists no files (so a malformed/empty database never silently
// drops the whole clang-tidy pass).
export const filterSourcesInDatabase = (sources: string[], databaseFiles: string[]): string[] => {
	if (databaseFiles.length === 0) return sources;
	const inDatabase = new Set(databaseFiles);
	return sources.filter((f) => inDatabase.has(canonicalPath(f)));
};
