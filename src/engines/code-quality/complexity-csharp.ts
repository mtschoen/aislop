import { CPP_SOURCE_EXTENSIONS } from "../cpp-targets.js";

// C# function boundaries come from the syntax tree (complexity-csharp-ast.ts), not
// from line patterns; only the file-size remediation text lives here.
// C# has a language-native remediation: partial classes split a type across
// files with no API or linkage cost, so point C# users at it directly.
export const CSHARP_FILE_TOO_LARGE_HELP =
	"Consider splitting this file into partial class files or smaller modules";

// Extensions whose function signatures may wrap across multiple physical lines
// and so need logical-signature joining before the patterns are applied. Scoped
// to C/C++ so Java/PHP detection stays byte-identical to the single-line path.
export const MULTILINE_SIGNATURE_EXTS = new Set(CPP_SOURCE_EXTENSIONS);

// A brace-language signature can span lines (wrapped parameter lists). When the
// line at `startIndex` opens more parens than it closes, join following lines
// (up to a small cap, stopping at a statement `;`) so the single-line
// FUNCTION_PATTERNS can see the whole `name(...)` on one logical line. Newlines
// become spaces; the reported start line stays `startIndex`.
export const logicalSignatureLine = (lines: string[], startIndex: number): string => {
	const first = lines[startIndex];
	let depth = 0;
	let sawOpen = false;
	for (const ch of first) {
		if (ch === "(") {
			depth++;
			sawOpen = true;
		} else if (ch === ")") depth--;
	}
	if (!sawOpen || depth <= 0) return first;

	let joined = first;
	for (let j = startIndex + 1; j < lines.length && j < startIndex + 12; j++) {
		const line = lines[j];
		joined += ` ${line}`;
		for (const ch of line) {
			if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		if (depth <= 0) break;
		if (line.includes(";")) break;
	}
	return joined;
};
