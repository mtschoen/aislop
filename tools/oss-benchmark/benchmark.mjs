import fs from "node:fs";
import path from "node:path";
import { aggregateResults } from "./aggregate.mjs";
import { containedPath, validateRepo } from "./containment.mjs";
import {
	ensureDir,
	info,
	readJson,
	relativeToRoot,
	RUNS_DIR,
	slugify,
	timestampStamp,
	writeJson,
	writeFile,
} from "./fs-utils.mjs";
import { renderMarkdownReport } from "./report.mjs";
import { ensureBuiltCli, SCAN_COMMAND_TEMPLATE, scanRepo } from "./scan-runner.mjs";
import { checkSandbox } from "./sandbox.mjs";

const runPool = async (items, jobs, worker) => {
	const results = Array.from({ length: items.length });
	let nextIndex = 0;

	const runners = Array.from({ length: Math.min(jobs, items.length) }, async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			results[currentIndex] = await worker(items[currentIndex], currentIndex);
		}
	});

	await Promise.all(runners);
	return results;
};

const writeReports = (runRoot, report) => {
	const summaryJsonPath = path.join(runRoot, "summary.json");
	const summaryMdPath = path.join(runRoot, "summary.md");
	writeJson(summaryJsonPath, report);
	writeFile(summaryMdPath, renderMarkdownReport(report));
	info(`Wrote JSON summary to ${relativeToRoot(summaryJsonPath)}`);
	info(`Wrote Markdown summary to ${relativeToRoot(summaryMdPath)}`);
};

const pinRevisions = (manifestPath, manifest, results) => {
	let pinned = 0;
	manifest.repos.forEach((repo, index) => {
		const sha = results[index]?.sha;
		if (repo.revision || !sha) return;
		repo.revision = sha;
		pinned += 1;
	});
	if (pinned === 0) return;
	writeJson(manifestPath, manifest);
	info(`Pinned ${pinned} repo(s) to their scanned revision in ${relativeToRoot(manifestPath)}`);
};

export const runBenchmark = async ({ manifestPath, iteration, jobs }) => {
	const manifest = readJson(manifestPath);
	if (!Array.isArray(manifest.repos) || !Array.isArray(manifest.languages))
		throw new Error("Invalid benchmark manifest");
	manifest.repos = manifest.repos.map(validateRepo);
	if (!Number.isSafeInteger(jobs) || jobs < 1)
		throw new Error("Benchmark jobs must be a positive integer");
	ensureBuiltCli();
	await checkSandbox();
	const iterationName = iteration ?? "pass-1";
	const runId = `${timestampStamp()}-${slugify(iterationName)}`;
	ensureDir(RUNS_DIR);
	const runRoot = fs.mkdtempSync(`${containedPath(RUNS_DIR, runId)}-`);

	const startedAt = new Date().toISOString();
	const total = manifest.repos.length;
	info(`Running cohort ${manifest.name} (${total} repos) as ${runId}`);

	const results = await runPool(manifest.repos, jobs, async (repo, index) => {
		info(`[${index + 1}/${total}] ${repo.language} ${repo.owner}/${repo.name}`);
		return scanRepo({ repo, runRoot });
	});

	const report = aggregateResults(manifest, results, {
		runId,
		iteration: iterationName,
		startedAt,
		finishedAt: new Date().toISOString(),
		manifestPath: relativeToRoot(manifestPath),
		runRoot: relativeToRoot(runRoot),
		scanCommand: SCAN_COMMAND_TEMPLATE,
	});

	writeReports(runRoot, report);
	pinRevisions(manifestPath, manifest, results);
	return report;
};
