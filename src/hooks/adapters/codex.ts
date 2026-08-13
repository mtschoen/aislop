import { readHookStdin, resolveHookCwd, scanTouchedFiles } from "./runtime.js";

export interface CodexHookStdin {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: { command?: string };
	cwd?: string;
	session_id?: string;
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

export const runCodexHook = async (
	dependencies: { stdin?: () => Promise<string>; write?: (text: string) => void } = {},
): Promise<number> => {
	const raw = await (dependencies.stdin ?? readHookStdin)();
	const input = parseCodexStdin(raw);
	const feedback = await scanTouchedFiles({
		agent: "codex",
		cwd: resolveHookCwd(input.cwd),
		filePaths: extractCodexPatchFiles(input.tool_input?.command ?? ""),
	});
	if (!feedback) return 0;

	const output = renderCodexOutput(JSON.stringify(feedback));
	(dependencies.write ?? ((text) => process.stdout.write(text)))(JSON.stringify(output));
	return 0;
};
