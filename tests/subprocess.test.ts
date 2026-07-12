import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	chunkFilePaths,
	isMissingToolError,
	runSubprocess,
	warnSubprocessFailure,
} from "../src/utils/subprocess.js";

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

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

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
		try {
			await expect(
				runSubprocess(process.execPath, ["-e", parentScript], { timeout: 2000 }),
			).rejects.toThrow(/timed out/);

			grandchildPid = Number(readFileSync(pidFile, "utf-8"));
			expect(Number.isInteger(grandchildPid)).toBe(true);

			// The tree kill is asynchronous (taskkill on Windows, signal
			// escalation elsewhere) - poll rather than asserting instantly.
			const deadline = Date.now() + 5000;
			while (isProcessAlive(grandchildPid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(isProcessAlive(grandchildPid)).toBe(false);
		} finally {
			if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {}
			}
			rmSync(pidFile, { force: true });
		}
	});
});

describe("runSubprocess timeout under event-loop starvation", () => {
	it("does not reject a child that completed while the event loop was blocked", async () => {
		// The child exits almost immediately, well inside the 500ms timeout.
		// The test then blocks the event loop past the timeout expiry, so on
		// wake the expired timer callback runs before the child's exit/close
		// events (timers phase precedes poll phase). The completion must win.
		const promise = runSubprocess(process.execPath, ["-e", "process.stdout.write('ok')"], {
			timeout: 500,
		});

		// Hop into a check-phase (setImmediate) callback first: its loop
		// iteration is already past the poll phase, so after the spin the
		// NEXT iteration begins with the timers phase and runs the (now
		// expired) timeout timer BEFORE the poll phase that would deliver the
		// child's exit/close events. Spinning from a poll- or timers-phase
		// continuation instead would let the completion win by accident and
		// mask the bug.
		await new Promise((resolve) => setImmediate(resolve));

		// Starve the loop: the child (an independent OS process) runs and
		// exits during the spin, but its exit/close events cannot be
		// processed until the spin ends - after the timer has already expired.
		const spinUntil = Date.now() + 1200;
		while (Date.now() < spinUntil) {
			// Busy-wait: simulates a synchronous engine pass starving the loop.
		}

		await expect(promise).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
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
