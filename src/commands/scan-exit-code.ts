// Target failures bypass finding baselines; a withheld score cannot be compared to failBelow.
export const computeScanExitCode = (opts: {
	hasErrors: boolean;
	hasEngineFailures?: boolean;
	scoreable: boolean;
	score: number;
	failBelow: number;
	missingTools?: boolean;
	failOnMissingTools?: boolean;
	newFindings?: number;
}): number => {
	const findingsFail = opts.newFindings === undefined ? opts.hasErrors : opts.newFindings > 0;
	return opts.hasEngineFailures ||
		findingsFail ||
		(opts.scoreable && opts.score < opts.failBelow) ||
		(opts.failOnMissingTools === true && opts.missingTools === true)
		? 1
		: 0;
};
