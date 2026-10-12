import { consumeQuotedString } from "./string-literals.js";

const consumePythonTripleString = (content: string, start: number, quote: string): number => {
	const triple = quote + quote + quote;
	let searchFrom = start + 3;
	const len = content.length;
	while (searchFrom < len) {
		const pos = content.indexOf(triple, searchFrom);
		if (pos === -1) return len;
		let backslashes = 0;
		let b = pos - 1;
		while (b >= start + 3 && content[b] === "\\") {
			backslashes++;
			b--;
		}
		if (backslashes % 2 === 0) {
			return pos + 3;
		}
		searchFrom = pos + 1;
	}
	return len;
};

export const maskSimple = (
	content: string,
	family: "py" | "rb" | "php",
	maskStrings: boolean,
): string => {
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
			if (content[i + 1] === c && content[i + 2] === c) {
				const stop = consumePythonTripleString(content, i, c);
				if (maskStrings) mask(i + 3, stop === len ? len : stop - 3);
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
