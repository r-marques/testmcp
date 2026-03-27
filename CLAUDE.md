# CLAUDE.md — testmcp

## What is this?

An MCP server that wraps existing test frameworks (Jest, Vitest, Pytest) and exposes structured, LLM-optimized results via MCP tools. Uses stdio transport for Claude Code / IDE integration.

## Commands

```bash
yarn build          # Compile TypeScript → dist/
yarn start          # Run the MCP server (stdio transport)
yarn dev            # Run in dev mode via tsx
```

## Architecture

```
src/
├── index.ts                # Entry: McpServer + StdioServerTransport
├── server.ts               # 8 MCP tool registrations & handlers
├── types.ts                # Core types (TestResult, TestRunSummary, etc.)
├── store.ts                # In-memory test run storage (LRU, max 50 runs)
├── adapters/
│   ├── base.ts             # Abstract adapter interface
│   ├── jest.ts             # Jest adapter (--json, assertionResults, name field)
│   ├── vitest.ts           # Vitest adapter (run --reporter=json, nested tasks)
│   └── pytest.ts           # Pytest adapter (--json-report, fallback stdout parsing)
├── git/
│   └── diff-analyzer.ts    # Git diff → affected test files (3 layers)
├── enrichment/
│   └── source-context.ts   # Stack trace parser + source code snippet reader
└── utils/
    ├── process.ts          # Child process runner with timeout/abort
    └── detect.ts           # Framework auto-detection from config files
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `discover` | Auto-detect test frameworks in a project |
| `run_tests` | Execute tests, return compact summary |
| `run_affected` | Git-aware: only run tests affected by changes |
| `get_failures` | Drill into failures with source context |
| `get_test_detail` | Single test deep-dive with full stack trace |
| `rerun_failed` | Re-execute only previously failed tests |
| `get_coverage` | Coverage data from a previous run |
| `list_runs` | List recent test run summaries |

## Key Design Decisions

- **Stdio transport only** — no HTTP server, no ports
- **Progressive disclosure** — `run_tests` returns summary only; drill into details on demand
- **Subprocess isolation** — frameworks spawned via `child_process.spawn` with `CI=true`, `TERM=dumb`
- **In-memory store** — test runs stored by UUID, LRU eviction at 50 runs

## Important: Never Guess Framework Output Formats

Jest, Vitest, and Pytest JSON output schemas vary by version. Always verify against actual output:

- **Jest**: Uses `testResults[].name` (NOT `testFilePath`) for file path, `assertionResults` (NOT `testResults`) for individual tests
- **Vitest**: Uses nested `tasks` with `type: 'test' | 'suite'` structure
- **Pytest**: Layered fallback — `pytest-reportlog` JSONL (primary) → `--junitxml` built-in XML (fallback 1) → verbose stdout parsing (fallback 2)

When modifying adapters, always test against a real project's actual JSON output before assuming field names.

## Testing the Server

```bash
# Quick smoke test — verify initialize + tools/list
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | timeout 5 node dist/index.js 2>/dev/null | tail -1 | python3 -m json.tool

# Test discover against a project
printf '...\n...\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discover","arguments":{"projectDir":"/path/to/project"}}}\n' | timeout 10 node dist/index.js 2>/dev/null | tail -1 | python3 -m json.tool
```

## Dependencies

- **Runtime**: `@modelcontextprotocol/sdk` ^1.25.2, `zod` 3.25 || ^4.0
- **Dev**: `typescript` ^5.9.2, `tsx` ^4.20.3
- **Zero other deps** — uses Node.js built-ins (`node:fs/promises`, `node:child_process`, `crypto.randomUUID()`)

## Configuring as MCP Server

Add to Claude Code's MCP config (`.claude/settings.json` or equivalent):
```json
{
  "mcpServers": {
    "testmcp": {
      "command": "node",
      "args": ["/home/rodmar/code/testmcp/dist/index.js"]
    }
  }
}
```
