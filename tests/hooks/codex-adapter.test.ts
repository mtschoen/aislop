import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractCodexPatchFiles,
	parseCodexStdin,
	renderCodexPostToolOutput,
	renderCodexStopOutput,
	runCodexHook,
	runCodexStopHook,
} from "../../src/hooks/adapters/codex.js";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-codex-adapter-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const enableAislop = (): void => {
	const configDirectory = path.join(root, ".aislop");
	fs.mkdirSync(configDirectory, { recursive: true });
	fs.writeFileSync(path.join(configDirectory, "config.yml"), "version: 1\n");
};

const postPayload = (): string =>
	JSON.stringify({
		hook_event_name: "PostToolUse",
		tool_name: "apply_patch",
		tool_input: { command: "*** Update File: src/index.ts" },
		cwd: root,
	});

describe("Codex payload parsing", () => {
	it("returns an empty object for empty or malformed JSON", () => {
		expect(parseCodexStdin("")).toEqual({});
		expect(parseCodexStdin("not json")).toEqual({});
	});

	it("extracts add, update, move, and delete paths without duplicates", () => {
		const files = extractCodexPatchFiles(`*** Begin Patch
*** Add File: src/new.ts
*** Update File: src/old.ts
*** Move to: src/moved.ts
*** Delete File: src/gone.ts
*** Update File: src/old.ts
*** End Patch`);

		expect(files).toEqual(["src/new.ts", "src/old.ts", "src/moved.ts", "src/gone.ts"]);
	});

	it("ignores ordinary shell text and malformed patch headers", () => {
		expect(extractCodexPatchFiles("echo hello\n*** Update File src/missing-colon.ts")).toEqual([]);
	});
});

describe("Codex output rendering", () => {
	it("renders advisory PostToolUse context", () => {
		expect(renderCodexPostToolOutput('{"score":100}')).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: '{"score":100}',
			},
		});
	});

	it("renders a Stop block without PostToolUse fields", () => {
		expect(renderCodexStopOutput("regressed")).toEqual({
			decision: "block",
			reason: "regressed",
		});
	});
});

describe("runCodexHook", () => {
	it("does nothing when the project has not opted in", async () => {
		const scan = vi.fn();
		const write = vi.fn();

		const exitCode = await runCodexHook({
			stdin: async () => postPayload(),
			write,
			scan,
		});

		expect(exitCode).toBe(0);
		expect(scan).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("scans affected files and writes advisory feedback for an opted-in project", async () => {
		enableAislop();
		const file = path.join(root, "src", "index.ts");
		const appendFiles = vi.fn();
		const write = vi.fn();
		const release = vi.fn();

		const exitCode = await runCodexHook({
			stdin: async () => postPayload(),
			write,
			resolveFiles: () => [file],
			acquireLock: () => release,
			scan: async () => ({ diagnostics: [], score: 100, rootDirectory: root }),
			readBaseline: () => null,
			appendFiles,
			track: vi.fn(),
		});

		expect(exitCode).toBe(0);
		expect(appendFiles).toHaveBeenCalledWith(root, [file]);
		expect(release).toHaveBeenCalledOnce();
		const output = JSON.parse(write.mock.calls[0][0]);
		expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
		const feedback = JSON.parse(output.hookSpecificOutput.additionalContext);
		expect(feedback.schema).toBe("aislop.hook.v2");
		expect(feedback.accountability.agent).toBe("codex");
	});

	it("fails open and releases the scan lock when scanning throws", async () => {
		enableAislop();
		const release = vi.fn();
		const write = vi.fn();

		const exitCode = await runCodexHook({
			stdin: async () => postPayload(),
			write,
			resolveFiles: () => [path.join(root, "src", "index.ts")],
			acquireLock: () => release,
			scan: async () => {
				throw new Error("scan failed");
			},
		});

		expect(exitCode).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});
});

describe("runCodexStopHook", () => {
	it("ignores repeated Stop continuations", async () => {
		enableAislop();
		const scan = vi.fn();

		const exitCode = await runCodexStopHook({
			stdin: async () => JSON.stringify({ cwd: root, stop_hook_active: true }),
			scan,
		});

		expect(exitCode).toBe(0);
		expect(scan).not.toHaveBeenCalled();
	});

	it("clears session files without output when the score does not regress", async () => {
		enableAislop();
		const clearFiles = vi.fn();
		const write = vi.fn();

		const exitCode = await runCodexStopHook({
			stdin: async () => JSON.stringify({ cwd: root }),
			write,
			readBaseline: () => ({ score: 100, findingFingerprints: [] }),
			readFiles: () => [path.join(root, "src", "index.ts")],
			acquireLock: () => vi.fn(),
			scan: async () => ({ diagnostics: [], score: 100, rootDirectory: root }),
			clearFiles,
		});

		expect(exitCode).toBe(0);
		expect(clearFiles).toHaveBeenCalledWith(root);
		expect(write).not.toHaveBeenCalled();
	});

	it("blocks Stop when the opted-in project regresses", async () => {
		enableAislop();
		const write = vi.fn();

		const exitCode = await runCodexStopHook({
			stdin: async () => JSON.stringify({ cwd: root }),
			write,
			readBaseline: () => ({ score: 100, findingFingerprints: [] }),
			readFiles: () => [path.join(root, "src", "index.ts")],
			acquireLock: () => vi.fn(),
			scan: async () => ({ diagnostics: [], score: 90, rootDirectory: root }),
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(write.mock.calls[0][0])).toEqual({
			decision: "block",
			reason: "aislop: score dropped from 100 to 90. Fix the findings before finishing.",
		});
	});

	it("fails open when another hook owns the scan lock", async () => {
		enableAislop();
		const scan = vi.fn();
		const write = vi.fn();

		const exitCode = await runCodexStopHook({
			stdin: async () => JSON.stringify({ cwd: root }),
			write,
			readBaseline: () => ({ score: 100, findingFingerprints: [] }),
			readFiles: () => [path.join(root, "src", "index.ts")],
			acquireLock: () => null,
			scan,
		});

		expect(exitCode).toBe(0);
		expect(scan).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
});
