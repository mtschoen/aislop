import path from "node:path";
import { parseSolutionProjects } from "../../src/engines/solution-projects.js";

type SubprocessFunction = (
	command: string,
	args: string[],
	options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

/**
 * Wrap a mocked runSubprocess so `dotnet sln <solution> list` answers from the
 * fixture solution file in the SDK's output shape, and every other command goes
 * to the wrapped mock untouched (so its call counts stay about the analyzers).
 */
export const withDotnetSolutionList =
	(subprocess: SubprocessFunction): SubprocessFunction =>
	async (command, args, options) => {
		if (command !== "dotnet" || args[0] !== "sln") return subprocess(command, args, options);
		const solutionPath = args[1];
		const solutionDirectory = path.dirname(solutionPath);
		const members = parseSolutionProjects(solutionPath, solutionDirectory);
		const stdout =
			members.length === 0
				? "No projects found in the solution."
				: ["Project(s)", "----------", ...members.map((member) => member.relativePath)].join("\n");
		return { stdout, stderr: "", exitCode: 0 };
	};
