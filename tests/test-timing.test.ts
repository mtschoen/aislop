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
			"        var watch = Stopwatch.StartNew();",
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
			{ filePath: "tests/FlushTests.cs", line: 4 },
			{ filePath: "tests/flush_test.cpp", line: 2 },
			{ filePath: "tests/flush_test.cpp", line: 3 },
		]);
	});

	it("flags every C# receiver the file binds to a Stopwatch, and the static clock reads", async () => {
		writeFile("tests/MixedTimingTests.cs", [
			"using System.Diagnostics;",
			"public class MixedTimingTests {",
			"    private readonly Stopwatch _timer = new Stopwatch();",
			"    public Stopwatch Ambient { get; set; }",
			"    public void AssertsMixed(Stopwatch injected) {",
			"        var started = Stopwatch.StartNew();",
			"        Stopwatch declared = new Stopwatch();",
			"        var (paired, display) = (Stopwatch.StartNew(), new ProgressDisplay());",
			"        foreach (Stopwatch each in watches) {",
			"            Assert.True(each.ElapsedTicks > 0);",
			"        }",
			"        if (lookup.TryGetValue(key, out Stopwatch resolved)) {",
			"            Assert.True(resolved.ElapsedTicks > 0);",
			"        }",
			"        Assert.True(started.ElapsedMilliseconds < 500);",
			"        Assert.True(declared.Elapsed < TimeSpan.FromSeconds(1));",
			"        Assert.True(paired.ElapsedMilliseconds < 500);",
			"        Assert.True(injected.ElapsedTicks > 0);",
			"        Assert.True(this._timer.ElapsedTicks > 0);",
			"        Assert.True(Ambient.ElapsedMilliseconds < 500);",
			"        started.Elapsed.Should().BeLessThan(TimeSpan.FromSeconds(1));",
			"        Assert.True(Stopwatch.GetTimestamp() > 0);",
			"        Assert.True(Stopwatch.GetElapsedTime(origin) < TimeSpan.FromSeconds(2));",
			"        Assert.True(Stopwatch.StartNew().ElapsedMilliseconds < 400);",
			"        Assert.True((new Stopwatch()).ElapsedMilliseconds < 100);",
			"        Assert.Equal(expected, DateTime.UtcNow);",
			"        Assert.Equal(expected, Environment.TickCount64);",
			"        Assert.Equal(",
			"            expected,",
			"            started.Elapsed);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/MixedTimingTests.cs", line: 10 },
			{ filePath: "tests/MixedTimingTests.cs", line: 13 },
			{ filePath: "tests/MixedTimingTests.cs", line: 15 },
			{ filePath: "tests/MixedTimingTests.cs", line: 16 },
			{ filePath: "tests/MixedTimingTests.cs", line: 17 },
			{ filePath: "tests/MixedTimingTests.cs", line: 18 },
			{ filePath: "tests/MixedTimingTests.cs", line: 19 },
			{ filePath: "tests/MixedTimingTests.cs", line: 20 },
			{ filePath: "tests/MixedTimingTests.cs", line: 21 },
			{ filePath: "tests/MixedTimingTests.cs", line: 22 },
			{ filePath: "tests/MixedTimingTests.cs", line: 23 },
			{ filePath: "tests/MixedTimingTests.cs", line: 24 },
			{ filePath: "tests/MixedTimingTests.cs", line: 25 },
			{ filePath: "tests/MixedTimingTests.cs", line: 26 },
			{ filePath: "tests/MixedTimingTests.cs", line: 27 },
			{ filePath: "tests/MixedTimingTests.cs", line: 30 },
		]);
	});

	it("flags a C# stopwatch read through null-conditional and null-forgiving access", async () => {
		writeFile("tests/AccessFormTests.cs", [
			"public class AccessFormTests {",
			"    public void ReadsThroughOperators() {",
			"        var watch = Stopwatch.StartNew();",
			"        Assert.True(watch?.ElapsedMilliseconds < 400);",
			"        Assert.True(watch!.ElapsedMilliseconds < 400);",
			"        Assert.Equal(expected, display?.Elapsed);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/AccessFormTests.cs", line: 4 },
			{ filePath: "tests/AccessFormTests.cs", line: 5 },
		]);
	});

	it("does not flag a C# Elapsed member on a receiver the file never binds to a Stopwatch", async () => {
		writeFile("tests/PresenterTests.cs", [
			"public class PresenterTests {",
			"    public void ShowsElapsed() {",
			'        Assert.Equal("00:04", display.Elapsed);',
			"        Assert.Equal(TimeSpan.FromSeconds(10), info.Elapsed);",
			"        Assert.Equal(500, run.ElapsedMilliseconds);",
			"        Assert.Contains(nameof(run.ElapsedMilliseconds), fired);",
			"        Assert.Contains(nameof(Stopwatch.ElapsedMilliseconds), fired);",
			"        var factoryWatch = factory.CreateStopwatch();",
			"        Assert.Equal(TimeSpan.Zero, factoryWatch.Elapsed);",
			"        var wrapped = CreateDisplay(Stopwatch.StartNew());",
			"        Assert.Equal(expected, wrapped.Elapsed);",
			"        var chained = Stopwatch.StartNew().ToDisplay();",
			"        Assert.Equal(expected, chained.Elapsed);",
			"        var factoryDisplay = new StopwatchFactory();",
			"        Assert.Equal(expected, factoryDisplay.Elapsed);",
			"        Assert.Throws<InvalidOperationException>(() => new Stopwatch());",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
	});

	it("does not bind a C# Stopwatch from a member assignment, tuple-valued initializer, method, generic or explicit-interface method, or indexer", async () => {
		writeFile("tests/BoundaryTests.cs", [
			"public class BoundaryTests {",
			"    Stopwatch display() { return null; }",
			"    Stopwatch render<T>() { return null; }",
			"    Stopwatch IFactory.make<T>() { return null; }",
			"    Stopwatch this[int index] => null;",
			"    public void Boundaries() {",
			"        presenter.display = Stopwatch.StartNew();",
			"        var tupleValued = (Stopwatch.StartNew(), Elapsed: expected);",
			"        Assert.Equal(expected, display.Elapsed);",
			"        Assert.Equal(expected, render.Elapsed);",
			"        Assert.Equal(expected, make.Elapsed);",
			"        Assert.Equal(expected, index.Elapsed);",
			"        Assert.Equal(expected, tupleValued.Elapsed);",
			"        Assert.Equal(expected, this.Elapsed);",
			"        Assert.Equal(expected, IFactory.Elapsed);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
	});

	it("does not flag same-spelled receivers in unrelated methods or classes", async () => {
		writeFile("tests/ScopeIsolationTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"public class FirstTests {",
			"    private readonly Stopwatch _timer = new Stopwatch();",
			"    public void TruePositiveMethod() {",
			"        var watch = Stopwatch.StartNew();",
			"        Assert.True(watch.ElapsedMilliseconds < 500);",
			"        Assert.True(this._timer.ElapsedTicks > 0);",
			"    }",
			"    public void UnrelatedMethodSameSpelling(ProgressDisplay watch) {",
			'        Assert.Equal("00:01", watch.Elapsed);',
			"    }",
			"}",
			"public class SecondTests {",
			"    public void OtherClassMethod(ProgressDisplay _timer) {",
			'        Assert.Equal("00:02", _timer.Elapsed);',
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/ScopeIsolationTests.cs", line: 7 },
			{ filePath: "tests/ScopeIsolationTests.cs", line: 8 },
		]);
	});

	it("flags an indexer parameter, a target-typed new, and the Diagnostics-qualified spelling", async () => {
		writeFile("tests/SpellingTests.cs", [
			"using System.Diagnostics;",
			"public class SpellingTests {",
			"    public int this[Stopwatch measured] {",
			"        get {",
			"            Assert.True(measured.ElapsedMilliseconds < 100);",
			"            return 0;",
			"        }",
			"    }",
			"    public void ReadsSpellings() {",
			"        Stopwatch targetTyped = new();",
			"        Diagnostics.Stopwatch qualified = new Diagnostics.Stopwatch();",
			"        Assert.True(targetTyped.ElapsedMilliseconds < 100);",
			"        Assert.True(qualified.ElapsedMilliseconds < 100);",
			"        Assert.True(Diagnostics.Stopwatch.StartNew().ElapsedTicks > 0);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/SpellingTests.cs", line: 5 },
			{ filePath: "tests/SpellingTests.cs", line: 12 },
			{ filePath: "tests/SpellingTests.cs", line: 13 },
			{ filePath: "tests/SpellingTests.cs", line: 14 },
		]);
	});

	it("flags a Stopwatch parameter of an operator, a conversion operator, a lambda, and a local function", async () => {
		writeFile("tests/ParameterTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"public class ParameterTests {",
			"    public static implicit operator int(Stopwatch converted) {",
			"        Assert.True(converted.ElapsedMilliseconds < 100);",
			"        return 0;",
			"    }",
			"    public static ParameterTests operator +(ParameterTests left, Stopwatch added) {",
			"        Assert.True(added.ElapsedMilliseconds < 100);",
			"        return left;",
			"    }",
			"    public void RunsCallbacks() {",
			"        Action<Stopwatch> callback = (Stopwatch passed) => {",
			"            Assert.True(passed.ElapsedMilliseconds < 100);",
			"        };",
			"        void Local(Stopwatch scoped) {",
			"            Assert.True(scoped.ElapsedMilliseconds < 100);",
			"        }",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/ParameterTests.cs", line: 5 },
			{ filePath: "tests/ParameterTests.cs", line: 9 },
			{ filePath: "tests/ParameterTests.cs", line: 14 },
			{ filePath: "tests/ParameterTests.cs", line: 17 },
		]);
	});

	it("does not flag a Stopwatch introduced by a shape outside the declaration list", async () => {
		writeFile("tests/OutsideDeclarationListTests.cs", [
			"using System.Diagnostics;",
			"using SW = System.Diagnostics.Stopwatch;",
			"public record struct Timed(Stopwatch primary) {",
			"    public void Verify() {",
			"        Assert.Equal(expected, primary.Elapsed);",
			"    }",
			"}",
			"public class BaseHolder {",
			"    protected Stopwatch inherited;",
			"}",
			"public class DerivedHolder : BaseHolder {",
			"    public void Verify(object candidate) {",
			"        Assert.Equal(expected, inherited.Elapsed);",
			"        SW aliased = null;",
			"        Assert.Equal(expected, aliased.Elapsed);",
			"        var produced = GetStopwatch();",
			"        Assert.Equal(expected, produced.Elapsed);",
			"        if (candidate is Stopwatch matched) {",
			"            Assert.Equal(expected, matched.Elapsed);",
			"        }",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
	});

	it("does not flag an implicit lambda parameter, a query range variable, or an accessor value", async () => {
		writeFile("tests/ImplicitBindingTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"public class ImplicitBindingTests {",
			"    public Stopwatch Current {",
			"        set { Assert.True(value.ElapsedMilliseconds < 100); }",
			"    }",
			"    public void Runs(Stopwatch[] watches) {",
			"        Action<Stopwatch> render = shown => Assert.True(shown.ElapsedMilliseconds < 100);",
			"        Assert.True((from watch in watches select watch.Elapsed).Any());",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
	});

	it("flags a deconstruction whose Stopwatch element carries a tuple label", async () => {
		writeFile("tests/LabeledTupleTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"public class LabeledTupleTests {",
			"    public void ReadsLabeledTuple() {",
			"        var (timer, expected) = (timer: Stopwatch.StartNew(), expected: 5);",
			"        Assert.True(timer.Elapsed > TimeSpan.Zero);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/LabeledTupleTests.cs", line: 6 },
		]);
	});

	it("flags a top-level statement that reads a Stopwatch declared by an earlier statement", async () => {
		writeFile("tests/TopLevelTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"Stopwatch timed = new Stopwatch();",
			"timed.Start();",
			"Work();",
			"Assert.True(timed.Elapsed > TimeSpan.Zero);",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/TopLevelTests.cs", line: 6 },
		]);
	});

	it("does not flag a same-named local declared in another member", async () => {
		writeFile("tests/CrossMemberTests.cs", [
			"using System.Diagnostics;",
			"public class CrossMemberTests {",
			"    public void StartsTimer() {",
			"        var timer = Stopwatch.StartNew();",
			"        Assert.True(timer.ElapsedMilliseconds < 100);",
			"    }",
			"    public void ReadsDisplay() {",
			"        var timer = new FakeTimer();",
			"        Assert.Equal(expected, timer.Elapsed);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/CrossMemberTests.cs", line: 5 },
		]);
	});

	it("does not flag any Stopwatch spelling in a file that aliases the name", async () => {
		writeFile("tests/AliasedNameTests.cs", [
			"using System;",
			"using Stopwatch = ProgressDisplay;",
			"public class AliasedNameTests {",
			"    private readonly Stopwatch display = new Stopwatch();",
			"    public void Reads() {",
			"        var started = Stopwatch.StartNew();",
			"        Assert.Equal(expected, started.Elapsed);",
			"        Assert.Equal(expected, display.Elapsed);",
			"        Assert.True(Stopwatch.GetTimestamp() > 0);",
			"        Assert.Equal(expected, DateTime.UtcNow);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/AliasedNameTests.cs", line: 10 },
		]);
	});

	it("does not flag any Stopwatch spelling in a file that declares its own Stopwatch type", async () => {
		writeFile("tests/OwnStopwatchTypeTests.cs", [
			"using System;",
			"public class Stopwatch {",
			"    public TimeSpan Elapsed { get; }",
			"}",
			"public class OwnStopwatchTypeTests {",
			"    public void Reads() {",
			"        var started = new Stopwatch();",
			"        Assert.Equal(expected, started.Elapsed);",
			"        Assert.True(Stopwatch.GetTimestamp() > 0);",
			"        Assert.Equal(expected, Environment.TickCount64);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/OwnStopwatchTypeTests.cs", line: 10 },
		]);
	});

	// Pins the two over-inclusions docs/rules.md documents, so the doc and the
	// rule cannot drift apart: the region is not a scope, so a name declared as a
	// Stopwatch anywhere in it counts even where another declaration shadows it,
	// and the `Stopwatch` spelling is read as the type even where it is a local.
	it("flags the documented over-inclusions: a shadowed name and a local named Stopwatch", async () => {
		writeFile("tests/OverInclusionTests.cs", [
			"using System.Diagnostics;",
			"public class OverInclusionTests {",
			"    private readonly Stopwatch display = new Stopwatch();",
			"    public void Renders(ProgressDisplay display) {",
			"        Assert.Equal(expected, display.Elapsed);",
			"    }",
			"    public void UsesLocalNamedStopwatch() {",
			"        ProgressDisplay Stopwatch = new ProgressDisplay();",
			"        Assert.Equal(expected, Stopwatch.Elapsed);",
			"        Assert.Equal(expected, Stopwatch.StartNew().Elapsed);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/OverInclusionTests.cs", line: 5 },
			{ filePath: "tests/OverInclusionTests.cs", line: 9 },
			{ filePath: "tests/OverInclusionTests.cs", line: 10 },
		]);
	});

	it("flags fully qualified static clock reads and constructions", async () => {
		writeFile("tests/QualifiedTimingTests.cs", [
			"using System;",
			"public class QualifiedTimingTests {",
			"    public void ReadsQualified() {",
			"        System.Diagnostics.Stopwatch declared = new System.Diagnostics.Stopwatch();",
			"        Assert.Equal(expected, System.DateTime.UtcNow);",
			"        Assert.Equal(expected, System.DateTimeOffset.Now);",
			"        Assert.Equal(expected, System.Environment.TickCount64);",
			"        Assert.True(System.Diagnostics.Stopwatch.GetTimestamp() > 0);",
			"        Assert.True(System.Diagnostics.Stopwatch.GetElapsedTime(origin) < TimeSpan.FromSeconds(2));",
			"        Assert.True(System.Diagnostics.Stopwatch.StartNew().ElapsedMilliseconds < 400);",
			"        Assert.True((new System.Diagnostics.Stopwatch()).ElapsedMilliseconds < 100);",
			"        Assert.True(declared.ElapsedMilliseconds < 100);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([
			{ filePath: "tests/QualifiedTimingTests.cs", line: 5 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 6 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 7 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 8 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 9 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 10 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 11 },
			{ filePath: "tests/QualifiedTimingTests.cs", line: 12 },
		]);
	});

	it("does not flag uninvoked static method groups", async () => {
		writeFile("tests/MethodGroupTests.cs", [
			"using System;",
			"using System.Diagnostics;",
			"public class MethodGroupTests {",
			"    public void TestsMethodGroups() {",
			"        Assert.NotNull((Func<long>)Stopwatch.GetTimestamp);",
			"        Assert.NotNull((Func<long>)System.Diagnostics.Stopwatch.GetTimestamp);",
			"        Assert.NotNull((Func<long, TimeSpan>)Stopwatch.GetElapsedTime);",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
	});

	it("does not flag a C# clock read quoted in a string or shown in a comment", async () => {
		writeFile("tests/QuotedTests.cs", [
			"public class QuotedTests {",
			"    // Assert.True(watch.ElapsedMilliseconds < 400);",
			"    public void Quoted() {",
			"        var watch = Stopwatch.StartNew();",
			'        var sample = "Assert.True(watch.ElapsedMilliseconds < 400);";',
			"        Assert.Equal(sample, Render());",
			"    }",
			"}",
		]);

		expect(await findingsFor(CLOCK_RULE, ["csharp"])).toEqual([]);
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
