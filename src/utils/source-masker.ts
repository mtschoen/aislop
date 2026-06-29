type LangFamily = "js" | "py" | "rb" | "php" | "none";

const JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py"]);
const RB_EXTS = new Set([".rb"]);
const PHP_EXTS = new Set([".php"]);

const familyForExt = (ext: string): LangFamily => {
	if (JS_EXTS.has(ext)) return "js";
	if (PY_EXTS.has(ext)) return "py";
	if (RB_EXTS.has(ext)) return "rb";
	if (PHP_EXTS.has(ext)) return "php";
	return "none";
};

export const maskStringsAndComments = (content: string, ext: string): string => {
	const family = familyForExt(ext);
	if (family === "none") return content;
	if (family === "js") return maskJs(content, true);
	return maskSimple(content, family, true);
};

// Mask comment bodies only; string and template contents stay readable.
export const maskComments = (content: string, ext: string): string => {
	const family = familyForExt(ext);
	if (family === "none") return content;
	if (family === "js") return maskJs(content, false);
	return maskSimple(content, family, false);
};

interface MaskHandler {
	handled: boolean;
	nextI: number;
}

const WORD_CHAR_RE = /[A-Za-z0-9_$]/;
// A `/` opens a regex literal (not division) when it follows one of these operators
// or openers ...
const REGEX_PRECEDER_CHARS = new Set([
	"(",
	"{",
	"}",
	"[",
	",",
	";",
	":",
	"?",
	"=",
	"!",
	"&",
	"|",
	"^",
	"~",
	"<",
	">",
	"+",
	"-",
	"*",
	"%",
]);
// ... or one of these keywords (`return /re/`, `typeof /re/`, ...).
const REGEX_PRECEDER_WORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"yield",
	"case",
	"do",
	"else",
	"await",
]);

// Decide whether a `/` starts a regex literal (vs a division operator) from the
// preceding significant token: regex after an operator/opener/keyword, division
// after a value (identifier, number, `)`, `]`, string, regex).
const regexAllowedAfter = (lastSig: string, lastWord: string): boolean => {
	if (lastSig === "") return true;
	if (WORD_CHAR_RE.test(lastSig)) return REGEX_PRECEDER_WORDS.has(lastWord);
	return REGEX_PRECEDER_CHARS.has(lastSig);
};

// Consume a regex literal from its opening `/`. Returns the index just past the
// closing `/`, or -1 if it isn't a single-line regex (hits a newline first), in
// which case the `/` was division after all. Handles `\` escapes and `[...]`
// character classes (where `/` is literal).
const consumeRegexLiteral = (content: string, start: number): number => {
	const len = content.length;
	let i = start + 1;
	let inClass = false;
	while (i < len) {
		const c = content[i];
		if (c === "\n") return -1;
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return i + 1;
		i++;
	}
	return -1;
};

const handleQuotesAndComments = (
	content: string,
	i: number,
	tplStack: number[],
	mask: (start: number, end: number) => void,
	maskStrings: boolean,
	lastSig: string,
	lastWord: string,
): MaskHandler => {
	const len = content.length;
	const c = content[i];
	const next = content[i + 1];
	if (c === '"' || c === "'") {
		const strStart = i;
		const end = consumeQuotedString(content, i, c);
		if (maskStrings) mask(strStart + 1, end - 1);
		return { handled: true, nextI: end };
	}
	if (c === "`") {
		const scan = consumeTemplateString(content, i + 1);
		if (maskStrings) mask(i + 1, scan.maskEnd);
		if (scan.openedInterp) tplStack.push(0);
		return { handled: true, nextI: scan.resumeAt };
	}
	if (c === "/" && next === "/") {
		const strStart = i;
		let k = i;
		while (k < len && content[k] !== "\n") k++;
		mask(strStart, k);
		return { handled: true, nextI: k };
	}
	if (c === "/" && next === "*") {
		const strStart = i;
		let k = i + 2;
		while (k < len - 1 && !(content[k] === "*" && content[k + 1] === "/")) k++;
		if (k < len - 1) k += 2;
		mask(strStart, k);
		return { handled: true, nextI: k };
	}
	// Regex literal: recognised so its contents (which routinely include quotes,
	// backticks and comment markers — e.g. /(?:`|["'])/) don't desync the scanner.
	if (c === "/" && regexAllowedAfter(lastSig, lastWord)) {
		const end = consumeRegexLiteral(content, i);
		if (end !== -1) {
			if (maskStrings) mask(i + 1, end - 1);
			return { handled: true, nextI: end };
		}
	}
	return { handled: false, nextI: i };
};

const maskJs = (content: string, maskStrings: boolean): string => {
	const out = content.split("");
	const len = content.length;
	const tplStack: number[] = [];
	let i = 0;
	// Last significant (non-whitespace) code char and the identifier ending at it;
	// used to disambiguate regex literals from division.
	let lastSig = "";
	let lastWord = "";

	const mask = (start: number, end: number) => {
		for (let k = start; k < end; k++) {
			if (out[k] !== "\n") out[k] = " ";
		}
	};

	while (i < len) {
		const c = content[i];

		if (tplStack.length > 0) {
			if (c === "{") {
				tplStack[tplStack.length - 1]++;
				lastSig = "{";
				lastWord = "";
				i++;
				continue;
			}
			if (c === "}") {
				const depth = tplStack[tplStack.length - 1];
				if (depth === 0) {
					tplStack.pop();
					const scan = consumeTemplateString(content, i + 1);
					if (maskStrings) mask(i + 1, scan.maskEnd);
					if (scan.openedInterp) tplStack.push(0);
					lastSig = "`";
					lastWord = "";
					i = scan.resumeAt;
					continue;
				}
				tplStack[tplStack.length - 1]--;
				lastSig = "}";
				lastWord = "";
				i++;
				continue;
			}
		}

		const handled = handleQuotesAndComments(
			content,
			i,
			tplStack,
			mask,
			maskStrings,
			lastSig,
			lastWord,
		);
		if (handled.handled) {
			// A comment is whitespace-like (leave lastSig alone); a string/template/regex
			// is a value, so a following `/` reads as division.
			const isComment = c === "/" && (content[i + 1] === "/" || content[i + 1] === "*");
			if (!isComment) {
				lastSig = c === "`" ? "`" : c === "/" ? "/" : '"';
				lastWord = "";
			}
			i = handled.nextI;
			continue;
		}

		if (!/\s/.test(c)) {
			lastSig = c;
			lastWord = WORD_CHAR_RE.test(c) ? lastWord + c : "";
		}
		i++;
	}

	return out.join("");
};

// Consume a quoted string starting at the opening quote. Returns the index
// just past the closing quote (or end-of-content if unterminated).
const consumeQuotedString = (content: string, start: number, quote: string): number => {
	const len = content.length;
	let i = start + 1;
	while (i < len) {
		const c = content[i];
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === quote) return i + 1;
		if (c === "\n") return i; // unterminated — bail
		i++;
	}
	return i;
};

interface TemplateScan {
	maskEnd: number;
	resumeAt: number;
	openedInterp: boolean;
}

const consumeTemplateString = (content: string, start: number): TemplateScan => {
	const len = content.length;
	let i = start;
	while (i < len) {
		const c = content[i];
		if (c === "\\" && i + 1 < len) {
			i += 2;
			continue;
		}
		if (c === "`") return { maskEnd: i, resumeAt: i + 1, openedInterp: false };
		if (c === "$" && content[i + 1] === "{") {
			return { maskEnd: i, resumeAt: i + 2, openedInterp: true };
		}
		i++;
	}
	return { maskEnd: i, resumeAt: i, openedInterp: false };
};

const maskSimple = (content: string, family: LangFamily, maskStrings: boolean): string => {
	const out = content.split("");
	const len = content.length;
	let i = 0;

	const mask = (start: number, end: number) => {
		for (let k = start; k < end; k++) {
			if (out[k] !== "\n") out[k] = " ";
		}
	};

	while (i < len) {
		const c = content[i];
		const next = content[i + 1];

		if (family === "py" && (c === '"' || c === "'")) {
			// Triple-quoted?
			if (content[i + 1] === c && content[i + 2] === c) {
				const triple = c + c + c;
				const end = content.indexOf(triple, i + 3);
				const stop = end === -1 ? len : end + 3;
				if (maskStrings) mask(i + 3, stop - 3);
				i = stop;
				continue;
			}
		}

		if (c === '"' || c === "'") {
			const strStart = i;
			i = consumeQuotedString(content, i, c);
			if (maskStrings) mask(strStart + 1, i - 1);
			continue;
		}

		if ((family === "py" || family === "rb" || family === "php") && c === "#") {
			const strStart = i;
			while (i < len && content[i] !== "\n") i++;
			mask(strStart, i);
			continue;
		}

		if (family === "php" && c === "/" && next === "/") {
			const strStart = i;
			while (i < len && content[i] !== "\n") i++;
			mask(strStart, i);
			continue;
		}

		if (family === "php" && c === "/" && next === "*") {
			const strStart = i;
			i += 2;
			while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
			if (i < len - 1) i += 2;
			mask(strStart, i);
			continue;
		}

		i++;
	}

	return out.join("");
};
