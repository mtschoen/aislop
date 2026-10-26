import path from "node:path";
import {
	SUBPROCESS_SHUTDOWN_GRACE_MS,
	SubprocessTimeoutError,
	trackSubprocessTimeouts,
} from "../utils/subprocess.js";

// Fork-only module. Every C# pass that loads MSBuild (jb inspectcode with its
// build, roslynator analyze, dotnet format) runs a design-time build that writes
// shared files under each project's obj/<tfm>/ (XamlCompiler input and output
// json, *.AssemblyReference.cache). Two such passes on the same projects race on
// those files and one loses with "Msbuild failed when processing the file", which
// the coverage gate correctly reports as a project that was not analyzed. The
// engines run concurrently, so each pass takes this lock around its tool process.
//
// Granularity is the resolved scan root: projects can be shared between several
// solutions under one root, so a per-solution key would still let two passes
// touch the same obj directory. Different roots never block each other, and
// passes that do not load MSBuild never take the lock.

const tails = new Map<string, Promise<void>>();

const waitForBoundedTerminations = async (
	terminations: ReadonlySet<Promise<void>>,
): Promise<void> => {
	if (terminations.size === 0) return;
	let graceTimer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.allSettled(terminations),
			new Promise<void>((resolve) => {
				graceTimer = setTimeout(resolve, SUBPROCESS_SHUTDOWN_GRACE_MS);
			}),
		]);
	} finally {
		if (graceTimer) clearTimeout(graceTimer);
	}
};

/** Run `task` once every earlier pass for the same scan root has settled and any
 *  timed-out subprocess tree it started has terminated (bounded by the shutdown
 *  grace period). A rejected or thrown task releases the lock for the next one
 *  after termination completes. */
export const runSerializedMsbuildPass = async <T>(
	rootDirectory: string,
	task: () => Promise<T>,
): Promise<T> => {
	const key = path.resolve(rootDirectory);
	const previous = tails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => released);
	tails.set(key, tail);
	await previous;
	const terminations = new Set<Promise<void>>();
	try {
		return await trackSubprocessTimeouts(terminations, task);
	} catch (error) {
		if (error instanceof SubprocessTimeoutError) {
			terminations.add(error.terminated);
		}
		throw error;
	} finally {
		try {
			await waitForBoundedTerminations(terminations);
		} finally {
			release();
			if (tails.get(key) === tail) tails.delete(key);
		}
	}
};
