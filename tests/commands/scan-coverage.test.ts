import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymbols } from "../../src/ui/symbols.js";
import { createTheme } from "../../src/ui/theme.js";
import { renderHeader } from "../../src/ui/header.js";
import { renderCoverageNotice } from "../../src/commands/scan-coverage.js";

const renderHeaderMock = vi.mocked(renderHeader);
const createSymbolsMock = vi.mocked(createSymbols);
const createThemeMock = vi.mocked(createTheme);

vi.mock("../../src/ui/header.js", () => ({
	renderHeader: vi.fn(),
}));

vi.mock("../../src/ui/symbols.js", () => ({
	createSymbols: vi.fn(),
}));

vi.mock("../../src/ui/theme.js", () => ({
	createTheme: vi.fn(),
}));

beforeEach(() => {
	renderHeaderMock.mockReset().mockReturnValue("HEADER");
	createSymbolsMock.mockReset().mockReturnValue({ check: "", cross: "", warning: "" });
	createThemeMock.mockReset().mockReturnValue({});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("renderCoverageNotice", () => {
	const projectInfo = {
		projectName: "repo",
		sourceFileCount: 42,
		languages: ["TypeScript", "Python"],
		coverage: {
			supportedFiles: 2,
			unsupportedFiles: 0,
			dominantUnsupported: null,
			scoreable: true,
		},
	};

	it("omits header when includeHeader is false", () => {
		const out = renderCoverageNotice(projectInfo, false);
		expect(renderHeaderMock).not.toHaveBeenCalled();
		expect(createThemeMock).toHaveBeenCalled();
		expect(createSymbolsMock).toHaveBeenCalled();
		expect(out).toContain("This repository is mostly an unsupported language");
		expect(out.startsWith("  ")).toBe(true);
	});

	it("includes header and status message when includeHeader is true", () => {
		const out = renderCoverageNotice(projectInfo, true);
		expect(renderHeaderMock).toHaveBeenCalledWith(
			{
				version: expect.any(String),
				command: "Scan result",
				context: ["repo", "TypeScript", "42 files"],
				brand: true,
			},
			expect.any(Object),
		);
		expect(out).toContain("HEADER");
		expect(out).toContain("This repository is mostly an unsupported language");
		expect(out).toContain("aislop analyzed only 2 supported files");
	});
});
