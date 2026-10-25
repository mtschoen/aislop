import {
	evaluateStopGate,
	hasAislopConfig,
	readHookStdin,
	resolveHookCwd,
	scanTouchedFiles,
} from "./runtime.js";

export interface CodexHookStdin {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: { command?: string };
	cwd?: string;
	session_id?: string;
	stop_hook_active?: boolean;
}

interface CodexStopOutput {
	decision: "block";
	reason: string;
}

interface CodexHookOutput {
	hookSpecificOutput: {
		hookEventName: "PostToolUse";
		additionalContext: string;
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseCodexStdin = (raw: string): CodexHookStdin => {
	if (!raw.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const input: CodexHookStdin = {};
		if (typeof parsed.hook_event_name === "string") input.hook_event_name = parsed.hook_event_name;
		if (typeof parsed.tool_name === "string") input.tool_name = parsed.tool_name;
		if (typeof parsed.cwd === "string") input.cwd = parsed.cwd;
		if (typeof parsed.session_id === "string") input.session_id = parsed.session_id;
		if (typeof parsed.stop_hook_active === "boolean") {
			input.stop_hook_active = parsed.stop_hook_active;
		}
		if (isRecord(parsed.tool_input) && typeof parsed.tool_input.command === "string") {
			input.tool_input = { command: parsed.tool_input.command };
		}
		return input;
	} catch {
		return {};
	}
};

export const extractCodexPatchFiles = (command: string): string[] => {
	const files = new Set<string>();
	for (const line of command.split(/\r?\n/)) {
		const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
		const move = line.match(/^\*\*\* Move to: (.+)$/);
		const filePath = header?.[1] ?? move?.[1];
		if (filePath?.trim()) files.add(filePath.trim());
	}
	return [...files];
};

export const renderCodexOutput = (additionalContext: string): CodexHookOutput => ({
	hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
});

const renderCodexStopOutput = (reason: string): CodexStopOutput => ({
	decision: "block",
	reason,
});

interface CodexHookDependencies {
	stdin?: () => Promise<string>;
	write?: (text: string) => void;
	hasConfig?: (cwd: string) => boolean;
	evaluateStop?: typeof evaluateStopGate;
}

export const runCodexHook = async (dependencies: CodexHookDependencies = {}): Promise<number> => {
	const raw = await (dependencies.stdin ?? readHookStdin)();
	const input = parseCodexStdin(raw);
	const cwd = resolveHookCwd(input.cwd);
	if (!(dependencies.hasConfig ?? hasAislopConfig)(cwd)) return 0;
	const feedback = await scanTouchedFiles({
		agent: "codex",
		cwd,
		filePaths: extractCodexPatchFiles(input.tool_input?.command ?? ""),
	});
	if (!feedback) return 0;

	const output = renderCodexOutput(JSON.stringify(feedback));
	(dependencies.write ?? ((text) => process.stdout.write(text)))(JSON.stringify(output));
	return 0;
};

export const runCodexStopHook = async (
	dependencies: CodexHookDependencies = {},
): Promise<number> => {
	const input = parseCodexStdin(await (dependencies.stdin ?? readHookStdin)());
	const cwd = resolveHookCwd(input.cwd);
	if (!(dependencies.hasConfig ?? hasAislopConfig)(cwd)) return 0;
	// Avoid infinite Stop loops if Codex already continued this turn after a previous block.
	if (input.stop_hook_active) return 0;

	const block = await (dependencies.evaluateStop ?? evaluateStopGate)({ agent: "codex", cwd });
	if (!block) return 0;
	(dependencies.write ?? ((text) => process.stdout.write(text)))(
		JSON.stringify(renderCodexStopOutput(block.reason)),
	);
	return 0;
};
