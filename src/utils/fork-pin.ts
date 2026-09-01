import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConfigDir } from "../config/index.js";
import { type BuildInfo, isCommitSha } from "./build-info.js";

// A consumer repository records the fork commit its CI is pinned to in
// `.aislop/fork-commit` (see .gitea/workflows/sync-consumers.yml, which bumps
// that pin everywhere on every push to schoen/main). Comparing it against the
// commit stamped into the running build's dist/build-info.json is what makes a
// stale machine checkout visible: CI builds the fork at the pinned sha in an
// ephemeral workspace, so a drifted local install never breaks a build, but it
// does make local results disagree with the gate.
//
// aislop's own repository carries no such pin, so every function here reports
// "no pin" when run against this checkout.
//
// Only `aislop doctor` consults this, and that is deliberate. The drift that
// prompted it showed up through the runtime hook, but the hook is the wrong
// place to report it: a consumer's harness warns once per session, where a
// fact about the machine belongs, while hook feedback is read per turn and
// describes the diff the agent just wrote. Routing machine maintenance into
// that channel also means handing the agent a command to run, and no single
// command is correct here: scripts/update-local-checkout.sh advances a
// checkout to schoen/main, which does not realign a deliberately older pin,
// so the advice would repeat every turn without ever resolving. `doctor`
// answers "is this machine set up correctly", on demand, and states both
// commits without promising a fix.

const FORK_PIN_FILE = "fork-commit";

type ForkPinState = "no-pin" | "aligned" | "drift" | "unknown-build";

export interface ForkPinStatus {
	state: ForkPinState;
	pinnedCommit: string | null;
	runningCommit: string | null;
}

// Resolves the pin through `findConfigDir`, the same upward walk configuration
// lookup uses, so a pin is found from a nested working directory exactly where
// a config file would be. As with configuration, the nearest `.aislop`
// directory wins: a nearer directory without a `fork-commit` file shadows a
// pin further up rather than falling through to it.
export const readForkPin = (startDirectory: string, stopAt?: string): string | null => {
	const configDirectory = findConfigDir(startDirectory, stopAt);
	if (!configDirectory) return null;
	try {
		const content = fs.readFileSync(path.join(configDirectory, FORK_PIN_FILE), "utf-8").trim();
		return isCommitSha(content) ? content : null;
	} catch {
		return null;
	}
};

// dist/build-info.json is written beside the bundled CLI, so the running
// install's commit is read from the directory this module was loaded from.
// A source or test run resolves to src/, where no stamp exists, and reports
// null rather than guessing.
export const readRunningBuildInfo = (distDirectory?: string): BuildInfo | null => {
	const directory = distDirectory ?? path.dirname(fileURLToPath(import.meta.url));
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(directory, "build-info.json"), "utf-8"),
		) as Partial<BuildInfo>;
		if (typeof parsed.version !== "string") return null;
		return {
			version: parsed.version,
			commit:
				typeof parsed.commit === "string" && isCommitSha(parsed.commit) ? parsed.commit : null,
			builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : new Date(0).toISOString(),
		};
	} catch {
		return null;
	}
};

export const checkForkPin = (input: {
	directory: string;
	stopAt?: string;
	distDirectory?: string;
}): ForkPinStatus => {
	const pinnedCommit = readForkPin(input.directory, input.stopAt);
	if (!pinnedCommit) {
		return { state: "no-pin", pinnedCommit: null, runningCommit: null };
	}

	const runningCommit = readRunningBuildInfo(input.distDirectory)?.commit ?? null;
	if (!runningCommit) {
		return { state: "unknown-build", pinnedCommit, runningCommit: null };
	}

	return {
		state: pinnedCommit.toLowerCase() === runningCommit.toLowerCase() ? "aligned" : "drift",
		pinnedCommit,
		runningCommit,
	};
};

export const shortCommit = (commit: string | null): string =>
	commit ? commit.slice(0, 7) : "unknown";
