import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageReadFailure = { enabled: false };

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	if (!packageReadFailure.enabled) return actual;
	return {
		...actual,
		readFileSync: vi.fn(() => {
			throw new Error("missing");
		}),
	};
});

describe("APP_VERSION", () => {
	const originalVersion = process.env.VERSION;

	afterEach(() => {
		vi.resetModules();
		if (originalVersion === undefined) {
			delete process.env.VERSION;
		} else {
			process.env.VERSION = originalVersion;
		}
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		if (originalVersion !== undefined) {
			process.env.VERSION = originalVersion;
		} else {
			delete process.env.VERSION;
		}
		packageReadFailure.enabled = false;
	});

	it("falls back to 0.0.0 when package metadata cannot be read", async () => {
		packageReadFailure.enabled = true;
		vi.resetModules();
		delete process.env.VERSION;
		const { APP_VERSION } = await import("../src/version.js");
		expect(APP_VERSION).toBe("0.0.0");
	});
});
