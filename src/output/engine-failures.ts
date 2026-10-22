import type { EngineResult } from "../engines/types.js";

/** Keep failure explanations off machine-readable stdout, in every output mode. */
export const printEngineFailures = (results: EngineResult[]): boolean => {
	const failures = results.flatMap((result) => result.failures ?? []);
	if (failures.length === 0) return false;
	process.stderr.write("aislop: Scan incomplete; the score reflects only completed analysis.\n");
	for (const failure of failures) {
		process.stderr.write(
			`aislop: ${failure.tool} not-run for ${failure.target}: ${failure.reason}\n`,
		);
	}
	return true;
};
