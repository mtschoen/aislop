import ts from "typescript";
import { maskComments, maskStringsAndComments } from "../../utils/source-masker.js";
import type { Diagnostic } from "../types.js";

const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAXIMUM_STRING_LITERAL_LENGTH = 80;
const TRIVIAL_NUMERIC_VALUES = new Set([-1, 0, 1, 2]);
const PYTHON_INTEGER_LITERAL_RE =
	/^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*)$/;
const PYTHON_ASSIGNMENT_LITERAL_RE =
	/\b([A-Za-z_]\w*)(?:\s*:\s*[^=,)\n]+)?\s*=(?!=)\s*(?:([+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?))(?![\w.])|((?:[rRuUbB]|[bB][rR]|[rR][bB])?)"((?:\\.|[^"\\]){1,80})"|((?:[rRuUbB]|[bB][rR]|[rR][bB])?)'((?:\\.|[^'\\]){1,80})')/g;

interface LiteralValue {
	key: string;
	display: string;
}

interface RepeatedLiteralOccurrence extends LiteralValue {
	line: number;
	name: string;
}

const numericLiteralValue = (rawValue: string, kind = "number"): LiteralValue | null => {
	const numericValue = Number(rawValue.replaceAll("_", ""));
	if (!Number.isFinite(numericValue) || TRIVIAL_NUMERIC_VALUES.has(numericValue)) return null;
	return { key: `${kind}:${numericValue}`, display: String(numericValue) };
};

const pythonNumericLiteralValue = (rawValue: string): LiteralValue | null => {
	if (!PYTHON_INTEGER_LITERAL_RE.test(rawValue)) {
		return numericLiteralValue(rawValue, "python-float");
	}

	const normalizedValue = rawValue.replaceAll("_", "");
	const isNegative = normalizedValue.startsWith("-");
	const unsignedValue = /^[+-]/.test(normalizedValue) ? normalizedValue.slice(1) : normalizedValue;
	const integerValue = BigInt(unsignedValue) * (isNegative ? -1n : 1n);
	if (TRIVIAL_NUMERIC_VALUES.has(Number(integerValue))) return null;
	return { key: `python-integer:${integerValue}`, display: String(integerValue) };
};

const stringLiteralValue = (value: string): LiteralValue | null => {
	if (value.length === 0 || value.length > MAXIMUM_STRING_LITERAL_LENGTH) return null;
	return { key: `string:${value}`, display: `'${value}'` };
};

const pythonStringLiteralValue = (prefix: string, value: string): LiteralValue | null => {
	const literalValue = stringLiteralValue(value);
	if (!literalValue) return null;
	const normalizedPrefix = prefix.toLowerCase();
	return {
		key: `python-string:${normalizedPrefix}:${value}`,
		display: `${normalizedPrefix}'${value}'`,
	};
};

const scanPythonRepeatedLiterals = (content: string): RepeatedLiteralOccurrence[] => {
	const occurrences: RepeatedLiteralOccurrence[] = [];
	const commentMaskedLines = maskComments(content, ".py").split("\n");
	const codeMaskedLines = maskStringsAndComments(content, ".py").split("\n");
	for (const [index, line] of commentMaskedLines.entries()) {
		const codeMaskedLine = codeMaskedLines[index] ?? "";
		for (const match of line.matchAll(PYTHON_ASSIGNMENT_LITERAL_RE)) {
			const matchIndex = match.index ?? 0;
			if (codeMaskedLine.slice(matchIndex, matchIndex + match[1].length) !== match[1]) {
				continue;
			}
			const value = match[2]
				? pythonNumericLiteralValue(match[2])
				: pythonStringLiteralValue(match[3] ?? match[5] ?? "", match[4] ?? match[6] ?? "");
			if (!value) continue;
			occurrences.push({ line: index + 1, name: match[1], ...value });
		}
	}
	return occurrences;
};

const scriptKindFor = (extension: string): ts.ScriptKind => {
	switch (extension) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
};

const nameOfDeclaration = (name: ts.BindingName | ts.PropertyName): string | null => {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return null;
};

const unwrapLiteralExpression = (expression: ts.Expression): ts.Expression => {
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		return unwrapLiteralExpression(expression.expression);
	}
	return expression;
};

const literalValueOfExpression = (expression: ts.Expression): LiteralValue | null => {
	const literalExpression = unwrapLiteralExpression(expression);
	if (ts.isNumericLiteral(literalExpression)) {
		return numericLiteralValue(literalExpression.text);
	}
	if (
		ts.isPrefixUnaryExpression(literalExpression) &&
		ts.isNumericLiteral(literalExpression.operand) &&
		(literalExpression.operator === ts.SyntaxKind.MinusToken ||
			literalExpression.operator === ts.SyntaxKind.PlusToken)
	) {
		const prefix = literalExpression.operator === ts.SyntaxKind.MinusToken ? "-" : "";
		return numericLiteralValue(`${prefix}${literalExpression.operand.text}`);
	}
	if (ts.isStringLiteralLike(literalExpression)) {
		return stringLiteralValue(literalExpression.text);
	}
	return null;
};

const nameOfAssignmentTarget = (expression: ts.Expression): string | null => {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return null;
};

const scanJavaScriptRepeatedLiterals = (
	content: string,
	filePath: string,
	extension: string,
): RepeatedLiteralOccurrence[] => {
	const sourceFile = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(extension),
	);
	const occurrences: RepeatedLiteralOccurrence[] = [];

	const addOccurrence = (name: string | null, expression: ts.Expression, node: ts.Node): void => {
		if (!name) return;
		const value = literalValueOfExpression(expression);
		if (!value) return;
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		occurrences.push({ line, name, ...value });
	};

	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAssignment(node)) {
			addOccurrence(nameOfDeclaration(node.name), node.initializer, node);
		} else if (ts.isParameter(node) && node.initializer) {
			addOccurrence(nameOfDeclaration(node.name), node.initializer, node);
		} else if (ts.isVariableDeclaration(node) && node.initializer) {
			addOccurrence(nameOfDeclaration(node.name), node.initializer, node);
		} else if (ts.isPropertyDeclaration(node) && node.initializer) {
			addOccurrence(nameOfDeclaration(node.name), node.initializer, node);
		} else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken
		) {
			addOccurrence(nameOfAssignmentTarget(node.left), node.right, node);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return occurrences;
};

const makeDiagnostics = (
	occurrences: RepeatedLiteralOccurrence[],
	relativePath: string,
	threshold: number,
): Diagnostic[] => {
	const groups = new Map<string, RepeatedLiteralOccurrence[]>();
	for (const occurrence of occurrences) {
		const key = `${occurrence.name}\0${occurrence.key}`;
		const group = groups.get(key) ?? [];
		group.push(occurrence);
		groups.set(key, group);
	}

	const diagnostics: Diagnostic[] = [];
	for (const group of groups.values()) {
		if (group.length <= threshold) continue;
		const first = group[0];
		diagnostics.push({
			filePath: relativePath,
			engine: "ai-slop",
			rule: "ai-slop/repeated-magic-literal",
			severity: "warning",
			message: `Literal ${first.display} is repeated ${group.length} times for '${first.name}'`,
			help: "Extract the repeated value to a module-level named constant and reference it at each use site.",
			line: first.line,
			column: 0,
			category: "AI Slop",
			fixable: false,
		});
	}
	return diagnostics;
};

export const detectRepeatedMagicLiteralsInFile = (
	content: string,
	relativePath: string,
	extension: string,
	threshold: number,
): Diagnostic[] => {
	const occurrences =
		extension === ".py"
			? scanPythonRepeatedLiterals(content)
			: JS_TS_EXTENSIONS.has(extension)
				? scanJavaScriptRepeatedLiterals(content, relativePath, extension)
				: [];
	return makeDiagnostics(occurrences, relativePath, threshold);
};
