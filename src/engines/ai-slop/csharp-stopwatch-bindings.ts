import type { Node } from "web-tree-sitter";

// The spellings that name System.Diagnostics.Stopwatch. A closed list: a type
// alias such as `using Timer = System.Diagnostics.Stopwatch` is not resolved.
const STOPWATCH_TYPE_SPELLINGS = new Set([
	"Stopwatch",
	"Diagnostics.Stopwatch",
	"System.Diagnostics.Stopwatch",
	"global::System.Diagnostics.Stopwatch",
]);

const STOPWATCH_NAME = "Stopwatch";

// web-tree-sitter returns undefined rather than null for a field the node does
// not carry, so every field read goes through this.
const fieldOf = (node: Node | null, field: string): Node | null =>
	node?.childForFieldName(field) ?? null;

const isStopwatchSpelling = (node: Node | null): boolean =>
	node !== null && STOPWATCH_TYPE_SPELLINGS.has(node.text.replace(/\s+/g, "").replace(/\?+$/, ""));

// Parentheses and the null-forgiving `!` suffix wrap an expression without
// changing what it evaluates to, so a receiver is read through both.
export const unwrapReceiver = (node: Node | null): Node | null => {
	let current = node;
	while (current !== null) {
		if (current.type === "parenthesized_expression") {
			current = current.namedChildren[0] ?? null;
			continue;
		}
		if (current.type === "postfix_unary_expression" && current.text.endsWith("!")) {
			current = fieldOf(current, "operand") ?? current.namedChildren[0] ?? null;
			continue;
		}
		return current;
	}
	return null;
};

/**
 * `new Stopwatch(...)` or `Stopwatch.StartNew()`, optionally parenthesized. These
 * are the only two expressions whose result is a Stopwatch by construction, with
 * no name resolution involved.
 */
const isStopwatchConstruction = (node: Node | null): boolean => {
	const expression = unwrapReceiver(node);
	if (expression === null) return false;
	if (expression.type === "object_creation_expression") {
		return isStopwatchSpelling(fieldOf(expression, "type"));
	}
	if (expression.type !== "invocation_expression") return false;
	const callee = fieldOf(expression, "function");
	if (callee === null || callee.type !== "member_access_expression") return false;
	return (
		isStopwatchSpelling(fieldOf(callee, "expression")) &&
		fieldOf(callee, "name")?.text === "StartNew"
	);
};

// The declaration node shapes that introduce a Stopwatch-typed name, and no
// others. A method, indexer, or lambda whose *return* type is Stopwatch declares
// nothing; neither does an assignment, a cast, or `var x = GetStopwatch()`.
const addDeclaredName = (node: Node | null, names: Set<string>): void => {
	if (node !== null && node.type === "identifier") names.add(node.text);
};

// A tuple element may carry a label (`timer: Stopwatch.StartNew()`), and the
// label is the argument's first named child, so the value is read past the
// optional `name` field rather than taken as the first child.
const argumentValue = (element: Node): Node | null => {
	const label = fieldOf(element, "name");
	return element.namedChildren.find((child) => child.id !== label?.id) ?? null;
};

// `var (first, second) = (Stopwatch.StartNew(), other)` binds by position:
// element `index` of the pattern takes element `index` of the tuple.
const addTupleDeconstruction = (pattern: Node, value: Node | null, names: Set<string>): void => {
	if (value === null || value.type !== "tuple_expression") return;
	pattern.namedChildren.forEach((target, index) => {
		const element = value.namedChildren[index] ?? null;
		const initializer = element?.type === "argument" ? argumentValue(element) : element;
		if (target.type === "tuple_pattern") {
			addTupleDeconstruction(target, initializer, names);
			return;
		}
		if (isStopwatchConstruction(initializer)) addDeclaredName(target, names);
	});
};

const addVariableDeclaration = (node: Node, names: Set<string>): void => {
	const declaresStopwatchType = isStopwatchSpelling(fieldOf(node, "type"));
	for (const declarator of node.namedChildren) {
		if (declarator.type !== "variable_declarator") continue;
		const target = declarator.namedChildren[0] ?? null;
		const value = fieldOf(declarator, "value") ?? declarator.namedChildren[1] ?? null;
		if (target === null) continue;
		if (target.type === "tuple_pattern") {
			addTupleDeconstruction(target, value, names);
			continue;
		}
		if (declaresStopwatchType || isStopwatchConstruction(value)) addDeclaredName(target, names);
	}
};

const addDeclaredStopwatchName = (node: Node, names: Set<string>): void => {
	switch (node.type) {
		case "variable_declaration":
			addVariableDeclaration(node, names);
			return;
		case "property_declaration":
		case "parameter":
		case "declaration_expression":
			if (isStopwatchSpelling(fieldOf(node, "type"))) addDeclaredName(fieldOf(node, "name"), names);
			return;
		case "foreach_statement":
			if (isStopwatchSpelling(fieldOf(node, "type"))) addDeclaredName(fieldOf(node, "left"), names);
			return;
		default:
			return;
	}
};

// The member a read sits in. Local functions and lambdas are part of the member
// that contains them, not regions of their own, so the walk does not stop there.
const MEMBER_REGION_TYPES = new Set([
	"method_declaration",
	"constructor_declaration",
	"destructor_declaration",
	"operator_declaration",
	"conversion_operator_declaration",
	"property_declaration",
	"indexer_declaration",
	"event_declaration",
	"field_declaration",
	"global_statement",
]);

// `record`, `record struct`, and `record class` all parse as `record_declaration`.
const TYPE_DECLARATION_TYPES = new Set([
	"class_declaration",
	"struct_declaration",
	"record_declaration",
	"interface_declaration",
]);

const nearestAncestorOfType = (node: Node, types: ReadonlySet<string>): Node | null => {
	for (let current: Node | null = node.parent; current !== null; current = current.parent) {
		if (types.has(current.type)) return current;
	}
	return null;
};

// Direct fields and properties of the enclosing type. Nested types are not
// walked, and neither are base classes or the other files of a partial class.
const addDirectMemberNames = (typeDeclaration: Node, names: Set<string>): void => {
	const body = typeDeclaration.namedChildren.find((child) => child.type === "declaration_list");
	for (const member of body?.namedChildren ?? []) {
		if (member.type === "property_declaration") {
			addDeclaredStopwatchName(member, names);
			continue;
		}
		if (member.type !== "field_declaration") continue;
		const declaration = member.namedChildren.find((child) => child.type === "variable_declaration");
		if (declaration !== undefined) addDeclaredStopwatchName(declaration, names);
	}
};

// The subtrees the enclosing member contributes. A top-level program is one body
// even though the grammar wraps each of its statements in its own
// `global_statement`, so a read in one of them takes every top-level statement.
const memberRegionRoots = (read: Node): Node[] => {
	const member = nearestAncestorOfType(read, MEMBER_REGION_TYPES);
	if (member === null) return [];
	if (member.type !== "global_statement") return [member];
	const program = member.parent ?? read.tree.rootNode;
	return program.namedChildren.filter((child) => child.type === "global_statement");
};

/**
 * Every name declared as a Stopwatch in the read's binding region: the subtree of
 * the enclosing member, plus the enclosing type's direct fields and properties.
 * The region is not a scope. A name declared as a Stopwatch anywhere in it counts,
 * even where another declaration of the same name is what the read really sees.
 */
const declaredStopwatchNames = (read: Node): Set<string> => {
	const names = new Set<string>();
	const pending: Node[] = memberRegionRoots(read);
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		pending.push(...node.namedChildren);
		addDeclaredStopwatchName(node, names);
	}
	const typeDeclaration = nearestAncestorOfType(read, TYPE_DECLARATION_TYPES);
	if (typeDeclaration !== null) addDirectMemberNames(typeDeclaration, names);
	return names;
};

// The two receiver forms that name one variable: `x` and `this.x`.
const simpleReceiverName = (expression: Node): string | null => {
	if (expression.type === "identifier") return expression.text;
	if (expression.type !== "member_access_expression") return null;
	const inner = unwrapReceiver(fieldOf(expression, "expression"));
	if (inner === null || inner.type !== "this") return null;
	const member = fieldOf(expression, "name");
	return member !== null && member.type === "identifier" ? member.text : null;
};

const NAME_SHADOWING_DECLARATION_TYPES = new Set([
	"class_declaration",
	"struct_declaration",
	"record_declaration",
	"interface_declaration",
	"enum_declaration",
	"delegate_declaration",
]);

/**
 * Whether `Stopwatch` still spells the framework type in this file. One structural
 * query: a `using Stopwatch = ...` alias or a type declared as `Stopwatch` gives
 * the name another meaning, and every Stopwatch-spelling check is then off for the
 * whole file rather than guessing which reads the redefinition reaches.
 */
export const fileUsesFrameworkStopwatchName = (root: Node): boolean => {
	const pending: Node[] = [root];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		pending.push(...node.namedChildren);
		const redefines =
			node.type === "using_directive" || NAME_SHADOWING_DECLARATION_TYPES.has(node.type);
		if (redefines && fieldOf(node, "name")?.text === STOPWATCH_NAME) return false;
	}
	return true;
};

/**
 * Whether an `.Elapsed*` member access on this receiver reads the machine clock:
 * the `Stopwatch` type name itself, a Stopwatch construction, or a name (bare or
 * reached through `this.`) declared as a Stopwatch in the read's binding region.
 */
export const isStopwatchReceiver = (
	receiver: Node | null,
	usesFrameworkStopwatchName: boolean,
): boolean => {
	if (!usesFrameworkStopwatchName) return false;
	const expression = unwrapReceiver(receiver);
	if (expression === null) return false;
	if (isStopwatchSpelling(expression) || isStopwatchConstruction(expression)) return true;
	const name = simpleReceiverName(expression);
	return name !== null && declaredStopwatchNames(expression).has(name);
};
