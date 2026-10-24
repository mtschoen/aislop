import type { Diagnostic, Engine, EngineContext, EngineResult } from "../types.js";
import { detectOverAbstraction } from "./abstractions.js";
import { detectTrivialComments } from "./comments.js";
import { inspectCommittedArtifacts } from "./committed-artifacts.js";
import { detectCppPatterns } from "./cpp-patterns.js";
import { detectCSharpPatterns } from "./csharp-patterns.js";
import { detectDeadPatterns } from "./dead-patterns.js";
import { detectDefensivePatterns } from "./defensive-patterns.js";
import { detectDuplicateImports } from "./duplicate-imports.js";
import { detectSwallowedExceptions } from "./exceptions.js";
import { detectGoPatterns } from "./go-patterns.js";
import { detectHallucinatedImports } from "./hallucinated-imports.js";
import { detectHardcodedConfigLiterals } from "./hardcoded-config.js";
import { detectHardcodedUserPaths } from "./hardcoded-user-path.js";
import { detectHiddenFallbacks } from "./hidden-fallback.js";
import { detectMetaComments } from "./meta-comment.js";
import { detectNarrativeComments } from "./narrative-comments.js";
import { detectNonAsciiPunctuation } from "./non-ascii-punctuation.js";
import { detectPythonPatterns } from "./python-patterns.js";
import { detectRustPatterns } from "./rust-patterns.js";
import { detectSilentRecovery } from "./silent-recovery.js";
import { detectUnknownDirectives } from "./suppression-directives.js";
import { detectSystemdTimeouts } from "./systemd-timeout.js";
import { detectTautologicalTests } from "./test-quality.js";
import { detectTestSleeps } from "./test-sleep.js";
import { detectTestSpawnTimeouts } from "./test-spawn-timeout.js";
import { detectTestWallClockAssertions } from "./test-wall-clock.js";
import { detectUnusedCss } from "./unused-css.js";
import { detectUnusedImports } from "./unused-imports.js";

export const aiSlopEngine: Engine = {
	name: "ai-slop",

	async run(context: EngineContext): Promise<EngineResult> {
		const diagnostics: Diagnostic[] = [];

		const results = await Promise.allSettled([
			detectTrivialComments(context),
			detectSwallowedExceptions(context),
			detectDefensivePatterns(context),
			detectOverAbstraction(context),
			detectDeadPatterns(context),
			detectUnusedImports(context),
			detectNarrativeComments(context),
			detectDuplicateImports(context),
			detectHardcodedConfigLiterals(context),
			detectHardcodedUserPaths(context),
			detectHiddenFallbacks(context),
			detectPythonPatterns(context),
			detectGoPatterns(context),
			detectRustPatterns(context),
			detectHallucinatedImports(context),
			detectSilentRecovery(context),
			detectMetaComments(context),
			detectCSharpPatterns(context),
			detectCppPatterns(context),
			detectUnusedCss(context),
			detectTautologicalTests(context),
			detectTestSleeps(context),
			detectTestSpawnTimeouts(context),
			detectTestWallClockAssertions(context),
			detectNonAsciiPunctuation(context),
			detectSystemdTimeouts(context),
			detectUnknownDirectives(context),
		]);
		const committedArtifacts = await inspectCommittedArtifacts(context);

		for (const result of results) {
			if (result.status === "fulfilled") {
				diagnostics.push(...result.value);
			}
		}
		diagnostics.push(...committedArtifacts.diagnostics);

		return {
			engine: "ai-slop",
			diagnostics,
			elapsed: 0,
			skipped: false,
			...(committedArtifacts.missingTools.length > 0
				? { missingTools: committedArtifacts.missingTools }
				: {}),
			...(committedArtifacts.failures.length > 0
				? { failed: true, failures: committedArtifacts.failures }
				: {}),
		};
	},
};
