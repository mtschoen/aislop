import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { AgentProvider } from "../../src/agents/providers.js";
import { runProvider } from "../../src/agents/provider-runner.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

const makeStream = (): EventEmitter & NodeJS.ReadableStream =>
	Object.assign(new EventEmitter(), {
		on: EventEmitter.prototype.on,
	});

const mockProvider: AgentProvider = {
	id: "codex",
	label: "Codex",
	bin: "codex",
	loginCommand: { command: "codex", args: ["login"] },
	loginHint: "",
	buildArgs: (prompt) => ["exec", prompt],
};

const makeChild = () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: makeStream(),
		stderr: makeStream(),
	});
	return child as unknown as ReturnType<typeof spawn>;
};

beforeEach(() => {
	spawnMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runProvider", () => {
	it("streams parsed stdout and stderr lines and resolves with exit code", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);

		const onEvent = vi.fn();
		const promise = runProvider(mockProvider, {
			cwd: "/repo",
			prompt: "please fix",
			maxTurns: 3,
			onEvent,
		});

		child.stdout.emit("data", Buffer.from("line one\nline two\n"));
		child.stderr.emit("data", Buffer.from("warn one\n"));
		child.emit("close", 0);

		expect(await promise).toBe(0);
		expect(onEvent).toHaveBeenCalledTimes(3);
		expect(onEvent).toHaveBeenCalledWith({ stream: "stdout", line: "line one" });
		expect(onEvent).toHaveBeenCalledWith({ stream: "stdout", line: "line two" });
		expect(onEvent).toHaveBeenCalledWith({ stream: "stderr", line: "warn one" });
		expect(spawnMock).toHaveBeenCalledOnce();
		expect(spawnMock).toHaveBeenCalledWith(
			"codex",
			["exec", "please fix"],
			expect.objectContaining({
				cwd: "/repo",
				env: expect.objectContaining({ NO_COLOR: "1" }),
			}),
		);
	});

	it("streams partial lines emitted across data chunks", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);

		const onEvent = vi.fn();
		const promise = runProvider(mockProvider, {
			cwd: "/repo",
			prompt: "scan",
			maxTurns: 1,
			onEvent,
		});

		child.stdout.emit("data", Buffer.from("first"));
		child.stdout.emit("data", Buffer.from(" line\nsecond\n"));
		child.emit("close", null);

		expect(await promise).toBeNull();
		expect(onEvent).toHaveBeenCalledTimes(2);
		expect(onEvent).toHaveBeenCalledWith({ stream: "stdout", line: "first line" });
		expect(onEvent).toHaveBeenCalledWith({ stream: "stdout", line: "second" });
	});

	it("rejects when spawn emits an error", async () => {
		const child = makeChild();
		spawnMock.mockReturnValue(child);

		const promise = runProvider(mockProvider, {
			cwd: "/repo",
			prompt: "repair",
			maxTurns: 2,
		});

		child.emit("error", new Error("spawn failed"));

		await expect(promise).rejects.toThrow("spawn failed");
	});
});
