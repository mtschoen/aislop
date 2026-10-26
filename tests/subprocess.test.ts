import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkFilePaths,
	hasChildExited,
	hasProcessExited,
	isMissingToolError,
	killActiveChildren,
	runSubprocess,
	SUBPROCESS_SHUTDOWN_GRACE_MS,
	SubprocessTimeoutError,
	warnSubprocessFailure,
} from "../src/utils/subprocess.js";

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
			const error = await promise.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(SubprocessTimeoutError);
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
			await (error as SubprocessTimeoutError).terminated;
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
			while (
				grandchildPid !== undefined &&
				isProcessAlive(grandchildPid) &&
				Date.now() < deadline
			) {
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
		const markerFile = path.join(tmpdir(), `aislop-starvation-${process.pid}-${Date.now()}.marker`);
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
			// state this starved parent leaves behind) guarantees the child has
			// finished at the OS level before the spin ends, even when libuv's
			// poll phase has not yet reaped it by the time the check phase runs
			// the deferred timeout. The deadline is hang detection, not a
			// performance assertion.
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

	it("does not reject when the OS reports the child exited before libuv reaped it, or when child.kill returns false", async () => {
		const originalPlatform = process.platform;
		const esrch = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		for (const scenario of [
			{ mode: "os-exited-before-reap", platform: originalPlatform },
			{ mode: "kill-returns-false", platform: "win32" },
			{ mode: "kill-returns-false", platform: "linux" },
			{ mode: "stalled-ps-probe-pr-157", platform: "darwin" },
			{ mode: "posix-persistent-group-probe-pr-169", platform: "linux" },
			{ mode: "win32-taskkill-confirmed-pr-169", platform: "win32" },
			{ mode: "win32-taskkill-error-surviving-worker-pr-169", platform: "win32" },
			{ mode: "win32-taskkill-nonzero-exit-pr-169", platform: "win32" },
			{ mode: "win32-taskkill-never-settling-pr-169", platform: "win32" },
		] as const) {
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
			});
			Object.defineProperty(process, "platform", { value: scenario.platform });
			const isWin32TaskkillScenario = scenario.mode.startsWith("win32-taskkill-");
			const fakeChild = Object.assign(new EventEmitter(), {
				pid: 999999,
				exitCode: null as number | null,
				signalCode: null as NodeJS.Signals | null,
				kill: vi.fn(
					() =>
						scenario.mode === "stalled-ps-probe-pr-157" ||
						scenario.mode === "posix-persistent-group-probe-pr-169" ||
						isWin32TaskkillScenario,
				),
			}) as unknown as ChildProcess;
			const fakeTaskkill = new EventEmitter() as unknown as ChildProcess;

			const spawnSpy = vi
				.spyOn(childProcess, "spawn")
				.mockImplementation((command, _arguments, spawnOptions) => {
					if (command === "taskkill") {
						return fakeTaskkill;
					}
					const stdio = spawnOptions?.stdio as [unknown, number, number] | undefined;
					if (stdio && typeof stdio[1] === "number") {
						writeSync(stdio[1], "ok\n");
					}
					return fakeChild;
				});
			const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
				status: null,
				signal: "SIGKILL",
				stdout: "",
				stderr: "",
				error: Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }),
			} as unknown as ReturnType<typeof childProcess.spawnSync>);
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
				if (scenario.mode === "os-exited-before-reap") {
					throw esrch;
				}
				return true;
			});
			const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((target, options) => {
				if (String(target).startsWith("/proc/")) {
					return "999999 (node) R 1 1 1";
				}
				return readFileSync(target, options as BufferEncoding);
			});

			try {
				const timeout = 1500;
				const promise = runSubprocess(process.execPath, ["-e", ""], { timeout });
				promise.catch(() => {});
				vi.advanceTimersByTime(timeout);
				await new Promise((resolve) => setImmediate(resolve));

				if (scenario.mode === "stalled-ps-probe-pr-157") {
					expect(spawnSyncSpy).toHaveBeenCalledWith("ps", ["-o", "stat=", "-p", "999999"], {
						encoding: "utf-8",
						timeout: 1000,
						killSignal: "SIGKILL",
					});
					expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
					fakeChild.emit("close", null);
					await new Promise((resolve) => setImmediate(resolve));
					killSpy.mockImplementation((pid) => {
						if (pid < 0) throw esrch;
						return true;
					});
					vi.advanceTimersByTime(20);
					const error = await promise.catch((caught: unknown) => caught);
					expect(error).toBeInstanceOf(SubprocessTimeoutError);
					await (error as SubprocessTimeoutError).terminated;
				} else if (scenario.mode === "posix-persistent-group-probe-pr-169") {
					const error = await promise.catch((caught: unknown) => caught);
					expect(error).toBeInstanceOf(SubprocessTimeoutError);
					let terminated = false;
					void (error as SubprocessTimeoutError).terminated.then(() => {
						terminated = true;
					});
					fakeChild.emit("close", null);
					await new Promise((resolve) => setImmediate(resolve));
					expect(terminated).toBe(false);
					vi.advanceTimersByTime(1000);
					await new Promise((resolve) => setImmediate(resolve));
					expect(terminated).toBe(false);
					vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS - 1000);
					await (error as SubprocessTimeoutError).terminated;
					expect(terminated).toBe(true);
				} else if (isWin32TaskkillScenario) {
					const error = await promise.catch((caught: unknown) => caught);
					expect(error).toBeInstanceOf(SubprocessTimeoutError);
					let terminated = false;
					void (error as SubprocessTimeoutError).terminated.then(() => {
						terminated = true;
					});
					await new Promise((resolve) => setImmediate(resolve));
					expect(terminated).toBe(false);

					if (scenario.mode === "win32-taskkill-confirmed-pr-169") {
						fakeTaskkill.emit("close", 0);
						fakeChild.emit("close", null);
						await (error as SubprocessTimeoutError).terminated;
						expect(terminated).toBe(true);
						expect(fakeChild.kill).toHaveBeenCalledTimes(1);
						expect(fakeChild.kill).toHaveBeenCalledWith(0);
					} else if (scenario.mode === "win32-taskkill-error-surviving-worker-pr-169") {
						fakeTaskkill.emit("error", new Error("missing taskkill"));
						expect(fakeChild.kill).toHaveBeenCalledWith();
						fakeChild.emit("close", null);
						await new Promise((resolve) => setImmediate(resolve));
						expect(terminated).toBe(false);
						vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS - 1);
						await new Promise((resolve) => setImmediate(resolve));
						expect(terminated).toBe(false);
						vi.advanceTimersByTime(1);
						await (error as SubprocessTimeoutError).terminated;
						expect(terminated).toBe(true);
					} else if (scenario.mode === "win32-taskkill-nonzero-exit-pr-169") {
						fakeTaskkill.emit("close", 1);
						expect(fakeChild.kill).toHaveBeenCalledWith();
						await new Promise((resolve) => setImmediate(resolve));
						expect(terminated).toBe(false);
						vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS);
						await (error as SubprocessTimeoutError).terminated;
						expect(terminated).toBe(true);
					} else {
						expect(fakeChild.kill).toHaveBeenCalledTimes(1);
						vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS);
						expect(fakeChild.kill).toHaveBeenCalledWith();
						await (error as SubprocessTimeoutError).terminated;
						expect(terminated).toBe(true);
					}
				} else {
					fakeChild.exitCode = 0;
					fakeChild.emit("close", 0);
					await expect(promise).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
					if (scenario.mode === "os-exited-before-reap") {
						expect(fakeChild.kill).not.toHaveBeenCalled();
					} else {
						expect(fakeChild.kill).toHaveBeenCalled();
					}
				}
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform });
				readSpy.mockRestore();
				killSpy.mockRestore();
				spawnSyncSpy.mockRestore();
				spawnSpy.mockRestore();
				vi.useRealTimers();
			}
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

describe("hasProcessExited and hasChildExited", () => {
	it("classifies Linux /proc stat states, ps fallback states, and ChildProcess exit states", () => {
		const originalPlatform = process.platform;
		const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
		const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const readSpy = vi.spyOn(fs, "readFileSync");
		const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync");

		try {
			Object.defineProperty(process, "platform", { value: "linux" });

			readSpy.mockReturnValueOnce("123 (my ) app) Z 1 1");
			expect(hasProcessExited(123)).toBe(true);

			readSpy.mockReturnValueOnce("123 (app) R 1 1");
			expect(hasProcessExited(123)).toBe(false);

			readSpy.mockImplementationOnce(() => {
				throw esrch;
			});
			expect(hasProcessExited(123)).toBe(true);

			readSpy.mockImplementationOnce(() => {
				throw enoent;
			});
			killSpy.mockReturnValueOnce(true).mockImplementationOnce(() => {
				throw esrch;
			});
			expect(hasProcessExited(123)).toBe(true);

			readSpy.mockImplementationOnce(() => {
				throw enoent;
			});
			killSpy.mockReturnValueOnce(true).mockImplementationOnce(() => {
				throw eperm;
			});
			expect(() => hasProcessExited(123)).toThrow("EPERM");

			for (const fallbackStat of ["no-closing-paren", "123 (app)   "] as const) {
				readSpy.mockReturnValueOnce(fallbackStat);
				spawnSyncSpy.mockReturnValueOnce({
					status: 0,
					stdout: "Z+\n",
					stderr: "",
				} as ReturnType<typeof childProcess.spawnSync>);
				expect(hasProcessExited(123)).toBe(true);
			}

			readSpy.mockImplementationOnce(() => {
				throw enoent;
			});
			spawnSyncSpy.mockReturnValueOnce({
				status: 0,
				stdout: "S\n",
				stderr: "",
			} as ReturnType<typeof childProcess.spawnSync>);
			expect(hasProcessExited(123)).toBe(false);

			Object.defineProperty(process, "platform", { value: "darwin" });

			spawnSyncSpy.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "",
				error: new Error("ps spawn failed"),
			} as ReturnType<typeof childProcess.spawnSync>);
			expect(() => hasProcessExited(123)).toThrow("ps spawn failed");
			expect(spawnSyncSpy).toHaveBeenLastCalledWith("ps", ["-o", "stat=", "-p", "123"], {
				encoding: "utf-8",
				timeout: 1000,
				killSignal: "SIGKILL",
			});

			spawnSyncSpy.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "",
			} as ReturnType<typeof childProcess.spawnSync>);
			killSpy.mockReturnValueOnce(true).mockImplementationOnce(() => {
				throw esrch;
			});
			expect(hasProcessExited(123)).toBe(true);

			spawnSyncSpy.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "ps failed",
			} as ReturnType<typeof childProcess.spawnSync>);
			expect(() => hasProcessExited(123)).toThrow(
				"ps state probe failed for live pid 123: ps failed",
			);

			spawnSyncSpy.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "",
			} as ReturnType<typeof childProcess.spawnSync>);
			expect(() => hasProcessExited(123)).toThrow("status=1");

			spawnSyncSpy.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "",
			} as ReturnType<typeof childProcess.spawnSync>);
			killSpy.mockReturnValueOnce(true).mockImplementationOnce(() => {
				throw eperm;
			});
			expect(() => hasProcessExited(123)).toThrow("EPERM");

			killSpy.mockImplementationOnce(() => {
				throw eperm;
			});
			expect(() => hasProcessExited(123)).toThrow("EPERM");

			expect(
				hasChildExited({ exitCode: 0, signalCode: null, pid: 123 } as unknown as ChildProcess),
			).toBe(true);
			expect(
				hasChildExited({
					exitCode: null,
					signalCode: "SIGTERM",
					pid: 123,
				} as unknown as ChildProcess),
			).toBe(true);
			expect(
				hasChildExited({
					exitCode: null,
					signalCode: null,
					pid: undefined,
				} as unknown as ChildProcess),
			).toBe(false);

			killSpy.mockImplementationOnce(() => {
				throw eperm;
			});
			expect(
				hasChildExited({ exitCode: null, signalCode: null, pid: 123 } as unknown as ChildProcess),
			).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			spawnSyncSpy.mockRestore();
			readSpy.mockRestore();
			killSpy.mockRestore();
		}
	});
});
