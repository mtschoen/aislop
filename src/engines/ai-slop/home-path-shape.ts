/**
 * Fork-only: the fixed home-path shapes behind `ai-slop/hardcoded-user-path`.
 *
 * The question this answers has a closed surface: does a token spell
 * `/home/<name>/`, `/Users/<name>/` or `<drive>:\Users\<name>\` (either
 * separator), or one of those behind a `file:` scheme, with `<name>` not on the
 * placeholder list or the configured `allowedPlaceholders`? Nothing is read from the
 * environment: the verdict depends on the scanned text and the configuration
 * only. Paths of other shapes are deliberate non-detections (docs/rules.md).
 */

/** Decides whether a lower-cased home name segment is exempt. */
export type HomeNameExemption = (lowered: string) => boolean;

/** Same boundary rules the rule's banned-root matcher uses for a path token. */
const PATH_TOKEN_BOUNDARY_CHARACTERS = new Set(['"', "'", "`", "(", ")", "[", ",", ";", "=", ":"]);
const WHITESPACE_CHARACTER = /\s/;
const TOKEN_START = String.raw`(?<![^\s"'\`()[\],;=:])`;
const TOKEN_END = String.raw`(?=$|[\s"'\`()\]},;:])`;
const TOKEN_REMAINDER = String.raw`[^\s"'\`<>]*`;
const DESCENDANT_REMAINDER = String.raw`[^\s"'\`<>()\]},;:]*`;
const POSIX_DESCENDANT = String.raw`(?:\/${DESCENDANT_REMAINDER})?`;
const WINDOWS_DESCENDANT = String.raw`(?:[\\/]${DESCENDANT_REMAINDER})?`;
const WEB_URL = String.raw`[Hh][Tt][Tt][Pp][Ss]?:\/\/${TOKEN_REMAINDER}`;
const FILE_SCHEME = "[Ff][Ii][Ll][Ee]:";
const FILE_URL = String.raw`${FILE_SCHEME}${TOKEN_REMAINDER}`;
const LOCALHOST = "[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]";
// A name starts with a word character and has no template, glob or bracket
// characters, so `$USER`, `%USERNAME%`, `*`, `<name>` and `{user}` never match.
const NAME = String.raw`[A-Za-z0-9_][^\s"'\`<>\\/()[\]{},;:$%*?|@]*`;
const POSIX_FILE_ROOT = String.raw`(?:\/{3}|\/|\/\/${LOCALHOST}\/)`;
const WINDOWS_FILE_ROOT = String.raw`(?:\/{1,3}|\/\/${LOCALHOST}\/)`;
const USERS = "[Uu][Ss][Ee][Rr][Ss]";
const WINDOWS_ROOT = String.raw`[A-Za-z]:[\\/]+${USERS}[\\/]+`;

const SHAPE_EXPRESSION = new RegExp(
	[
		WEB_URL,
		// file: forms: file:/x, file:///x and file://localhost/x, plus file://C:/x for drive
		// roots. Any other authority (file://host/x) is not a local path and is consumed
		// opaquely by FILE_URL below.
		String.raw`(?<filePath>${TOKEN_START}${FILE_SCHEME}(?:${POSIX_FILE_ROOT}(?:home|Users)\/+(?<fileName>${NAME})${POSIX_DESCENDANT}|${WINDOWS_FILE_ROOT}${WINDOWS_ROOT}(?<fileWindowsName>${NAME})${WINDOWS_DESCENDANT})${TOKEN_END})`,
		FILE_URL,
		String.raw`(?<windowsPath>${TOKEN_START}${WINDOWS_ROOT}(?<windowsName>${NAME})${WINDOWS_DESCENDANT}${TOKEN_END})`,
		String.raw`(?<posixPath>${TOKEN_START}\/(?:home|Users)\/+(?<posixName>${NAME})${POSIX_DESCENDANT}${TOKEN_END})`,
	].join("|"),
	"g",
);

export interface HomePathSpan {
	start: number;
	end: number;
}

const isPathTokenBoundaryCharacter = (character: string | undefined): boolean =>
	character === undefined ||
	WHITESPACE_CHARACTER.test(character) ||
	PATH_TOKEN_BOUNDARY_CHARACTERS.has(character);

const hasWindowsDrivePrefix = (line: string, matchIndex: number): boolean => {
	const driveLetterIndex = matchIndex - 2;
	const driveLetter = line[driveLetterIndex]?.toLowerCase();
	return (
		line[matchIndex - 1] === ":" &&
		driveLetter !== undefined &&
		driveLetter >= "a" &&
		driveLetter <= "z" &&
		isPathTokenBoundaryCharacter(line[driveLetterIndex - 1])
	);
};

/**
 * Combines the caller's blessed-name predicate (the placeholder list owned by
 * `hardcoded-user-path.ts`) and the configured `allowedPlaceholders`
 * (case-insensitive) into one predicate.
 */
export const buildExemptNameSet = (
	isBlessedName: HomeNameExemption,
	allowedPlaceholders: readonly string[] | undefined,
): HomeNameExemption => {
	const allowed = new Set((allowedPlaceholders ?? []).map((name) => name.toLowerCase()));
	return (lowered) => isBlessedName(lowered) || allowed.has(lowered);
};

/** Spans of home paths on one line whose user name is not exempt. */
export const collectHomeShapeSpans = (
	line: string,
	isExempt: HomeNameExemption,
): HomePathSpan[] => {
	const spans: HomePathSpan[] = [];
	for (const match of line.matchAll(SHAPE_EXPRESSION)) {
		const groups = match.groups as Record<string, string | undefined>;
		const index = match.index as number;
		if (groups.posixName !== undefined && hasWindowsDrivePrefix(line, index)) continue;
		const name =
			groups.windowsName ?? groups.fileName ?? groups.fileWindowsName ?? groups.posixName;
		if (name === undefined || isExempt(name.toLowerCase())) continue;
		spans.push({ start: index, end: index + match[0].length });
	}
	return spans;
};
