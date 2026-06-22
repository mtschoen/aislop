import path from "node:path";
import { relativePosix } from "../../utils/paths.js";
import { runSubprocess } from "../../utils/subprocess.js";
import {
	CPP_IMPL_EXTENSIONS,
	filterSourcesInDatabase,
	findCompileCommandsDir,
	findCppSources,
	readCompileCommandsFiles,
} from "../cpp-targets.js";
import type { Diagnostic, EngineContext } from "../types.js";

// clang-tidy prints: `<file>:<line>:<col>: warning|error: <message> [<check-name>]`.
// `note:` continuation lines and the trailing "N warnings generated." are ignored.
// The bracket can hold a comma-separated list: a project `.clang-tidy` with
// `WarningsAsErrors: "*"` appends `,-warnings-as-errors` to every check name, and
// clang-tidy may list multiple checks. We capture the whole list (commas allowed)
// and resolve the real check id from it.
const LINE_RE = /^(.+?):(\d+):(\d+):\s+(warning|error):\s+(.*?)\s+\[([A-Za-z0-9_.,-]+)\]\s*$/;

// From a bracket payload like `bugprone-narrowing-conversions,-warnings-as-errors`,
// return the first real check id, dropping the `-warnings-as-errors` pseudo-entry.
const resolveCheckId = (payload: string): string | undefined =>
	payload
		.split(",")
		.map((part) => part.trim())
		.find((part) => part.length > 0 && part !== "-warnings-as-errors");

export const parseClangTidyOutput = (output: string, rootDirectory: string): Diagnostic[] => {
	const out: Diagnostic[] = [];
	for (const raw of output.split(/\r?\n/)) {
		const match = LINE_RE.exec(raw);
		if (!match) continue;
		const [, file, line, column, severity, message, checkPayload] = match;
		const check = resolveCheckId(checkPayload);
		if (!check) continue;
		out.push({
			filePath: path.isAbsolute(file) ? relativePosix(rootDirectory, file) : file,
			engine: "lint",
			rule: `clang-tidy/${check}`,
			severity: severity === "error" ? "error" : "warning",
			message,
			help: "",
			line: Number(line),
			column: Number(column),
			category: "C++ Lint",
			fixable: false,
		});
	}
	return out;
};

export const runClangTidy = async (context: EngineContext): Promise<Diagnostic[]> => {
	// clang-tidy needs the compilation database for correct semantic analysis; with
	// no compile_commands.json we skip rather than emit wrong findings (cppcheck
	// still covers the repo). clang-tidy auto-discovers the project's `.clang-tidy`.
	const compileCommandsDir = findCompileCommandsDir(context);
	if (!compileCommandsDir) return [];
	const implSources = findCppSources(context).filter((f) =>
		CPP_IMPL_EXTENSIONS.has(path.extname(f).toLowerCase()),
	);
	// Restrict to the files the database describes. clang-tidy guesses flags for
	// any source it has no compile command for, which surfaces false
	// clang-diagnostic-error on platform-specific files (e.g. a POSIX .cpp on a
	// Windows database) that were never meant to build in this configuration.
	const sources = filterSourcesInDatabase(
		implSources,
		readCompileCommandsFiles(compileCommandsDir),
	);
	if (sources.length === 0) return [];
	try {
		const result = await runSubprocess(
			"clang-tidy",
			["-p", compileCommandsDir, "--quiet", ...sources],
			{ cwd: context.rootDirectory, timeout: 300000 },
		);
		return parseClangTidyOutput(result.stdout, context.rootDirectory);
	} catch {
		return [];
	}
};
