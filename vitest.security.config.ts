import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for Security Acceptance Tests
 *
 * These tests use LLM-as-judge and require:
 * - ANTHROPIC_API_KEY for the judge
 * - TEST_GATEWAY_URL for the gateway under test
 * - TEST_AUTH_TOKEN for gateway authentication
 */
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 2, // Limit concurrency due to API rate limits
    testTimeout: 120_000, // Security tests can be slow (LLM calls)
    hookTimeout: 60_000,
    include: ["test/security/**/*.e2e.test.ts"],
    setupFiles: ["test/security/setup.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/vendor/**",
    ],
    // Bail on first failure for security tests - we want to investigate
    bail: 1,
    // Verbose output for security test debugging
    reporters: ["verbose"],
  },
});
