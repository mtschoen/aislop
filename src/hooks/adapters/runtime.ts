import path from "node:path";
import { buildHookScanCompletedProps, track } from "../../telemetry/index.js";
import { type AislopFeedback, buildFeedback } from "../feedback.js";
import { acquireHookLock } from "../io/scan-lock.js";
import { resolveHookFiles, runScopedScan } from "../io/scoped-scan.js";
import { appendSessionFiles, readBaseline } from "../quality-gate/baseline.js";

export type RuntimeHookAgent = "codex";

export const readHookStdin = async (): Promise<string> => {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
};

export const resolveHookCwd = (candidate: string | undefined): string =>
	candidate && path.isAbsolute(candidate) ? candidate : process.cwd();

export const scanTouchedFiles = async (input: {
	agent: RuntimeHookAgent;
	cwd: string;
	filePaths: string[];
}): Promise<AislopFeedback | null> => {
	const files = resolveHookFiles(input.cwd, input.filePaths);
	if (files.length === 0) return null;

	const release = acquireHookLock(input.cwd);
	if (!release) return null;

	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(input.cwd, files);
		const baseline = readBaseline(input.cwd);
		appendSessionFiles(input.cwd, files);
		const feedback = buildFeedback(
			diagnostics,
			score,
			rootDirectory,
			baseline
				? { score: baseline.score, findingFingerprints: baseline.findingFingerprints }
				: undefined,
			{ agent: input.agent, touchedFiles: files },
		);
		track({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: input.agent,
				score,
				scoreDelta: baseline ? score - baseline.score : null,
				findingCount: diagnostics.length,
				fileCount: files.length,
			}),
		});
		return feedback;
	} catch {
		return null;
	} finally {
		release();
	}
};
