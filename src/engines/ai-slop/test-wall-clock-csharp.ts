import type { Node } from "web-tree-sitter";
import { parseCsharp } from "../../utils/csharp-parser.js";
import {
	fileUsesFrameworkStopwatchName,
	isStopwatchReceiver,
	unwrapReceiver,
} from "./csharp-stopwatch-bindings.js";

const ELAPSED_PREFIX = "Elapsed";
const ASSERT_RECEIVER = "Assert";
const FLUENT_ASSERTION_MEMBER = "Should";
const NAMEOF = "nameof";

// Static clock property reads: receiver type name to the properties that read the clock.
const STATIC_CLOCK_PROPERTIES = new Map<string, ReadonlySet<string>>([
	["DateTime", new Set(["Now", "UtcNow"])],
	["System.DateTime", new Set(["Now", "UtcNow"])],
	["global::System.DateTime", new Set(["Now", "UtcNow"])],
	["DateTimeOffset", new Set(["Now", "UtcNow"])],
	["System.DateTimeOffset", new Set(["Now", "UtcNow"])],
	["global::System.DateTimeOffset", new Set(["Now", "UtcNow"])],
	["Environment", new Set(["TickCount", "TickCount64"])],
	["System.Environment", new Set(["TickCount", "TickCount64"])],
	["global::System.Environment", new Set(["TickCount", "TickCount64"])],
]);

// Static clock methods: receiver type name to the methods that read the clock.
// Unlike properties, these must be invoked to evaluate the clock.
const STATIC_CLOCK_METHODS = new Map<string, ReadonlySet<string>>([
	["Stopwatch", new Set(["GetTimestamp", "GetElapsedTime"])],
	["System.Diagnostics.Stopwatch", new Set(["GetTimestamp", "GetElapsedTime"])],
	["global::System.Diagnostics.Stopwatch", new Set(["GetTimestamp", "GetElapsedTime"])],
]);

const memberName = (node: Node | null): string | null => {
	if (node === null) return null;
	if (node.type === "identifier") return node.text;
	if (node.type !== "generic_name") return null;
	const base = node.childForFieldName("name") ?? node.namedChildren[0];
	return base !== undefined && base.type === "identifier" ? base.text : null;
};

interface MemberRead {
	readonly member: string;
	readonly receiver: Node | null;
}

// The two node types C# uses to read a member by name, `receiver.Member` and
// `receiver?.Member`. Indexers (`element_access_expression`) name no member and
// so can never be an `.Elapsed*` read.
const memberRead = (node: Node): MemberRead | null => {
	if (node.type === "member_access_expression") {
		const member = memberName(node.childForFieldName("name"));
		return member === null ? null : { member, receiver: node.childForFieldName("expression") };
	}
	if (node.type !== "conditional_access_expression") return null;
	const [receiver, binding] = node.namedChildren;
	if (binding === undefined || binding.type !== "member_binding_expression") return null;
	const member = memberName(binding.namedChildren[0] ?? null);
	return member === null ? null : { member, receiver: receiver ?? null };
};

const isInvocationCallee = (node: Node): boolean => {
	let current = node;
	while (current.parent !== null) {
		if (current.parent.type === "parenthesized_expression") {
			current = current.parent;
			continue;
		}
		if (current.parent.type === "invocation_expression") {
			const callee =
				current.parent.childForFieldName("function") ?? current.parent.namedChildren[0];
			return callee?.id === current.id;
		}
		return false;
	}
	return false;
};

const isClockRead = (node: Node, usesFrameworkStopwatchName: boolean): boolean => {
	const read = memberRead(node);
	if (read === null) return false;
	if (read.member.startsWith(ELAPSED_PREFIX)) {
		return isStopwatchReceiver(read.receiver, usesFrameworkStopwatchName);
	}
	const receiver = unwrapReceiver(read.receiver);
	if (receiver === null) return false;
	const receiverText = receiver.text.replace(/\s+/g, "");
	if (STATIC_CLOCK_PROPERTIES.get(receiverText)?.has(read.member) === true) {
		return true;
	}
	if (STATIC_CLOCK_METHODS.get(receiverText)?.has(read.member) === true) {
		return usesFrameworkStopwatchName && isInvocationCallee(node);
	}
	return false;
};

const isAssertionCall = (node: Node): boolean => {
	if (node.type !== "invocation_expression") return false;
	const callee = node.childForFieldName("function");
	if (callee === null || callee.type !== "member_access_expression") return false;
	const receiver = callee.childForFieldName("expression");
	const receiverText = receiver?.text.replace(/\s+/g, "");
	if (receiverText === ASSERT_RECEIVER || receiverText?.endsWith("." + ASSERT_RECEIVER))
		return true;
	return memberName(callee.childForFieldName("name")) === FLUENT_ASSERTION_MEMBER;
};

// `nameof(x.ElapsedMilliseconds)` names a member; it never evaluates it.
const isNameofCall = (node: Node): boolean =>
	node.type === "invocation_expression" && node.childForFieldName("function")?.text === NAMEOF;

interface AncestorVerdict {
	readonly assertion: boolean;
	readonly nameof: boolean;
}

const inspectAncestors = (node: Node): AncestorVerdict => {
	let assertion = false;
	for (let current = node.parent; current !== null; current = current.parent) {
		if (isNameofCall(current)) return { assertion: false, nameof: true };
		if (isAssertionCall(current)) assertion = true;
	}
	return { assertion, nameof: false };
};

/**
 * One-based line numbers of C# assertions whose value comes from the machine
 * clock. Returns an empty list when the bundled grammar is unavailable, which
 * makes the rule under-report rather than fail the scan.
 */
export const csharpWallClockAssertionLines = async (source: string): Promise<number[]> => {
	const root = await parseCsharp(source);
	if (root === null) return [];

	const usesFrameworkStopwatchName = fileUsesFrameworkStopwatchName(root);
	const lines = new Set<number>();
	const pending: Node[] = [root];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		pending.push(...node.namedChildren);
		if (!isClockRead(node, usesFrameworkStopwatchName)) continue;
		const verdict = inspectAncestors(node);
		if (verdict.assertion && !verdict.nameof) lines.add(node.startPosition.row + 1);
	}
	return [...lines].sort((left, right) => left - right);
};
