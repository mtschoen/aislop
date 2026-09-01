import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSystemdTimeouts } from "../src/engines/ai-slop/systemd-timeout.js";
import type { EngineContext } from "../src/engines/types.js";

// Adversarial corpus for `ai-slop/systemd-timeout`.
//
// These cases were written against the rule's documented contract alone, by a
// separate agent harness with no sight of the detector source, then reconciled
// against the built CLI. They are kept as data written into a temporary
// directory rather than as checked-in `.service` fixtures on purpose: 22 of
// them are genuine unbounded-timeout findings, so committing them as real
// files under `tests/` would make aislop report them against itself.
//
// The narrower hand-written cases in `systemd-timeout.test.ts` stay the
// readable documentation of each individual behavior. This file is the
// breadth check that the whole contract holds at once, so a later change to
// the parser cannot quietly re-open one edge of it.

interface CorpusCase {
	name: string;
	lines: string[];
	// 1-based lines expected to produce a finding, in ascending order.
	expectedLines: number[];
}

const CORPUS: CorpusCase[] = [
	{
		name: "case-key-timeoutsec-upper.socket",
		lines: [
			"# Probes uppercase TIMEOUTSEC key mismatch in socket",
			"",
			"[Unit]",
			"Description=Uppercase timeout key test",
			"",
			"[Socket]",
			"ListenStream=9000",
			"TIMEOUTSEC=0",
		],
		expectedLines: [],
	},
	{
		name: "case-key-timeoutstartsec-lower.service",
		lines: [
			"# Probes lowercase timeoutstartsec directive key mismatch",
			"",
			"[Unit]",
			"Description=Lowercase directive key test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"timeoutstartsec=infinity",
		],
		expectedLines: [],
	},
	{
		name: "case-key-type-lower.service",
		lines: [
			"# Probes lowercase type directive key mismatch",
			"",
			"[Unit]",
			"Description=Lowercase type key test",
			"",
			"[Service]",
			"type=oneshot",
			"ExecStart=/bin/true",
		],
		expectedLines: [],
	},
	{
		name: "case-section-service-lower.service",
		lines: [
			"# Probes lowercase [service] section casing mismatch",
			"",
			"[Unit]",
			"Description=Lowercase section test",
			"",
			"[service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [],
	},
	{
		name: "case-section-socket-upper.socket",
		lines: [
			"# Probes uppercase [SOCKET] section casing mismatch",
			"",
			"[Unit]",
			"Description=Uppercase socket section test",
			"",
			"[SOCKET]",
			"ListenStream=8080",
			"TimeoutSec=0",
		],
		expectedLines: [],
	},
	{
		name: "case-val-timeout-infinity-title.service",
		lines: [
			"# Probes TitleCase TimeoutStartSec=Infinity value mismatch",
			"",
			"[Unit]",
			"Description=TitleCase Infinity value test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=Infinity",
		],
		expectedLines: [],
	},
	{
		name: "case-val-type-oneshot-camel.service",
		lines: [
			"# Probes camelcase Type=OneShot value mismatch",
			"",
			"[Unit]",
			"Description=CamelCase Type value test",
			"",
			"[Service]",
			"Type=OneShot",
			"ExecStart=/bin/true",
		],
		expectedLines: [],
	},
	{
		name: "clean-empty-file.service",
		lines: [],
		expectedLines: [],
	},
	{
		name: "cross-section-service-in-mount.mount",
		lines: [
			"# Probes that [Service] section inside .mount file is ignored",
			"",
			"[Unit]",
			"Description=Cross-section test in mount",
			"",
			"[Service]",
			"Type=oneshot",
			"",
			"[Mount]",
			"What=/dev/sda1",
			"Where=/mnt/data",
		],
		expectedLines: [],
	},
	{
		name: "cross-section-service-in-socket.socket",
		lines: [
			"# Probes that [Service] section inside .socket file is ignored",
			"",
			"[Unit]",
			"Description=Cross-section test in socket",
			"",
			"[Service]",
			"TimeoutSec=0",
			"",
			"[Socket]",
			"ListenStream=8080",
		],
		expectedLines: [],
	},
	{
		name: "cross-section-socket-in-service.service",
		lines: [
			"# Probes that [Socket] section inside .service file is ignored",
			"",
			"[Unit]",
			"Description=Cross-section test in service",
			"",
			"[Socket]",
			"TimeoutSec=0",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
		],
		expectedLines: [],
	},
	{
		name: "ext-target-ignored.target",
		lines: [
			"# Probes that .target files are ignored by the linter",
			"",
			"[Unit]",
			"Description=My Target",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
		],
		expectedLines: [],
	},
	{
		name: "ext-timer-ignored.timer",
		lines: [
			"# Probes that .timer files are ignored by the linter",
			"",
			"[Timer]",
			"OnBootSec=5min",
			"TimeoutSec=0",
		],
		expectedLines: [],
	},
	{
		name: "mount-unbounded-zero.mount",
		lines: [
			"# Probes unbounded TimeoutSec=0 in [Mount]",
			"",
			"[Unit]",
			"Description=Unbounded mount timeout",
			"",
			"[Mount]",
			"What=/dev/sda1",
			"Where=/mnt/data",
			"TimeoutSec=0",
		],
		expectedLines: [9],
	},
	{
		name: "near-miss-fractional-nonzero.service",
		lines: [
			"# Probes near-miss non-zero 0.5s timeout",
			"",
			"[Unit]",
			"Description=Near miss fractional seconds",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0.5s",
		],
		expectedLines: [],
	},
	{
		name: "near-miss-ten-seconds.service",
		lines: [
			"# Probes near-miss 10s timeout",
			"",
			"[Unit]",
			"Description=Ten seconds bounded timeout",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=10s",
		],
		expectedLines: [],
	},
	{
		name: "near-miss-trailing-comment-infinity.service",
		lines: [
			"# Probes that systemd does not have inline comments for infinity",
			"",
			"[Unit]",
			"Description=Trailing inline comment on infinity",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity # no timeout",
		],
		expectedLines: [],
	},
	{
		name: "near-miss-trailing-comment-zero.service",
		lines: [
			"# Probes that systemd does not have inline comments for zero",
			"",
			"[Unit]",
			"Description=Trailing inline comment on zero",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutSec=0s # disable timeout",
		],
		expectedLines: [],
	},
	{
		name: "near-miss-zero-hex.service",
		lines: [
			"# Probes near-miss 0x invalid time span",
			"",
			"[Unit]",
			"Description=Near miss hex zero format",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0x",
		],
		expectedLines: [],
	},
	{
		name: "oneshot-bare.service",
		lines: [
			"# Probes bare Type=oneshot without timeout bound",
			"",
			"[Unit]",
			"Description=Bare oneshot service",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
		],
		expectedLines: [7],
	},
	{
		name: "oneshot-bounded-timeoutstartsec.service",
		lines: [
			"# Probes Type=oneshot with explicit TimeoutStartSec bound",
			"",
			"[Unit]",
			"Description=Bounded oneshot service",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
			"TimeoutStartSec=10min",
		],
		expectedLines: [],
	},
	{
		name: "oneshot-unbounded-timeoutstartsec.service",
		lines: [
			"# Probes Type=oneshot with explicit unbounded TimeoutStartSec",
			"",
			"[Unit]",
			"Description=Oneshot with unbounded timeout",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [9],
	},
	{
		name: "rationale-blank-line-separated-not-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Rationale separated by blank line does not suppress",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"# Legitimate long startup explanation",
			"",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [8],
	},
	{
		name: "rationale-directive-separated-not-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Rationale separated by directive does not suppress",
			"",
			"[Service]",
			"# Legitimate long startup explanation",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [7],
	},
	{
		name: "rationale-empty-hash-not-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Empty hash comment does not suppress",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"#",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [7],
	},
	{
		name: "rationale-hash-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Rationale hash comment test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/migrate",
			"# Database migration can take arbitrarily long",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [],
	},
	{
		name: "rationale-indented-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Indented rationale comment test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"   # Indented rationale explaining unlimited startup",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [],
	},
	{
		name: "rationale-multiline-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Multiline rationale comment test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"# First line of justification",
			"# Second line of justification",
			"TimeoutStartSec=0",
		],
		expectedLines: [],
	},
	{
		name: "rationale-on-oneshot-does-not-suppress.service",
		lines: [
			"[Unit]",
			"Description=Rationale on Type=oneshot does not suppress missing bound",
			"",
			"[Service]",
			"# One-time initialization script",
			"Type=oneshot",
			"ExecStart=/bin/true",
		],
		expectedLines: [6],
	},
	{
		name: "rationale-on-overridden-not-effective.service",
		lines: [
			"[Unit]",
			"Description=Rationale on overridden directive does not suppress effective directive",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"# Rationale applies only to TimeoutSec",
			"TimeoutSec=infinity",
			"TimeoutStartSec=0",
		],
		expectedLines: [8],
	},
	{
		name: "rationale-semicolon-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Rationale semicolon comment test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"; Initial cluster sync requires unlimited startup window",
			"TimeoutSec=0",
		],
		expectedLines: [],
	},
	{
		name: "rationale-whitespace-hash-not-suppressed.service",
		lines: [
			"[Unit]",
			"Description=Whitespace hash comment does not suppress",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"#    ",
			"TimeoutStartSec=0",
		],
		expectedLines: [7],
	},
	{
		name: "repeated-section-override-bounded.service",
		lines: [
			"# Probes repeated [Service] sections merging in file order to bounded",
			"",
			"[Unit]",
			"Description=Repeated service section test",
			"",
			"[Service]",
			"TimeoutStartSec=0",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=30s",
		],
		expectedLines: [],
	},
	{
		name: "repeated-section-override-unbounded.service",
		lines: [
			"# Probes repeated [Service] sections merging in file order to unbounded",
			"",
			"[Unit]",
			"Description=Repeated service section test unbounded",
			"",
			"[Service]",
			"TimeoutStartSec=30s",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutSec=infinity",
		],
		expectedLines: [11],
	},
	{
		name: "repeated-section-type-override-oneshot.service",
		lines: [
			"# Probes repeated [Service] sections where Type=oneshot overrides Type=simple",
			"",
			"[Unit]",
			"Description=Repeated type override to oneshot",
			"",
			"[Service]",
			"Type=simple",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
		],
		expectedLines: [10],
	},
	{
		name: "repeated-section-type-override-simple.service",
		lines: [
			"# Probes repeated [Service] sections where Type=simple overrides Type=oneshot",
			"",
			"[Unit]",
			"Description=Repeated type override test",
			"",
			"[Service]",
			"Type=oneshot",
			"",
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
		],
		expectedLines: [],
	},
	{
		name: "service-empty-resets-startsec.service",
		lines: [
			"# Probes empty TimeoutStartSec= resetting unbounded timeout to default",
			"",
			"[Unit]",
			"Description=Empty assignment reset test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0",
			"TimeoutStartSec=",
		],
		expectedLines: [],
	},
	{
		name: "service-empty-resets-timeoutsec.service",
		lines: [
			"# Probes empty TimeoutSec= resetting unbounded TimeoutStartSec to default",
			"",
			"[Unit]",
			"Description=Empty TimeoutSec reset test",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity",
			"TimeoutSec=",
		],
		expectedLines: [],
	},
	{
		name: "service-oneshot-empty-resets-to-missing.service",
		lines: [
			"# Probes empty TimeoutStartSec= causing oneshot to have no explicit bound",
			"",
			"[Unit]",
			"Description=Oneshot with reset timeout",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
			"TimeoutStartSec=30s",
			"TimeoutStartSec=",
		],
		expectedLines: [7],
	},
	{
		name: "service-sec-bounded-then-start-unbounded.service",
		lines: [
			"# Probes TimeoutStartSec=infinity overriding earlier bounded TimeoutSec",
			"",
			"[Unit]",
			"Description=TimeoutStartSec overrides TimeoutSec to unbounded",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutSec=30s",
			"TimeoutStartSec=infinity",
		],
		expectedLines: [9],
	},
	{
		name: "service-sec-unbounded-then-start-bounded.service",
		lines: [
			"# Probes TimeoutStartSec overriding earlier unbounded TimeoutSec",
			"",
			"[Unit]",
			"Description=TimeoutStartSec overrides TimeoutSec",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutSec=infinity",
			"TimeoutStartSec=15s",
		],
		expectedLines: [],
	},
	{
		name: "service-start-bounded-then-sec-unbounded.service",
		lines: [
			"# Probes TimeoutSec=0 overriding earlier bounded TimeoutStartSec",
			"",
			"[Unit]",
			"Description=TimeoutSec overrides TimeoutStartSec to unbounded",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=30s",
			"TimeoutSec=0",
		],
		expectedLines: [9],
	},
	{
		name: "service-start-unbounded-then-sec-bounded.service",
		lines: [
			"# Probes TimeoutSec overriding earlier unbounded TimeoutStartSec",
			"",
			"[Unit]",
			"Description=TimeoutSec overrides TimeoutStartSec",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0",
			"TimeoutSec=45s",
		],
		expectedLines: [],
	},
	{
		name: "service-type-simple-no-timeout.service",
		lines: [
			"# Probes Type=simple without timeout does not require bound",
			"",
			"[Unit]",
			"Description=Simple service without timeout",
			"",
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
		],
		expectedLines: [],
	},
	{
		name: "socket-empty-resets-unbounded.socket",
		lines: [
			"# Probes empty TimeoutSec= in [Socket] resetting unbounded timeout",
			"",
			"[Unit]",
			"Description=Socket empty reset test",
			"",
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=infinity",
			"TimeoutSec=",
		],
		expectedLines: [],
	},
	{
		name: "socket-timeoutstartsec-ignored.socket",
		lines: [
			"# Probes that TimeoutStartSec is ignored in [Socket] section",
			"",
			"[Unit]",
			"Description=TimeoutStartSec ignored in socket",
			"",
			"[Socket]",
			"ListenStream=8080",
			"TimeoutStartSec=0",
		],
		expectedLines: [],
	},
	{
		name: "socket-timeoutstartsec-mask-attempt.socket",
		lines: [
			"# Probes that TimeoutStartSec cannot mask unbounded TimeoutSec in [Socket]",
			"",
			"[Unit]",
			"Description=TimeoutStartSec cannot override TimeoutSec in socket",
			"",
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=0",
			"TimeoutStartSec=30s",
		],
		expectedLines: [8],
	},
	{
		name: "socket-unbounded-infinity.socket",
		lines: [
			"# Probes unbounded TimeoutSec=infinity in [Socket]",
			"",
			"[Unit]",
			"Description=Unbounded socket timeout",
			"",
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=infinity",
		],
		expectedLines: [8],
	},
	{
		name: "swap-timeoutstartsec-mask-attempt.swap",
		lines: [
			"# Probes that TimeoutStartSec cannot mask unbounded TimeoutSec in [Swap]",
			"",
			"[Unit]",
			"Description=TimeoutStartSec cannot override TimeoutSec in swap",
			"",
			"[Swap]",
			"What=/dev/sdb1",
			"TimeoutSec=infinity",
			"TimeoutStartSec=10s",
		],
		expectedLines: [8],
	},
	{
		name: "swap-unbounded-zero-compound.swap",
		lines: [
			"# Probes unbounded compound zero TimeoutSec in [Swap]",
			"",
			"[Unit]",
			"Description=Compound zero swap timeout",
			"",
			"[Swap]",
			"What=/dev/sdb1",
			"TimeoutSec=0h 0m",
		],
		expectedLines: [8],
	},
	{
		name: "timeoutstopsec-does-not-bound-oneshot.service",
		lines: [
			"# Probes that TimeoutStopSec does not satisfy start-timeout requirement for oneshot",
			"",
			"[Unit]",
			"Description=TimeoutStopSec does not bound oneshot start",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
			"TimeoutStopSec=30s",
		],
		expectedLines: [7],
	},
	{
		name: "timeoutstopsec-infinity.service",
		lines: [
			"# Probes that TimeoutStopSec is never flagged",
			"",
			"[Unit]",
			"Description=TimeoutStopSec never flagged",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStopSec=infinity",
		],
		expectedLines: [],
	},
	{
		name: "zero-bare.service",
		lines: [
			"# Probes unbounded bare 0 time span",
			"",
			"[Unit]",
			"Description=Bare zero timeout",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0",
		],
		expectedLines: [8],
	},
	{
		name: "zero-compound-hours-minutes.service",
		lines: [
			"# Probes unbounded compound 0h 0m time span",
			"",
			"[Unit]",
			"Description=Zero hours minutes compound timeout",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0h 0m",
		],
		expectedLines: [8],
	},
	{
		name: "zero-seconds-suffix.service",
		lines: [
			"# Probes unbounded 0s time span",
			"",
			"[Unit]",
			"Description=Zero seconds timeout",
			"",
			"[Service]",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0s",
		],
		expectedLines: [8],
	},
];

let temporaryDirectory: string;
let findingsByFile: Map<string, number[]>;

const buildContext = (): EngineContext => ({
	rootDirectory: temporaryDirectory,
	languages: [],
	frameworks: [],
	installedTools: {},
	config: {
		quality: {
			maxFunctionLoc: 80,
			maxFileLoc: 400,
			maxNesting: 5,
			maxParams: 6,
			repeatedLiteralThreshold: 3,
		},
		security: { audit: false, auditTimeout: 0 },
		lint: {
			typecheck: false,
			expoDoctor: false,
			csharp: {
				projectEvaluation: false,
				jb: false,
				roslynator: false,
				jbSeverityFloor: "WARNING",
				jbExcludeTypes: [],
			},
			cpp: {
				cppcheck: false,
				clangTidy: false,
				cppcheckEnable: "",
				jb: false,
				jbSeverityFloor: "WARNING",
				jbExcludeTypes: [],
			},
		},
	},
});

describe("systemd-timeout adversarial corpus", () => {
	beforeAll(async () => {
		temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-systemd-corpus-"));
		for (const testCase of CORPUS) {
			const absolute = path.join(temporaryDirectory, testCase.name);
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, `${testCase.lines.join("\n")}\n`);
		}

		findingsByFile = new Map();
		for (const diagnostic of await detectSystemdTimeouts(buildContext())) {
			const existing = findingsByFile.get(diagnostic.filePath) ?? [];
			existing.push(diagnostic.line);
			findingsByFile.set(diagnostic.filePath, existing);
		}
		for (const lines of findingsByFile.values()) {
			lines.sort((first, second) => first - second);
		}
	});

	afterAll(() => {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it.each(CORPUS.map((testCase) => [testCase.name, testCase.expectedLines] as const))(
		"%s",
		(name, expectedLines) => {
			expect(findingsByFile.get(name) ?? []).toEqual(expectedLines);
		},
	);

	it("reports nothing outside the enumerated corpus cases", () => {
		const known = new Set(CORPUS.map((testCase) => testCase.name));
		expect([...findingsByFile.keys()].filter((name) => !known.has(name))).toEqual([]);
	});
});
