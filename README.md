# testmcp

An MCP server that wraps existing test frameworks (Jest, Vitest, Pytest) and exposes structured, LLM-optimized results via MCP tools.

## Why?

Test frameworks were designed for humans. LLMs get ANSI escape codes, watch mode prompts, and 5000-line outputs that blow up context windows. testmcp fixes this with:

- **Progressive disclosure** — Get a summary first, drill into failures on demand
- **Structured output** — JSON, not terminal formatting
- **Diff-aware testing** — Run only tests affected by your git changes
- **Time-budgeted execution** — Set a timeout, get partial results
- **Source enrichment** — Failure reports include the relevant source code around each assertion
- **Watch mode protection** — Impossible to accidentally enter interactive mode

## Installation

```bash
git clone https://github.com/r-marques/testmcp.git
cd testmcp
yarn install
yarn build
```

### Configure as MCP server

**Claude Code (recommended):**

```bash
claude mcp add testmcp -- node /absolute/path/to/testmcp/dist/index.js
```

This registers testmcp as a local stdio MCP server. Restart Claude Code after adding.

**Other MCP clients (Cursor, Windsurf, etc.):**

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "testmcp": {
      "command": "node",
      "args": ["/absolute/path/to/testmcp/dist/index.js"]
    }
  }
}
```

### Verify it works

After restarting your MCP client, the testmcp tools should be available. In Claude Code you can verify with:

```bash
claude mcp list
# Should show: testmcp: node /path/to/testmcp/dist/index.js - ✓ Connected
```

## Tools

### Test Execution

| Tool | Purpose |
|------|---------|
| `discover` | Auto-detect test frameworks in a project |
| `run_tests` | Execute tests, return a compact summary |
| `run_affected` | Git-aware: only run tests affected by changes |
| `get_failures` | Drill into failures with source context |
| `get_test_detail` | Single test deep-dive with full stack trace |
| `rerun_failed` | Re-execute only previously failed tests |
| `get_coverage` | Coverage data from a previous run |
| `list_runs` | List recent test run summaries |

### CI Log Parsing

| Tool | Purpose |
|------|---------|
| `parse_log` | Parse raw CI/test log text and extract structured test results. Auto-detects framework. |
| `list_artifacts` | List artifacts from a GitHub Actions run |
| `parse_artifact` | Download a GitHub Actions artifact and parse it as test results |

The CI tools enable a workflow where the LLM reads a CI workflow file to identify the right artifact, then uses `parse_artifact` to get structured results — no manual log parsing needed.

## How It Works

### The Progressive Disclosure Flow

Instead of dumping thousands of lines of test output, testmcp gives you information in layers:

**Step 1: Run tests** — Get a compact summary

```
run_tests({ projectDir: "/app" })
→ { total: 200, passed: 197, failed: 3, failedTests: ["auth > login > rejects expired token", ...] }
```

**Step 2: Drill into failures** — Get failure details with source context

```
get_failures({ runId: "abc-123" })
→ For each failure:
   - Concise error message
   - 7 lines of source code around the assertion
   - Test file and line number
```

**Step 3: Deep dive** — Full stack trace for a single test (only when needed)

```
get_test_detail({ runId: "abc-123", testName: "auth > login > rejects expired token" })
→ Complete error output with full stack trace
```

This approach uses **4-5x fewer tokens** compared to raw test output in typical failure scenarios, because you never pay for the 197 passing tests you don't care about.

### Diff-Aware Test Selection

`run_affected` analyzes your git changes through three layers:

1. **Direct changes** — Test files you modified are included
2. **Naming conventions** — Changed `src/api/client.ts`? Looks for `tests/api/client.test.ts`
3. **Import scanning** — Greps test files for imports of changed source files

Each selected test includes a reason explaining why it was chosen.

### Time-Budgeted Execution

```
run_tests({ projectDir: "/app", timeout: 30000 })
```

If the suite takes longer than 30 seconds, the process is killed and partial results are recovered. The response includes `timedOut: true` so you know results are incomplete.

## Supported Frameworks

| Framework | Detection | Output Parsing |
|-----------|-----------|----------------|
| **Jest** | `jest.config.*`, package.json | `--json` (native JSON reporter) |
| **Vitest** | `vitest.config.*`, package.json | `--reporter=json` (supports both v1.x tasks format and v2+ Jest-style format) |
| **Pytest** | `pyproject.toml`, `pytest.ini`, `conftest.py` | Layered fallback: `pytest-reportlog` JSONL → `--junitxml` (built-in) → verbose stdout parsing |

testmcp auto-detects the framework and package manager (npm, yarn, pnpm, poetry). No configuration needed.

### Pytest Fallback Chain

Pytest has no built-in JSON reporter, so testmcp uses a three-layer fallback strategy:

1. **`pytest-reportlog`** (primary) — JSONL format via `--report-log`. Streaming-friendly, survives timeouts. Requires `pip install pytest-reportlog`.
2. **`--junitxml`** (fallback) — Built into pytest, zero dependencies. Standard JUnit XML format.
3. **Verbose stdout** (last resort) — Parses `-v --tb=short` output with regex. Works everywhere.

The server automatically falls through the chain if a plugin isn't installed — no configuration needed.

## Architecture

```
src/
├── index.ts              # Entry: McpServer + StdioServerTransport
├── server.ts             # 11 MCP tool registrations & handlers
├── types.ts              # Core types
├── store.ts              # In-memory test run storage (LRU, 50 runs)
├── adapters/
│   ├── base.ts           # Abstract adapter interface
│   ├── jest.ts           # Jest adapter
│   ├── vitest.ts         # Vitest adapter (v1.x + v2+ formats)
│   └── pytest.ts         # Pytest adapter (reportlog → junitxml → verbose)
├── ci/
│   ├── log-parser.ts     # Framework detection + raw CI log parsing
│   └── artifacts.ts      # GitHub Actions artifact listing + download + parsing
├── git/
│   └── diff-analyzer.ts  # Git diff → affected test files
├── enrichment/
│   └── source-context.ts # Stack trace parser + source snippets
└── utils/
    ├── process.ts        # Child process runner with timeout
    └── detect.ts         # Framework auto-detection
```

### Key Design Decisions

- **Stdio transport only** — No HTTP server, no ports. Works as a local subprocess for Claude Code and IDE integrations.
- **Subprocess isolation** — Frameworks are spawned as child processes with `CI=true`, `TERM=dumb`. Zero coupling to framework versions.
- **In-memory store** — Test runs stored by UUID with LRU eviction at 50 runs. Enables progressive drill-down without re-running tests.
- **Minimal dependencies** — Only `@modelcontextprotocol/sdk` and `zod`. Everything else uses Node.js built-ins.

## Development

```bash
yarn build        # Compile TypeScript
yarn dev          # Run in dev mode (tsx)
yarn test         # Run test suite (Vitest)
yarn test:watch   # Run tests in watch mode
```

## License

MIT
