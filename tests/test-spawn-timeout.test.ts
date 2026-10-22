import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogRuleIds } from "../src/commands/rules.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import { detectTestSpawnTimeouts } from "../src/engines/ai-slop/test-spawn-timeout.js";
import type { EngineContext } from "../src/engines/types.js";
import { descriptionForRule, labelForRule } from "../src/output/rule-labels.js";
import { RULE_SCORE_IMPACTS } from "../src/scoring/rule-impact.js";
import { applySuppressions } from "../src/utils/suppress.js";

const RULE = "ai-slop/test-spawn-timeout-literal";

let tmpDir: string;

const writeFile = (relative: string, lines: string[]): void => {
	const absolute = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, `${lines.join("\n")}\n`);
};

const buildContext = (
	languages: EngineContext["languages"],
	aiSlop?: EngineContext["config"]["aiSlop"],
): EngineContext => ({
	rootDirectory: tmpDir,
	languages,
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
		aiSlop,
	},
});

const findingLines = async (
	languages: EngineContext["languages"],
	aiSlop?: EngineContext["config"]["aiSlop"],
): Promise<Array<{ filePath: string; line: number }>> => {
	const result = await aiSlopEngine.run(buildContext(languages, aiSlop));
	const { results } = applySuppressions([result], tmpDir);
	return results[0].diagnostics
		.filter((diagnostic) => diagnostic.rule === RULE)
		.map((diagnostic) => ({ filePath: diagnostic.filePath, line: diagnostic.line }))
		.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-test-spawn-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("literal timeouts on real subprocesses in Python tests", () => {
	it("flags subprocess calls and the default wrapper names", async () => {
		writeFile("tests/test_cli.py", [
			"def test_cli():",
			"    subprocess.run(['tool'], timeout=10)",
			"    subprocess.check_output(['tool'], capture_output=True, timeout=15.5)",
			"    run_captured(['tool'], timeout=20)",
			"    helpers.run_command(['tool'], timeout=2 * 30)",
			"    _run(['tool'], timeout=1_000)",
		]);
		expect(await findingLines(["python"])).toEqual(
			[2, 3, 4, 5, 6].map((line) => ({ filePath: "tests/test_cli.py", line })),
		);
	});

	it("reports a multi-line call at the line of the callee", async () => {
		writeFile("tests/test_cli.py", [
			"def test_cli():",
			"    subprocess.run(",
			"        ['tool', 'arg'],",
			"        timeout=10,",
			"    )",
		]);
		expect(await findingLines(["python"])).toEqual([{ filePath: "tests/test_cli.py", line: 2 }]);
	});

	it("flags communicate and wait on a name bound to Popen", async () => {
		writeFile("tests/test_cli.py", [
			"def test_cli(other):",
			"    process = subprocess.Popen(['tool'])",
			"    process.communicate(timeout=5)",
			"    process.wait(5)",
			"    process.wait(timeout=5)",
			"    holder.other = subprocess.Popen(['tool'])",
			"    holder.\\",
			"        other = subprocess.Popen(['tool'])",
			"    launch(other=subprocess.Popen(['tool']))",
			"    launch(",
			"        other=subprocess.Popen(['tool']),",
			"    )",
			"    other.wait(timeout=5)",
			"    other.communicate(timeout=5)",
		]);
		expect(await findingLines(["python"])).toEqual([
			{ filePath: "tests/test_cli.py", line: 3 },
			{ filePath: "tests/test_cli.py", line: 4 },
			{ filePath: "tests/test_cli.py", line: 5 },
		]);

		const countEnclosureVisits = async (bindingCount: number): Promise<number> => {
			writeFile("tests/test_cli.py", [
				"def test_cli():",
				...Array.from({ length: bindingCount }, () => "    process = subprocess.Popen(['tool'])"),
				"    process.wait(timeout=5)",
			]);
			const originalIncludes = String.prototype.includes;
			let visits = 0;
			const spy = vi
				.spyOn(String.prototype, "includes")
				.mockImplementation(function (this: string, searchString: string, position?: number) {
					if (this === "([{") visits++;
					return originalIncludes.call(this, searchString, position);
				});
			try {
				await detectTestSpawnTimeouts(buildContext(["python"]));
			} finally {
				spy.mockRestore();
			}
			return visits;
		};
		const visits100 = await countEnclosureVisits(100);
		const visits200 = await countEnclosureVisits(200);
		expect(visits100).toBeLessThan(5_000);
		expect(visits200 / visits100).toBeLessThan(2.2);
	});

	it("does not flag named constants, environment lookups, or unresolved receivers", async () => {
		writeFile("tests/test_cli.py", [
			"BOUND = 10",
			"def test_cli(process, session):",
			"    subprocess.run(['tool'], timeout=BOUND)",
			"    subprocess.run(['tool'], timeout=int(os.environ.get('TOOL_BOUND', '10')))",
			"    subprocess.run(['tool'])",
			"    subprocess.run(['tool'], timeout=None)",
			"    holder.process = subprocess.Popen(['tool'])",
			"    holder.\\",
			"        process = subprocess.Popen(['tool'])",
			"    launch = lambda \\",
			"        process=subprocess.Popen(['tool']): process",
			"    launch(process=subprocess.Popen(['tool']))",
			"    launch(",
			"        process=subprocess.Popen(['tool']),",
			"    )",
			"    process.communicate(timeout=5)",
			"    process.wait(timeout=5)",
			"    session.get('url', timeout=5)",
			"    requests.get('url', timeout=5)",
			"    run_other(['tool'], timeout=5)",
			"    print('subprocess.run(x, timeout=10)')  # subprocess.run(x, timeout=10)",
		]);
		expect(await findingLines(["python"])).toEqual([]);
	});

	it("does not flag a wrapper definition default or a non-test file", async () => {
		writeFile("tests/test_helpers.py", ["def run_captured(command, timeout=30):", "    return 1"]);
		writeFile("src/tool.py", ["subprocess.run(['tool'], timeout=10)"]);
		expect(await findingLines(["python"])).toEqual([]);
	});

	it("honours configured wrapper names and helper paths", async () => {
		writeFile("tests/test_cli.py", [
			"def test_cli():",
			"    run_tool(['tool'], timeout=5)",
			"    subprocess.run(['tool'], timeout=5)",
			"    process = subprocess.Popen(['tool'])",
			"    process.wait(timeout=5)",
			"    process.communicate(timeout=5)",
		]);
		writeFile("tests/helpers/test_spawn.py", [
			"def go():",
			"    subprocess.run(['tool'], timeout=5)",
		]);
		expect(await findingLines(["python"])).toEqual([
			{ filePath: "tests/helpers/test_spawn.py", line: 2 },
			{ filePath: "tests/test_cli.py", line: 3 },
			{ filePath: "tests/test_cli.py", line: 5 },
			{ filePath: "tests/test_cli.py", line: 6 },
		]);
		expect(
			await findingLines(["python"], {
				testSpawnTimeout: {
					wrapperNames: ["run_tool", "run", "wait", "communicate"],
					helperPaths: ["tests/helpers/"],
				},
			}),
		).toEqual([
			{ filePath: "tests/test_cli.py", line: 2 },
			{ filePath: "tests/test_cli.py", line: 3 },
			{ filePath: "tests/test_cli.py", line: 5 },
			{ filePath: "tests/test_cli.py", line: 6 },
		]);
	});

	it("honours the inline suppression marker", async () => {
		writeFile("tests/test_cli.py", [
			"def test_cli():",
			"    # aislop-ignore-next-line ai-slop/test-spawn-timeout-literal -- the timeout is the subject",
			"    subprocess.run(['tool'], timeout=1)",
			"    subprocess.run(['tool'], timeout=1)",
		]);
		expect(await findingLines(["python"])).toEqual([{ filePath: "tests/test_cli.py", line: 4 }]);
	});
});

describe("literal timeouts on real subprocesses in JavaScript and TypeScript tests", () => {
	it("flags the sync spellings and child_process.exec", async () => {
		writeFile("src/cli.test.ts", [
			"it('runs', () => {",
			"  execSync('tool', { env: { timeout: 0 }, timeout: 5000 });",
			String.raw`  execSync('tool', { '\\u{110000}': 0, '\\u{110000000}': 0 });`,
			"  spawnSync('tool', ['arg'], { encoding: 'utf8', timeout: 10_000, 'cwd': '.', ['stdio']: 'pipe', get shell() { return false; } });",
			String.raw`  execFileSync('tool', [], { timeout: 10 * 1000, 'time\x5cout': 0, 'time\u005cout': 0, 'time\u{5c}out': 0, ['time\x5cout']: 0, ['time\u005cout']: 0, ['time\u{5c}out']: 0 });`,
			"  child_process.exec('tool', { timeout: 3000 }, () => {});",
			"});",
		]);
		expect(await findingLines(["typescript"])).toEqual(
			[2, 4, 5, 6].map((line) => ({ filePath: "src/cli.test.ts", line })),
		);
	});

	it("does not flag named constants, missing options, or look-alike calls", async () => {
		writeFile("src/cli.test.ts", [
			"const BOUND = 5000;",
			"const timeout = 0;",
			"const key = 'timeout';",
			"it('runs', () => {",
			"  execSync('tool', { timeout: 5000 });",
			"  execSync('tool', { timeout: BOUND });",
			"  execSync('tool', { timeout: Number(process.env.BOUND ?? 5000) });",
			"  execSync('tool', { encoding: 'utf8' });",
			"  execSync('tool', { env: { timeout: 5000 } });",
			"  execSync(makeCommand({ timeout: 5000 }), { timeout: BOUND });",
			"  spawnSync('tool', makeArgs({ timeout: 5000 }), { timeout: BOUND });",
			"  child_process.exec(makeCommand({ timeout: 5000 }), () => {});",
			"  child_process.execFile(makeCommand({ timeout: 5000 }), () => {});",
			"  execSync('tool', { timeout: 5000, ...{ timeout: 0 } });",
			"  execSync('tool', { timeout: 5000, ...overrides });",
			"  execSync('tool', { timeout: 5000, timeout: 0 });",
			"  execSync('tool', { timeout: 5000, timeout: BOUND });",
			"  execSync('tool', { timeout: 5000, timeout });",
			"  execSync('tool', { timeout: 5000, 'timeout': 0 });",
			'  execSync(\'tool\', { timeout: 5000, "timeout": 0 });',
			String.raw`  execSync('tool', { timeout: 5000, time\u006fut: 0 });`,
			String.raw`  execSync('tool', { timeout: 5000, \u{74}imeout: 0 });`,
			String.raw`  execSync('tool', { timeout: 5000, 'time\157ut': 0 });`,
			String.raw`  execSync('tool', { timeout: 5000, "time\157ut": 0 });`,
			String.raw`  spawnSync('tool', ['arg'], { timeout: 5000, ['time\157ut']: 0 });`,
			String.raw`  execFileSync('tool', [], { timeout: 5000, ["time\157ut"]: 0 });`,
			String.raw`  child_process.exec('tool', { timeout: 5000, get 'time\157ut'() { return 0; } }, () => {});`,
			String.raw`  childProcess.execFile('tool', ['arg'], { timeout: 5000, get "time\157ut"() { return 0; } }, () => {});`,
			String.raw`  execSync('tool', { timeout: 5000, get ['time\157ut']() { return 0; } });`,
			String.raw`  execSync('tool', { timeout: 5000, get ["time\157ut"]() { return 0; } });`,
			String.raw`  execSync('tool', { timeout: 5000, set 'time\157ut'(value) {} });`,
			String.raw`  execSync('tool', { timeout: 5000, set "time\157ut"(value) {} });`,
			String.raw`  execSync('tool', { timeout: 5000, set ['time\157ut'](value) {} });`,
			String.raw`  execSync('tool', { timeout: 5000, set ["time\157ut"](value) {} });`,
			"  execSync('tool', { timeout: 5000, 'time\\\nout': 0 });",
			"  execSync('tool', { timeout: 5000, 'time\\\r\nout': 0 });",
			"  execSync('tool', { timeout: 5000, 'time\\\rout': 0 });",
			"  execSync('tool', { timeout: 5000, 'time\\\u2028out': 0 });",
			"  execSync('tool', { timeout: 5000, 'time\\\u2029out': 0 });",
			"  execSync('tool', { timeout: 5000, ['time\\\rout']: 0 });",
			"  execSync('tool', { timeout: 5000, ['time\\\u2028out']: 0 });",
			"  execSync('tool', { timeout: 5000, ['time\\\u2029out']: 0 });",
			"  execSync('tool', { timeout: 5000, get 'time\\\rout'() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get 'time\\\u2028out'() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get 'time\\\u2029out'() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get ['time\\\rout']() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get ['time\\\u2028out']() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get ['time\\\u2029out']() { return 0; } });",
			"  execSync('tool', { timeout: 5000, set 'time\\\rout'(value) {} });",
			"  execSync('tool', { timeout: 5000, set 'time\\\u2028out'(value) {} });",
			"  execSync('tool', { timeout: 5000, set 'time\\\u2029out'(value) {} });",
			"  execSync('tool', { timeout: 5000, set ['time\\\rout'](value) {} });",
			"  execSync('tool', { timeout: 5000, set ['time\\\u2028out'](value) {} });",
			"  execSync('tool', { timeout: 5000, set ['time\\\u2029out'](value) {} });",
			String.raw`  execSync('tool', { '\\u{110000}': 0 });`,
			String.raw`  execSync('tool', { timeout: 5000, '\u{110000}': 0 });`,
			String.raw`  execSync('tool', { 'time\x5cout': 5000 });`,
			String.raw`  execSync('tool', { 'time\u005cout': 5000 });`,
			String.raw`  execSync('tool', { 'time\u{5c}out': 5000 });`,
			String.raw`  execSync('tool', { ['time\x5cout']: 5000 });`,
			String.raw`  execSync('tool', { ['time\u005cout']: 5000 });`,
			String.raw`  execSync('tool', { ['time\u{5c}out']: 5000 });`,
			"  execSync('tool', { timeout: 5000, get timeout() { return 0; } });",
			"  execSync('tool', { timeout: 5000, set timeout(value) {} });",
			"  execSync('tool', { timeout: 5000, ['timeout']: 0 });",
			"  execSync('tool', { timeout: 5000, [key]: 0 });",
			"  execSync('tool', { timeout: 5000, get ['timeout']() { return 0; } });",
			"  execSync('tool', { timeout: 5000, get [key]() { return 0; } });",
			"  execSync('tool', { timeout: 5000, set ['timeout'](value) {} });",
			"  execSync('tool', { timeout: 5000, set [key](value) {} });",
			"  $execSync('tool', { timeout: 5000 });",
			"  $spawnSync('tool', ['arg'], { timeout: 5000 });",
			"  $execFileSync('tool', [], { timeout: 5000 });",
			"  \u00e9execSync('tool', { timeout: 5000 });",
			"  \u00e9spawnSync('tool', ['arg'], { timeout: 5000 });",
			"  \u00e9execFileSync('tool', [], { timeout: 5000 });",
			"  \u03b1execSync('tool', { timeout: 5000 });",
			"  \u03b1spawnSync('tool', ['arg'], { timeout: 5000 });",
			"  \u03b1execFileSync('tool', [], { timeout: 5000 });",
			"  a\u200cexecSync('tool', { timeout: 5000 });",
			"  a\u200dspawnSync('tool', ['arg'], { timeout: 5000 });",
			"  a\u200cexecFileSync('tool', [], { timeout: 5000 });",
			String.raw`  \u0061execSync('tool', { timeout: 5000 });`,
			String.raw`  \u{61}spawnSync('tool', ['arg'], { timeout: 5000 });`,
			String.raw`  \u{61}execFileSync('tool', [], { timeout: 5000 });`,
			"  $child_process.exec('tool', { timeout: 5000 }, () => {});",
			"  $childProcess.execFile('tool', ['arg'], { timeout: 5000 }, () => {});",
			"  \u00e9child_process.exec('tool', { timeout: 5000 }, () => {});",
			"  \u00e9childProcess.execFile('tool', ['arg'], { timeout: 5000 }, () => {});",
			"  \u03b1child_process.exec('tool', { timeout: 5000 }, () => {});",
			"  \u03b1childProcess.execFile('tool', ['arg'], { timeout: 5000 }, () => {});",
			"  a\u200cchild_process.exec('tool', { timeout: 5000 }, () => {});",
			"  a\u200dchildProcess.execFile('tool', ['arg'], { timeout: 5000 }, () => {});",
			String.raw`  \u0061child_process.exec('tool', { timeout: 5000 }, () => {});`,
			String.raw`  \u{61}childProcess.execFile('tool', ['arg'], { timeout: 5000 }, () => {});`,
			"  pattern.exec('text');",
			"  fetchThing('x', { timeout: 5000 });",
			"  const sample = \"execSync('tool', { timeout: 5000 })\";",
			"  // execSync('tool', { timeout: 5000 })",
			"  execSync('tool', { timeout: 5000 });",
			"});",
		]);
		expect(await findingLines(["typescript"])).toEqual([
			{ filePath: "src/cli.test.ts", line: 5 },
			{ filePath: "src/cli.test.ts", line: 102 },
		]);
	});

	it("honours the inline suppression marker", async () => {
		writeFile("src/cli.test.ts", [
			"it('runs', () => {",
			"  // aislop-ignore-next-line ai-slop/test-spawn-timeout-literal -- exercising the timeout path",
			"  execSync('tool', { timeout: 50 });",
			"});",
		]);
		expect(await findingLines(["typescript"])).toEqual([]);
	});
});

describe("registration", () => {
	it("is in the catalog, scored as maintainability, and labelled explicitly", () => {
		expect(catalogRuleIds()).toContain(RULE);
		expect(RULE_SCORE_IMPACTS[RULE].tier).toBe("maintainability");
		expect(labelForRule(RULE)).toBe("Literal timeout on a real process in a test");
		expect(descriptionForRule(RULE)).toContain("literal timeout");
	});
});
