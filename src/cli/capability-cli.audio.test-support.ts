import path from "node:path";

// The POSIX checkout prefix is 40 base64 characters and matches the AWS-secret heuristic.
// Windows resolves the same input to backslash-separated components, without that collision.
export const emptyTranscriptionCases = [
  { input: "/audio/memo.m4a", diagnostic: "/audio/memo.m4a" },
  {
    input: "/home/runner/work/OpenClaw/OpenClaw/memo.m4a",
    diagnostic: "/home/…memo.m4a",
  },
].map(({ input, diagnostic }) => ({
  file: path.resolve(input),
  diagnostic: process.platform === "win32" ? path.resolve(input) : diagnostic,
}));
