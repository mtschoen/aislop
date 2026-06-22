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

// `clang-format --dry-run --Werror <file>` exits non-zero when the file would
// change. Failures (missing binary, parse error) are swallowed to "formatted".
const isUnformatted = async (filePath: string, rootDirectory: string): Promise<boolean> => {
	try {
		const result = await runSubprocess("clang-format", ["--dry-run", "--Werror", filePath], {
			cwd: rootDirectory,
			timeout: 60000,
		});
		return result.exitCode !== 0;
	} catch {
		return false;
	}
};

export const runClangFormat = async (context: EngineContext): Promise<Diagnostic[]> => {
	if (!hasClangFormatConfig(context.rootDirectory)) return [];
	const files = findCppSources(context);
	const diagnostics: Diagnostic[] = [];
	for (const filePath of files) {
		if (await isUnformatted(filePath, context.rootDirectory)) {
			diagnostics.push(formattingDiagnostic(relativePosix(context.rootDirectory, filePath)));
		}
	}
	return diagnostics;
};

export const fixClangFormat = async (rootDirectory: string): Promise<void> => {
	if (!hasClangFormatConfig(rootDirectory)) return;
	const files = findCppSourcesForRoot(rootDirectory);
	if (files.length === 0) return;
	const result = await runSubprocess("clang-format", ["-i", ...files], {
		cwd: rootDirectory,
		timeout: 180000,
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.stdout || `clang-format exited ${result.exitCode}`);
	}
};
