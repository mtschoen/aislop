import { describe, expect, it } from "vitest";
import { parseGithubSlug } from "../../src/utils/github-slug.js";

describe("parseGithubSlug", () => {
	it.each([
		["ssh remotes and strips .git", "git@github.com:scanaislop/aislop.git"],
		["https remotes", "https://github.com/scanaislop/aislop"],
		[
			"https remotes with an auth token and trailing newline",
			"https://x-access-token:abc123@github.com/scanaislop/aislop.git\n",
		],
	])("parses %s", (_kind, remote) => {
		expect(parseGithubSlug(remote)).toEqual({
			owner: "scanaislop",
			repo: "aislop",
		});
	});

	it("keeps dots in repo names while stripping a trailing .git", () => {
		expect(parseGithubSlug("git@github.com:vercel/next.js.git")).toEqual({
			owner: "vercel",
			repo: "next.js",
		});
		expect(parseGithubSlug("https://github.com/socketio/socket.io")).toEqual({
			owner: "socketio",
			repo: "socket.io",
		});
	});

	it("returns null for non-github or malformed remotes", () => {
		expect(parseGithubSlug("git@gitlab.com:foo/bar.git")).toBeNull();
		expect(parseGithubSlug("https://example.com/foo/bar")).toBeNull();
		expect(parseGithubSlug("not a url")).toBeNull();
		expect(parseGithubSlug("")).toBeNull();
	});
});
