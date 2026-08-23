import { relativePosix } from "../../utils/paths.js";
import {
	isMissingToolError,
	runSubprocess,
	warnSubprocessFailure,
} from "../../utils/subprocess.js";
import { resolveToolBinary } from "../../utils/tooling.js";
import type { Diagnostic, EngineContext } from "../types.js";

interface GolangciIssue {
	FromLinter: string;
	Text: string;
	Pos: { Filename: string; Line: number; Column: number };
}

export const runGolangciLint = async (context: EngineContext): Promise<Diagnostic[]> => {
	const golangciBinary = resolveToolBinary("golangci-lint");
	try {
		// golangci-lint v2 dropped the v1 `--out-format` flag; JSON output is now
		// selected via `--output.json.path=stdout`. By default in v2 `--show-stats`
		// is true, which appends non-JSON statistics to stdout and breaks JSON.parse;
		// `--show-stats=false` ensures pure JSON output. See the v2 migration guide:
		// https://golangci-lint.run/docs/product/migration-guide/
		const result = await runSubprocess(
			golangciBinary,
			["run", "--output.json.path=stdout", "--show-stats=false", "./..."],
			{
				cwd: context.rootDirectory,
				timeout: 120000,
			},
		);

		const output = result.stdout;
		if (!output) {
			if (result.exitCode !== 0) {
				const detail =
					(result.stderr ? result.stderr.slice(0, 200) : "") || `exit code ${result.exitCode}`;
				warnSubprocessFailure("golangci-lint", new Error(detail));
			}
			return [];
		}

		let parsed: { Issues?: GolangciIssue[] };
		try {
			parsed = JSON.parse(output);
		} catch {
			warnSubprocessFailure("golangci-lint", new Error(`Non-JSON output: ${output.slice(0, 200)}`));
			return [];
		}

		return (parsed.Issues ?? []).map((issue) => ({
			filePath: relativePosix(context.rootDirectory, issue.Pos.Filename),
			engine: "lint" as const,
			rule: `go/${issue.FromLinter}`,
			severity: "warning" as const,
			message: issue.Text,
			help: "",
			line: issue.Pos.Line,
			column: issue.Pos.Column,
			category: "Go Lint",
			fixable: false,
		}));
	} catch (error) {
		// A missing binary is gated out before this ever runs (installedTools["golangci-lint"]);
		// anything else is golangci-lint present but failing, which must not go silent.
		if (!isMissingToolError(error)) warnSubprocessFailure("golangci-lint", error);
		return [];
	}
};
