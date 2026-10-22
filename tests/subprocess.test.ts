import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkFilePaths,
	isMissingToolError,
	killActiveChildren,
	runSubprocess,
	warnSubprocessFailure,
} from "../src/utils/subprocess.js";

const isMissingProcessError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ESRCH";

// Read the single-character state code from /proc/<pid>/stat on Linux.
// The state field sits right after the comm's closing paren (comm itself can
// contain spaces or parens, so split on the LAST ")"). Returns null when /proc
// is unavailable so the caller can fall back to ps.
const readProcStatState = (pid: number): string | null => {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen === -1) return null;
		const state = stat.slice(closeParen + 1).trimStart().charAt(0);
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
const hasProcessExited = (pid: number): boolean => {
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
	const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" });
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

const isProcessAlive = (pid: number): boolean => !hasProcessExited(pid);

describe("runSubprocess timeout", () => {
	it("kills the whole process tree on timeout, not just the direct child", async () => {
		const pidFile = path.join(tmpdir(), `aislop-treekill-${process.pid}-${Date.now()}.pid`);
		// The direct child spawns a grandchild (like cppcheck -j spawning
		// workers), records its PID, then idles until the timeout reaps it.
		// On Windows the grandchild is detached: a node middleman puts its
		// children in a kill-on-close Job Object, which real scanner binaries
		// do not do - detaching opts out so the test models a real tool tree.
		const parentScript = [
			`const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32" });`,
			`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"setInterval(() => {}, 1000);",
		].join("\n");

		let grandchildPid: number | undefined;
		// Fake only the timer functions, so the test decides when the timeout
		// expires: the wall-clock race between child startup (slow on a loaded
		// CI runner) and the already-armed timeout disappears, while process
		// spawning, signals and file probes stay real. Date and setImmediate
		// stay real so the deferred timeout callback in src/utils/subprocess.ts
		// still runs through the normal check phase.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const promise = runSubprocess(process.execPath, ["-e", parentScript], { timeout: 2000 });

			// Readiness handshake: busy-poll for the grandchild's pid file with
			// synchronous syscalls (they need no event loop, and the child runs
			// independently of the parent loop). Only once the tree provably
			// exists is the timeout expired below; the deadline is hang
			// detection, not a performance assertion.
			const spawnDeadline = Date.now() + 20000;
			while (grandchildPid === undefined && Date.now() < spawnDeadline) {
				if (existsSync(pidFile)) {
					const raw = readFileSync(pidFile, "utf-8").trim();
					if (raw && Number.isInteger(Number(raw))) {
						grandchildPid = Number(raw);
					}
				}
			}

			// Expire the timeout on demand. The real setImmediate queued by the
			// timeout callback runs once the await below yields, tree-kills the
			// child and rejects; advancing past the 1000ms SIGKILL escalation
			// afterwards covers the case where SIGTERM alone did not finish the
			// tree.
			vi.advanceTimersByTime(2000);
			await expect(promise).rejects.toThrow(/timed out/);
			vi.advanceTimersByTime(1000);

			expect(grandchildPid).toBeDefined();

			// The tree kill is asynchronous at OS level (taskkill on Windows,
			// signal delivery elsewhere) - poll rather than asserting
			// instantly. The poll is synchronous on purpose: the real timers it
			// would otherwise sleep on are faked right now.
			if (grandchildPid !== undefined) {
				const deadline = Date.now() + 20000;
				while (isProcessAlive(grandchildPid) && Date.now() < deadline) {
					// Busy-wait: no timers are real while faked, and process
					// teardown needs no parent event loop.
				}
				expect(isProcessAlive(grandchildPid)).toBe(false);
			}
		} finally {
			if (grandchildPid !== undefined) {
				try {
					if (isProcessAlive(grandchildPid)) {
						process.kill(grandchildPid, "SIGKILL");
					}
				} catch {}
			}
			rmSync(pidFile, { force: true });
			vi.useRealTimers();
		}
	});
});

describe("killActiveChildren", () => {
	it("reaps in-flight children and their process groups, like a Ctrl-C cleanup", async () => {
		const pidFile = path.join(tmpdir(), `aislop-sigint-${process.pid}-${Date.now()}.pid`);
		// Same shape as the tree-kill test: the direct child spawns a grandchild
		// (a scanner's worker), records its PID, then idles. Nothing here has a
		// timeout - the tree only dies because killActiveChildren reaps it, which
		// is exactly what cli.ts's SIGINT handler does when the user presses
		// Ctrl-C mid-scan.
		const parentScript = [
			`const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32" });`,
			`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
			"setInterval(() => {}, 1000);",
		].join("\n");

		let grandchildPid: number | undefined;
		// runSubprocess registers the child synchronously, so it is already in the
		// active set by the time this returns; no timeout means it stays there
		// until killActiveChildren fires.
		const promise = runSubprocess(process.execPath, ["-e", parentScript], {});
		try {
			// Wait until the child has spawned its grandchild and written a valid
			// PID before triggering the cleanup.
			const spawnDeadline = Date.now() + 5000;
			while (Date.now() < spawnDeadline) {
				if (existsSync(pidFile)) {
					const raw = readFileSync(pidFile, "utf-8").trim();
					if (raw && Number.isInteger(Number(raw))) {
						grandchildPid = Number(raw);
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(grandchildPid).toBeDefined();

			killActiveChildren();

			// The direct child dies with the cleanup; runSubprocess resolves once
			// its 'close' fires (a signal-killed child reports exitCode null).
			await promise;

			// The kill is asynchronous (taskkill on Windows, signal escalation
			// elsewhere) - poll rather than asserting instantly.
			const deadline = Date.now() + 5000;
			while (grandchildPid !== undefined && isProcessAlive(grandchildPid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(grandchildPid !== undefined && isProcessAlive(grandchildPid)).toBe(false);
		} finally {
			if (grandchildPid !== undefined) {
				try {
					if (isProcessAlive(grandchildPid)) {
						process.kill(grandchildPid, "SIGKILL");
					}
				} catch {}
			}
			rmSync(pidFile, { force: true });
		}
	});
});

describe("runSubprocess timeout under event-loop starvation", () => {
	it("does not reject a child that completed while the event loop was blocked", async () => {
		const markerFile = path.join(
			tmpdir(),
			`aislop-starvation-${process.pid}-${Date.now()}.marker`,
		);
		const timeout = 1500;
		const timerExpiry = Date.now() + timeout;
		try {
			// The child records its pid in the marker and exits almost
			// immediately, well inside the timeout. The test then blocks the
			// event loop past the timeout expiry, so on wake the expired timer
			// callback runs before the child's exit/close events (timers phase
			// precedes poll phase). The completion must win.
			const promise = runSubprocess(
				process.execPath,
				[
					"-e",
					`require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, String(process.pid)); process.stdout.write("ok");`,
				],
				{ timeout },
			);

			// Hop into a check-phase (setImmediate) callback first: its loop
			// iteration is already past the poll phase, so after the spin the
			// NEXT iteration begins with the timers phase and runs the (now
			// expired) timeout timer BEFORE the poll phase that would deliver the
			// child's exit/close events. Spinning from a poll- or timers-phase
			// continuation instead would let the completion win by accident and
			// mask the bug.
			await new Promise((resolve) => setImmediate(resolve));

			// Starve the loop: the child (an independent OS process) runs,
			// writes the marker, and exits during the spin, but its exit/close
			// events cannot be processed until the spin ends - after the timer
			// has already expired.
			//
			// Spin synchronously until ALL of: the child's marker names a pid,
			// that pid has exited at the OS level, and the timeout timer is past
			// expiry. Breaking on the marker alone raced on loaded runners: the
			// child can spend unbounded time between writing the marker and
			// actually exiting, and if it has not exited when the spin ends, the
			// expired timer's deferred check sees no exit and kills it. Waiting
			// for OS-level exit (hasProcessExited handles the unreaped-zombie
			// state this starved parent leaves behind) makes the wake-up order
			// deterministic: the poll phase delivers the exit before the check
			// phase runs the deferred timeout, however slow the machine is. The
			// deadline is hang detection, not a performance assertion.
			const spinDeadline = Date.now() + 20000;
			let childPid: number | undefined;
			let childExited = false;
			while (Date.now() < spinDeadline) {
				if (childPid === undefined && existsSync(markerFile)) {
					const raw = readFileSync(markerFile, "utf-8").trim();
					if (raw && Number.isInteger(Number(raw))) {
						childPid = Number(raw);
					}
				}
				if (childPid !== undefined && !childExited) {
					childExited = hasProcessExited(childPid);
				}
				if (childExited && Date.now() > timerExpiry + 200) {
					break;
				}
			}

			expect(childPid).toBeDefined();
			expect(childExited).toBe(true);
			await expect(promise).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
		} finally {
			rmSync(markerFile, { force: true });
		}
	});
});

describe("runSubprocess output capture", () => {
	it("does not block a child writing faster than the parent can drain a starved pipe", async () => {
		// On Windows, child-side pipe writes are synchronous: once the 64KiB OS
		// pipe buffer fills, write() blocks until the parent drains it. A
		// starved parent event loop never drains, so the child stalls at zero
		// CPU. Capturing output through temp files instead of pipes removes
		// the parent from that path entirely - the child should finish writing
		// well before the parent's busy spin ends.
		const markerFile = path.join(
			tmpdir(),
			`aislop-backpressure-${process.pid}-${Date.now()}.marker`,
		);
		const childScript = [
			`const fs = require("node:fs");`,
			// Built at runtime, not inlined as a literal: embedding a 64KiB
			// string directly in the -e argument overflows the Windows
			// command-line length limit before the process even spawns.
			`const chunk = "x".repeat(65536);`, // 64KiB, matches the OS pipe buffer size
			// 16 x 64KiB = 1MiB, far past the pipe buffer a starved parent leaves full.
			`for (let i = 0; i < 16; i++) { process.stdout.write(chunk); }`,
			`fs.writeFileSync(${JSON.stringify(markerFile)}, String(Date.now()));`,
		].join("\n");

		try {
			const promise = runSubprocess(process.execPath, ["-e", childScript], { timeout: 10000 });

			// Hop into a check-phase callback before starving the loop, matching
			// the other starvation test's phase-ordering discipline.
			await new Promise((resolve) => setImmediate(resolve));

			// Starve the loop: the child runs and writes its full output during
			// the spin, independent of whether the parent is draining anything.
			//
			// The invariant is ordering, not duration, so spin until the marker
			// appears instead of for a fixed stretch: a child genuinely blocked
			// on the pipe never writes the marker, so exhausting the deadline is
			// the regression signal, and the healthy path exits immediately.
			//
			// existsSync is a synchronous syscall, so the loop never yields and
			// the parent stays starved for the whole poll. The deadline must stay
			// well under vitest's 30s testTimeout so a regression lands on the
			// assertion below rather than an opaque framework timeout.
			const spinDeadline = Date.now() + 20000;
			let markerWrittenWhileStarved = false;
			while (Date.now() < spinDeadline) {
				if (existsSync(markerFile)) {
					markerWrittenWhileStarved = true;
					break;
				}
			}

			const result = await promise;

			expect(result.stdout.length).toBe(1048576);
			expect(markerWrittenWhileStarved).toBe(true);
		} finally {
			rmSync(markerFile, { force: true });
		}
	});
});

describe("chunkFilePaths", () => {
	it("puts everything in one chunk when well under both limits", () => {
		const files = ["a.cpp", "b.cpp", "c.cpp"];
		expect(chunkFilePaths(files, 200, 25000)).toEqual([files]);
	});

	it("splits once the file-count cap is hit", () => {
		const files = Array.from({ length: 5 }, (_, i) => `f${i}.cpp`);
		const chunks = chunkFilePaths(files, 2, 25000);
		expect(chunks).toEqual([["f0.cpp", "f1.cpp"], ["f2.cpp", "f3.cpp"], ["f4.cpp"]]);
	});

	it("splits once the character budget is hit", () => {
		// Each path is 10 chars + 1 separator = 11; a budget of 25 fits two per chunk.
		const files = ["aaaaaaaa.c", "bbbbbbbb.c", "cccccccc.c", "dddddddd.c"];
		const chunks = chunkFilePaths(files, 200, 25);
		expect(chunks).toEqual([
			["aaaaaaaa.c", "bbbbbbbb.c"],
			["cccccccc.c", "dddddddd.c"],
		]);
	});

	it("gives an over-budget lone file its own chunk instead of dropping it", () => {
		const hugePath = "x".repeat(100);
		const files = [hugePath, "short.cpp"];
		const chunks = chunkFilePaths(files, 200, 25);
		expect(chunks).toEqual([[hugePath], ["short.cpp"]]);
	});

	it("returns [] for an empty file list", () => {
		expect(chunkFilePaths([])).toEqual([]);
	});

	it("defaults to a 200-file / 25000-char budget", () => {
		const files = Array.from({ length: 201 }, (_, i) => `f${i}.cpp`);
		const chunks = chunkFilePaths(files);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(200);
		expect(chunks[1]).toHaveLength(1);
	});
});

describe("isMissingToolError", () => {
	it("is true for an ENOENT spawn error", () => {
		const error = Object.assign(new Error("spawn foo ENOENT"), { code: "ENOENT" });
		expect(isMissingToolError(error)).toBe(true);
	});

	it("is false for a non-ENOENT error (e.g. a timeout)", () => {
		expect(isMissingToolError(new Error("Command timed out after 1000ms: foo"))).toBe(false);
	});

	it("is false for a non-Error rejection", () => {
		expect(isMissingToolError("some string")).toBe(false);
		expect(isMissingToolError(undefined)).toBe(false);
	});
});

describe("warnSubprocessFailure", () => {
	it("writes a message to console.error naming the tool and the failure", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		warnSubprocessFailure("cppcheck", new Error("boom"));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toContain("cppcheck");
		expect(spy.mock.calls[0][0]).toContain("boom");
		spy.mockRestore();
	});
});
