// pip-audit documents `-r FILE` as security-equivalent to `pip install -r FILE`
// (https://pypi.org/project/pip-audit/#security-model): its default resolver builds local
// and sdist requirements, which runs repository-controlled build code. Its `--disable-pip`
// mode never invokes pip, and pip-audit refuses it unless `--no-deps` is also given
// (RequirementSource._collect_from_files, checked against pip-audit 2.10.1). That mode only
// understands exact `name==version` pins, so any other line makes the file unauditable here.

// Options that cannot change what is installed or fetched when pip is disabled.
const HARMLESS_OPTIONS = new Set([
	"--index-url",
	"-i",
	"--extra-index-url",
	"--trusted-host",
	"--no-index",
	"--pre",
	"--only-binary",
	"--no-binary",
	"--prefer-binary",
	"--require-hashes",
]);

const PINNED_REQUIREMENT =
	/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,\s-]*\])?\s*==\s*[A-Za-z0-9.!+_-]+\s*(;[^@]*)?((\s+--hash[=\s]\S+)*)$/;

// Joins backslash continuations (hash options usually sit on them) and strips comments.
const logicalLines = (text: string): string[] =>
	text
		.replace(/\\\r?\n/g, " ")
		.split(/\r?\n/)
		.map((line) => line.replace(/(^|\s)#.*$/, "").trim())
		.filter(Boolean);

const optionName = (line: string): string => line.split(/[\s=]/, 1)[0];

// Returns the first line pip-audit cannot audit without running pip, or undefined when
// every line is an exact pin (an empty file has nothing to resolve).
export const findUnauditableRequirement = (text: string): string | undefined =>
	logicalLines(text).find((line) =>
		line.startsWith("-") ? !HARMLESS_OPTIONS.has(optionName(line)) : !PINNED_REQUIREMENT.test(line),
	);
