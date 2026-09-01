import { spawnSync } from "node:child_process";

export interface BuildInfo {
	version: string;
	commit: string | null;
	builtAt: string;
}

const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

export const isCommitSha = (value: string): boolean => COMMIT_SHA_PATTERN.test(value);

// Resolves the commit that dist/build-info.json stamps. CI may inject an
// explicit COMMIT (a shallow clone or a source tarball checkout can make
// `git rev-parse` answer wrong, or there is no .git directory at all), so an
// explicit override always wins over asking git when it is a valid 40-character SHA.
export const resolveCommitSha = (
	environmentCommit: string | undefined,
	gitRevParseHead: () => string | null,
): string | null => {
	const trimmedEnvironmentCommit = environmentCommit?.trim();
	if (trimmedEnvironmentCommit && isCommitSha(trimmedEnvironmentCommit)) {
		return trimmedEnvironmentCommit;
	}
	const fallbackCommit = gitRevParseHead()?.trim();
	if (fallbackCommit && isCommitSha(fallbackCommit)) {
		return fallbackCommit;
	}
	return null;
};

// Runs `git rev-parse HEAD` in `cwd` and never throws: a missing git binary,
// a directory that is not a checkout (an npm source tarball build has no
// .git), or any other git failure all resolve to null. A missing commit must
// never fail the build.
export const gitRevParseHead = (cwd: string): string | null => {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
	});
	if (result.error || result.status !== 0) return null;
	const commit = result.stdout.trim();
	return isCommitSha(commit) ? commit : null;
};

export const buildBuildInfo = (input: {
	version: string;
	commit: string | null;
	builtAt: Date;
}): BuildInfo => ({
	version: input.version,
	commit: input.commit,
	builtAt: input.builtAt.toISOString(),
});
