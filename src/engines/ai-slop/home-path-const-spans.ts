import path from "node:path";
import ts from "typescript";
import type { AllowedPathSpan } from "./home-path-location-policy.js";

const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
	[".ts", ts.ScriptKind.TS],
	[".tsx", ts.ScriptKind.TSX],
	[".js", ts.ScriptKind.JS],
	[".jsx", ts.ScriptKind.JSX],
	[".mjs", ts.ScriptKind.JS],
	[".cjs", ts.ScriptKind.JS],
	[".mts", ts.ScriptKind.TS],
	[".cts", ts.ScriptKind.TS],
]);

const COMMONJS_OBJECT_METHODS = new Set(["defineProperty", "defineProperties", "assign"]);

const makeProgram = (sourceFile: ts.SourceFile): ts.Program => {
	const host: ts.CompilerHost = {
		getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : undefined),
		getDefaultLibFileName: () => "",
		writeFile: () => undefined,
		getCurrentDirectory: () => "/",
		getDirectories: () => [],
		fileExists: (name) => name === sourceFile.fileName,
		readFile: (name) => (name === sourceFile.fileName ? sourceFile.text : undefined),
		getCanonicalFileName: (name) => name,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
	};
	return ts.createProgram(
		[sourceFile.fileName],
		{
			noLib: true,
			noResolve: true,
			allowJs: true,
			checkJs: false,
			target: ts.ScriptTarget.Latest,
			module: ts.ModuleKind.ESNext,
		},
		host,
	);
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
};

const isLexicalBindingDeclaration = (declaration: ts.Declaration): boolean => {
	if (ts.isTypeOnlyImportOrExportDeclaration(declaration)) return false;
	if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0) return false;
	return (
		ts.isVariableDeclaration(declaration) ||
		ts.isParameter(declaration) ||
		ts.isBindingElement(declaration) ||
		ts.isFunctionDeclaration(declaration) ||
		ts.isFunctionExpression(declaration) ||
		ts.isClassDeclaration(declaration) ||
		ts.isClassExpression(declaration) ||
		ts.isEnumDeclaration(declaration) ||
		ts.isModuleDeclaration(declaration) ||
		ts.isImportClause(declaration) ||
		ts.isImportSpecifier(declaration) ||
		ts.isNamespaceImport(declaration) ||
		ts.isImportEqualsDeclaration(declaration)
	);
};

const isLocallyBoundIdentifier = (identifier: ts.Identifier, checker: ts.TypeChecker): boolean => {
	const symbol = checker.resolveName(
		identifier.text,
		identifier,
		ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
		false,
	);
	return symbol?.declarations?.some(isLexicalBindingDeclaration) ?? false;
};

const getStaticMemberName = (
	expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined => {
	if (ts.isPropertyAccessExpression(expression)) {
		return ts.isIdentifier(expression.name) ? expression.name.text : undefined;
	}
	const argument = unwrapExpression(expression.argumentExpression);
	return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
		? argument.text
		: undefined;
};

const isUnboundExportsIdentifier = (
	expression: ts.Expression,
	checker: ts.TypeChecker,
): boolean => {
	const target = unwrapExpression(expression);
	return (
		ts.isIdentifier(target) &&
		target.text === "exports" &&
		!isLocallyBoundIdentifier(target, checker)
	);
};

const isUnboundModuleExportsAccess = (
	expression: ts.Expression,
	checker: ts.TypeChecker,
): boolean => {
	const target = unwrapExpression(expression);
	if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
		return false;
	}
	if (getStaticMemberName(target) !== "exports") return false;
	const receiver = unwrapExpression(target.expression);
	return (
		ts.isIdentifier(receiver) &&
		receiver.text === "module" &&
		!isLocallyBoundIdentifier(receiver, checker)
	);
};

const isCommonJsExportTarget = (expression: ts.Expression, checker: ts.TypeChecker): boolean => {
	const target = unwrapExpression(expression);
	if (isUnboundModuleExportsAccess(target, checker)) return true;
	if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
		return false;
	}
	let current = unwrapExpression(target.expression);
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		if (isUnboundModuleExportsAccess(current, checker)) return true;
		current = unwrapExpression(current.expression);
	}
	return isUnboundExportsIdentifier(current, checker);
};

const isCommonJsExportCall = (call: ts.CallExpression, checker: ts.TypeChecker): boolean => {
	if (call.arguments.length < 2) return false;
	const callee = unwrapExpression(call.expression);
	if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
		return false;
	}
	const method = getStaticMemberName(callee);
	if (!method || !COMMONJS_OBJECT_METHODS.has(method)) return false;
	const receiver = unwrapExpression(callee.expression);
	if (
		!ts.isIdentifier(receiver) ||
		receiver.text !== "Object" ||
		isLocallyBoundIdentifier(receiver, checker)
	) {
		return false;
	}
	const firstArgument = call.arguments[0];
	return (
		!ts.isSpreadElement(firstArgument) &&
		(isUnboundExportsIdentifier(firstArgument, checker) ||
			isUnboundModuleExportsAccess(firstArgument, checker))
	);
};

const hasCommonJsExport = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): boolean => {
	const stack: ts.Node[] = [sourceFile];
	while (stack.length > 0) {
		const node = stack.pop() as ts.Node;
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
			isCommonJsExportTarget(node.left, checker)
		) {
			return true;
		}
		if (ts.isCallExpression(node) && isCommonJsExportCall(node, checker)) {
			return true;
		}
		ts.forEachChild(node, (child) => {
			stack.push(child);
		});
	}
	return false;
};

const localExportSymbols = (sourceFile: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> => {
	const symbols = new Set<ts.Symbol>();
	for (const statement of sourceFile.statements) {
		if (
			ts.isExportDeclaration(statement) &&
			!statement.moduleSpecifier &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) {
				const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
				if (symbol) symbols.add(symbol);
			}
		}
		if (ts.isExportAssignment(statement)) {
			const expression = unwrapExpression(statement.expression);
			if (ts.isIdentifier(expression)) {
				const symbol = checker.getSymbolAtLocation(expression);
				if (symbol) symbols.add(symbol);
			}
		}
	}
	return symbols;
};

interface CandidateConstDeclaration {
	readonly name: ts.Identifier;
	readonly initializer: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
}

const collectCandidateConstDeclarations = (
	sourceFile: ts.SourceFile,
): CandidateConstDeclaration[] => {
	const candidates: CandidateConstDeclaration[] = [];
	for (const statement of sourceFile.statements) {
		if (
			!ts.isVariableStatement(statement) ||
			!(statement.declarationList.flags & ts.NodeFlags.Const) ||
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			const initializer = declaration.initializer;
			if (
				ts.isIdentifier(declaration.name) &&
				initializer !== undefined &&
				(ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
			) {
				candidates.push({ name: declaration.name, initializer });
			}
		}
	}
	return candidates;
};

export const collectAllowedHomePathConstSpans = (
	filePath: string,
	content: string,
): AllowedPathSpan[] => {
	const extension = path.extname(filePath).toLowerCase();
	const scriptKind = SCRIPT_KINDS.get(extension);
	if (scriptKind === undefined) return [];
	const sourceFile = ts.createSourceFile(
		`/source${extension}`,
		content,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const candidates = collectCandidateConstDeclarations(sourceFile);
	if (candidates.length === 0) return [];
	const program = makeProgram(sourceFile);
	if (program.getSyntacticDiagnostics(sourceFile).length > 0) return [];
	const checker = program.getTypeChecker();
	if (hasCommonJsExport(sourceFile, checker)) return [];
	const exported = localExportSymbols(sourceFile, checker);
	const spans: AllowedPathSpan[] = [];
	for (const { name, initializer } of candidates) {
		const symbol = checker.getSymbolAtLocation(name);
		if (!symbol || exported.has(symbol)) continue;
		spans.push({ start: initializer.getStart(sourceFile) + 1, end: initializer.end - 1 });
	}
	return spans;
};
