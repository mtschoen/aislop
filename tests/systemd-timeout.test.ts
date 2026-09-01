import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogRuleIds } from "../src/commands/rules.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import { detectSystemdTimeouts } from "../src/engines/ai-slop/systemd-timeout.js";
import type { EngineContext } from "../src/engines/types.js";
import { descriptionForRule, labelForRule } from "../src/output/rule-labels.js";
import { RULE_SCORE_IMPACTS } from "../src/scoring/rule-impact.js";
import { applySuppressions } from "../src/utils/suppress.js";

const RULE_ID = "ai-slop/systemd-timeout";

let tmpDir: string;

const writeFile = (relative: string, lines: string[]): void => {
	const absolute = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, `${lines.join("\n")}\n`);
};

const buildContext = (files?: string[]): EngineContext => ({
	rootDirectory: tmpDir,
	languages: [],
	frameworks: [],
	installedTools: {},
	files,
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

const findingsForContext = async (
	context: EngineContext,
): Promise<Array<{ filePath: string; line: number; message: string }>> => {
	const diagnostics = await detectSystemdTimeouts(context);
	return diagnostics
		.filter((diagnostic) => diagnostic.rule === RULE_ID)
		.map((diagnostic) => ({
			filePath: diagnostic.filePath,
			line: diagnostic.line,
			message: diagnostic.message,
		}));
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-systemd-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("systemd timeout rule metadata", () => {
	it("is registered in the rules catalog", () => {
		expect(catalogRuleIds()).toContain(RULE_ID);
	});

	it("has an explicit label and description", () => {
		expect(labelForRule(RULE_ID)).toBe("Unbounded systemd start timeout");
		expect(descriptionForRule(RULE_ID)).toContain("systemd unit has an unbounded start timeout");
	});

	it("has a maintainability score impact classification", () => {
		const impact = RULE_SCORE_IMPACTS[RULE_ID];
		expect(impact).toBeDefined();
		expect(impact?.tier).toBe("maintainability");
		expect(impact?.rationale.length).toBeGreaterThan(20);
	});
});

describe("Type=oneshot systemd units missing TimeoutStartSec", () => {
	it("flags Type=oneshot with no timeout directive (the pr-crew-deploy.service case)", async () => {
		writeFile("pr-crew-deploy.service", [
			"[Unit]",
			"Description=Deploy PR Crew",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/opt/schoen-lab/packages/local_ci/deploy/apply.sh deploy-pr-crew",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "pr-crew-deploy.service",
				line: 5,
				message:
					"`Type=oneshot` service defaults to an unbounded start timeout (`TimeoutStartSec=infinity`).",
			},
		]);
	});

	it("does not flag Type=OneShot (systemd enum values are case-sensitive; only lowercase oneshot is recognized)", async () => {
		writeFile("services/sync.service", [
			"[Service]",
			"Type=OneShot",
			"ExecStart=/usr/local/bin/sync-job",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag Type=oneshot when explicit bounded TimeoutStartSec is provided", async () => {
		writeFile("local-ci-apply.service", [
			"[Unit]",
			"Description=Local CI Apply",
			"",
			"[Service]",
			"Type=oneshot",
			"ExecStart=/opt/schoen-lab/packages/local_ci/deploy/apply.sh",
			"TimeoutStartSec=6h",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag Type=oneshot when explicit bounded TimeoutSec is provided", async () => {
		writeFile("deploy.service", [
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/true",
			"TimeoutSec=5min",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("merges multiple [Service] sections when resolving oneshot timeout", async () => {
		writeFile("multi-section.service", [
			"[Service]",
			"Type=oneshot",
			"ExecStart=/bin/step1",
			"",
			"[Service]",
			"TimeoutStartSec=30m",
			"ExecStart=/bin/step2",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag when Type=oneshot is overridden by Type=simple", async () => {
		writeFile("override.service", [
			"[Service]",
			"Type=oneshot",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag Type=simple without timeout (systemd defaults to 90s bounded)", async () => {
		writeFile("daemon.service", [
			"[Unit]",
			"Description=Normal Daemon",
			"",
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag services with omitted Type= (defaults to simple)", async () => {
		writeFile("default-simple.service", [
			"[Service]",
			"ExecStart=/usr/bin/simple-service",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});
});

describe("explicit unbounded timeouts across unit types", () => {
	it("flags explicit TimeoutStartSec=infinity without a rationale comment", async () => {
		writeFile("unbounded-simple.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "unbounded-simple.service",
				line: 4,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it.each([
		"0",
		"0s",
		"0sec",
		"0seconds",
		"0ms",
		"0msec",
		"0us",
		"0usec",
		"0µs",
		"0m",
		"0min",
		"0minute",
		"0minutes",
		"0h",
		"0hr",
		"0hour",
		"0hours",
		"0d",
		"0day",
		"0days",
		"0w",
		"0week",
		"0weeks",
		"0M",
		"0month",
		"0months",
		"0y",
		"0year",
		"0years",
		"0.0s",
		"0.00ms",
		"0h 0m 0s",
		"0 days 0 hours 0 seconds",
		"0w 0d 0h 0m 0s",
	])("flags explicit TimeoutStartSec=%s without a rationale comment", async (val) => {
		writeFile(`zero-${val.replace(/[^a-zA-Z0-9]/g, "_")}.service`, [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			`TimeoutStartSec=${val}`,
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: `zero-${val.replace(/[^a-zA-Z0-9]/g, "_")}.service`,
				line: 4,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag non-zero compound time spans like TimeoutStartSec=0h 5m", async () => {
		writeFile("bounded-compound.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=0h 5m",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("flags explicit TimeoutSec=infinity without a rationale comment", async () => {
		writeFile("unbounded-sec.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "unbounded-sec.service",
				line: 4,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag an unbounded service timeout overridden by a bounded value", async () => {
		writeFile("bounded-override.service", [
			"[Service]",
			"Type=simple",
			"TimeoutStartSec=infinity",
			"TimeoutStartSec=5m",
			"ExecStart=/usr/bin/daemon",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("flags explicit TimeoutSec=infinity in a [Socket] unit", async () => {
		writeFile("unbounded.socket", [
			"[Unit]",
			"Description=Test Socket",
			"",
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "unbounded.socket",
				line: 6,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag an unbounded socket timeout overridden in a repeated section", async () => {
		writeFile("bounded-override.socket", [
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=infinity",
			"",
			"[Socket]",
			"TimeoutSec=5m",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("flags explicit TimeoutSec=0 in a [Mount] unit", async () => {
		writeFile("data.mount", [
			"[Mount]",
			"What=/dev/sdb1",
			"Where=/data",
			"TimeoutSec=0",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "data.mount",
				line: 4,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag TimeoutStopSec=infinity (the pr-crew-drain.service case)", async () => {
		writeFile("pr-crew-drain.service", [
			"# SIGINT lets Python unwind the ThreadPoolExecutor, which waits for active",
			"# harnesses. mixed targets only the drain process initially, leaving its",
			"# harness children alone while they finish. The deploy must remain pending",
			"# rather than escalate to SIGKILL and discard their work.",
			"KillSignal=SIGINT",
			"KillMode=mixed",
			"TimeoutStopSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag explicit TimeoutStartSec=infinity when preceded by a rationale comment", async () => {
		writeFile("justified.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/slow-init-daemon",
			"# Wait indefinitely for cluster quorum handshake over high-latency WAN",
			"TimeoutStartSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag explicit TimeoutStartSec=0 when preceded by a rationale comment", async () => {
		writeFile("justified-zero.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/slow-init-daemon",
			"# Offline database migration job can take unboundedly long",
			"TimeoutStartSec=0",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag explicit TimeoutStartSec=infinity with semicolon comment rationale", async () => {
		writeFile("semicolon-justified.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/slow-init-daemon",
			"; Offline database migration job can take unboundedly long",
			"TimeoutStartSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});
});

describe("case sensitivity and unit-type section matching", () => {
	it("does not flag a lowercase [service] section header (systemd requires exact casing)", async () => {
		writeFile("lowercase-section.service", [
			"[service]",
			"Type=oneshot",
			"ExecStart=/usr/local/bin/job",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag timeoutstartsec=infinity (wrong key casing is not recognized by systemd)", async () => {
		writeFile("wrong-key-case.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"timeoutstartsec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag TimeoutStartSec=Infinity (capitalized value is not the infinity token)", async () => {
		writeFile("capitalized-value.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=Infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("flags the TimeoutSec line, unmasked by a later ignored TimeoutStartSec, in a .socket unit", async () => {
		// systemd.socket documents only TimeoutSec=; a TimeoutStartSec= line
		// in a [Socket] section is ignored by systemd, so it must not
		// override the TimeoutSec=infinity resolution here either.
		writeFile("masking.socket", [
			"[Socket]",
			"ListenStream=8080",
			"TimeoutSec=infinity",
			"TimeoutStartSec=5m",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "masking.socket",
				line: 3,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag [Service] TimeoutStartSec=infinity followed by a bounded TimeoutSec", async () => {
		writeFile("service-order-bounded.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=infinity",
			"TimeoutSec=5m",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("flags the TimeoutSec line when a bounded TimeoutStartSec is followed by an unbounded TimeoutSec", async () => {
		writeFile("service-order-unbounded.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"TimeoutStartSec=5m",
			"TimeoutSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([
			{
				filePath: "service-order-unbounded.service",
				line: 5,
				message: "Explicit unbounded start timeout without a rationale comment.",
			},
		]);
	});

	it("does not flag a [Socket] section with TimeoutSec=infinity inside a .service file (section does not match unit type)", async () => {
		writeFile("mismatched-socket-section.service", [
			"[Service]",
			"Type=simple",
			"ExecStart=/usr/bin/daemon",
			"",
			"[Socket]",
			"TimeoutSec=infinity",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});

	it("does not flag a [Service] section with Type=oneshot inside a .socket file (section does not match unit type)", async () => {
		writeFile("mismatched-service-section.socket", [
			"[Socket]",
			"ListenStream=8080",
			"",
			"[Service]",
			"Type=oneshot",
		]);

		const findings = await findingsForContext(buildContext());
		expect(findings).toEqual([]);
	});
});

describe("suppression and engine integration", () => {
	it("runs through aiSlopEngine and supports aislop-ignore directives", async () => {
		writeFile("ignored.service", [
			"[Service]",
			"# aislop-ignore-next-line ai-slop/systemd-timeout -- intentional oneshot default",
			"Type=oneshot",
			"ExecStart=/usr/bin/backup.sh",
		]);

		const context = buildContext();
		const result = await aiSlopEngine.run(context);
		const { results, suppressedCount } = applySuppressions([result], tmpDir);

		const activeFindings = results[0].diagnostics.filter((d) => d.rule === RULE_ID);
		expect(activeFindings).toEqual([]);
		expect(suppressedCount).toBe(1);
	});

	it("supports semicolon-prefixed aislop-ignore directives", async () => {
		writeFile("semicolon-ignored.service", [
			"[Service]",
			"; aislop-ignore-next-line ai-slop/systemd-timeout -- intentional",
			"Type=oneshot",
			"ExecStart=/usr/bin/backup.sh",
		]);

		const context = buildContext();
		const result = await aiSlopEngine.run(context);
		const { results, suppressedCount } = applySuppressions([result], tmpDir);

		const activeFindings = results[0].diagnostics.filter((d) => d.rule === RULE_ID);
		expect(activeFindings).toEqual([]);
		expect(suppressedCount).toBe(1);
	});
});
