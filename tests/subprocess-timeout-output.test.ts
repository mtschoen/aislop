import { describe, expect, it } from "vitest";
import { runSubprocess, SubprocessTimeoutError } from "../src/utils/subprocess.js";

describe("runSubprocess timeout", () => {
	it("rejects with the output the command printed before it was killed", async () => {
		const script = "process.stdout.write('{\"partial\":true}'); setInterval(() => {}, 1000);";

		const error = await runSubprocess(process.execPath, ["-e", script], { timeout: 1500 }).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(SubprocessTimeoutError);
		expect((error as SubprocessTimeoutError).stdout).toBe('{"partial":true}');
		expect((error as Error).message).toContain("timed out");
	});
});
