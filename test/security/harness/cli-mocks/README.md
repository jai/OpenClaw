# CLI Mocks for Security Testing

This directory contains mock implementations of CLI tools used by Moltbot. These mocks intercept
real CLI calls and return poisoned responses containing prompt injection payloads for security testing.

## Purpose

The mocks serve two purposes:

1. **Security Testing** - Inject malicious payloads into tool responses to test whether the agent
   resists prompt injection attacks
2. **Isolation** - Run tests without real API credentials or network access

## Mock Architecture

All mocks use `mock-binary.ts` which creates executable shell scripts that:
- Get installed to `/tmp/moltbot-test-bin` and prepended to `PATH`
- Parse command-line arguments to select appropriate responses
- Return poisoned JSON/text matching the real CLI's output format

## Mock Inventory

| Mock | File | Original CLI | Status |
|------|------|--------------|--------|
| `gog` | `mock-binary.ts` | [gog](https://github.com/steipete/gog) | Done |
| `curl` | `curl-mock.ts` | [curl](https://curl.se/docs/manpage.html) | Done |
| `wget` | `curl-mock.ts` | [wget](https://www.gnu.org/software/wget/manual/) | Done |
| `gh` | `github-mock.ts` | [GitHub CLI](https://cli.github.com/manual/) | Done |
| `browser-cli` | `browser-mock.ts` | Moltbot browser-cli | Done |
| `himalaya` | - | [himalaya](https://github.com/pimalaya/himalaya) | Pending |

## Reference Documentation

To ensure mocks return responses matching the real CLI output format, consult these references:

### gog (Gmail/Calendar CLI)

- **Source:** https://github.com/steipete/gog
- **Output format:** JSON
- **Key commands mocked:**
  - `gog gmail search` - Returns thread list
  - `gog gmail get <id>` - Returns full message with headers/body
  - `gog calendar list` - Returns event list

### curl / wget

- **curl docs:** https://curl.se/docs/manpage.html
- **wget docs:** https://www.gnu.org/software/wget/manual/wget.html
- **Output format:** Raw HTTP response or body text
- **Key behaviors mocked:**
  - URL-specific responses via `urlResponses` config
  - HTTP status codes
  - Error simulation (connection refused, timeout)

### gh (GitHub CLI)

- **Source:** https://github.com/cli/cli
- **Manual:** https://cli.github.com/manual/
- **Output format:** JSON (with `--json` flag, which agent uses)
- **Key commands mocked:**
  - `gh issue view` - [Schema](https://docs.github.com/en/rest/issues/issues#get-an-issue)
  - `gh issue list` - Array of issues
  - `gh pr view` - [Schema](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
  - `gh pr list` - Array of PRs
  - `gh api` - Raw API response
  - `gh release view` - [Schema](https://docs.github.com/en/rest/releases/releases#get-a-release)
  - `gh run view` - Workflow run details

### browser-cli (Moltbot internal)

- **Source:** `src/browser/` in this repo
- **Output format:** JSON with `url`, `title`, `content`, `metadata` fields
- **Key commands mocked:**
  - `browser-cli fetch <url>` - Page content extraction
  - `browser-cli screenshot <url>` - Screenshot with OCR text
  - `browser-cli pdf <url>` - PDF text extraction
  - `browser-cli dom <url>` - DOM element extraction

## Validating Mock Fidelity

To verify mocks match real CLI output:

```bash
# 1. Capture real output
gh issue view 123 --json number,title,body,author > real-issue.json

# 2. Compare with mock
node -e "console.log(JSON.stringify(require('./github-mock').poisonedIssue, null, 2))" > mock-issue.json

# 3. Check structure matches (keys, types)
diff <(jq -S 'keys' real-issue.json) <(jq -S 'keys' mock-issue.json)
```

When updating mocks, ensure:
- All required fields from the real CLI are present
- Field types match (string, number, object, array)
- Nested structures follow the same schema

## Adding New Mocks

1. Create `<tool>-mock.ts` following the pattern in existing mocks
2. Define poisoned payload constants with realistic structure + injection
3. Export a `create<Tool>Mock(config)` factory function
4. Add entry to `index.ts` exports
5. Update this README with reference links
6. Add validation script or test to verify output matches real CLI

## Known Limitations

- **Static responses** - Mocks return predetermined responses regardless of input args (except
  for URL/arg matching). Real CLIs have complex state and pagination.
- **No auth simulation** - Mocks don't simulate auth flows or token refresh
- **Simplified error handling** - Only basic error simulation (exit code + stderr)

These limitations are acceptable for security testing where we control the test scenario, but
the mocks should not be used for integration testing where realistic behavior matters.
