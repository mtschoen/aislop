import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractCodexPatchFiles,
	parseCodexStdin,
	renderCodexOutput,
	runCodexHook,
	runCodexStopHook,
} from "../../src/hooks/adapters/codex.js";
import { hasAislopConfig } from "../../src/hooks/adapters/runtime.js";

describe("Codex adapter", () => {
	it("extracts every touched path from an apply_patch command", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/old.ts",
			"*** Move to: src/new.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: src/added.ts",
			"+export {};",
			"*** Delete File: src/deleted.ts",
			"*** Update File: src/old.ts",
			"*** End Patch",
		].join("\r\n");

		expect(extractCodexPatchFiles(patch)).toEqual([
			"src/old.ts",
			"src/new.ts",
			"src/added.ts",
			"src/deleted.ts",
		]);
	});

	it("reads patch text from tool_input.command", () => {
		const parsed = parseCodexStdin(
			JSON.stringify({
				hook_event_name: "PostToolUse",
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch",
				},
				cwd: "/repo",
			}),
		);

		expect(parsed.tool_input?.command).toContain("*** Update File: src/example.ts");
	});

	it("fails open for malformed provider field types", async () => {
		const raw = JSON.stringify({
			hook_event_name: [],
			tool_name: 17,
			tool_input: { command: 42 },
			cwd: 99,
			session_id: {},
		});

		expect(parseCodexStdin(raw)).toEqual({});

		await expect(runCodexHook({ stdin: async () => raw })).resolves.toBe(0);
	});

	it("renders Codex-compatible PostToolUse additionalContext", () => {
		const output = renderCodexOutput('{"schema":"aislop.hook.v2"}');

		expect(output.hookSpecificOutput).toEqual({
			hookEventName: "PostToolUse",
			additionalContext: '{"schema":"aislop.hook.v2"}',
		});
	});
});

const stopBlock = {
	reason: "aislop: score dropped from 90 to 70. Fix the 2 findings before finishing.",
	feedback: {} as never,
};

describe("Codex project opt-in guard", () => {
	let project: string;

	beforeEach(() => {
		project = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-codex-optin-"));
		fs.mkdirSync(path.join(project, "src"));
		fs.writeFileSync(path.join(project, "src", "a.ts"), "export const value = 1;\n");
	});

	afterEach(() => {
		fs.rmSync(project, { recursive: true, force: true });
	});

	const patchStdin = (cwd: string) =>
		JSON.stringify({
			hook_event_name: "PostToolUse",
			tool_name: "apply_patch",
			tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" },
			cwd,
		});

	it("detects the opt-in only when an aislop config file exists", () => {
		expect(hasAislopConfig(project)).toBe(false);
		fs.mkdirSync(path.join(project, ".aislop"));
		expect(hasAislopConfig(project)).toBe(false);
		fs.writeFileSync(path.join(project, ".aislop", "config.yml"), "version: 1\n");
		expect(hasAislopConfig(project)).toBe(true);
	});

	it("PostToolUse callback is a silent no-op in a project without aislop config", async () => {
		const write = vi.fn();
		await expect(runCodexHook({ stdin: async () => patchStdin(project), write })).resolves.toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(project, ".aislop"))).toBe(false);
	});

	it("Stop callback never evaluates the gate in a project without aislop config", async () => {
		const evaluateStop = vi.fn(async () => stopBlock);
		const write = vi.fn();
		const stdin = async () => JSON.stringify({ hook_event_name: "Stop", cwd: project });
		await expect(runCodexStopHook({ stdin, write, evaluateStop })).resolves.toBe(0);
		expect(evaluateStop).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
});

describe("Codex Stop callback", () => {
	const stdin =
		(extra: Record<string, unknown> = {}) =>
		async () =>
			JSON.stringify({ hook_event_name: "Stop", cwd: path.resolve("project"), ...extra });

	it("prints a block decision as JSON on a score regression", async () => {
		const writes: string[] = [];
		const code = await runCodexStopHook({
			stdin: stdin(),
			write: (text) => writes.push(text),
			hasConfig: () => true,
			evaluateStop: async () => stopBlock,
		});
		expect(code).toBe(0);
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0])).toEqual({ decision: "block", reason: stopBlock.reason });
	});

	it("prints nothing when there is no regression", async () => {
		const write = vi.fn();
		const code = await runCodexStopHook({
			stdin: stdin(),
			write,
			hasConfig: () => true,
			evaluateStop: async () => null,
		});
		expect(code).toBe(0);
		expect(write).not.toHaveBeenCalled();
	});

	it("does not block again when stop_hook_active is true", async () => {
		const evaluateStop = vi.fn(async () => stopBlock);
		const write = vi.fn();
		const code = await runCodexStopHook({
			stdin: stdin({ stop_hook_active: true }),
			write,
			hasConfig: () => true,
			evaluateStop,
		});
		expect(code).toBe(0);
		expect(evaluateStop).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
});
