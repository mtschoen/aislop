import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import vitestConfiguration from "../vitest.config.js";

const executeFile = promisify(execFile);

const captureStatusPost = async (
	reportPath: string,
): Promise<{ body: Record<string, string>; stderr: string; stdout: string }> => {
	let resolveBody: ((body: Record<string, string>) => void) | undefined;
	const receivedBody = new Promise<Record<string, string>>((resolve) => {
		resolveBody = resolve;
	});
	const server = http.createServer((request, response) => {
		let requestBody = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			requestBody += chunk;
		});
		request.on("end", () => {
			resolveBody?.(JSON.parse(requestBody));
			response.writeHead(201).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const { stderr, stdout } = await executeFile(
			"python3",
			["ci/post-coverage-status.py", "--cobertura", reportPath],
			{
				env: {
					...process.env,
					GITHUB_SERVER_URL: `http://127.0.0.1:${port}`,
					GITHUB_REPOSITORY: "schoen/aislop",
					GITHUB_SHA: "abc123",
					GITHUB_RUN_ID: "42",
					GITHUB_TOKEN: "test-token",
				},
			},
		);
		return { body: await receivedBody, stderr, stdout };
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
};

describe("Gitea coverage status", () => {
	it("measures source coverage and always posts the pr-crew status", () => {
		const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8"));
		const coverageJob = workflow.jobs.coverage;

		expect(coverageJob.permissions).toEqual({ contents: "write" });
		expect(coverageJob.steps).toContainEqual(
			expect.objectContaining({
				name: "Measure coverage",
				run: "pnpm test:coverage",
			}),
		);
		expect(coverageJob.steps).toContainEqual(
			expect.objectContaining({
				name: "Post coverage status",
				if: "${{ always() }}",
				env: { GITHUB_TOKEN: "${{ github.token }}" },
				run: 'python3 ci/post-coverage-status.py --cobertura "coverage/cobertura-coverage.xml"',
			}),
		);
	});

	it("configures Vitest to report coverage for all production source files", () => {
		expect(vitestConfiguration.test?.coverage).toMatchObject({
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			reporter: ["text-summary", "cobertura"],
			reportOnFailure: true,
		});

		const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
		expect(packageManifest.scripts["test:coverage"]).toBe("vitest run --coverage");
		expect(packageManifest.devDependencies["@vitest/coverage-v8"]).toBe("4.1.10");
	});

	it("vendors the shared helper with the exact status context", () => {
		const helper = fs.readFileSync("ci/post-coverage-status.py", "utf8");

		expect(helper).toContain('"context": "pr-crew/coverage"');
		expect(helper).toContain('"state": state');
		expect(helper).toContain('f"{percent}% line coverage"');
	});

	it.skipIf(process.platform === "win32")(
		"posts the measured line percentage with a reproducible target URL",
		async () => {
			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-status-helper-"));
			const reportPath = path.join(temporaryDirectory, "coverage.xml");
			fs.writeFileSync(
				reportPath,
				[
					"<coverage><packages><package><classes>",
					'<class filename="src/example.ts"><lines>',
					'<line number="1" hits="1"/><line number="2" hits="1"/>',
					'<line number="3" hits="0"/><line number="4" hits="1"/>',
					"</lines></class></classes></package></packages></coverage>",
				].join(""),
				"utf8",
			);

			try {
				const { body, stdout } = await captureStatusPost(reportPath);

				expect(body).toEqual({
					context: "pr-crew/coverage",
					state: "success",
					description: "75.0% line coverage",
					target_url: expect.stringMatching(/\/schoen\/aislop\/actions\/runs\/42$/),
				});
				expect(stdout).toContain("posted pr-crew/coverage success: 75.0% line coverage");
			} finally {
				fs.rmSync(temporaryDirectory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"posts an error status without masking a missing coverage report",
		async () => {
			const missingReport = path.join(
				os.tmpdir(),
				`aislop-missing-coverage-${process.pid}-${Date.now()}.xml`,
			);

			const { body, stderr, stdout } = await captureStatusPost(missingReport);

			expect(body).toMatchObject({
				context: "pr-crew/coverage",
				state: "error",
				description: "coverage measurement failed",
			});
			expect(stderr).toContain("coverage measurement failed: no Cobertura XML matched");
			expect(stdout).toBe("");
		},
	);
});
