import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasChildExited } from "./process-state.js";

export { hasChildExited, hasProcessExited } from "./process-state.js";

interface SubprocessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

// Windows caps a process's total command line around 32767 characters; other
// platforms are more permissive but a conservative shared limit keeps one code
// path for every OS. Chunking by file count too keeps a single invocation from
// paying for an unbounded amount of a tool's own per-file startup/parse work.
const DEFAULT_CHUNK_MAX_FILES = 200;
const DEFAULT_CHUNK_MAX_CHARS = 25000;

// Group file paths into batches that each fit a single subprocess invocation,
// respecting both a character budget (command line length) and a file-count
// cap. A lone file longer than the character budget still gets its own chunk
// rather than being dropped or split.
export const chunkFilePaths = (
	filePaths: string[],
	maxFiles: number = DEFAULT_CHUNK_MAX_FILES,
	maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): string[][] => {
	const chunks: string[][] = [];
	let current: string[] = [];
	let currentChars = 0;
	for (const filePath of filePaths) {
		const addedChars = filePath.length + 1; // +1 for the separating space
		const overflowsChunk =
			current.length > 0 && (current.length >= maxFiles || currentChars + addedChars > maxChars);
		if (overflowsChunk) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(filePath);
		currentChars += addedChars;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
};

const SIGKILL_ESCALATION_MS = 1000;
const POSIX_TREE_POLL_INTERVAL_MS = 20;
export const SUBPROCESS_SHUTDOWN_GRACE_MS = 2000;

const waitForExit = (child: ChildProcess): Promise<void> =>
	new Promise((resolve) => {
		child.once("close", () => resolve());
		child.once("error", () => resolve());
	});

const isProcessGroupAlive = (pid: number): boolean => {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
};

const waitForWindowsTreeExit = (
	child: ChildProcess,
	taskkill: ChildProcess,
	hasFallbackFired: () => boolean,
	killDirectChild: () => void,
): Promise<void> =>
	new Promise<void>((resolve) => {
		let taskkillSucceeded = false;
		let childExited = false;
		const finish = () => {
			clearTimeout(graceTimer);
			resolve();
		};
		const finishIfConfirmed = () => {
			if (taskkillSucceeded && childExited) finish();
		};
		const graceTimer = setTimeout(() => {
			if (!taskkillSucceeded) killDirectChild();
			finish();
		}, SUBPROCESS_SHUTDOWN_GRACE_MS);
		taskkill.once("close", (code) => {
			if (code !== 0 || hasFallbackFired()) return;
			taskkillSucceeded = true;
			finishIfConfirmed();
		});
		void waitForExit(child).then(() => {
			childExited = true;
			finishIfConfirmed();
		});
	});

const waitForPosixTreeExit = (
	child: ChildProcess,
	pid: number,
	sigkillTimer: NodeJS.Timeout,
): Promise<void> =>
	new Promise<void>((resolve) => {
		let settled = false;
		let poll: NodeJS.Timeout | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(sigkillTimer);
			clearTimeout(graceTimer);
			if (poll) clearInterval(poll);
			resolve();
		};
		const graceTimer = setTimeout(finish, SUBPROCESS_SHUTDOWN_GRACE_MS);
		sigkillTimer.ref();
		void waitForExit(child).then(() => {
			if (settled) return;
			if (!isProcessGroupAlive(pid)) return finish();
			poll = setInterval(() => {
				if (!isProcessGroupAlive(pid)) finish();
			}, POSIX_TREE_POLL_INTERVAL_MS);
		});
	});

// A timed-out tool (e.g. cppcheck -j) can have spawned worker processes of its
// own; killing only the direct child leaves those workers running as orphans.
// This kills the whole tree instead and returns false when the direct child
// was already gone so the signal could not be delivered. Windows has no
// process groups, so it shells out to taskkill's /T (tree) flag; POSIX relies
// on the child having been spawned detached (see below) so its pid doubles as
// a process-group id.
const killProcessTree = (child: ChildProcess, terminations?: Promise<void>[]): boolean => {
	if (process.platform === "win32") {
		if (child.pid === undefined) return child.kill("SIGTERM");
		if (!child.kill(0)) return false;
		// taskkill walks the tree by parent pid, so the parent must still be
		// alive when it runs - calling child.kill("SIGTERM") first would sever
		// the walk and orphan the very workers this is meant to reap.
		const taskkill = childProcess.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		let directChildKilled = false;
		const killDirectChild = () => {
			if (directChildKilled) return;
			directChildKilled = true;
			child.kill();
		};
		// A missing or failing taskkill binary must not crash the process or
		// leave the direct child running; fall back to killing the direct child
		// and keep tree termination unconfirmed until the shutdown grace expires.
		taskkill.once("error", killDirectChild);
		taskkill.once("close", (code) => {
			if (code !== 0) killDirectChild();
		});
		terminations?.push(
			waitForWindowsTreeExit(child, taskkill, () => directChildKilled, killDirectChild),
		);
		return true;
	}

	if (child.pid === undefined) {
		if (!child.kill("SIGTERM")) return false;
		setTimeout(() => child.kill("SIGKILL"), SIGKILL_ESCALATION_MS).unref();
		return true;
	}
	if (!child.kill("SIGTERM")) return false;
	const pid = child.pid;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// The direct child was already signaled via child.kill("SIGTERM") above.
	}
	const sigkillTimer = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, SIGKILL_ESCALATION_MS);
	sigkillTimer.unref();
	if (terminations) terminations.push(waitForPosixTreeExit(child, pid, sigkillTimer));
	return true;
};

// Every in-flight child is tracked here so an interactive Ctrl-C can reap it.
// The timeout path already tree-kills its own child; this registry is for the
// signal path, where cli.ts's SIGINT/SIGTERM handlers would otherwise call
// process.exit() and orphan any scanner still running. On POSIX each child is a
// process-group leader (see the detached spawn below), so killProcessTree
// signals the whole group; on win32 the children are not detached and already
// receive the console's Ctrl-C directly, making this a best-effort backstop.
const activeChildren = new Set<ChildProcess>();

export const killActiveChildren = (): void => {
	for (const child of activeChildren) {
		killProcessTree(child);
	}
	activeChildren.clear();
};

interface OutputCapture {
	tempDir: string;
	stdoutPath: string;
	stderrPath: string;
	outFd: number;
	errFd: number;
}

// Output goes through temp files instead of pipes: the OS pipe buffer is
// 64KB, and on Windows a child-side pipe write() is synchronous, blocking
// once that buffer fills until the parent drains it. A parent stuck in a
// long synchronous pass (e.g. aislop's per-file engine work) never drains,
// so the child would stall at zero CPU; a file write needs no parent at all.
const createOutputCapture = (): OutputCapture => {
	const tempDir = mkdtempSync(path.join(tmpdir(), "aislop-"));
	const stdoutPath = path.join(tempDir, "stdout.log");
	const stderrPath = path.join(tempDir, "stderr.log");
	let outFd: number | undefined;
	try {
		outFd = openSync(stdoutPath, "w");
		const errFd = openSync(stderrPath, "w");
		return { tempDir, stdoutPath, stderrPath, outFd, errFd };
	} catch (error) {
		if (outFd !== undefined) {
			try {
				closeSync(outFd);
			} catch {
				// stdout fd may already be unusable if the failure came from
				// opening stderr; nothing more to release for it either way.
			}
		}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort: leaking an occasional temp dir is acceptable.
		}
		throw error;
	}
};

// True when a runSubprocess rejection means the tool binary itself could not be
// found (ENOENT from the underlying spawn). Callers gate on `installedTools`
// before invoking a tool at all, so this should be rare in practice, but it is
// the expected-and-silent case: the current UX for a missing optional tool is
// to say nothing. Anything else - a timeout, an oversized argv, a real spawn
// error - is a tool that IS present failing to run, which must not be swallowed
// the same way (see warnSubprocessFailure).
export const isMissingToolError = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

// Surface a real invocation failure (not a missing tool) instead of silently
// returning no findings. Writes to stderr, never stdout, so it cannot corrupt
// `--json`/`--sarif` output, which is a single machine-readable blob on stdout.
export const warnSubprocessFailure = (tool: string, error: unknown): void => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`aislop: ${tool} failed to run and was skipped: ${message}`);
};

const MAXIMUM_FAILURE_DETAIL_LENGTH = 300;

// Tool output copied into a failure reason lands in JSON, SARIF and stderr, so
// keep only a bounded head of it and say when the rest was dropped.
export const truncateFailureDetail = (detail: string): string => {
	const trimmed = detail.trim();
	return trimmed.length <= MAXIMUM_FAILURE_DETAIL_LENGTH
		? trimmed
		: `${trimmed.slice(0, MAXIMUM_FAILURE_DETAIL_LENGTH)}... [truncated ${trimmed.length - MAXIMUM_FAILURE_DETAIL_LENGTH} characters]`;
};

const activeTimeoutTerminations = new AsyncLocalStorage<Set<Promise<void>>>();

export const trackSubprocessTimeouts = <T>(
	terminations: Set<Promise<void>>,
	task: () => Promise<T>,
): Promise<T> => activeTimeoutTerminations.run(terminations, task);

// A timed-out command still printed whatever it had written before it was killed. The
// error carries that output so a caller can keep readable findings and still report the
// run as incomplete, plus a `terminated` promise that settles once the killed process
// tree has finished exiting.
export class SubprocessTimeoutError extends Error {
	constructor(
		message: string,
		readonly stdout: string,
		readonly stderr: string,
		readonly terminated: Promise<void> = Promise.resolve(),
	) {
		super(message);
		this.name = "SubprocessTimeoutError";
		activeTimeoutTerminations.getStore()?.add(terminated);
	}
}

const readCapturedOutput = (filePath: string): string => {
	try {
		return readFileSync(filePath, "utf-8").trim();
	} catch {
		return "";
	}
};

export const runSubprocess = (
	command: string,
	args: string[],
	options: {
		cwd?: string;
		timeout?: number;
		env?: Record<string, string>;
	} = {},
): Promise<SubprocessResult> => {
	return new Promise((resolve, reject) => {
		let capture: OutputCapture;
		try {
			capture = createOutputCapture();
		} catch (error) {
			reject(
				new Error(`Failed to prepare output capture for ${command}: ${(error as Error).message}`),
			);
			return;
		}

		const child = childProcess.spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", capture.outFd, capture.errFd],
			windowsHide: true,
			// Makes the child a process-group leader on POSIX so a timeout can
			// signal the whole group via a negative pid, not just this process.
			// win32 ignores `detached` for grouping purposes; taskkill handles
			// the tree there instead (see killProcessTree).
			detached: process.platform !== "win32",
		});

		activeChildren.add(child);

		// Runs exactly once, on whichever of 'close'/'error' fires first (a
		// spawn failure can still emit 'close' afterward). Not gated behind
		// `settled`: a timeout already rejected before the killed child's
		// 'close' arrives, but the temp files must still be read and removed.
		let cleanedUp = false;
		const cleanup = (): { stdout: string; stderr: string } => {
			if (cleanedUp) return { stdout: "", stderr: "" };
			cleanedUp = true;
			activeChildren.delete(child);
			closeSync(capture.outFd);
			closeSync(capture.errFd);
			const stdout = readFileSync(capture.stdoutPath, "utf-8").trim();
			const stderr = readFileSync(capture.stderrPath, "utf-8").trim();
			// Best-effort: on Windows a just-killed child can still hold the
			// file handle briefly, so removal can fail here - leaking an
			// occasional temp file/dir into the OS tmpdir is acceptable.
			try {
				rmSync(capture.tempDir, { recursive: true, force: true });
			} catch {
				// Best-effort: leaking an occasional temp dir is acceptable.
			}
			return { stdout, stderr };
		};

		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finalize = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			callback();
		};

		if (options.timeout && options.timeout > 0) {
			timer = setTimeout(() => {
				// Under a starved event loop an expired timer can fire on the
				// same wake-up that carries the child's own exit/close events,
				// and the timers phase runs first. Deferring to the check phase
				// via setImmediate gives the intervening poll phase a chance to
				// reap the child, but a single non-blocking poll pass is not
				// guaranteed to observe an OS-level exit that just happened:
				// queuing setImmediate makes uv_backend_timeout 0, so poll does
				// not wait if SIGCHLD delivery to the signal pipe (POSIX) or
				// the RegisterWaitForSingleObject threadpool callback posting to
				// the IOCP (Windows) is still in flight under CPU contention.
				setImmediate(() => {
					if (settled) return;
					// Check both libuv's reaped state (exitCode/signalCode) and
					// the OS-level process state (including unreaped zombies on
					// POSIX), plus whether signaling the child reports it already
					// gone. When the child has finished at the OS level before
					// 'close' has fired, let 'close' resolve with the captured
					// output instead of misreporting a timeout.
					if (hasChildExited(child)) return;
					const terminations: Promise<void>[] = [];
					if (!killProcessTree(child, terminations)) return;
					const stdout = readCapturedOutput(capture.stdoutPath);
					const stderr = readCapturedOutput(capture.stderrPath);
					finalize(() =>
						reject(
							new SubprocessTimeoutError(
								`Command timed out after ${options.timeout}ms: ${command}`,
								stdout,
								stderr,
								Promise.all(terminations).then(() => {}),
							),
						),
					);
				});
			}, options.timeout);
			timer.unref();
		}

		child.once("error", (error: NodeJS.ErrnoException) => {
			cleanup();
			finalize(() => {
				const wrapped: NodeJS.ErrnoException = new Error(
					`Failed to run ${command}: ${error.message}`,
				);
				if (error.code) wrapped.code = error.code;
				reject(wrapped);
			});
		});
		child.once("close", (code) => {
			const { stdout, stderr } = cleanup();
			finalize(() => resolve({ stdout, stderr, exitCode: code }));
		});
	});
};

export const isToolInstalled = async (tool: string): Promise<boolean> => {
	try {
		const command = process.platform === "win32" ? "where.exe" : "which";
		const result = await runSubprocess(command, [tool]);
		return result.exitCode === 0 && result.stdout.length > 0;
	} catch {
		return false;
	}
};
