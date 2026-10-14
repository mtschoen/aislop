import { detectInvocation } from "../../ui/invocation.js";
import { runSubprocess } from "../../utils/subprocess.js";
import type { Diagnostic } from "../types.js";
import { type AuditOutcome, skippedAuditDiagnostic, toDependencyAdvisory } from "./audit-shared.js";
import { isRecord, readRecordArray, readString } from "./audit-value.js";

// `govulncheck -json` prints a stream of JSON values, each an object with exactly one
// of `config`, `progress`, `osv`, `finding` or `SBOM`, pretty-printed over many lines
// (https://pkg.go.dev/golang.org/x/vuln/internal/govulncheck, "Message"). Braces are
// kept at module scope so no literal sits inside a function body where a brace-depth
// scanner that does not mask strings would miscount it.
const OBJECT_OPEN = "{";
const OBJECT_CLOSE = "}";
const STRING_QUOTE = '"';
const ESCAPE = "\\";

interface DecodedStream {
	messages: unknown[];
	// True when anything other than whitespace, a leading preamble or a well-formed
	// message was seen: stray text after the first message, an unterminated object, or
	// a balanced object that is not JSON.
	corrupt: boolean;
}

// Decodes the stream line by line. A line starting with a brace opens an object and
// scanning continues until its braces balance. Text before the first object (for
// example "go: downloading ..." from the toolchain) is a tolerated preamble. When
// an object finishes at its balancing closing brace, decoding continues on any
// remaining line content; trailing non-whitespace residue marks the run corrupt.
// Govulncheck indents the inside of an object, so an unindented brace while an object
// is open means that object was cut off: it is dropped and decoding resumes at the new
// object.
const decodeStream = (stream: string): DecodedStream => {
	const messages: unknown[] = [];
	let corrupt = false;
	let open: string[] | null = null;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (const line of stream.split("\n")) {
		if (open !== null && line.startsWith(OBJECT_OPEN)) {
			corrupt = true;
			open = null;
		}

		let charIndex = 0;

		if (open === null) {
			const trimmed = line.trimStart();
			if (!trimmed.startsWith(OBJECT_OPEN)) {
				if (line.trim() !== "" && messages.length > 0) corrupt = true;
				continue;
			}
			charIndex = line.indexOf(OBJECT_OPEN);
		}

		while (charIndex < line.length) {
			if (open === null) {
				open = [];
				depth = 0;
				inString = false;
				escaped = false;
			}

			const objectStartOnLine = charIndex;
			let objectCompleted = false;

			while (charIndex < line.length) {
				const character = line[charIndex];
				charIndex++;

				if (inString) {
					if (escaped) escaped = false;
					else if (character === ESCAPE) escaped = true;
					else if (character === STRING_QUOTE) inString = false;
				} else if (character === STRING_QUOTE) {
					inString = true;
				} else if (character === OBJECT_OPEN) {
					depth++;
				} else if (character === OBJECT_CLOSE) {
					depth--;
					if (depth === 0) {
						objectCompleted = true;
						break;
					}
				}
			}

			if (objectCompleted) {
				open.push(line.slice(objectStartOnLine, charIndex));
				try {
					messages.push(JSON.parse(open.join("\n")));
				} catch {
					corrupt = true;
				}
				open = null;

				const remainder = line.slice(charIndex);
				const trimmed = remainder.trimStart();
				if (trimmed === "") break;
				if (trimmed.startsWith(OBJECT_OPEN)) {
					const leadingWhitespaceLength = remainder.length - trimmed.length;
					charIndex += leadingWhitespaceLength;
				} else {
					corrupt = true;
					break;
				}
			} else {
				open.push(line.slice(objectStartOnLine));
			}
		}
	}
	if (open !== null) corrupt = true;
	return { messages, corrupt };
};

interface OsvEntry {
	aliases: unknown;
	summary?: string;
}

interface CalledFinding {
	osv: string;
	moduleName?: string;
	fixedVersion?: string;
}

// A finding's trace is one frame for a module-level or package-level finding (the
// module is required, or a package of it is imported) and starts at the vulnerable
// symbol for a symbol-level finding. Only the latter means the code can reach the
// vulnerability, so a frame naming a function is what makes a finding count. This is
// what govulncheck itself treats as a vulnerability in its default output.
const toCalledFinding = (finding: Record<string, unknown>): CalledFinding | null => {
	const osv = readString(finding, "osv");
	if (!osv) return null;
	const trace = readRecordArray(finding, "trace");
	if (!trace.some((frame) => readString(frame, "function"))) return null;
	return {
		osv,
		moduleName: readString(trace[0], "module"),
		fixedVersion: readString(finding, "fixed_version"),
	};
};

const MESSAGE_FIELDS = ["config", "progress", "osv", "finding", "SBOM"];

// The protocol gives every message exactly one populated field, so an empty message, a
// null or non-object field, or two fields at once means the stream was damaged.
const isWellFormedMessage = (message: unknown): message is Record<string, unknown> => {
	if (!isRecord(message)) return false;
	const present = MESSAGE_FIELDS.filter((field) => field in message);
	if (present.length !== 1) return false;
	const payload = message[present[0]];
	if (!isRecord(payload)) return false;
	if (present[0] === "progress" && "message" in payload) {
		return typeof payload.message === "string";
	}
	if (present[0] === "SBOM" && "modules" in payload) {
		return Array.isArray(payload.modules);
	}
	return true;
};

// A finding names its advisory and carries at least one trace frame, even a module-level
// one, and every frame names its module (`Frame.Module` is always serialized).
const isWellFormedFinding = (finding: Record<string, unknown>): boolean => {
	if (!readString(finding, "osv")) return false;
	const trace = finding.trace;
	if (!Array.isArray(trace) || trace.length === 0) return false;
	return trace.every(
		(frame) =>
			isRecord(frame) &&
			!!readString(frame, "module") &&
			["function", "package"].every(
				(field) => !(field in frame) || typeof frame[field] === "string",
			),
	);
};

const describeFinding = (finding: CalledFinding, entry: OsvEntry | undefined): string => {
	const invocation = detectInvocation();
	const fixedIn =
		finding.moduleName && finding.fixedVersion
			? `upgrade ${finding.moduleName} to ${finding.fixedVersion}`
			: "";
	const detail = [entry?.summary, fixedIn].filter(Boolean).join(" - ");
	return `Run \`${invocation} fix -f\` to apply this fix${detail ? ` - ${detail}` : ""}`;
};

const toDiagnostic = (finding: CalledFinding, entry: OsvEntry | undefined): Diagnostic => ({
	filePath: "go.mod",
	engine: "security",
	rule: "security/vulnerable-dependency",
	severity: "error",
	message: `Go vulnerability: ${finding.osv}`,
	help: describeFinding(finding, entry),
	line: 0,
	column: 0,
	category: "Security",
	fixable: false,
	packageName: finding.moduleName,
	advisories: [toDependencyAdvisory([finding.osv], entry?.aliases)],
});

interface ParsedStream {
	diagnostics: Diagnostic[];
	// True when the stream decoded cleanly and its first message is a `config` with a
	// protocol version, which the protocol requires of every stream.
	wellFormed: boolean;
}

const RERUN_ADVICE = "Re-run `govulncheck -json ./...` and check its output.";
const UNPARSED_HELP = `govulncheck printed output that could not be fully parsed, so Go vulnerabilities may be missing. ${RERUN_ADVICE}`;
const FAILED_RUN_HELP = `govulncheck printed no report, failed, or timed out, so Go vulnerabilities may be missing. ${RERUN_ADVICE}`;

const skippedDiagnostic = (help: string): Diagnostic =>
	skippedAuditDiagnostic("go.mod", "govulncheck", help);

const unparsedDiagnostic = (): Diagnostic => skippedDiagnostic(UNPARSED_HELP);
const failedRunDiagnostic = (): Diagnostic => skippedDiagnostic(FAILED_RUN_HELP);

const opensWithConfig = (messages: unknown[]): boolean => {
	const [first] = messages;
	return (
		isRecord(first) && isRecord(first.config) && !!readString(first.config, "protocol_version")
	);
};

const parseGovulncheckOutput = (output: string): ParsedStream => {
	const osvEntries = new Map<string, OsvEntry>();
	const called = new Map<string, CalledFinding>();
	const { messages, corrupt: undecodable } = decodeStream(output);
	let malformed = false;

	for (const message of messages) {
		if (!isWellFormedMessage(message)) {
			malformed = true;
			continue;
		}
		if (isRecord(message.osv)) {
			const id = readString(message.osv, "id");
			if (id) {
				osvEntries.set(id, {
					aliases: message.osv.aliases,
					summary: readString(message.osv, "summary"),
				});
			}
		}
		if (isRecord(message.finding)) {
			if (!isWellFormedFinding(message.finding)) malformed = true;
			const finding = toCalledFinding(message.finding);
			// One advisory yields many findings (module, package and each call path).
			// Each vulnerable module is its own diagnostic, so accepting an advisory
			// for one module cannot hide the same advisory in another.
			const key = finding ? `${finding.osv}\u0000${finding.moduleName ?? ""}` : "";
			if (finding && !called.has(key)) called.set(key, finding);
		}
	}

	const diagnostics = [...called.values()].map((finding) =>
		toDiagnostic(finding, osvEntries.get(finding.osv)),
	);
	const wellFormed = !undecodable && !malformed && opensWithConfig(messages);
	return {
		diagnostics: wellFormed ? diagnostics : [unparsedDiagnostic(), ...diagnostics],
		wellFormed,
	};
};

// govulncheck exits zero in JSON mode whether or not it found anything, so a
// non-zero exit is a failed run. So is a stream that is not a clean sequence of
// protocol messages starting with `config`: it is reported as such, never as a clean
// audit. An empty report, a failed or timed-out run and a non-zero exit all carry the
// skipped-audit warning too. Findings that could still be read are kept.
export const inspectGovulncheck = async (
	rootDir: string,
	timeout: number,
): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess("govulncheck", ["-json", "./..."], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return { diagnostics: [failedRunDiagnostic()], completed: false };
		const { diagnostics, wellFormed } = parseGovulncheckOutput(result.stdout);
		if (wellFormed && result.exitCode !== 0) {
			return { diagnostics: [failedRunDiagnostic(), ...diagnostics], completed: false };
		}
		return { diagnostics, completed: wellFormed && result.exitCode === 0 };
	} catch {
		return { diagnostics: [failedRunDiagnostic()], completed: false };
	}
};

export const runGovulncheck = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectGovulncheck(rootDir, timeout)).diagnostics;
