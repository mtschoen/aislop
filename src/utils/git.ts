import { spawnSync } from "node:child_process";
import path from "node:path";
import { type ChangedLines, parseUnifiedDiffHunks } from "./change-context.js";
import { projectRelativePosix } from "./paths.js";

const MAX_BUFFER = 50 * 1024 * 1024;
const TEXT_ENCODING = "utf-8" as const;
const SCOPE_DISCOVERY_FAILURE = Symbol.for("aislop.scopeDiscoveryFailure");

const markScopeDiscoveryFailed = (stderr: string | null | undefined): string[] => {
	const files: string[] = [];
	Object.defineProperty(files, SCOPE_DISCOVERY_FAILURE, {
		value: (typeof stderr === "string" ? stderr.trim() : "") || "git diff failed",
		enumerable: false,
		configurable: true,
	});
	return files;
};

const runGit = (cwd: string, gitArguments: string[]) =>
	spawnSync("git", gitArguments, {
		cwd,
		encoding: TEXT_ENCODING,
		maxBuffer: MAX_BUFFER,
	});

const splitNullDelimited = (output: string): string[] =>
	output.split("\0").filter((entry) => entry.length > 0);

// Separates a missing/unfetched base ref from a genuine empty diff.
export const baseRefExists = (cwd: string, ref: string): boolean => {
	const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return !result.error && result.status === 0;
};

export const getChangedFiles = (cwd: string, base?: string): string[] => {
	const baseRef = base ?? "HEAD";
	const diff = runGit(cwd, [
		"diff",
		"--no-color",
		"--relative",
		"--name-only",
		"-z",
		"--diff-filter=ACMR",
		baseRef,
	]);
	if (diff.error || diff.status !== 0) return markScopeDiscoveryFailed(diff.stderr);

	const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);

	const names = new Set<string>(splitNullDelimited(diff.stdout));
	if (!untracked.error && untracked.status === 0) {
		for (const entry of splitNullDelimited(untracked.stdout)) {
			names.add(entry);
		}
	}

	return Array.from(names).map((filePath) => path.resolve(cwd, filePath));
};

export const getStagedFiles = (cwd: string): string[] => {
	const result = runGit(cwd, [
		"diff",
		"--no-color",
		"--relative",
		"--cached",
		"--name-only",
		"-z",
		"--diff-filter=ACMR",
	]);
	if (result.error || result.status !== 0) return markScopeDiscoveryFailed(result.stderr);
	return splitNullDelimited(result.stdout).map((filePath) => path.resolve(cwd, filePath));
};

const listUntrackedFiles = (cwd: string): string[] => {
	const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked.error || untracked.status !== 0) return [];
	return splitNullDelimited(untracked.stdout);
};

export const getChangedLineMap = (cwd: string, base?: string): Map<string, ChangedLines> => {
	const baseRef = base ?? "HEAD";
	const diff = runGit(cwd, [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--relative",
		"-U0",
		"--diff-filter=ACMR",
		baseRef,
	]);
	const map = !diff.error && diff.status === 0 ? parseUnifiedDiffHunks(diff.stdout) : new Map();
	for (const name of listUntrackedFiles(cwd)) {
		map.set(projectRelativePosix(cwd, path.resolve(cwd, name)), { kind: "all" });
	}
	return map;
};
