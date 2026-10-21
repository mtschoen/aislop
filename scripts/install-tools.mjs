#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import * as tar from "tar";

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const TOOLS_BIN_DIR = path.join(PACKAGE_ROOT, "tools", "bin");
const TOOLS_ANALYZERS_DIR = path.join(PACKAGE_ROOT, "tools", "analyzers");
const USER_AGENT = "aislop-installer";
const DOWNLOAD_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Pinned Roslyn analyzer packages whose rules feed the C# lint engine.
// (AsyncFixer01-03, MA0040/42/45, IDISP001: see RELEVANT_IDS in lint/dotnet.ts).
// Bundling their assemblies lets `roslynator analyze --analyzer-assemblies` cover
// projects that don't reference these analyzers themselves. NuGet catalog hashes
// prevent floating versions or altered archives from placing unverified assemblies.
// IDisposableAnalyzers is single-assembly and its IDISP rules are on by default
// (unlike CA2000, which is disabled by default in the SDK analyzers), so it gives
// type-accurate "created but never disposed" detection with no curated type list.
//
// Roslynator.Analyzers is intentionally NOT bundled: its RCS rules aren't in
// RELEVANT_IDS, and its nupkg flattens dependency assemblies under analyzers/dotnet/cs
// with prefixed names that break naive extraction.
const ANALYZER_PACKAGES = [
	{
		id: "AsyncFixer",
		version: "2.1.0",
		sha512: "9exIvSbeCBqtmVeSC6hX9CD9UxtNaWWFbPPte+J3QqjYi2jOP2nt8keuehOrFBeTJXj2j/9PHx99tFltpWpV5Q==",
	},
	{
		id: "Meziantou.Analyzer",
		version: "3.0.123",
		sha512: "NbIeci8/kG8/EWnK1Fs0Clt5BHNNGMGd48CScxGHkPkVX5D4DgSFbOFCELLdJaIvNkS7mkTCBHxqON8PqEZ+sQ==",
	},
	{
		id: "IDisposableAnalyzers",
		version: "4.0.8",
		sha512: "hvk7xMUBwUzUsGaL66zFTsOAp17hKj2XO0Y0rNIwts3iZ0PGF1M6YTAFiQ0tGnJxzsA8oWczc3ZTfaxj91Xwfw==",
	},
];

const PLATFORM_KEY = `${process.platform}-${process.arch}`;

const TOOL_DEFINITIONS = [
	{
		name: "ruff",
		repo: "astral-sh/ruff",
		version: "0.17.1",
		tag: "0.17.1",
		binaryName: "ruff",
		assets: {
			"darwin-arm64": ["ruff-aarch64-apple-darwin.tar.gz"],
			"darwin-x64": ["ruff-x86_64-apple-darwin.tar.gz"],
			"linux-arm64": ["ruff-aarch64-unknown-linux-gnu.tar.gz"],
			"linux-x64": ["ruff-x86_64-unknown-linux-gnu.tar.gz"],
			"win32-arm64": ["ruff-aarch64-pc-windows-msvc.zip"],
			"win32-x64": ["ruff-x86_64-pc-windows-msvc.zip"],
		},
		sha256: {
			"darwin-arm64": "1c8e6e36538eaa0b996378a20c226403c4ca6369ac24884751b024d3a9530b86",
			"darwin-x64": "88ee16f88dba9d440e06375f46898ec85baf578042ad086764d5a33558bb6e17",
			"linux-arm64": "d3ead1f0ed779e777a034ccd9286be6bd9bd3cdaba732ff9797f8288a283e9e2",
			"linux-x64": "a293ac937715ae6fb6b64da86761598379e6149f40fbc00fde9ba8a2a562ac65",
			"win32-arm64": "2f8ba07c7b2b8d1f011056968360e99e9ac7f0815e2d02eaab958255e110b1df",
			"win32-x64": "a841fb7e59680508b9394bfea32e369b3907cc6620a491c65d8d1f479498db82",
		},
	},
	{
		name: "golangci-lint",
		repo: "golangci/golangci-lint",
		version: "2.15.0",
		tag: "v2.15.0",
		binaryName: "golangci-lint",
		assets: {
			"darwin-arm64": [
				"golangci-lint-2.15.0-darwin-arm64.tar.gz",
				"golangci-lint-v2.15.0-darwin-arm64.tar.gz",
			],
			"darwin-x64": [
				"golangci-lint-2.15.0-darwin-amd64.tar.gz",
				"golangci-lint-v2.15.0-darwin-amd64.tar.gz",
			],
			"linux-arm64": [
				"golangci-lint-2.15.0-linux-arm64.tar.gz",
				"golangci-lint-v2.15.0-linux-arm64.tar.gz",
			],
			"linux-x64": [
				"golangci-lint-2.15.0-linux-amd64.tar.gz",
				"golangci-lint-v2.15.0-linux-amd64.tar.gz",
			],
			"win32-arm64": [
				"golangci-lint-2.15.0-windows-arm64.zip",
				"golangci-lint-v2.15.0-windows-arm64.zip",
			],
			"win32-x64": [
				"golangci-lint-2.15.0-windows-amd64.zip",
				"golangci-lint-v2.15.0-windows-amd64.zip",
			],
		},
		sha256: {
			"darwin-arm64": "d1e409481a8ca846c4bc97e781eb5cb1bd5c23353a0b3977a1cbda1b1b6447d5",
			"darwin-x64": "767b899a28285e88ded2823d5dcc4bc5ef681173eb2d80f029a7b17ee4ece3b8",
			"linux-arm64": "b4d8f17068b35ee6060cc2f69a16fb48740d706fbba81661c318649c114a6998",
			"linux-x64": "9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea",
			"win32-arm64": "4fb8988abf186158e30af1b8a0fb3671cf2cb02bc91d7e6ce6996f4c1e922e9a",
			"win32-x64": "cd7ea6063c95de245e17e5246e42bdc14bb221792c429dbd239ab3a6ade6ca6a",
		},
	},
];

const isWindows = process.platform === "win32";
const withExecutableExtension = (name) => (isWindows ? `${name}.exe` : name);

const info = (message) => console.error(`[aislop] ${message}`);
const warn = (message) => console.error(`[aislop] ${message}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const downloadError = (message, retryable) =>
	Object.assign(new Error(message), { retryable });

const downloadFile = async (url, destination) => {
	let lastError = null;
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: { "User-Agent": USER_AGENT },
			});
			if (response.ok && response.body) {
				await pipeline(
					Readable.fromWeb(response.body),
					fs.createWriteStream(destination),
				);
				return;
			}
			const message = `Failed to download ${url} (${response.status})`;
			lastError = downloadError(message, RETRYABLE_HTTP_STATUSES.has(response.status));
			if (!lastError.retryable) throw lastError;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (lastError.retryable === false || attempt === DOWNLOAD_ATTEMPTS) break;
		}
		await sleep(400 * attempt);
	}
	throw lastError ?? new Error(`Failed to download ${url}`);
};

const extractArchive = async (archivePath, extractDir) => {
	if (archivePath.endsWith(".tar.gz")) {
		await tar.x({ file: archivePath, cwd: extractDir });
		return;
	}
	if (archivePath.endsWith(".zip")) {
		const zip = new AdmZip(archivePath);
		zip.extractAllTo(extractDir, true);
		return;
	}
	throw new Error(`Unsupported archive format for ${archivePath}`);
};

const getTagCandidates = (tag) => {
	if (tag.startsWith("v")) {
		return [tag, tag.slice(1)];
	}
	return [tag, `v${tag}`];
};

const getAssetUrls = (tool, assetName) =>
	getTagCandidates(tool.tag).map(
		(tag) =>
			`https://github.com/${tool.repo}/releases/download/${tag}/${assetName}`,
	);

const downloadFromCandidates = async (urls, archivePath) => {
	const failures = [];
	for (const url of urls) {
		try {
			await downloadFile(url, archivePath);
			return url;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(
		`Could not download from candidate URLs: ${failures.join(" | ")}`,
	);
};

const findBinary = (rootDir, binaryName) => {
	const queue = [rootDir];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		const entries = fs.readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (entry.name === binaryName) return fullPath;
		}
	}
	return null;
};

const digestOf = async (filePath, algorithm, encoding) => {
	const hash = createHash(algorithm);
	for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
	return hash.digest(encoding);
};

const installTool = async (tool) => {
	const assetNames = tool.assets[PLATFORM_KEY];
	if (!assetNames || assetNames.length === 0) {
		warn(`No bundled ${tool.name} build for ${PLATFORM_KEY}; skipping.`);
		return false;
	}

	const destinationBinary = path.join(
		TOOLS_BIN_DIR,
		withExecutableExtension(tool.binaryName),
	);
	if (fs.existsSync(destinationBinary)) {
		info(`${tool.name} already present.`);
		return true;
	}

	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), `aislop-${tool.name}-`),
	);
	const archivePath = path.join(tempDir, assetNames[0]);
	const extractDir = path.join(tempDir, "extract");
	fs.mkdirSync(extractDir, { recursive: true });

	try {
		const candidateUrls = assetNames.flatMap((assetName) =>
			getAssetUrls(tool, assetName),
		);
		info(`Downloading ${tool.name} ${tool.version}...`);
		await downloadFromCandidates(candidateUrls, archivePath);
		const actualSha256 = await digestOf(archivePath, "sha256", "hex");
		if (actualSha256 !== tool.sha256[PLATFORM_KEY]) {
			throw new Error(`SHA-256 mismatch for ${tool.name} ${tool.version}`);
		}
		await extractArchive(archivePath, extractDir);

		const extractedBinary = findBinary(
			extractDir,
			withExecutableExtension(tool.binaryName),
		);
		if (!extractedBinary) {
			throw new Error(
				`Unable to locate ${tool.binaryName} in extracted archive`,
			);
		}

		fs.mkdirSync(TOOLS_BIN_DIR, { recursive: true });
		fs.copyFileSync(extractedBinary, destinationBinary);
		if (!isWindows) fs.chmodSync(destinationBinary, 0o755);

		info(`Installed bundled ${tool.name} at ${destinationBinary}`);
		return true;
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
};

// One analyzer DLL per basename, preferring the newest Roslyn-versioned subfolder
// (e.g. analyzers/dotnet/roslyn4.7/cs over roslyn3.8) so we don't load duplicates.
const pickAnalyzerEntries = (zip) => {
	const dllRe = /(?:^|\/)analyzers\/.*\/cs\/[^/]+\.dll$/i;
	const byBasename = new Map();
	for (const entry of zip.getEntries()) {
		if (entry.isDirectory || !dllRe.test(entry.entryName)) continue;
		const basename = path.posix.basename(entry.entryName);
		const existing = byBasename.get(basename);
		if (!existing || entry.entryName > existing.entryName) byBasename.set(basename, entry);
	}
	return [...byBasename.values()];
};

const installAnalyzerPackage = async (
	{ id: packageId, version, sha512 },
	destinationDirectory,
) => {
	const idLower = packageId.toLowerCase();
	const url = `https://api.nuget.org/v3-flatcontainer/${idLower}/${version}/${idLower}.${version}.nupkg`;

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `aislop-${idLower}-`));
	const nupkgPath = path.join(tempDir, `${idLower}.${version}.nupkg`);
	try {
		await downloadFile(url, nupkgPath);
		const actualSha512 = await digestOf(nupkgPath, "sha512", "base64");
		if (actualSha512 !== sha512) {
			throw new Error(`SHA-512 mismatch for ${packageId} ${version}`);
		}
		const entries = pickAnalyzerEntries(new AdmZip(nupkgPath));
		if (entries.length === 0) throw new Error(`no analyzer assemblies inside ${packageId}`);
		for (const entry of entries) {
			fs.writeFileSync(
				path.join(destinationDirectory, path.posix.basename(entry.entryName)),
				entry.getData(),
			);
		}
		info(`Bundled ${entries.length} analyzer assembly(ies) from ${packageId} ${version}`);
		return true;
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
};

const installAnalyzers = async () => {
	const stagingDirectory = `${TOOLS_ANALYZERS_DIR}-${process.pid}`;
	fs.rmSync(stagingDirectory, { recursive: true, force: true });
	fs.mkdirSync(stagingDirectory, { recursive: true });
	try {
		for (const analyzerPackage of ANALYZER_PACKAGES) {
			await installAnalyzerPackage(analyzerPackage, stagingDirectory);
		}
		fs.rmSync(TOOLS_ANALYZERS_DIR, { recursive: true, force: true });
		fs.renameSync(stagingDirectory, TOOLS_ANALYZERS_DIR);
	} catch (error) {
		fs.rmSync(stagingDirectory, { recursive: true, force: true });
		throw error;
	}
};

const main = async () => {
	const failures = [];
	for (const tool of TOOL_DEFINITIONS) {
		try {
			const installed = await installTool(tool);
			if (!installed) {
				failures.push(`${tool.name}: unsupported platform`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${tool.name}: ${message}`);
			warn(`Failed to install ${tool.name}: ${message}`);
		}
	}

	if (failures.length > 0) {
		warn("Some bundled tools could not be installed:");
		for (const failure of failures) {
			warn(`  - ${failure}`);
		}
		warn(
			"aislop will still run, but coverage for those tools may be reduced until installation succeeds.",
		);
		process.exitCode = 1;
		return;
	}

	await installAnalyzers();

	printNextSteps();
};

const printNextSteps = () => {
	if (process.env.CI) return;
	info("Installed. Next:");
	info("  aislop scan     score this repo for AI slop");
	info("  aislop agent    run a coding agent and auto-scan its work");
	info("  Gate every PR for your team, free -> https://scanaislop.com");
};

main().catch((error) => {
	warn(
		`tool installation failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
