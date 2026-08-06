import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installAntigravity,
	uninstallAntigravity,
} from "../../src/hooks/install/antigravity.js";
import { installCline, uninstallCline } from "../../src/hooks/install/cline.js";
import { installCopilot, uninstallCopilot } from "../../src/hooks/install/copilot.js";
import { installKilocode, uninstallKilocode } from "../../src/hooks/install/kilocode.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("install guards", () => {
	it("skips Antigravity install and uninstall when scope is global", () => {
		const globalOpts = { home, cwd, scope: "global" as const };
		const installResult = installAntigravity(globalOpts);
		expect(installResult.planned).toHaveLength(1);
		expect(installResult.planned[0].summary).toContain("project-scope only");
		expect(uninstallAntigravity(globalOpts)).toEqual({ removed: [], skipped: [] });
	});

	it("skips Cline install and uninstall when scope is global", () => {
		const globalOpts = { home, cwd, scope: "global" as const };
		const installResult = installCline(globalOpts);
		expect(installResult.planned).toHaveLength(1);
		expect(installResult.planned[0].summary).toContain("project-scope only");
		expect(uninstallCline(globalOpts)).toEqual({ removed: [], skipped: [] });
	});

	it("skips Copilot install and uninstall when scope is global", () => {
		const globalOpts = { home, cwd, scope: "global" as const };
		const installResult = installCopilot(globalOpts);
		expect(installResult.planned).toHaveLength(1);
		expect(installResult.planned[0].summary).toContain("project-scope only");
		expect(uninstallCopilot(globalOpts)).toEqual({ removed: [], skipped: [] });
	});

	it("skips Kilocode install and uninstall when scope is global", () => {
		const globalOpts = { home, cwd, scope: "global" as const };
		const installResult = installKilocode(globalOpts);
		expect(installResult.planned).toHaveLength(1);
		expect(installResult.planned[0].summary).toContain("project-scope only");
		expect(uninstallKilocode(globalOpts)).toEqual({ removed: [], skipped: [] });
	});
});
