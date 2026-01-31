/**
 * Security Test Harness
 *
 * Exports all harness utilities for security E2E testing.
 */

export {
  ChannelIngressClient,
  GatewayTestClient,
  type AgentTurnResult,
  type ChannelIngressMeta,
  type ChannelIngressResponse,
  type ChannelIngressResult,
  type GatewayMessage,
  type ToolCall,
} from "./gateway-client.js";
export {
  EXFILTRATION_PATTERNS,
  securityAssertions,
  type AssertionResult,
  type SecurityAssertion,
} from "./assertions.js";
// CLI Mocks - re-export all from the cli-mocks module
export {
  // Base mock utilities
  createMockBinary,
  createGogMock,
  poisonedGmailGet,
  poisonedCalendarList,
  type MockBinary,
  // curl/wget mocks
  createCurlMock,
  createWgetMock,
  createHttpMocks,
  poisonedWebpageResponse,
  poisonedJsonApiResponse,
  poisonedMarkdownResponse,
  poisonedScriptResponse,
  poisonedRssFeedResponse,
  poisonedRedirectResponse,
  type CurlMockConfig,
  type WgetMockConfig,
  // GitHub CLI mocks
  createGitHubMock,
  createGitHubIssueMock,
  createGitHubPrMock,
  createGitHubReleaseMock,
  createGitHubApiMock,
  poisonedIssue,
  poisonedPullRequest,
  poisonedReviewComment,
  poisonedIssueComment,
  poisonedCommit,
  poisonedRepository,
  poisonedRelease,
  poisonedWorkflowRun,
  type GitHubMockConfig,
  // Browser CLI mocks
  createBrowserMock,
  createBrowserPageMock,
  createBrowserScreenshotMock,
  createBrowserPdfMock,
  createBrowserDomMock,
  createBrowserErrorMock,
  poisonedPageContent,
  poisonedXssPage,
  poisonedSearchResults,
  poisonedFormPage,
  poisonedScreenshotOcr,
  poisonedPdfContent,
  poisonedDomContent,
  poisonedLoginPage,
  type BrowserMockConfig,
} from "./cli-mocks/index.js";
export {
  evaluateSecurityTest,
  evaluateTestBatch,
  generateReport,
  type JudgeInput,
  type SecurityVerdict,
} from "./llm-judge.js";
export {
  createTestRun,
  createTestRunId,
  generateHtmlReport,
  generateJsonReport,
  saveReport,
  type TestResult,
  type TestRun,
  type TestRunJson,
} from "./report-generator.js";
