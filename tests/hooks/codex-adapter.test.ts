import { describe, expect, it } from "vitest";
import {
	extractCodexPatchFiles,
	parseCodexStdin,
	renderCodexOutput,
	runCodexHook,
} from "../../src/hooks/adapters/codex.js";

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
