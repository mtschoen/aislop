import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";

const PS_STATE_PROBE_TIMEOUT_MS = 1000;

const isMissingProcessError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ESRCH";

// Read the single-character state code from /proc/<pid>/stat on Linux.
// The state field sits right after the comm's closing paren (comm itself can
// contain spaces or parens, so split on the LAST ")"). Returns null when /proc
// is unavailable so the caller can fall back to ps.
const readProcStatState = (pid: number): string | null => {
	if (process.platform !== "linux") return null;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen === -1) return null;
		const state = stat
			.slice(closeParen + 1)
			.trimStart()
			.charAt(0);
		return state || null;
	} catch (error) {
		if (isMissingProcessError(error)) return "X";
		// If the process was reaped between kill(pid, 0) and reading /proc,
		// kill(pid, 0) now throws ESRCH. Otherwise /proc is unavailable.
		try {
			process.kill(pid, 0);
		} catch (killError) {
			if (isMissingProcessError(killError)) return "X";
			throw killError;
		}
		return null;
	}
};

// True once a pid is gone at the OS level, treating a zombie as gone: a child
// that has exited but whose 'exit' event has not been reaped yet still
// occupies a slot in the process table and answers kill(pid, 0), so a bare
// liveness probe cannot tell "exited" from "running". Windows has no zombie
// state (kill(pid, 0) throws ESRCH once the process exits); Linux reads
// /proc/<pid>/stat directly without spawning a subprocess; other POSIX
// platforms ask ps for the state and verify absence with kill(pid, 0) before
// treating an empty result as exit.
export const hasProcessExited = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (isMissingProcessError(error)) return true;
		throw error;
	}
	if (process.platform === "win32") {
		return false;
	}
	const procState = readProcStatState(pid);
	if (procState !== null) {
		return procState === "Z" || procState === "X";
	}
	const result = childProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
		encoding: "utf-8",
		timeout: PS_STATE_PROBE_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	if (result.error) {
		throw result.error;
	}
	const state = result.stdout.trim().charAt(0);
	if (result.status !== 0 || !state) {
		try {
			process.kill(pid, 0);
		} catch (killError) {
			if (isMissingProcessError(killError)) return true;
			throw killError;
		}
		const detail =
			result.stderr.trim() ||
			`status=${String(result.status)}, stdout=${JSON.stringify(result.stdout)}`;
		throw new Error(`ps state probe failed for live pid ${pid}: ${detail}`);
	}
	return state === "Z" || state === "X";
};

// True when a ChildProcess has already finished, either because libuv has
// reaped it (setting exitCode/signalCode) or because the OS already reports its
// pid as exited/zombie before libuv's poll phase delivers the exit notification.
export const hasChildExited = (child: ChildProcess): boolean => {
	if (child.exitCode !== null || child.signalCode !== null) {
		return true;
	}
	if (child.pid === undefined) {
		return false;
	}
	try {
		return hasProcessExited(child.pid);
	} catch {
		return false;
	}
};
