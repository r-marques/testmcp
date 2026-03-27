# testmcp: An MCP Server for LLM-Friendly Test Running

## The Problem

Modern test frameworks — Jest, Pytest, Vitest, Mocha — were designed for humans sitting in front of a terminal. They produce colorful, interactive output optimized for human eyes. As LLMs increasingly write, debug, and maintain code, these frameworks become a bottleneck: the interface between "run tests" and "understand results" is fundamentally mismatched.

This document captures what we discovered exploring this problem space, the specific pain points, what already exists, and what we intend to build.

---

## Pain Points: An LLM's Perspective on Test Frameworks

### 1. Output is Designed for Human Eyes

Test frameworks output ANSI color codes, progress spinners, animated bars, and formatted tables. An LLM receives this as raw text filled with escape sequences that consume tokens without adding information.

**Example of what an LLM actually sees:**
```
\u001b[1m\u001b[32m PASS \u001b[39m\u001b[22m src/utils/__tests__/parser.test.ts
  Parser
    \u001b[32m✓\u001b[39m \u001b[2mshould parse valid input (3 ms)\u001b[22m
    \u001b[31m✕\u001b[39m \u001b[2mshould reject malformed input (5 ms)\u001b[22m
```

**What the LLM actually needs:**
```json
{ "name": "should reject malformed input", "status": "failed", "duration": 5 }
```

JSON reporters exist in some frameworks (`jest --json`, `vitest --reporter=json`) but they're afterthoughts — poorly documented, inconsistent across frameworks, and not the default.

### 2. Watch Mode is Hostile

Jest defaults to watch mode in interactive terminals. Vitest has `--watch` as default behavior. These modes wait for keypresses, re-run on file changes, and present menus — all completely unusable for an LLM.

LLMs have to remember tricks like `--watchAll=false`, `CI=true`, or `vitest run` to avoid getting stuck in an interactive session. When they forget, the process hangs and times out.

### 3. Timeouts and the Background Job Dance

LLM tool environments typically have execution timeouts (e.g., 2 minutes in Claude Code). A test suite that takes 3 minutes forces the LLM into an awkward pattern:

1. Start the test in the background
2. Wait (how long? guess.)
3. Read the output file
4. If not done, wait more
5. Parse whatever came back

There is no "run for 60 seconds, give me what you have, continue in background" mode.

### 4. All-or-Nothing Output

A test suite with 500 tests produces thousands of lines of output. The LLM either gets all of it (blowing up its context window with passing tests it doesn't care about) or gets truncated output that might cut off right before the one failure that matters.

What the LLM wants is progressive disclosure:
- **First:** "500 tests: 497 passed, 3 failed. Failed: test_a, test_b, test_c" (2 lines)
- **On demand:** Full failure details for test_a with source context
- **On demand:** The complete stack trace for test_b

No existing test framework works this way.

### 5. No Diff-Awareness

After modifying a function, an LLM wants to know: "which tests cover what I just changed?" Some tools exist (`jest --changedSince`, `pytest --lf`) but they're unreliable, framework-specific, and require git integration that's not always configured.

The ideal flow:
1. LLM changes `src/api/client.ts`
2. Test tool automatically determines that `tests/api/client.test.ts` and `tests/integration/api.test.ts` are affected
3. Only those tests run
4. Result comes back in seconds, not minutes

### 6. Failure Messages Lack Context

When a test fails, the LLM gets an assertion error and a stack trace. To understand the failure, it needs to:
1. Read the test file at the failure line
2. Read the source file referenced in the stack trace
3. Understand the relationship between the two

This requires 2-3 additional file reads, burning tokens and round-trips. The test runner already knows where the failure is — it should provide the surrounding source code automatically.

### 7. Framework Fragmentation

A monorepo might use Jest for the frontend, Vitest for a library, and Pytest for the backend. The LLM needs to remember different commands, flags, and output formats for each. There's no unified interface.

---

## What Already Exists

We surveyed the current landscape of MCP test runners and LLM-friendly test tooling:

### privsim/mcp-test-runner
- **What it does:** Unified MCP server supporting Jest, Pytest, Vitest, Bats, Flutter, Go, Rust
- **Strengths:** Multi-framework, structured `TestResult`/`TestSummary` interfaces, security validation
- **Gaps:** No progressive detail model (returns everything at once), no diff-aware test selection, no time budgeting, no source enrichment, basic output parsing

### vitest-mcp (djankies)
- **What it does:** Vitest-specific MCP server optimized for LLM consumption
- **Strengths:** AI-optimized output (limits verbosity), console log capture, line-by-line coverage, safety guards against watch mode, adaptive output sizing
- **Gaps:** Vitest-only (no Jest, no Pytest), no diff-awareness, no time budgeting, no progressive drill-down via separate tools

### mcp-pytest-runner
- **What it does:** Pytest-specific MCP implementation
- **Strengths:** Intelligent test selection, context-aware recommendations
- **Gaps:** Pytest-only, no multi-framework support

### test-mcp (Loadmill)
- **What it does:** Automated testing tool for MCP servers themselves (tests the server, not your code)
- **Not the same problem space** — this tests MCP servers, not application code

### Common Gaps Across All Solutions

| Capability | privsim | vitest-mcp | pytest-runner | **Needed** |
|-----------|---------|------------|---------------|-----------|
| Multi-framework | Yes | No | No | Yes |
| Progressive detail | No | Partial | No | Yes |
| Diff-aware selection | No | No | No | Yes |
| Time-budgeted execution | No | No | No | Yes |
| Failure source enrichment | No | No | No | Yes |
| Watch mode protection | Partial | Yes | N/A | Yes |
| Coverage integration | No | Yes | No | Yes |
| Run history / re-run failed | No | No | No | Yes |

---

## What We Intend to Build

### testmcp

A standalone MCP server that wraps existing test frameworks and exposes structured, LLM-optimized results via MCP tools. It does **not** replace Jest/Pytest/Vitest — it runs them as subprocesses and normalizes their output.

### Core Principles

1. **Progressive disclosure over dump-everything.** The LLM gets a summary first. It can drill into failures on demand. Full stack traces and raw output are available but never forced.

2. **Frameworks as adapters, not dependencies.** testmcp spawns `npx jest` or `python -m pytest` as child processes. It has zero coupling to framework versions. Adding a new framework means implementing one adapter class.

3. **Structured by default, human-readable on request.** Every response is JSON. If a human wants to read it, they can format it. The LLM should never have to parse ANSI escape codes.

4. **Safety as a feature.** Watch mode is impossible. `CI=true` and `TERM=dumb` are always set. Processes are spawned in isolated process groups. Time budgets are enforced with `SIGTERM` → `SIGKILL`.

5. **Git-native intelligence.** The server understands git diffs and can determine which tests are affected by recent changes, reducing test execution from minutes to seconds.

### Architecture Overview

```
LLM (Claude Code, Cursor, etc.)
    |
    | MCP protocol (stdio)
    v
testmcp MCP Server
    |
    ├── discover      → detect frameworks in a project
    ├── run_tests     → execute tests, return summary
    ├── run_affected  → git-aware selective testing
    ├── get_failures  → drill into failures with source context
    ├── get_test_detail → single test deep-dive
    ├── rerun_failed  → re-run only what failed
    ├── get_coverage  → coverage data on demand
    └── list_runs     → test run history
    |
    ├── Jest Adapter     → npx jest --json --watchAll=false
    ├── Vitest Adapter   → npx vitest run --reporter=json
    └── Pytest Adapter   → python -m pytest (reportlog → junitxml → verbose)
```

### The Progressive Disclosure Flow

This is the key interaction pattern that makes testmcp different:

```
Step 1: LLM calls run_tests({ projectDir: "/app" })
  → Response: { runId: "abc-123", total: 200, passed: 197, failed: 3,
                failedTests: ["auth > login > rejects expired token",
                              "api > users > handles missing field",
                              "utils > parse > edge case unicode"] }
  → 2 lines of useful information. Zero noise.

Step 2: LLM calls get_failures({ runId: "abc-123" })
  → Response: Array of 3 TestResult objects, each with:
    - Concise failure message
    - Source context: 7 lines of code around the assertion
    - Source context: 7 lines of the source file at the failure point
  → LLM can now fix the bugs without reading any files.

Step 3 (if needed): LLM calls get_test_detail({ runId: "abc-123", testName: "auth > login > rejects expired token" })
  → Response: Full stack trace, complete error output
  → Only fetched when the concise info wasn't enough.
```

Compare this to today: the LLM gets 5000 lines of terminal output, searches for "FAIL", tries to parse the assertion error, then makes 3 separate file-read calls to understand the context.

### Diff-Aware Test Selection

The `run_affected` tool analyzes git changes through three layers:

1. **Direct changes** — If a test file itself was modified, include it
2. **Naming conventions** — If `src/api/client.ts` changed, look for `tests/api/client.test.ts`, `src/api/__tests__/client.test.ts`, etc.
3. **Import scanning** — Grep test files for imports of the changed source files

Each selected test includes a **reason** explaining why it was chosen, so the LLM (and the developer) can verify the selection makes sense.

### Time-Budgeted Execution

Instead of "run all tests and hope it finishes in time":

```
run_tests({ projectDir: "/app", timeout: 30000 })
```

If the test suite takes longer than 30 seconds, the process is killed and partial results are recovered from the JSON output file. The response includes `timedOut: true` and `partial: true` flags so the LLM knows the results are incomplete and can decide whether to run the remaining tests.

### Technology Choices

- **TypeScript** — Matches the MCP SDK ecosystem, runs on Node.js (same runtime as Jest/Vitest)
- **Stdio transport** — Zero configuration for Claude Code and IDE integrations. No ports, no HTTP, no sessions.
- **Minimal dependencies** — Only `@modelcontextprotocol/sdk` and `zod`. Everything else uses Node.js built-ins.
- **No framework dependencies** — Jest, Vitest, and Pytest are invoked as external processes, not imported as libraries

### What This Is Not

- **Not a replacement for Jest/Pytest/Vitest.** It wraps them. Your existing tests, configs, and plugins work unchanged.
- **Not a test-writing tool.** It runs and reports on tests. It doesn't generate them.
- **Not a CI system.** It's a local development tool that runs via MCP stdio, designed for real-time interaction with LLMs.

---

## Data Source Research: How to Get Structured Results from Each Framework

A key design decision for testmcp is *how* to extract structured test results from each framework. We evaluated five approaches, from most integrated to most portable.

### Approach 1: Programmatic APIs (Import the Framework)

**Idea:** Import Jest/Vitest/Pytest as a library and invoke tests programmatically, receiving results as native data structures.

| Framework | API | Status |
|-----------|-----|--------|
| Jest | `@jest/core` `runCLI()` | Exists but tightly coupled to Jest version; breaks across majors |
| Vitest | `vitest/node` `createVitest()` | Unstable API, changed significantly between 1.x and 2.x |
| Pytest | `pytest.main()` | Returns only exit codes; results require plugins or hooks |

**Trade-offs:**
- (+) Richest data, lowest latency, no parsing
- (-) Framework version coupling — testmcp would need to match the project's exact framework version
- (-) Node.js runtime can't import Python's pytest
- (-) Plugin/config loading is fragile when invoked programmatically
- (-) Breaking API changes across major versions require constant maintenance

**Verdict:** Rejected. The version coupling alone is disqualifying — a tool that wraps test frameworks can't depend on specific versions of those frameworks.

### Approach 2: Custom Reporters / Plugins

**Idea:** Write a custom Jest reporter, Vitest reporter, or Pytest plugin that emits structured output in our format.

| Framework | Mechanism | Complexity |
|-----------|-----------|------------|
| Jest | Custom reporter class (`onTestResult`, `onRunComplete`) | Medium |
| Vitest | Custom reporter (`onFinished`) | Medium |
| Pytest | `conftest.py` plugin with `pytest_runtest_makereport` hook | High |

**Trade-offs:**
- (+) Full control over output format
- (+) Can emit exactly the data testmcp needs
- (-) Requires injecting a reporter file into the user's project at runtime
- (-) Pytest plugins need Python code deployed alongside the Node.js MCP server
- (-) Reporter APIs change across framework versions (same coupling problem as Approach 1)
- (-) Users may have reporter conflicts in their configs

**Verdict:** Rejected for the same reason — it trades subprocess isolation for framework coupling, and the cross-language problem (Node.js server needing a Python plugin) is awkward.

### Approach 3: Built-in JSON Output (CLI Flags)

**Idea:** Use the frameworks' own JSON output modes: `jest --json`, `vitest run --reporter=json`, `pytest --json-report`.

| Framework | Flag | Format | Built-in? |
|-----------|------|--------|-----------|
| Jest | `--json --outputFile=<path>` | Single JSON object | Yes |
| Vitest | `--reporter=json` (stdout) | Single JSON object | Yes |
| Pytest | `--json-report --json-report-file=<path>` | Single JSON object | No — requires `pytest-json-report` plugin |

**Trade-offs:**
- (+) Clean subprocess isolation — just add CLI flags
- (+) Jest and Vitest JSON is built-in, no extra installs
- (-) Pytest's best JSON option (`pytest-json-report`) is a third-party plugin that may not be installed
- (-) JSON schemas differ across frameworks (Jest uses `assertionResults`, Vitest uses nested `tasks`)
- (-) Schema can vary across framework versions (Jest changed `testFilePath` → `name`)

**Verdict:** This is our primary strategy for Jest and Vitest. For Pytest, we need a fallback chain since `pytest-json-report` is optional.

### Approach 4: JUnit XML Output

**Idea:** Use `--junitxml=<path>` which is built into pytest (no plugins needed), and parse the standard JUnit XML format.

| Framework | Flag | Built-in? |
|-----------|------|-----------|
| Jest | `--reporters=jest-junit` | No (third-party) |
| Vitest | `--reporter=junit` | Yes (since v1.3) |
| Pytest | `--junitxml=<path>` | **Yes** (built-in) |

**Trade-offs:**
- (+) Built into pytest — zero additional dependencies
- (+) Well-defined, stable XML schema (JUnit format is a de facto standard)
- (+) Includes failure messages and test durations
- (-) XML parsing in Node.js requires either a dependency or a regex-based parser
- (-) Less rich than JSON — no structured error objects, no longrepr breakdown by phase (setup/call/teardown)
- (-) Vitest/Jest have better native JSON, so JUnit XML is only useful as a pytest fallback

**Verdict:** Excellent fallback for pytest when no JSON plugin is available.

### Approach 5: pytest-reportlog (JSONL)

**Idea:** Use `--report-log=<path>` from the `pytest-reportlog` plugin, which emits one JSON object per line (JSONL format).

```
{"$report_type": "SessionStart", ...}
{"$report_type": "TestReport", "nodeid": "tests/test_math.py::test_add", "outcome": "passed", "when": "call", "duration": 0.001}
{"$report_type": "TestReport", "nodeid": "tests/test_math.py::test_div", "outcome": "failed", "when": "call", "longrepr": "...traceback..."}
{"$report_type": "SessionFinish", "exitstatus": 1}
```

**Trade-offs:**
- (+) JSONL is trivially parseable — one `JSON.parse()` per line
- (+) Streaming-friendly — partial results are valid even if the process is killed mid-run
- (+) Richer than JUnit XML — includes `longrepr`, phase breakdown (setup/call/teardown), fixture details
- (+) Lightweight plugin (`pip install pytest-reportlog`) — more commonly installed than `pytest-json-report`
- (+) Being adopted as a pytest core feature candidate (may become built-in)
- (-) Still a third-party plugin — may not be installed
- (-) Requires grouping TestReport entries by nodeid across phases

**Verdict:** Best primary option for pytest. The JSONL format is ideal for an MCP server that may need partial results from timed-out runs.

### Approach 6: Verbose Stdout Parsing

**Idea:** Run with `-v --tb=short` and parse the human-readable output line by line.

```
tests/test_math.py::test_add PASSED [  33%]
tests/test_math.py::test_divide FAILED [ 100%]

================================= FAILURES =================================
_______________________________ test_divide ________________________________
    def test_divide():
>       assert divide(10, 3) == 3
E       AssertionError: assert 3.333 == 3
tests/test_math.py:15: AssertionError

========================= short test summary info ==========================
FAILED tests/test_math.py::test_divide - AssertionError: assert 3.333 == 3
======================== 1 failed, 1 passed in 0.15s ======================
```

**Trade-offs:**
- (+) Works everywhere — no plugins, no special flags, just pytest
- (+) Universal fallback that can never fail (assuming pytest itself runs)
- (-) Brittle regex parsing — format can change across pytest versions
- (-) No structured error data — must reconstruct from text
- (-) ANSI codes, progress bars, and plugin output can interfere

**Verdict:** Essential as the last-resort fallback when no plugins are available.

### Decision: Layered Subprocess Strategy

We chose a **layered fallback chain** that maximizes data quality while guaranteeing zero-dependency operation:

```
┌─────────────────────────────────────────────────┐
│                  Jest / Vitest                   │
│   Primary: built-in JSON (--json / --reporter)  │
│   Fallback: unparseable → minimal error result  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                    Pytest                        │
│   Layer 1: pytest-reportlog (--report-log)      │
│     ↓ unrecognized flag? retry with:            │
│   Layer 2: --junitxml (built-in, no plugins)    │
│     ↓ XML parse fails? fall through to:         │
│   Layer 3: verbose stdout parsing (-v --tb=short)│
└─────────────────────────────────────────────────┘
```

**Why this order for pytest:**
1. **reportlog first** — JSONL is trivially parseable, streaming-friendly (survives timeouts), and richer than XML. If the plugin is installed, we get the best possible data.
2. **junitxml second** — Built into pytest itself. Zero dependencies. Gives us test names, durations, and failure messages. The XML format is stable and well-defined.
3. **verbose stdout last** — Always works but yields the least structured data. Regex parsing is inherently fragile.

**Why not pytest-json-report?** We initially used `pytest-json-report` as the primary option. We're replacing it with `pytest-reportlog` because:
- reportlog's JSONL format is streaming-friendly (partial results from timed-out runs)
- reportlog is lighter-weight and more commonly installed
- reportlog is being considered for inclusion in pytest core
- json-report gives a single JSON blob — if the process is killed mid-run, the file is truncated and unparseable

---

## Open Questions

1. **Should we support Mocha / Go test / Rust test from day one?** The adapter pattern makes this easy to add later. Starting with Jest + Vitest + Pytest covers ~90% of LLM coding use cases.

2. **Should testmcp have its own configuration file?** (e.g., `.testmcp.json` for custom test patterns, framework overrides). Or is auto-detection sufficient?

3. **Should we publish to npm as a package?** The primary distribution is as an MCP server in Claude Code's config, but npm publishing would make installation easier.

4. **Should we also build a Python version?** Many AI coding tools run on Python. However, TypeScript + stdio works universally since the LLM client just needs to spawn a Node.js process.
