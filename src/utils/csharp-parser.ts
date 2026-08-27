import fs from "node:fs";
import type { Node } from "web-tree-sitter";
import { resolveBundledCsharpGrammar } from "./tooling.js";

type ParseFunction = (source: string) => Node | null;

const buildParser = async (): Promise<ParseFunction | null> => {
	const grammarPath = resolveBundledCsharpGrammar();
	if (grammarPath === null) return null;

	const { Language, Parser } = await import("web-tree-sitter");
	await Parser.init();
	const language = await Language.load(fs.readFileSync(grammarPath));
	const parser = new Parser();
	parser.setLanguage(language);
	return (source: string) => parser.parse(source)?.rootNode ?? null;
};

// Null when the bundled grammar is missing or will not load on this host, which
// turns every C# detection into the documented non-detection rather than failing
// the whole scan over one optional asset.
const loadParser = async (): Promise<ParseFunction | null> => {
	try {
		return await buildParser();
	} catch {
		return null;
	}
};

let parserPromise: Promise<ParseFunction | null> | null = null;

/**
 * Parse C# source into a tree-sitter syntax tree, or return null when the bundled
 * grammar is unavailable. The grammar is loaded once per process and only on the
 * first call, so scans of projects without C# tests never pay for it.
 */
export const parseCsharp = async (source: string): Promise<Node | null> => {
	parserPromise ??= loadParser();
	const parse = await parserPromise;
	return parse === null ? null : parse(source);
};
