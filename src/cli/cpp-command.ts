import type { Command } from "commander";
import { cppSyncInternalCommand } from "../commands/cpp-sync-internal.js";
import { scaffoldComponentCommand } from "../commands/scaffold.js";

const repeatableValueParser = (value: string, previous: string[] = []): string[] => [
	...previous,
	value,
];

export const registerScaffoldCommand = (program: Command): void => {
	program
		.command("scaffold")
		.description("Generate source scaffolds (experimental)")
		.command("component <name>")
		.description("Generate a C++ component-as-translation-unit scaffold (experimental)")
		.option("--dir <path>", "directory to write component files", ".")
		.option("--fragment <fragment>", "fragment name to generate", repeatableValueParser, [])
		.option("--adopt", "fold existing sources into the component instead of failing")
		.action((name: string, _flags, command) => {
			const flags = command.optsWithGlobals() as {
				dir?: string;
				fragment?: string[];
				adopt?: boolean;
			};
			scaffoldComponentCommand(name, {
				directory: flags.dir,
				fragments: flags.fragment,
				adopt: flags.adopt,
			});
		});
};

export const registerCppCommand = (program: Command): void => {
	program
		.command("cpp")
		.description("C++ helper commands (experimental)")
		.command("sync-internal <component>")
		.description(
			"Regenerate a component .internal.h for standalone fragment editing (experimental)",
		)
		.option("--dir <path>", "project directory", ".")
		.action((component: string, _flags, command) => {
			const flags = command.optsWithGlobals() as { dir?: string };
			cppSyncInternalCommand(component, { directory: flags.dir });
		});
};
