import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	killActiveChildren,
	runSubprocess,
	SubprocessTimeoutError,
} from "../src/utils/subprocess.js";

const runTimeoutOutputCase = async (
	expectedReadyFileName = "ready",
	readinessTimeoutMs = 30000,
	onSettled?: (fakeTimersEnabled: boolean) => void,
): Promise<void> => {
	const directory = mkdtempSync(path.join(tmpdir(), "aislop-timeout-output-"));
	const childReadyFile = path.join(directory, "ready");
	const polledReadyFile = path.join(directory, expectedReadyFileName);
	// The child prints, then creates the ready file as proof the print
	// landed (stdout is a file, so the write is synchronous), then idles.
	const script = [
		"process.stdout.write('{\"partial\":true}');",
		`require("node:fs").writeFileSync(${JSON.stringify(childReadyFile)}, "ready");`,
		"setInterval(() => {}, 1000);",
	].join("\n");

	// Fake only the timer functions so the test, not the wall clock,
	// decides when the timeout expires. Node startup on a loaded runner
	// can exceed any fixed timeout, which killed the child before it had
	// printed. Date and setImmediate stay real so the deferred timeout
	// callback in src/utils/subprocess.ts still runs.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let promise: Promise<unknown> | undefined;
	try {
		promise = runSubprocess(process.execPath, ["-e", script], { timeout: 1500 }).finally(() => {
			onSettled?.(vi.isFakeTimers());
		});

		// Readiness handshake: synchronous poll (the real timers are faked
		// and the child runs independently of this event loop). The
		// deadline is hang detection, not a performance assertion.
		const spawnDeadline = Date.now() + readinessTimeoutMs;
		while (!existsSync(polledReadyFile) && Date.now() < spawnDeadline) {
			// Busy-wait for the child's ready file.
		}
		expect(existsSync(polledReadyFile)).toBe(true);

		vi.advanceTimersByTime(1500);
		const error = await promise.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(SubprocessTimeoutError);
		expect((error as SubprocessTimeoutError).stdout).toBe('{"partial":true}');
		expect((error as Error).message).toContain("timed out");
	} finally {
		killActiveChildren();
		await promise?.catch(() => {});
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	}
};

describe("runSubprocess timeout", () => {
	it("rejects with the output the command printed before it was killed", async () => {
		await runTimeoutOutputCase();

		let settledWithFakeTimers = false;
		await expect(
			runTimeoutOutputCase("missing-ready", 0, (fakeTimersEnabled) => {
				settledWithFakeTimers = fakeTimersEnabled;
			}),
		).rejects.toThrow();
		expect(settledWithFakeTimers).toBe(true);
		expect(vi.isFakeTimers()).toBe(false);
	});
});
