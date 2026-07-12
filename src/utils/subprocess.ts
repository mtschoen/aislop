import { type ChildProcess, spawn } from "node:child_process";

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

// A timed-out tool (e.g. cppcheck -j) can have spawned worker processes of its
// own; killing only the direct child leaves those workers running as orphans.
// This kills the whole tree instead. Windows has no process groups, so it
// shells out to taskkill's /T (tree) flag; POSIX relies on the child having
// been spawned detached (see below) so its pid doubles as a process-group id.
const killProcessTree = (child: ChildProcess): void => {
	if (process.platform === "win32") {
		if (child.pid === undefined) {
			child.kill("SIGTERM");
			return;
		}
		// taskkill walks the tree by parent pid, so the parent must still be
		// alive when it runs - calling child.kill() first would sever the
		// walk and orphan the very workers this is meant to reap.
		const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		// A missing taskkill binary must not crash the process; the timeout
		// rejection below still fires regardless of whether this succeeds.
		taskkill.once("error", () => {});
		return;
	}

	if (child.pid === undefined) {
		child.kill("SIGTERM");
		setTimeout(() => child.kill("SIGKILL"), 1000).unref();
		return;
	}
	const pid = child.pid;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, 1000).unref();
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
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			// Makes the child a process-group leader on POSIX so a timeout can
			// signal the whole group via a negative pid, not just this process.
			// win32 ignores `detached` for grouping purposes; taskkill handles
			// the tree there instead (see killProcessTree).
			detached: process.platform !== "win32",
		});

		const stdoutBuffers: Buffer[] = [];
		const stderrBuffers: Buffer[] = [];

		child.stdout?.on("data", (buffer: Buffer) => stdoutBuffers.push(buffer));
		child.stderr?.on("data", (buffer: Buffer) => stderrBuffers.push(buffer));

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
				killProcessTree(child);
				finalize(() =>
					reject(new Error(`Command timed out after ${options.timeout}ms: ${command}`)),
				);
			}, options.timeout);
			timer.unref();
		}

		child.once("error", (error: NodeJS.ErrnoException) =>
			finalize(() => {
				const wrapped: NodeJS.ErrnoException = new Error(
					`Failed to run ${command}: ${error.message}`,
				);
				if (error.code) wrapped.code = error.code;
				reject(wrapped);
			}),
		);
		child.once("close", (code) => {
			finalize(() =>
				resolve({
					stdout: Buffer.concat(stdoutBuffers).toString("utf-8").trim(),
					stderr: Buffer.concat(stderrBuffers).toString("utf-8").trim(),
					exitCode: code,
				}),
			);
		});
	});
};

export const isToolInstalled = async (tool: string): Promise<boolean> => {
	try {
		const result = await runSubprocess("which", [tool]);
		return result.exitCode === 0 && result.stdout.length > 0;
	} catch {
		return false;
	}
};
