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

## Quick Start

```bash
# Install
git clone https://github.com/r-marques/testmcp.git
cd testmcp
yarn install
yarn build

# Configure as MCP server in Claude Code
# Add to your settings.json:
{
  "mcpServers": {
    "testmcp": {
      "command": "node",
      "args": ["/path/to/testmcp/dist/index.js"]
    }
  }
}
```

## Tools

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

## How It Works

### The Progressive Disclosure Flow

Instead of dumping 5000 lines of test output, testmcp gives you information in layers:

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
   - 7 lines of source code around the assertion (with >>> marker)
   - Test file and line number
```

**Step 3: Deep dive** — Full stack trace for a single test
```
get_test_detail({ runId: "abc-123", testName: "auth > login > rejects expired token" })
→ Complete error output with full stack trace
```

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
| **Vitest** | `vitest.config.*`, package.json | `--reporter=json` |
| **Pytest** | `pyproject.toml`, `pytest.ini`, `conftest.py` | `--json-report` plugin, or verbose stdout fallback |

testmcp auto-detects the framework and package manager (npm, yarn, pnpm, poetry). No configuration needed.

## Architecture

```
src/
├── index.ts              # Entry: McpServer + StdioServerTransport
├── server.ts             # 8 MCP tool registrations & handlers
├── types.ts              # Core types
├── store.ts              # In-memory test run storage (LRU, 50 runs)
├── adapters/
│   ├── base.ts           # Abstract adapter interface
│   ├── jest.ts           # Jest adapter
│   ├── vitest.ts         # Vitest adapter
│   └── pytest.ts         # Pytest adapter (with fallback parser)
├── git/
│   └── diff-analyzer.ts  # Git diff → affected test files
├── enrichment/
│   └── source-context.ts # Stack trace parser + source snippets
└── utils/
    ├── process.ts        # Child process runner with timeout
    └── detect.ts         # Framework auto-detection
```

## Development

```bash
yarn build    # Compile TypeScript
yarn dev      # Run in dev mode (tsx)
yarn start    # Run compiled server

# E2E test
npx tsx test/e2e.ts test/fixtures/jest-project
```

## License

MIT
