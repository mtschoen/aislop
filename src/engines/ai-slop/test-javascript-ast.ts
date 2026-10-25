import ts from "typescript";

const lineStartsByFile = new WeakMap<ts.SourceFile, readonly number[]>();

const lineStarts = (sourceFile: ts.SourceFile): readonly number[] => {
	const cached = lineStartsByFile.get(sourceFile);
	if (cached) return cached;
	const starts = [0];
	let newline = sourceFile.text.indexOf("\n");
	while (newline !== -1) {
		starts.push(newline + 1);
		newline = sourceFile.text.indexOf("\n", newline + 1);
	}
	lineStartsByFile.set(sourceFile, starts);
	return starts;
};

// Suppression lines advance only at LF, not at every TypeScript line terminator.
// Keep zero-based coordinates here; diagnostics convert both fields to one-based.
export const suppressionPosition = (
	sourceFile: ts.SourceFile,
	offset: number,
): { line: number; character: number } => {
	const starts = lineStarts(sourceFile);
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return { line: low, character: offset - starts[low] };
};

// The test detectors parse original source so literal contents and JSX nodes
// remain available without any text-based reconstruction.
export const parseJavaScriptTest = (
	filePath: string,
	source: string,
	extension: string,
): ts.SourceFile => {
	const scriptKind =
		extension === ".tsx"
			? ts.ScriptKind.TSX
			: extension === ".jsx"
				? ts.ScriptKind.JSX
				: [".js", ".mjs", ".cjs"].includes(extension)
					? ts.ScriptKind.JS
					: ts.ScriptKind.TS;
	return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
};
