import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogRuleIds } from "../src/commands/rules.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import type { EngineContext } from "../src/engines/types.js";
import { descriptionForRule, labelForRule } from "../src/output/rule-labels.js";
import { RULE_SCORE_IMPACTS } from "../src/scoring/rule-impact.js";

const SLEEP_RULE = "ai-slop/test-sleep";
const CLOCK_RULE = "ai-slop/test-wall-clock-assertion";

let tmpDir: string;

const writeFile = (relative: string, lines: string[]): void => {
	const absolute = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, `${lines.join("\n")}\n`);
};

const buildContext = (languages: EngineContext["languages"]): EngineContext => ({
	rootDirectory: tmpDir,
	languages,
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
});

const findingsFor = async (
	rule: string,
	languages: EngineContext["languages"],
): Promise<Array<{ filePath: string; line: number }>> => {
	const result = await aiSlopEngine.run(buildContext(languages));
	return result.diagnostics
		.filter((diagnostic) => diagnostic.rule === rule)
		.map((diagnostic) => ({ filePath: diagnostic.filePath, line: diagnostic.line }));
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-test-timing-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fixed sleeps in tests", () => {
	it("flags the Python sleep spellings", async () => {
		writeFile("tests/test_pipeline.py", [
			"def test_waits():",
			"    time.sleep(0.5)",
			"",
			"async def test_awaits():",
			"    await asyncio.sleep(2)",
		]);

		expect(await findingsFor(SLEEP_RULE, ["python"])).toEqual([
			{ filePath: "tests/test_pipeline.py", line: 2 },
			{ filePath: "tests/test_pipeline.py", line: 5 },
		]);
	});

	it("flags the JavaScript promise-wrapped timer and the timers/promises form", async () => {
		writeFile("src/waiting.test.ts", [
			'it("settles", async () => {',
			"  await new Promise((resolve) => setTimeout(resolve, 100));",
			"});",
			'it("settles again", async () => {',
			"  await setTimeout(250);",
			"});",
		]);

		expect(await findingsFor(SLEEP_RULE, ["typescript"])).toEqual([
			{ filePath: "src/waiting.test.ts", line: 2 },
			{ filePath: "src/waiting.test.ts", line: 5 },
		]);
	});

	it("flags the C# thread and task delays, including TimeSpan durations", async () => {
		writeFile("tests/WaitingTests.cs", [
			"public class WaitingTests {",
			"    public void Settles() {",
			"        Thread.Sleep(500);",
			"    }",
			"    public async Task SettlesAsync() {",
			"        await Task.Delay(TimeSpan.FromSeconds(2));",
			"    }",
			"}",
		]);

		expect(await findingsFor(SLEEP_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/WaitingTests.cs", line: 3 },
			{ filePath: "tests/WaitingTests.cs", line: 6 },
		]);
	});

	it("flags the Go, PHP, and C++ spellings", async () => {
		writeFile("pkg/waiting_test.go", [
			"func TestSettles(t *testing.T) {",
			"    time.Sleep(150 * time.Millisecond)",
			"}",
		]);
		writeFile("tests/test_waiting.php", [
			"<?php",
			"class WaitingTest {",
			"    public function testSettles() {",
			"        usleep(20000);",
			"    }",
			"}",
		]);
		writeFile("tests/waiting_test.cpp", [
			"TEST(Waiting, Settles) {",
			"    std::this_thread::sleep_for(std::chrono::milliseconds(75));",
			"}",
		]);

		expect(await findingsFor(SLEEP_RULE, ["go", "php", "cpp"])).toEqual([
			{ filePath: "pkg/waiting_test.go", line: 2 },
			{ filePath: "tests/test_waiting.php", line: 4 },
			{ filePath: "tests/waiting_test.cpp", line: 2 },
		]);
	});

	it("does not flag a delay used as a polling interval inside a loop", async () => {
		writeFile("src/polling.test.ts", [
			'it("waits for the child to die", async () => {',
			"  const deadline = Date.now() + 5000;",
			"  while (isAlive(pid) && Date.now() < deadline) {",
			"    await new Promise((resolve) => setTimeout(resolve, 100));",
			"  }",
			"  for (let attempt = 0; attempt < 5; attempt++) {",
			"    if (ready()) break;",
			"    await new Promise((resolve) => setTimeout(resolve, 30));",
			"  }",
			"});",
		]);

		expect(await findingsFor(SLEEP_RULE, ["typescript"])).toEqual([]);
	});

	it("does not flag a Python delay inside a polling loop", async () => {
		writeFile("tests/test_polling.py", [
			"def test_waits_for_ready():",
			"    while not ready():",
			"        time.sleep(0.1)",
			"    for attempt in range(5):",
			"        if done():",
			"            break",
			"        time.sleep(0.2)",
		]);

		expect(await findingsFor(SLEEP_RULE, ["python"])).toEqual([]);
	});

	it("does not flag a delay inside a loop body written without braces", async () => {
		writeFile("tests/PollingTests.cs", [
			"public class PollingTests {",
			"    public void Settles() {",
			"        while (!ready)",
			"            Thread.Sleep(50);",
			"    }",
			"}",
		]);

		expect(await findingsFor(SLEEP_RULE, ["csharp"])).toEqual([]);
	});

	it("does not flag a delay whose duration is not a literal", async () => {
		writeFile("src/helper.test.ts", [
			"const pause = (milliseconds: number) =>",
			"  new Promise((resolve) => setTimeout(resolve, milliseconds));",
			'it("settles", async () => {',
			"  await pause(40);",
			"  await sleep(60);",
			"});",
		]);
		writeFile("tests/test_helper.py", [
			"def test_waits(timeout):",
			"    time.sleep(timeout)",
			"    sleep(3)",
		]);

		expect(await findingsFor(SLEEP_RULE, ["typescript", "python"])).toEqual([]);
	});

	it("does not flag a zero delay, which yields to the scheduler", async () => {
		writeFile("src/yielding.test.ts", [
			'it("yields", async () => {',
			"  await new Promise((resolve) => setTimeout(resolve, 0));",
			"});",
		]);
		writeFile("tests/test_yielding.py", ["async def test_yields():", "    await asyncio.sleep(0)"]);

		expect(await findingsFor(SLEEP_RULE, ["typescript", "python"])).toEqual([]);
	});

	it("does not flag a sleep spelling that only appears in a comment or a string", async () => {
		writeFile("src/quoted.test.ts", [
			"// await new Promise((resolve) => setTimeout(resolve, 100));",
			'const sample = "await new Promise((resolve) => setTimeout(resolve, 100));";',
			"const template = `await setTimeout(300);`;",
		]);
		writeFile("tests/test_quoted.py", [
			"# time.sleep(4)",
			'EXAMPLE = "time.sleep(4)"',
			'BLOCK = """',
			"time.sleep(4)",
			'"""',
		]);

		expect(await findingsFor(SLEEP_RULE, ["typescript", "python"])).toEqual([]);
	});

	it("flags a Go delay written as a bare duration constant", async () => {
		writeFile("pkg/settling_test.go", [
			"func TestSettles(t *testing.T) {",
			"    time.Sleep(time.Second)",
			"}",
		]);

		expect(await findingsFor(SLEEP_RULE, ["go"])).toEqual([
			{ filePath: "pkg/settling_test.go", line: 2 },
		]);
	});

	it("does not flag a scheduled callback that no promise waits on", async () => {
		writeFile("src/scheduling.test.ts", [
			'it("closes late", () => {',
			"  setTimeout(finish, 100);",
			"  setTimeout(() => server.close(), 250);",
			"});",
		]);

		expect(await findingsFor(SLEEP_RULE, ["typescript"])).toEqual([]);
	});

	it("does not flag a delay in production code", async () => {
		writeFile("src/retry.py", ["def backoff():", "    time.sleep(1.5)"]);

		expect(await findingsFor(SLEEP_RULE, ["python"])).toEqual([]);
	});
});

describe("clock-dependent assertions in tests", () => {
	it("flags a JavaScript assertion on the difference between two clock reads", async () => {
		writeFile("src/flush.test.ts", [
			'it("returns within the cap", async () => {',
			"  const start = Date.now();",
			"  await flush(50);",
			"  expect(Date.now() - start).toBeLessThan(500);",
			"});",
		]);

		expect(await findingsFor(CLOCK_RULE, ["typescript"])).toEqual([
			{ filePath: "src/flush.test.ts", line: 4 },
		]);
	});

	it("flags the Python bare-assert and unittest assertion forms", async () => {
		writeFile("tests/test_flush.py", [
			"def test_returns_quickly():",
			"    start = time.monotonic()",
			"    flush()",
			"    assert time.monotonic() - start < 1.0",
			"",
			"class FlushTest(TestCase):",
			"    def test_returns_quickly(self):",
			"        self.assertLess(time.time() - self.started, 1.0)",
		]);

		expect(await findingsFor(CLOCK_RULE, ["python"])).toEqual([
			{ filePath: "tests/test_flush.py", line: 4 },
			{ filePath: "tests/test_flush.py", line: 8 },
		]);
	});

	it("flags the C#, Go, and C++ assertion forms", async () => {
		writeFile("tests/FlushTests.cs", [
			"public class FlushTests {",
			"    public void ReturnsQuickly() {",
			"        Assert.True(watch.ElapsedMilliseconds < 400);",
			"    }",
			"}",
		]);
		writeFile("pkg/flush_test.go", [
			"func TestReturnsQuickly(t *testing.T) {",
			"    assert.Less(t, time.Since(start), limit)",
			"}",
		]);
		writeFile("tests/flush_test.cpp", [
			"TEST(Flush, ReturnsQuickly) {",
			"    EXPECT_LT(chrono::duration_cast<chrono::milliseconds>(finish - start).count(), 400);",
			"    ASSERT_LT(std::chrono::steady_clock::now() - start, limit);",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp", "go", "cpp"])).toEqual([
			{ filePath: "pkg/flush_test.go", line: 2 },
			{ filePath: "tests/FlushTests.cs", line: 3 },
			{ filePath: "tests/flush_test.cpp", line: 2 },
			{ filePath: "tests/flush_test.cpp", line: 3 },
		]);
	});

	it("does not flag C++ assertions comparing against duration literals", async () => {
		writeFile("tests/timeout_test.cpp", [
			"TEST(Config, Timeout) {",
			"    EXPECT_EQ(config.timeout, std::chrono::seconds(5));",
			"    ASSERT_EQ(delay, chrono::milliseconds(100));",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["cpp"])).toEqual([]);
	});

	it("does not flag an assertion without a clock read, or a clock read without an assertion", async () => {
		writeFile("src/plain.test.ts", [
			'it("reports status", async () => {',
			"  const startedAt = Date.now();",
			"  record(startedAt);",
			'  expect(readStatus()).toBe("ok");',
			"});",
		]);

		expect(await findingsFor(CLOCK_RULE, ["typescript"])).toEqual([]);
	});

	it("does not flag elapsed time that was computed on an earlier line", async () => {
		writeFile("src/elapsed.test.ts", [
			'it("returns within the cap", async () => {',
			"  const start = Date.now();",
			"  await flush(50);",
			"  const elapsed = Date.now() - start;",
			"  expect(elapsed).toBeLessThan(500);",
			"});",
		]);

		expect(await findingsFor(CLOCK_RULE, ["typescript"])).toEqual([]);
	});

	it("does not flag a clock-dependent assertion that only appears in a comment or a string", async () => {
		writeFile("src/quoted-clock.test.ts", [
			"// expect(Date.now() - start).toBeLessThan(500);",
			'const sample = "expect(Date.now() - start).toBeLessThan(500);";',
		]);

		expect(await findingsFor(CLOCK_RULE, ["typescript"])).toEqual([]);
	});

	it("does not flag production code that measures elapsed time", async () => {
		writeFile("src/timer.ts", [
			"export const measure = (started: number): number => Date.now() - started;",
		]);

		expect(await findingsFor(CLOCK_RULE, ["typescript"])).toEqual([]);
	});
});

describe("timing rule registration", () => {
	it("registers both rules in the catalog and the score impacts", () => {
		for (const rule of [SLEEP_RULE, CLOCK_RULE]) {
			expect(catalogRuleIds()).toContain(rule);
			expect(RULE_SCORE_IMPACTS[rule].tier).toBe("maintainability");
		}
	});

	it("gives both rules an explicit label and description rather than the derived fallback", () => {
		expect(labelForRule(SLEEP_RULE)).toBe("Fixed sleep in a test");
		expect(labelForRule(CLOCK_RULE)).toBe("Assertion on real elapsed time");
		expect(descriptionForRule(SLEEP_RULE)).toBe(
			"Test waits a fixed delay instead of polling or mocking the clock.",
		);
		expect(descriptionForRule(CLOCK_RULE)).toBe(
			"Test assertion reads the real clock, so load decides whether it passes.",
		);
	});
});
