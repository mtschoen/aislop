import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, findConfigDir } from "../../config/index.js";
import type { Diagnostic } from "../../engines/types.js";
import { buildHookScanCompletedProps, track as trackTelemetry } from "../../telemetry/index.js";
import { buildFeedback } from "../feedback.js";
import { acquireHookLock } from "../io/scan-lock.js";
import { resolveHookFiles, runScopedScan } from "../io/scoped-scan.js";
import {
	appendSessionFiles,
	clearSessionFiles,
	readBaseline,
	readSessionFiles,
} from "../quality-gate/baseline.js";

interface CodexHookStdin {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: {
		command?: string;
	};
	cwd?: string;
	session_id?: string;
	stop_hook_active?: boolean;
}

interface CodexPostToolOutput {
	hookSpecificOutput: {
		hookEventName: "PostToolUse";
		additionalContext: string;
	};
}

interface CodexStopOutput {
	decision: "block";
	reason: string;
}

interface ScanResult {
	diagnostics: Diagnostic[];
	score: number;
	rootDirectory: string;
}

interface BaselineSnapshot {
	score: number;
	findingFingerprints: string[];
}

interface CodexAdapterDependencies {
	stdin?: () => Promise<string>;
	write?: (output: string) => void;
	hasConfig?: (cwd: string) => boolean;
	resolveFiles?: (cwd: string, files: string[]) => string[];
	acquireLock?: (cwd: string) => (() => void) | null;
	scan?: (cwd: string, files: string[]) => Promise<ScanResult>;
	readBaseline?: (cwd: string) => BaselineSnapshot | null;
	appendFiles?: (cwd: string, files: string[]) => void;
	readFiles?: (cwd: string) => string[];
	clearFiles?: (cwd: string) => void;
	track?: typeof trackTelemetry;
}

const PATCH_PATH_PATTERN = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

export const parseCodexStdin = (raw: string): CodexHookStdin => {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw) as CodexHookStdin;
	} catch {
		return {};
	}
};

export const extractCodexPatchFiles = (command: string): string[] => {
	const files = new Set<string>();
	for (const line of command.split("\n")) {
		const file = line.match(PATCH_PATH_PATTERN)?.[1]?.trim();
		if (file) files.add(file);
	}
	return Array.from(files);
};

export const renderCodexPostToolOutput = (additionalContext: string): CodexPostToolOutput => ({
	hookSpecificOutput: {
		hookEventName: "PostToolUse",
		additionalContext,
	},
});

export const renderCodexStopOutput = (reason: string): CodexStopOutput => ({
	decision: "block",
	reason,
});

const readStdin = async (): Promise<string> => {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
};

const hasAislopConfig = (cwd: string): boolean => {
	const configDirectory = findConfigDir(cwd);
	return configDirectory !== null && fs.existsSync(path.join(configDirectory, CONFIG_FILE));
};

const resolveCwd = (input: CodexHookStdin): string =>
	input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();

export const runCodexHook = async (deps: CodexAdapterDependencies = {}): Promise<number> => {
	const input = parseCodexStdin(await (deps.stdin ?? readStdin)());
	const cwd = resolveCwd(input);
	if (!(deps.hasConfig ?? hasAislopConfig)(cwd)) return 0;
	if (input.tool_name !== "apply_patch") return 0;

	const command = input.tool_input?.command ?? "";
	const files = (deps.resolveFiles ?? resolveHookFiles)(cwd, extractCodexPatchFiles(command));
	if (files.length === 0) return 0;

	const release = (deps.acquireLock ?? acquireHookLock)(cwd);
	if (!release) return 0;

	try {
		const { diagnostics, score, rootDirectory } = await (deps.scan ?? runScopedScan)(cwd, files);
		const baseline = (deps.readBaseline ?? readBaseline)(cwd);
		(deps.appendFiles ?? appendSessionFiles)(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, baseline ?? undefined, {
			agent: "codex",
			touchedFiles: files,
		});
		(deps.track ?? trackTelemetry)({
			event: "hook_scan_completed",
			properties: buildHookScanCompletedProps({
				agent: "codex",
				score,
				scoreDelta: baseline ? score - baseline.score : null,
				findingCount: diagnostics.length,
				fileCount: files.length,
			}),
		});
		const output = renderCodexPostToolOutput(JSON.stringify(feedback));
		(deps.write ?? ((value) => process.stdout.write(value)))(JSON.stringify(output));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};

export const runCodexStopHook = async (deps: CodexAdapterDependencies = {}): Promise<number> => {
	const input = parseCodexStdin(await (deps.stdin ?? readStdin)());
	const cwd = resolveCwd(input);
	if (!(deps.hasConfig ?? hasAislopConfig)(cwd) || input.stop_hook_active) return 0;

	const baseline = (deps.readBaseline ?? readBaseline)(cwd);
	if (!baseline) return 0;
	const files = (deps.readFiles ?? readSessionFiles)(cwd);
	if (files.length === 0) return 0;

	const release = (deps.acquireLock ?? acquireHookLock)(cwd);
	if (!release) return 0;

	try {
		const { diagnostics, score, rootDirectory } = await (deps.scan ?? runScopedScan)(cwd, files);
		const feedback = buildFeedback(diagnostics, score, rootDirectory, baseline, {
			agent: "codex",
			touchedFiles: files,
		});
		if (!feedback.regressed) {
			(deps.clearFiles ?? clearSessionFiles)(cwd);
			return 0;
		}
		const output = renderCodexStopOutput(
			`aislop: score dropped from ${baseline.score} to ${score}. Fix the findings before finishing.`,
		);
		(deps.write ?? ((value) => process.stdout.write(value)))(JSON.stringify(output));
		return 0;
	} catch {
		return 0;
	} finally {
		release();
	}
};
