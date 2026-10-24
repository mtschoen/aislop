import type { DotnetTargetSelection } from "../dotnet-targets.js";
import type { AnalyzerExecution, EngineContext, EngineFailure } from "../types.js";
import { toRelative } from "./csharp-execution.js";

export const missingRestoreReason = "no restore evidence (project.assets.json); run dotnet restore";

export const unrestoredProjectFailures = (
	context: EngineContext,
	tool: AnalyzerExecution["tool"],
	selection: DotnetTargetSelection,
	inScope?: (projectPath: string) => boolean,
): EngineFailure[] =>
	context.config.lint.csharp?.projectEvaluation === true
		? selection.coldProjects
				.filter((project) => inScope?.(project) ?? true)
				.map((project) => ({
					tool,
					target: toRelative(context, project),
					reason: missingRestoreReason,
				}))
		: [];

export const notSelectedFailures = (
	context: EngineContext,
	executions: AnalyzerExecution[],
): EngineFailure[] => {
	if (context.config.lint.csharp?.projectEvaluation !== true) return [];
	return executions
		.filter(
			(execution) =>
				execution.status === "not-selected" &&
				context.config.lint.csharp?.[execution.tool === "roslynator" ? "roslynator" : "jb"] !==
					false,
		)
		.map((execution) => ({
			tool: execution.tool,
			target: ".",
			reason: execution.reason ?? "no analysis targets selected",
		}));
};
