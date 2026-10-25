import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, findConfigDir } from "../../config/index.js";
import { buildHookScanCompletedProps, track } from "../../telemetry/index.js";
import { type AislopFeedback, buildFeedback } from "../feedback.js";
import { acquireHookLock } from "../io/scan-lock.js";
import { resolveHookFiles, runScopedScan } from "../io/scoped-scan.js";
import {
	appendSessionFiles,
	clearSessionFiles,
	readBaseline,
	readSessionFiles,
} from "../quality-gate/baseline.js";

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

/** A project opts in to runtime hooks by having an aislop configuration file. */
export const hasAislopConfig = (cwd: string): boolean => {
	const configDirectory = findConfigDir(cwd);
	return configDirectory !== null && fs.existsSync(path.join(configDirectory, CONFIG_FILE));
};

export interface StopGateBlock {
	reason: string;
	feedback: AislopFeedback;
}

/**
 * Shared Stop quality gate: rescans the files touched this session and returns a block
 * when the score regressed against the captured baseline. Returns null to allow the stop.
 */
export const evaluateStopGate = async (input: {
	agent: "claude" | "codex";
	cwd: string;
}): Promise<StopGateBlock | null> => {
	const baseline = readBaseline(input.cwd);
	if (!baseline) return null;

	const sessionFiles = readSessionFiles(input.cwd);
	if (sessionFiles.length === 0) return null;

	const release = acquireHookLock(input.cwd);
	if (!release) return null;
	try {
		const { diagnostics, score, rootDirectory } = await runScopedScan(input.cwd, sessionFiles);
		const feedback = buildFeedback(
			diagnostics,
			score,
			rootDirectory,
			{ score: baseline.score, findingFingerprints: baseline.findingFingerprints },
			{ agent: input.agent, touchedFiles: sessionFiles },
		);
		if (!feedback.regressed) {
			clearSessionFiles(input.cwd);
			return null;
		}
		const total = feedback.counts.total;
		return {
			reason: `aislop: score dropped from ${baseline.score} to ${score}. Fix the ${total} finding${total === 1 ? "" : "s"} before finishing.`,
			feedback,
		};
	} catch {
		return null;
	} finally {
		release();
	}
};
