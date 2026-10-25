import { findMissingTools, type ToolRequirement, withMissingTools } from "../missing-tools.js";
import type { Diagnostic, Engine, EngineContext, EngineFailure, EngineResult } from "../types.js";
import { runBiomeFormat } from "./biome.js";
import { hasClangFormatConfig, runClangFormat } from "./clang-format.js";
import { runDotnetFormat } from "./dotnet-format.js";
import { runGenericFormatter } from "./generic.js";
import { runGofmt } from "./gofmt.js";
import { runRuffFormat } from "./ruff-format.js";

const FORMAT_TOOL_REQUIREMENTS: readonly ToolRequirement[] = [
	{ language: "python", tool: "ruff" },
	{ language: "go", tool: "gofmt" },
	{ language: "rust", tool: "cargo" },
	{ language: "rust", tool: "rustfmt" },
	{ language: "ruby", tool: "rubocop" },
	{ language: "php", tool: "php-cs-fixer" },
	{
		language: "csharp",
		tool: "dotnet",
		applies: (context) => context.config.lint.csharp?.projectEvaluation === true,
	},
	{
		language: "cpp",
		tool: "clang-format",
		applies: (context) => hasClangFormatConfig(context.rootDirectory),
	},
];

export const formatEngine: Engine = {
	name: "format",

	async run(context: EngineContext): Promise<EngineResult> {
		const diagnostics: Diagnostic[] = [];
		const { languages, installedTools } = context;

		const promises: Array<{ tool: string; run: Promise<Diagnostic[]> }> = [];
		const add = (tool: string, run: Promise<Diagnostic[]>) => promises.push({ tool, run });

		if (languages.includes("typescript") || languages.includes("javascript")) {
			add("biome", runBiomeFormat(context));
		}

		if (languages.includes("python") && installedTools.ruff) {
			add("ruff", runRuffFormat(context));
		}

		if (languages.includes("go") && installedTools.gofmt) {
			add("gofmt", runGofmt(context));
		}

		if (languages.includes("rust") && installedTools.cargo && installedTools.rustfmt) {
			add("rustfmt", runGenericFormatter(context, "rust"));
		}

		if (languages.includes("ruby") && installedTools.rubocop) {
			add("rubocop", runGenericFormatter(context, "ruby"));
		}

		if (languages.includes("php") && installedTools["php-cs-fixer"]) {
			add("php-cs-fixer", runGenericFormatter(context, "php"));
		}

		if (
			languages.includes("csharp") &&
			installedTools.dotnet &&
			context.config.lint.csharp?.projectEvaluation === true
		) {
			add("dotnet format", runDotnetFormat(context));
		}

		if (languages.includes("cpp") && installedTools["clang-format"]) {
			add("clang-format", runClangFormat(context));
		}

		// No formatter matched the detected languages/installed tools. Report this as
		// skipped (mirroring `doctor`) rather than returning an empty result, which the
		// scan summary would otherwise launder into a misleading "done (0 issues)".
		const missingTools = findMissingTools(context, FORMAT_TOOL_REQUIREMENTS);
		if (promises.length === 0) {
			return withMissingTools(
				{
					engine: "format",
					diagnostics,
					elapsed: 0,
					skipped: true,
					skipReason: "no formatter for the detected languages",
				},
				missingTools,
			);
		}

		const results = await Promise.allSettled(promises.map((entry) => entry.run));
		const failures: EngineFailure[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === "fulfilled") {
				diagnostics.push(...result.value);
			} else {
				const reason =
					result.reason instanceof Error ? result.reason.message : String(result.reason);
				failures.push({ tool: promises[index].tool, target: ".", reason });
			}
		}

		// A formatter that failed to run is reported as a failed engine (the same
		// shape the orchestrator gives a throwing engine), not as zero findings.
		const failure =
			failures.length > 0
				? {
						skipped: true,
						failed: true,
						failures,
						skipReason: failures.map((entry) => entry.reason).join("; "),
					}
				: { skipped: false };
		return withMissingTools(
			{
				engine: "format",
				diagnostics,
				elapsed: 0,
				...failure,
			},
			missingTools,
		);
	},
};
