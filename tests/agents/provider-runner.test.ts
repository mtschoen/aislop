import { describe, expect, it } from "vitest";
import { runProvider } from "../../src/agents/provider-runner.js";
import type { AgentProvider } from "../../src/agents/providers.js";

const providerWithExitCode = (exitCode: number): AgentProvider => ({
	id: "opencode",
	label: "OpenCode",
	bin: process.execPath,
	loginCommand: { command: "opencode", args: ["auth", "login"] },
	loginHint: "Run `opencode auth login`.",
	buildArgs: () => ["-e", `process.exitCode = ${exitCode}`],
});

const providerRunning = (script: string): AgentProvider => ({
	...providerWithExitCode(0),
	buildArgs: () => ["-e", script],
});

describe("provider runner", () => {
	it.each([{ outcomes: [] }, { outcomes: ["stop"] }, { outcomes: ["error", "stop"] }])(
		"resolves a successful process and recovered Pi outcomes $outcomes",
		async ({ outcomes }) => {
			const provider =
				outcomes.length === 0
					? providerWithExitCode(0)
					: {
							...providerRunning(
								`process.stdout.write(${JSON.stringify(outcomes.map((stopReason) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason, errorMessage: "Unauthorized" } })).join("\n"))})`,
							),
							id: "pi" as const,
						};
			await expect(
				runProvider(provider, {
					cwd: process.cwd(),
					prompt: "repair",
					maxTurns: 1,
				}),
			).resolves.toBe(0);
		},
	);

	it.each([
		{ outcome: null, code: 7, id: "opencode" as const, message: "OpenCode exited with code 7." },
		{ outcome: "error", code: 0, id: "pi" as const, message: "Unauthorized" },
		{ outcome: "aborted", code: 0, id: "pi" as const, message: "Unauthorized" },
	])(
		"rejects process or terminal failure $outcome/$code",
		async ({ outcome, code, id, message }) => {
			const provider =
				outcome === null
					? providerWithExitCode(code)
					: {
							...providerRunning(
								`process.stdout.write(${JSON.stringify(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: outcome, errorMessage: message } }))})`,
							),
							id,
						};
			await expect(
				runProvider(provider, {
					cwd: process.cwd(),
					prompt: "repair",
					maxTurns: 1,
				}),
			).rejects.toMatchObject({
				name: "ProviderExitError",
				providerId: id,
				exitCode: code,
				message: expect.stringContaining(message),
			});
		},
	);

	it("emits a final line without a newline and splits carriage returns", async () => {
		const events: string[] = [];
		await expect(
			runProvider(
				providerRunning(
					'process.stderr.write("progress 1\\rprogress 2\\nError: no model configured"); process.exitCode = 1',
				),
				{
					cwd: process.cwd(),
					prompt: "repair",
					maxTurns: 1,
					onEvent: (event) => events.push(`${event.stream}:${event.line}`),
				},
			),
		).rejects.toMatchObject({ exitCode: 1 });
		expect(events).toEqual([
			"stderr:progress 1",
			"stderr:progress 2",
			"stderr:Error: no model configured",
		]);
	});
});
