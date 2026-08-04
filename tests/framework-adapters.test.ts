import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createViteAislopScripts, createViteAislopWorkflow, runViteAislop } from "../src/framework-adapters/vite.js";
import {
	createAislopPackageScripts,
	createAislopCiWorkflow,
	maybeRunAislop,
	resolveAislopRunRequest,
	type AislopRunRequest,
} from "../src/framework-adapters/core.js";
import {
	createAstroAislopScripts,
	createAstroAislopWorkflow,
} from "../src/framework-adapters/astro.js";
import {
	createExpoAislopScripts,
	createExpoAislopWorkflow,
	runExpoAislop,
} from "../src/framework-adapters/expo.js";
import {
	createNuxtAislopScripts,
	createNuxtAislopWorkflow,
	createAislopNuxtModule,
	runNuxtAislop,
} from "../src/framework-adapters/nuxt.js";
import {
	createSvelteKitAislopScripts,
	createSvelteKitAislopWorkflow,
	runSvelteKitAislop,
} from "../src/framework-adapters/sveltekit.js";
import aislopAstro from "../src/framework-adapters/astro.js";
import aislopSvelteKit from "../src/framework-adapters/sveltekit.js";
import aislopVite from "../src/framework-adapters/vite.js";
import withAislopExpo from "../src/framework-adapters/expo.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

beforeEach(() => {
	spawnMock.mockReset();
});

afterEach(() => {
	spawnMock.mockReset();
});

const recordingRunner = (calls: AislopRunRequest[]) => async (request: AislopRunRequest) => {
	calls.push(request);
	return {
		command: request.bin,
		args: request.args,
		exitCode: 0,
		signal: null,
		skipped: false,
	};
};

const buildAislopChild = (exitCode: number | null = 0, signal: NodeJS.Signals | null = null) => {
	const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
	spawnMock.mockImplementation(() => {
		setImmediate(() => {
			child.emit("close", exitCode, signal);
		});
		return child;
	});
};

describe("framework adapters", () => {
	it("resolves command defaults without enabling execution", async () => {
		const request = resolveAislopRunRequest("astro", { args: ["--changes"] });

		expect(request.bin).toBe("aislop");
		expect(request.args).toEqual(["ci", "--changes"]);

		const skipped = await maybeRunAislop("astro", { args: ["--changes"] });
		expect(skipped).toMatchObject({
			command: "aislop",
			args: ["ci", "--changes"],
			exitCode: 0,
			skipped: true,
		});
	});

	it("generates package scripts and workflows across frameworks", () => {
		expect(createAislopPackageScripts("expo")).toEqual({
			"aislop:agent": "aislop agent",
			"aislop:ci": "aislop ci",
			"aislop:hook": "aislop hook install",
			"aislop:scan": "aislop scan",
		});
		expect(createViteAislopScripts()).toHaveProperty("aislop:build-gate", "aislop ci --changes");
		expect(createNuxtAislopScripts()).toHaveProperty("aislop:scan", "aislop scan");
		expect(createExpoAislopScripts()).toHaveProperty("aislop:ci", "aislop ci");
		expect(createSvelteKitAislopScripts()).toHaveProperty("aislop:agent", "aislop agent");

		expect(createAislopCiWorkflow()).toContain("npx --yes aislop@latest ci");
		expect(createViteAislopWorkflow()).toContain("npx --yes aislop@latest ci");
		expect(createNuxtAislopWorkflow()).toContain("npx --yes aislop@latest ci");
		expect(createExpoAislopWorkflow()).toContain("npx --yes aislop@latest ci");
		expect(createSvelteKitAislopWorkflow()).toContain("npx --yes aislop@latest ci");
		expect(createAstroAislopWorkflow()).toContain("npx --yes aislop@latest ci");
	});

	it("builds an Astro integration with opt-in build execution", async () => {
		const calls: AislopRunRequest[] = [];
		const integration = aislopAstro({ enabled: true, runner: recordingRunner(calls) });

		expect(integration.name).toBe("@scanaislop/astro");
		expect(createAstroAislopScripts()["aislop:ci"]).toBe("aislop ci");

		await integration.hooks["astro:build:start"]?.();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.framework).toBe("astro");
	});

	it("runs Vite and SvelteKit plugins through build hooks only when enabled", async () => {
		const calls: AislopRunRequest[] = [];
		const vite = aislopVite({ enabled: true, runner: recordingRunner(calls), hook: "buildStart" });
		const svelte = aislopSvelteKit({ enabled: true, runner: recordingRunner(calls) });

		expect(vite.name).toBe("aislop:vite");
		expect(vite.apply).toBe("build");

		await vite.buildStart?.();
		await svelte.closeBundle?.();

		expect(calls.map((call) => call.framework)).toEqual(["vite", "sveltekit"]);
	});

	it("resolves default runners and throws when aislop fails", async () => {
		buildAislopChild(2, null);

		await expect(maybeRunAislop("astro", { enabled: true })).rejects.toThrow(
			"aislop ci failed for astro with exit code 2",
		);
	});

	it("calls default runner through framework entry points", async () => {
		buildAislopChild(0, null);
		const calls: AislopRunRequest[] = [];

		const nuxtResult = await runNuxtAislop({ enabled: true, runner: undefined });
		const expoResult = await runExpoAislop({ enabled: true, runner: undefined });
		const svelteResult = await runSvelteKitAislop({ enabled: true, runner: recordingRunner(calls) });
		const viteResult = await runViteAislop({ enabled: true, runner: undefined });

		expect(nuxtResult.exitCode).toBe(0);
		expect(expoResult.exitCode).toBe(0);
		expect(svelteResult.exitCode).toBe(0);
		expect(viteResult.exitCode).toBe(0);
		expect(calls.map((call) => call.framework)).toEqual(["sveltekit"]);
	});

	it("registers a Nuxt build hook and runs through the injected runner", async () => {
		const calls: AislopRunRequest[] = [];
		let callback: (() => Promise<void>) | null = null;
		const module = createAislopNuxtModule({ enabled: true, runner: recordingRunner(calls) });
		expect(module.meta.name).toBe("@scanaislop/nuxt");
		expect(module.meta.configKey).toBe("aislop");

		module.setup(
			{},
			{
				hook(name, cb) {
					expect(name).toBe("build:before");
					callback = cb;
				},
			},
		);

		await callback?.();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.framework).toBe("nuxt");
	});

	it("injects an aislop plugin section into Expo config", () => {
		const config = withAislopExpo({
			extra: {
				existing: true,
			},
		});

		expect(config).toMatchObject({
			extra: {
				existing: true,
				aislop: {
					command: "npx --yes aislop@latest ci",
					hook: "aislop hook install",
					enabled: true,
				},
			},
		});
	});
});
