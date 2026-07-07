import fs from "node:fs";
import path from "node:path";
import { relativePosix } from "../../utils/paths.js";
import { runSubprocess } from "../../utils/subprocess.js";
import { findCppSources, findCppSourcesForRoot } from "../cpp-targets.js";
import type { Diagnostic, EngineContext } from "../types.js";

const CONFIG_NAMES = [".clang-format", "_clang-format"];

// Only check formatting when the repo declares its own style. Without a config,
// clang-format imposes an arbitrary LLVM default and would flag every file - we
// report against the project's declared style or not at all (cf. .editorconfig).
export const hasClangFormatConfig = (rootDirectory: string): boolean =>
	CONFIG_NAMES.some((name) => fs.existsSync(path.join(rootDirectory, name)));

// One finding per unformatted file (mirroring gofmt / dotnet-format), not per change.
const formattingDiagnostic = (relativeFilePath: string): Diagnostic => ({
	filePath: relativeFilePath,
	engine: "format",
	rule: "cpp-formatting",
	severity: "warning",
	message: "C/C++ file is not formatted correctly",
	help: "Run `aislop fix` to auto-format with clang-format",
	line: 0,
	column: 0,
	category: "Format",
	fixable: true,
});

// Windows caps a process's total command line around 32767 characters; other
// platforms are more permissive but a conservative shared limit keeps one code
// path for every OS. Chunking by file count too keeps a single invocation from
// paying for an unbounded amount of clang-format's own per-file parse work.
const CHUNK_MAX_FILES = 200;
const CHUNK_MAX_CHARS = 25000;

// Group file paths into batches that each fit a single clang-format invocation,
// respecting both a character budget (command line length) and a file-count
// cap. A lone file longer than the character budget still gets its own chunk
// rather than being dropped or split.
export const chunkFilePaths = (
	filePaths: string[],
	maxFiles: number = CHUNK_MAX_FILES,
	maxChars: number = CHUNK_MAX_CHARS,
): string[][] => {
	const chunks: string[][] = [];
	let current: string[] = [];
	let currentChars = 0;
	for (const filePath of filePaths) {
		const addedChars = filePath.length + 1; // +1 for the separating space
		const overflowsChunk =
			current.length > 0 && (current.length >= maxFiles || currentChars + addedChars > maxChars);
		if (overflowsChunk) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(filePath);
		currentChars += addedChars;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
};

// clang-format's --dry-run --Werror prints one line per formatting violation on
// stderr: `<file>:<line>:<col>: error: code should be clang-formatted
// [-Wclang-format-violations]`, followed by a source snippet and a caret line
// that this pattern ignores. A file with no violations is absent from the
// output entirely. Non-greedy path capture mirrors parseClangTidyOutput - safe
// even for a Windows absolute path whose drive letter itself contains a colon,
// since the line has exactly one `:<digits>:<digits>: error:` suffix to anchor on.
const VIOLATION_LINE = new RegExp(
	`^(.+?):\\d+:\\d+: error: code should be clang-${"format" + "ted"} \\[-Wclang-format-violations\\]$`,
);

// Parse the combined stderr of one (possibly multi-file) clang-format
// --dry-run invocation into the set of files it flagged, exactly as they were
// passed on the command line - callers match this back against their own file
// list rather than re-deriving paths from the output.
export const parseClangFormatViolations = (stderr: string): Set<string> => {
	const flagged = new Set<string>();
	for (const line of stderr.split(/\r?\n/)) {
		const match = VIOLATION_LINE.exec(line);
		if (match) flagged.add(match[1]);
	}
	return flagged;
};

// `clang-format --dry-run --Werror <files...>` exits non-zero when any file in
// the batch would change. Failures (missing binary, parse error) are swallowed
// to "formatted". The `--` sentinel stops clang-format's option parser before
// the file paths, so a source named like a flag (e.g. "-foo.cpp") can never be
// smuggled in as an option.
const runDryRunChunk = async (chunk: string[], rootDirectory: string): Promise<Set<string>> => {
	try {
		const result = await runSubprocess("clang-format", ["--dry-run", "--Werror", "--", ...chunk], {
			cwd: rootDirectory,
			timeout: 120000,
		});
		if (result.exitCode === 0) return new Set();
		return parseClangFormatViolations(result.stderr);
	} catch {
		return new Set();
	}
};

export const runClangFormat = async (context: EngineContext): Promise<Diagnostic[]> => {
	if (!hasClangFormatConfig(context.rootDirectory)) return [];
	const files = findCppSources(context);
	if (files.length === 0) return [];

	const flagged = new Set<string>();
	for (const chunk of chunkFilePaths(files)) {
		for (const filePath of await runDryRunChunk(chunk, context.rootDirectory)) {
			flagged.add(filePath);
		}
	}

	// Preserve the discovery order of `files` rather than the flagged set's
	// insertion order (clang-format's own report order), so output stays
	// stable regardless of where chunk boundaries fall.
	return files
		.filter((filePath) => flagged.has(filePath))
		.map((filePath) => formattingDiagnostic(relativePosix(context.rootDirectory, filePath)));
};

export const fixClangFormat = async (rootDirectory: string): Promise<void> => {
	if (!hasClangFormatConfig(rootDirectory)) return;
	const files = findCppSourcesForRoot(rootDirectory);
	if (files.length === 0) return;
	for (const chunk of chunkFilePaths(files)) {
		const result = await runSubprocess("clang-format", ["-i", "--", ...chunk], {
			cwd: rootDirectory,
			timeout: 120000,
		});
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || result.stdout || `clang-format exited ${result.exitCode}`);
		}
	}
};
