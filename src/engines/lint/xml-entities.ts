// Decodes the handful of XML entities that appear in roslynator/jb report text.
// Both parsers avoid a full XML dependency, so this stays a single-pass string replace
// that decodes named, decimal, and hexadecimal entities without reprocessing replacement text.
const NAMED_ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	amp: "&",
};

export const decodeEntities = (value: string): string =>
	value.replace(
		/&(?:(lt|gt|quot|apos|amp)|#([0-9]+)|#[xX]([0-9a-fA-F]+));/gi,
		(match, named, decimal, hex) => {
			if (named) {
				return NAMED_ENTITIES[named.toLowerCase()] ?? match;
			}
			const code = decimal ? Number(decimal) : parseInt(hex, 16);
			if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return match;
		},
	);

// Reads one `name="value"` or `name='value'` attribute out of a single XML tag string,
// accepting whitespace around the equals sign. Shared by the regex-based (no XML
// dependency) parsers for cppcheck, jb, roslynator, and solution output; returns
// null when the attribute is absent.
export const xmlAttribute = (tag: string, name: string): string | null => {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
	return match ? (match[1] ?? match[2] ?? "") : null;
};
