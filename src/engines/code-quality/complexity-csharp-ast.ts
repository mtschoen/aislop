import type { Node } from "web-tree-sitter";
import { parseCsharp } from "../../utils/csharp-parser.js";
import type { FunctionInfo } from "./complexity-functions.js";
import { countTemplateLines } from "./function-boundaries.js";

// Syntax-tree node kinds that own an executable body. Type declarations
// (class, struct, record, interface, enum) are deliberately absent: a C# 12
// primary constructor puts a parameter list on the type itself, and a type is
// never a function to measure.
const FUNCTION_NODE_TYPES = new Set([
	"method_declaration",
	"constructor_declaration",
	"destructor_declaration",
	"operator_declaration",
	"conversion_operator_declaration",
	"local_function_statement",
	"accessor_declaration",
]);

const TYPE_NODE_TYPES = new Set([
	"class_declaration",
	"struct_declaration",
	"interface_declaration",
]);

const LEADING_NON_SIGNATURE_TYPES = new Set(["attribute_list", "comment", "#endif", "#else"]);

const PARAMETER_CHILD_TYPES = new Set(["parameter", "params"]);

const CONTROL_FLOW_NODE_TYPES = new Set([
	"if_statement",
	"for_statement",
	"foreach_statement",
	"while_statement",
	"do_statement",
	"switch_statement",
	"try_statement",
]);

const accessorOwnerName = (accessor: Node): string =>
	accessor.parent?.parent?.childForFieldName("name")?.text ?? "this";

const functionName = (node: Node): string => {
	const declaredName = node.childForFieldName("name")?.text;
	if (node.type === "accessor_declaration") {
		return `${accessorOwnerName(node)}.${declaredName ?? "accessor"}`;
	}
	if (declaredName !== undefined) return declaredName;
	return node.type === "conversion_operator_declaration" ? "operator conversion" : "operator";
};

// The first line of the signature proper: attributes, comments, and preprocessor
// directives that sit on their own lines above a member are not part of the
// measured function. Nested conditional attributes can also leave closing
// directives in a leading ERROR recovery node.
const isLeadingNonSignatureChild = (child: Node): boolean =>
	LEADING_NON_SIGNATURE_TYPES.has(child.type) ||
	child.type.startsWith("preproc_") ||
	(child.type === "ERROR" &&
		child.children.length > 0 &&
		child.children.every(isLeadingNonSignatureChild));

const signatureStartRow = (node: Node): number => {
	const firstSignatureChild = node.children.find((child) => !isLeadingNonSignatureChild(child));
	return (firstSignatureChild ?? node).startPosition.row;
};

// Ordinary parameters are `parameter` children; a trailing `params T[] name`
// slot is flattened by the bundled grammar into `params`, the type node, and
// the identifier node, with optional `comment` and `attribute_list` siblings.
const countParameters = (parameterList: Node | null): number => {
	if (parameterList === null) return 0;
	return parameterList.children.filter((child) => PARAMETER_CHILD_TYPES.has(child.type)).length;
};

const isElseIfBranch = (node: Node): boolean =>
	node.type === "if_statement" &&
	node.parent?.type === "if_statement" &&
	node.parent.childForFieldName("alternative")?.id === node.id;

const isControlFlowNode = (node: Node): boolean =>
	CONTROL_FLOW_NODE_TYPES.has(node.type) && !isElseIfBranch(node);

const measureBodyNesting = (memberNode: Node): number => {
	const body = memberNode.childForFieldName("body");
	if (body === null) return 0;
	let maximumDepth = 0;
	const pending: Array<{ node: Node; depth: number }> = [{ node: body, depth: 0 }];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		for (const child of current.node.namedChildren) {
			if (FUNCTION_NODE_TYPES.has(child.type)) continue;
			const nextDepth = isControlFlowNode(child) ? current.depth + 1 : current.depth;
			if (nextDepth > maximumDepth) maximumDepth = nextDepth;
			pending.push({ node: child, depth: nextDepth });
		}
	}
	return maximumDepth;
};

// A C# 12 primary constructor is a constructor whose parameters sit on the
// type declaration. It is measured as its parameter list alone (it has no body
// of its own), so the too-many-params limit still applies while the type's
// members are measured one by one. Positional records declare components rather
// than callable signatures, so their parameter lists are deliberately excluded.
const primaryConstructorList = (node: Node): Node | null => {
	if (!TYPE_NODE_TYPES.has(node.type)) return null;
	return node.children.find((child) => child.type === "parameter_list") ?? null;
};

const measurePrimaryConstructor = (typeNode: Node, parameterList: Node): FunctionInfo => ({
	name: typeNode.childForFieldName("name")?.text ?? "primary constructor",
	startLine: parameterList.startPosition.row + 1,
	lineCount: parameterList.endPosition.row - parameterList.startPosition.row + 1,
	maxNesting: 0,
	paramCount: countParameters(parameterList),
	templateLines: 0,
});

const measureFunction = (node: Node, lines: string[]): FunctionInfo => {
	const primaryList = primaryConstructorList(node);
	if (primaryList !== null) return measurePrimaryConstructor(node, primaryList);
	const startRow = signatureStartRow(node);
	const endRow = node.endPosition.row;
	return {
		name: functionName(node),
		startLine: startRow + 1,
		lineCount: endRow - startRow + 1,
		maxNesting: measureBodyNesting(node),
		paramCount: countParameters(node.childForFieldName("parameters")),
		templateLines: countTemplateLines(lines.slice(startRow + 1, endRow)),
	};
};

const collectFunctionNodes = (root: Node): Node[] => {
	const found: Node[] = [];
	const pending: Node[] = [root];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		const ownsBlockBody =
			FUNCTION_NODE_TYPES.has(node.type) && node.childForFieldName("body")?.type === "block";
		if (ownsBlockBody || primaryConstructorList(node) !== null) found.push(node);
		pending.push(...node.namedChildren);
	}
	return found.sort((left, right) => left.startIndex - right.startIndex);
};

/**
 * The bundled C# grammar is part of the install, so failing to load it is a
 * broken install and never a normal state. There is deliberately no line-pattern
 * fallback: it would silently reintroduce the primary-constructor misreading.
 */
export class CsharpGrammarUnavailableError extends Error {
	constructor() {
		super(
			"the bundled C# grammar did not load, so C# functions cannot be measured (reinstall aislop)",
		);
		this.name = "CsharpGrammarUnavailableError";
	}
}

/**
 * Measure the C# members that own a block body, straight from the syntax tree.
 * Throws CsharpGrammarUnavailableError when the bundled grammar will not load.
 */
export const analyzeCsharpFunctions = async (content: string): Promise<FunctionInfo[]> => {
	const root = await parseCsharp(content);
	if (root === null) throw new CsharpGrammarUnavailableError();
	try {
		const lines = content.split("\n");
		return collectFunctionNodes(root).map((node) => measureFunction(node, lines));
	} finally {
		root.tree.delete();
	}
};
