import type { Diagnostic, Engine, EngineContext, EngineFailure, EngineResult } from "../types.js";
import { checkComplexity } from "./complexity.js";
import { detectDuplicateBlocks } from "./duplicate-block.js";
import { runKnip } from "./knip.js";
import { detectRepeatedChainedCalls } from "./repeated-chained-call.js";

export const codeQualityEngine: Engine = {
	name: "code-quality",

	async run(context: EngineContext): Promise<EngineResult> {
		const diagnostics: Diagnostic[] = [];

		const promises: Promise<Diagnostic[]>[] = [];
		const checkNames: string[] = [];

		const canRunProjectLocalTools = context.config.allowProjectLocalTools !== false;
		if (
			canRunProjectLocalTools &&
			(context.languages.includes("typescript") || context.languages.includes("javascript"))
		) {
			checkNames.push("knip");
			promises.push(runKnip(context.rootDirectory));
		}

		checkNames.push("complexity", "repeated-chained-call", "duplicate-block");
		promises.push(checkComplexity(context));
		promises.push(detectRepeatedChainedCalls(context));
		promises.push(detectDuplicateBlocks(context));

		// A check that throws did not run: report it so the scan is marked
		// incomplete instead of quietly scoring as if the check had passed.
		const failures: EngineFailure[] = [];
		const results = await Promise.allSettled(promises);
		results.forEach((result, index) => {
			if (result.status === "fulfilled") {
				diagnostics.push(...result.value);
				return;
			}
			const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
			failures.push({ tool: `code-quality ${checkNames[index]}`, target: ".", reason });
		});

		return {
			engine: "code-quality",
			diagnostics,
			elapsed: 0,
			skipped: false,
			...(failures.length > 0 ? { failures, failed: true } : {}),
		};
	},
};
