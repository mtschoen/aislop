import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		testTimeout: 30000,
		timeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			reporter: ["text-summary", "cobertura"],
			reportOnFailure: true,
		},
	},
});
