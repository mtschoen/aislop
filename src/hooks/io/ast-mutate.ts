import ts from "typescript";

export const detectEol = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

export const detectIndent = (text: string): string => {
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(/^([ \t]+)(?="|\w)/);
		if (match) {
			const leading = match[1];
			return leading.includes("\t") ? "\t" : leading;
		}
	}
	return "  ";
};

export const formatValue = (value: unknown, indentUnit: string, eol: string, level = 0): string => {
	const currentIndent = indentUnit.repeat(level);
	const nextIndent = indentUnit.repeat(level + 1);

	if (value === null) return "null";
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") return JSON.stringify(value);

	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map(
			(item) => `${nextIndent}${formatValue(item, indentUnit, eol, level + 1)}`,
		);
		return `[${eol}${items.join(`,${eol}`)}${eol}${currentIndent}]`;
	}

	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		if (keys.length === 0) return "{}";
		const properties = keys.map(
			(key) =>
				`${nextIndent}${JSON.stringify(key)}: ${formatValue((value as Record<string, unknown>)[key], indentUnit, eol, level + 1)}`,
		);
		return `{${eol}${properties.join(`,${eol}`)}${eol}${currentIndent}}`;
	}

	return JSON.stringify(value);
};

export const getNodeValue = (node: ts.Node | undefined): unknown => {
	if (!node) return undefined;
	switch (node.kind) {
		case ts.SyntaxKind.StringLiteral:
			return (node as ts.StringLiteral).text;
		case ts.SyntaxKind.NumericLiteral:
			return Number((node as ts.NumericLiteral).text);
		case ts.SyntaxKind.TrueKeyword:
			return true;
		case ts.SyntaxKind.FalseKeyword:
			return false;
		case ts.SyntaxKind.NullKeyword:
			return null;
		case ts.SyntaxKind.PrefixUnaryExpression: {
			const unary = node as ts.PrefixUnaryExpression;
			const numberValue = Number((unary.operand as ts.NumericLiteral).text);
			return unary.operator === ts.SyntaxKind.MinusToken ? -numberValue : numberValue;
		}
		case ts.SyntaxKind.ArrayLiteralExpression:
			return (node as ts.ArrayLiteralExpression).elements.map(getNodeValue);
		case ts.SyntaxKind.ObjectLiteralExpression: {
			const objectResult: Record<string, unknown> = {};
			for (const property of (node as ts.ObjectLiteralExpression).properties) {
				if (ts.isPropertyAssignment(property) && property.name) {
					const propertyKey =
						"text" in property.name
							? (property.name as { text: string }).text
							: ((property.name as { escapedText?: string }).escapedText ?? "");
					objectResult[propertyKey] = getNodeValue(property.initializer);
				}
			}
			return objectResult;
		}
		default:
			return undefined;
	}
};

export const parseSourceFile = (source: string): ts.JsonSourceFile =>
	ts.parseJsonText("file.json", source);

export const getRootObject = (sourceFile: ts.JsonSourceFile): ts.ObjectLiteralExpression =>
	(sourceFile.statements[0] as ts.ExpressionStatement).expression as ts.ObjectLiteralExpression;

export const findProperty = (
	objectNode: ts.ObjectLiteralExpression | undefined,
	propertyName: string,
): ts.PropertyAssignment | undefined => {
	if (!objectNode?.properties) return undefined;
	return objectNode.properties.find(
		(property) =>
			ts.isPropertyAssignment(property) &&
			("text" in property.name
				? (property.name as { text: string }).text
				: (property.name as { escapedText?: string }).escapedText) === propertyName,
	) as ts.PropertyAssignment | undefined;
};

export const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
		if (!deepEqual(aObj[key], bObj[key])) return false;
	}
	return true;
};

const removeEntrySpanFromSource = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	entryNode: ts.Node,
	entryIndex: number,
	previousNode?: ts.Node,
): string => {
	const entryStart = entryNode.getStart(sourceFile);
	const entryEnd = entryNode.getEnd();

	const matchAfterComma = source.slice(entryEnd).match(/^[ \t]*,[ \t]*(\r?\n)?/);
	if (matchAfterComma) {
		const previousNewline = source.lastIndexOf("\n", entryStart - 1);
		const leadingText = source.slice(previousNewline + 1, entryStart);
		const deleteStart =
			previousNewline !== -1 && /^[ \t]*$/.test(leadingText) ? previousNewline + 1 : entryStart;
		return source.slice(0, deleteStart) + source.slice(entryEnd + matchAfterComma[0].length);
	}

	if (entryIndex > 0 && previousNode) {
		const relativeCommaIndex = source.slice(previousNode.getEnd(), entryStart).indexOf(",");
		let deleteStart = entryStart;
		if (relativeCommaIndex !== -1) {
			deleteStart = previousNode.getEnd() + relativeCommaIndex;
		}
		return source.slice(0, deleteStart) + source.slice(entryEnd);
	}

	const previousNewline = source.lastIndexOf("\n", entryStart - 1);
	const leadingText = source.slice(previousNewline + 1, entryStart);
	const deleteStart =
		previousNewline !== -1 && /^[ \t]*$/.test(leadingText) ? previousNewline + 1 : entryStart;
	const matchTrailingNewline = source.slice(entryEnd).match(/^[ \t]*\r?\n/);
	const deleteEnd = entryEnd + (matchTrailingNewline ? matchTrailingNewline[0].length : 0);
	return source.slice(0, deleteStart) + source.slice(deleteEnd);
};

export const removePropertyFromSource = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	targetObject: ts.ObjectLiteralExpression,
	propertyName: string,
): string => {
	if (!targetObject?.properties) return source;
	const propertyIndex = targetObject.properties.findIndex(
		(property) =>
			ts.isPropertyAssignment(property) &&
			("text" in property.name
				? (property.name as { text: string }).text
				: (property.name as { escapedText?: string }).escapedText) === propertyName,
	);
	if (propertyIndex === -1) return source;

	const property = targetObject.properties[propertyIndex];
	const previousProperty =
		propertyIndex > 0 ? targetObject.properties[propertyIndex - 1] : undefined;
	return removeEntrySpanFromSource(source, sourceFile, property, propertyIndex, previousProperty);
};

const insertEntryIntoContainer = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	containerNode: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
	itemNodes: readonly ts.Node[] | undefined,
	openChar: "{" | "[",
	closeChar: "}" | "]",
	entryFormatted: string,
	level: number,
): string => {
	const eol = detectEol(source);
	const indent = detectIndent(source);
	const entryIndent = indent.repeat(level);

	if (!itemNodes || itemNodes.length === 0) {
		const startPosition = containerNode.getStart(sourceFile);
		const endPosition = containerNode.getEnd();
		const closePosition = endPosition - 1;
		const insideContent = source.slice(startPosition + 1, closePosition);

		if (insideContent.trim().length === 0) {
			const formatted = `${openChar}${eol}${entryIndent}${entryFormatted}${eol}${indent.repeat(Math.max(0, level - 1))}${closeChar}`;
			return `${source.slice(0, startPosition)}${formatted}${source.slice(endPosition)}`;
		}

		const needsLeadingNewline = !insideContent.endsWith("\n");
		const formatted = `${needsLeadingNewline ? eol : ""}${entryIndent}${entryFormatted}${eol}${indent.repeat(Math.max(0, level - 1))}`;
		return `${source.slice(0, closePosition)}${formatted}${source.slice(closePosition)}`;
	}

	const lastItem = itemNodes[itemNodes.length - 1];
	const closePosition = containerNode.getEnd() - 1;
	const betweenText = source.slice(lastItem.getEnd(), closePosition);

	if (betweenText.includes(",")) {
		const relativeCommaIndex = betweenText.indexOf(",");
		const insertPosition = lastItem.getEnd() + relativeCommaIndex + 1;
		const afterCommaText = source.slice(insertPosition, closePosition);
		if (afterCommaText.startsWith(eol) || afterCommaText.startsWith("\n")) {
			const newlineLength = afterCommaText.startsWith("\r\n") ? 2 : 1;
			const formatted = `${entryIndent}${entryFormatted},${eol}`;
			return (
				source.slice(0, insertPosition + newlineLength) +
				formatted +
				source.slice(insertPosition + newlineLength)
			);
		}
		const formatted = `${eol}${entryIndent}${entryFormatted}`;
		return source.slice(0, insertPosition) + formatted + source.slice(insertPosition);
	}

	const formatted = `,${eol}${entryIndent}${entryFormatted}`;
	return source.slice(0, lastItem.getEnd()) + formatted + source.slice(lastItem.getEnd());
};

export const insertPropertyIntoSource = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	targetObject: ts.ObjectLiteralExpression,
	propertyName: string,
	propertyValueFormatted: string,
	level: number,
): string => {
	const entryFormatted = `${JSON.stringify(propertyName)}: ${propertyValueFormatted}`;
	return insertEntryIntoContainer(
		source,
		sourceFile,
		targetObject,
		targetObject.properties,
		"{",
		"}",
		entryFormatted,
		level,
	);
};

// Comments are trivia to the JSON parser: they never appear as elements or
// properties, so an "empty" array/object node can still hold source text a
// user wrote on purpose. Scan the interior span (between the brackets) for
// comment markers before treating a container as safe to delete outright.
export const hasCommentTrivia = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	containerNode: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
): boolean => {
	const interiorStart = containerNode.getStart(sourceFile) + 1;
	const interiorEnd = containerNode.getEnd() - 1;
	if (interiorEnd <= interiorStart) return false;
	return /\/\/|\/\*/.test(source.slice(interiorStart, interiorEnd));
};

export const removeArrayElementFromSource = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	arrayNode: ts.ArrayLiteralExpression,
	elementIndex: number,
): string => {
	if (!arrayNode?.elements || elementIndex < 0 || elementIndex >= arrayNode.elements.length) {
		return source;
	}
	const element = arrayNode.elements[elementIndex];
	const previousElement = elementIndex > 0 ? arrayNode.elements[elementIndex - 1] : undefined;
	return removeEntrySpanFromSource(source, sourceFile, element, elementIndex, previousElement);
};

export const insertArrayElementIntoSource = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	arrayNode: ts.ArrayLiteralExpression,
	elementFormatted: string,
	level: number,
): string => {
	return insertEntryIntoContainer(
		source,
		sourceFile,
		arrayNode,
		arrayNode.elements,
		"[",
		"]",
		elementFormatted,
		level,
	);
};
