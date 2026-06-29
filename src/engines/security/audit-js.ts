import fs from "node:fs";
import path from "node:path";
import { runSubprocess } from "../../utils/subprocess.js";
import type { Diagnostic } from "../types.js";
import { type JsAuditSource, SEVERITY_RANK, toSeverity } from "./audit-shared.js";

export const runNpmAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess("npm", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		return parseJsAudit(result.stdout, "npm audit");
	} catch {
		return [];
	}
};

export const runPnpmAuditWithFallback = async (
	rootDir: string,
	timeout: number,
): Promise<Diagnostic[]> => {
	const canFallbackToNpm = fs.existsSync(path.join(rootDir, "package-lock.json"));

	try {
		const result = await runSubprocess("pnpm", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		const diagnostics = parseJsAudit(result.stdout, "pnpm audit");
		const hasAuditFailure = diagnostics.some((d) => d.rule === "security/dependency-audit-skipped");
		if (hasAuditFailure) {
			if (canFallbackToNpm) {
				return runNpmAudit(rootDir, timeout);
			}
			// pnpm audit failed due to an infrastructure/tooling issue, not a project problem — suppress.
			return [];
		}
		return diagnostics;
	} catch {
		if (canFallbackToNpm) {
			return runNpmAudit(rootDir, timeout);
		}
		return [];
	}
};

interface VulnAggregate {
	packageName: string;
	worstSeverity: string;
	advisories: number;
	recommendations: Set<string>;
}

const upsertVuln = (
	bucket: Map<string, VulnAggregate>,
	packageName: string,
	severity: string,
	recommendation: string,
): void => {
	const existing = bucket.get(packageName);
	if (existing) {
		existing.advisories++;
		if ((SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[existing.worstSeverity] ?? 0)) {
			existing.worstSeverity = severity;
		}
		if (recommendation) existing.recommendations.add(recommendation);
	} else {
		bucket.set(packageName, {
			packageName,
			worstSeverity: severity,
			advisories: 1,
			recommendations: recommendation ? new Set([recommendation]) : new Set(),
		});
	}
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
const cmpSemver = (a: string, b: string): number => {
	const [, a1, a2, a3] = SEMVER_RE.exec(a) ?? ["", "0", "0", "0"];
	const [, b1, b2, b3] = SEMVER_RE.exec(b) ?? ["", "0", "0", "0"];
	if (Number(a1) !== Number(b1)) return Number(a1) - Number(b1);
	if (Number(a2) !== Number(b2)) return Number(a2) - Number(b2);
	return Number(a3) - Number(b3);
};

const pickBestRecommendation = (recs: string[]): string => {
	if (recs.length <= 1) return recs[0] ?? "";
	const versioned = recs.filter((r) => SEMVER_RE.test(r));
	if (versioned.length === 0) return recs[0];
	return versioned.reduce((best, r) => (cmpSemver(r, best) > 0 ? r : best));
};

const cleanRecommendation = (raw: string): string => {
	const t = raw.trim();
	if (!t || t.toLowerCase() === "none") return "no fix available";
	return t;
};

const aggregateToDiagnostic = (agg: VulnAggregate, source: JsAuditSource): Diagnostic => {
	const recs = [...agg.recommendations];
	const best = cleanRecommendation(pickBestRecommendation(recs));
	const countLabel = agg.advisories > 1 ? ` (${agg.advisories} advisories)` : "";
	const recLabel = best ? ` — ${best}` : "";
	return {
		filePath: "package.json",
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: toSeverity(agg.worstSeverity),
		message: `${agg.packageName} (${agg.worstSeverity})${recLabel}${countLabel}`,
		help: "",
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
		detail: source === "npm audit" ? "npm" : "pnpm",
	};
};

const parseLegacyAdvisories = (
	advisories: Record<string, Record<string, unknown>>,
	source: JsAuditSource,
): Diagnostic[] => {
	const bucket = new Map<string, VulnAggregate>();

	for (const [key, advisory] of Object.entries(advisories)) {
		const packageName =
			(advisory.module_name as string) ??
			(advisory.name as string) ??
			(advisory.package as string) ??
			key;
		const severity = ((advisory.severity as string) ?? "moderate").toLowerCase();
		const recommendation = (advisory.recommendation as string) ?? (advisory.title as string) ?? "";

		upsertVuln(bucket, packageName, severity, recommendation);
	}

	return [...bucket.values()].map((agg) => aggregateToDiagnostic(agg, source));
};

// An object in `via` means this package is the CVE source; a string means it is
// only affected through another, so reporting it would duplicate the root cause.
const carriesAdvisory = (vulnerability: Record<string, unknown>): boolean =>
	Array.isArray(vulnerability.via) &&
	vulnerability.via.some((entry) => entry !== null && typeof entry === "object");

const parseModernVulnerabilities = (
	vulnerabilities: Record<string, Record<string, unknown>>,
	source: JsAuditSource,
): Diagnostic[] => {
	const bucket = new Map<string, VulnAggregate>();
	const hasRootCauses = Object.values(vulnerabilities).some(carriesAdvisory);

	for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
		if (hasRootCauses && !carriesAdvisory(vulnerability)) continue;
		const severity = ((vulnerability.severity as string) ?? "moderate").toLowerCase();
		const fixAvailable = vulnerability.fixAvailable;
		const isDirect = vulnerability.isDirect === true;

		let recommendation = "";
		if (fixAvailable === false) {
			recommendation = isDirect
				? "no automatic fix"
				: "transitive — needs override or parent upgrade";
		} else if (!isDirect && fixAvailable === true) {
			recommendation = "transitive — may need override or parent upgrade";
		} else if (
			fixAvailable &&
			typeof fixAvailable === "object" &&
			"name" in fixAvailable &&
			"version" in fixAvailable
		) {
			const target = fixAvailable as { name?: string; version?: string };
			if (target.name && target.version) {
				recommendation = `upgrade to ${target.name}@${target.version}`;
			}
		}

		upsertVuln(bucket, packageName, severity, recommendation);
	}

	return [...bucket.values()].map((agg) => aggregateToDiagnostic(agg, source));
};

export const parseJsAudit = (output: string, source: JsAuditSource): Diagnostic[] => {
	if (!output) return [];
	try {
		const parsed = JSON.parse(output) as Record<string, unknown>;

		const error = parsed.error as { code?: string; summary?: string; detail?: string } | undefined;
		if (error?.code === "ENOLOCK") {
			return [
				{
					filePath: "package.json",
					engine: "security",
					rule: "security/dependency-audit-skipped",
					severity: "info",
					message: `Dependency audit skipped (${source}): lockfile is missing`,
					help:
						error.detail ??
						"Generate a lockfile, then re-run `aislop scan` for dependency vulnerability checks.",
					line: 0,
					column: 0,
					category: "Security",
					fixable: false,
				},
			];
		}
		if (error?.summary || error?.code) {
			return [
				{
					filePath: "package.json",
					engine: "security",
					rule: "security/dependency-audit-skipped",
					severity: "info",
					message: `Dependency audit did not complete (${source})`,
					help:
						error.detail ??
						error.summary ??
						"Re-run dependency audit directly to inspect the underlying error.",
					line: 0,
					column: 0,
					category: "Security",
					fixable: false,
				},
			];
		}

		const advisories = parsed.advisories;
		if (advisories && typeof advisories === "object") {
			return parseLegacyAdvisories(advisories as Record<string, Record<string, unknown>>, source);
		}

		const vulnerabilities = parsed.vulnerabilities;
		if (vulnerabilities && typeof vulnerabilities === "object") {
			return parseModernVulnerabilities(
				vulnerabilities as Record<string, Record<string, unknown>>,
				source,
			);
		}

		return [];
	} catch {
		return [];
	}
};
