import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { BaseAdapter } from './base.js';
import { detectFrameworks } from '../utils/detect.js';
import { runProcess } from '../utils/process.js';
import type {
  FrameworkDetection, RunOptions, TestRunResult, TestResult, TestStatus,
  CoverageSummary, CoverageMetric,
} from '../types.js';

interface PytestJsonTest {
  nodeid: string;
  outcome: 'passed' | 'failed' | 'skipped' | 'error' | 'xfailed' | 'xpassed';
  duration: number;
  call?: { longrepr?: string };
  setup?: { longrepr?: string };
  teardown?: { longrepr?: string };
}

interface PytestJsonReport {
  summary: {
    passed?: number;
    failed?: number;
    error?: number;
    skipped?: number;
    total: number;
    duration: number;
  };
  tests: PytestJsonTest[];
}

function mapPytestStatus(outcome: string): TestStatus {
  switch (outcome) {
    case 'passed':
    case 'xpassed': return 'passed';
    case 'failed':
    case 'error': return 'failed';
    case 'skipped':
    case 'xfailed': return 'skipped';
    default: return 'skipped';
  }
}

function nodeIdToFullName(nodeid: string): string {
  return nodeid.replace(/::/g, ' > ');
}

function nodeIdToName(nodeid: string): string {
  const parts = nodeid.split('::');
  return parts[parts.length - 1];
}

export class PytestAdapter extends BaseAdapter {
  readonly framework = 'pytest' as const;

  async detect(projectDir: string): Promise<FrameworkDetection | null> {
    const all = await detectFrameworks(projectDir);
    return all.find(d => d.framework === 'pytest') ?? null;
  }

  buildCommand(options: RunOptions & { fallbackMode?: boolean }): { command: string; args: string[]; env?: Record<string, string> } {
    const outputFile = join(tmpdir(), `testmcp-pytest-${randomUUID()}.json`);
    const usePoetry = options.packageManager === 'poetry';
    const fallback = options.fallbackMode ?? false;

    const command = usePoetry ? 'poetry' : 'python';
    const prefix = usePoetry ? ['run', 'python', '-m', 'pytest'] : ['-m', 'pytest'];

    const args = [...prefix];

    if (fallback) {
      // Fallback: verbose output for line-by-line parsing
      args.push('--tb=short', '-v', '--no-header', '-p', 'no:cacheprovider');
    } else {
      // Preferred: JSON report plugin
      args.push(
        '--tb=short', '-q', '--no-header',
        '--json-report', `--json-report-file=${outputFile}`,
        '-p', 'no:cacheprovider',
      );
    }

    if (options.fileGlob) {
      args.push(options.fileGlob);
    }
    if (options.testNamePattern) {
      args.push('-k', options.testNamePattern);
    }
    if (options.testFiles?.length) {
      args.push(...options.testFiles);
    }
    if (options.coverage) {
      args.push('--cov', '--cov-report=json');
    }

    return {
      command,
      args,
      env: { __TEST_SOLVER_OUTPUT_FILE: fallback ? '' : outputFile },
    };
  }

  async parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    options: RunOptions,
  ): Promise<TestRunResult> {
    const runId = randomUUID();
    const env = options.env as Record<string, string> | undefined;
    const outputFile = env?.__TEST_SOLVER_OUTPUT_FILE;

    let report: PytestJsonReport | null = null;

    // Try JSON report file first
    if (outputFile) {
      try {
        const content = await readFile(outputFile, 'utf-8');
        report = JSON.parse(content);
      } catch {
        // Fall through to stdout parsing
      }
    }

    // Fallback: parse verbose stdout
    if (!report) {
      return this.parseFallbackOutput(runId, stdout, stderr, exitCode, options);
    }

    const tests: TestResult[] = report.tests.map(t => {
      const errorParts: string[] = [];
      if (t.call?.longrepr) errorParts.push(t.call.longrepr);
      if (t.setup?.longrepr) errorParts.push(t.setup.longrepr);
      if (t.teardown?.longrepr) errorParts.push(t.teardown.longrepr);
      const fullError = errorParts.join('\n\n').trim() || undefined;
      const failureMessage = fullError
        ? (fullError.length > 500 ? fullError.slice(0, 500) + '...' : fullError)
        : undefined;

      const testFile = t.nodeid.split('::')[0];

      return {
        name: nodeIdToName(t.nodeid),
        fullName: nodeIdToFullName(t.nodeid),
        status: mapPytestStatus(t.outcome),
        duration: Math.round(t.duration * 1000),
        failureMessage,
        fullError,
        sourceContext: t.outcome === 'failed' || t.outcome === 'error'
          ? { testFile, testLine: 0 }
          : undefined,
      };
    });

    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.fullName);

    let coverage: CoverageSummary | undefined;
    if (options.coverage) {
      coverage = await this.parseCoverage(options.projectDir);
    }

    return {
      summary: {
        runId,
        framework: 'pytest',
        projectDir: options.projectDir,
        total: report.summary.total,
        passed: report.summary.passed ?? 0,
        failed: (report.summary.failed ?? 0) + (report.summary.error ?? 0),
        skipped: report.summary.skipped ?? 0,
        duration: Math.round(report.summary.duration * 1000),
        failedTests,
        timedOut: false,
        partial: false,
        timestamp: new Date().toISOString(),
        command: 'python -m pytest --json-report',
      },
      tests,
      coverage,
      rawOutput: stdout + stderr,
    };
  }

  async listTestFiles(projectDir: string, packageManager?: string): Promise<string[]> {
    const usePoetry = packageManager === 'poetry';
    const command = usePoetry ? 'poetry' : 'python';
    const prefix = usePoetry ? ['run', 'python', '-m', 'pytest'] : ['-m', 'pytest'];

    const result = await runProcess({
      command,
      args: [...prefix, '--collect-only', '-q', '--no-header', '-p', 'no:cacheprovider'],
      cwd: projectDir,
    });
    if (result.exitCode !== 0) return [];

    const files = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(.+\.py)::/);
      if (match) {
        files.add(relative(projectDir, match[1]));
      }
    }
    return [...files];
  }

  private parseFallbackOutput(
    runId: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    options: RunOptions,
  ): TestRunResult {
    const lines = stdout.split('\n');

    // --- Step 1: Parse verbose PASSED/FAILED/SKIPPED lines ---
    const linePattern = /^(.+\.py)::(.+?)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)/;
    const tests: TestResult[] = [];
    // Map from nodeid (e.g. "tests/unit/test_foo.py::test_broken") to TestResult for later enrichment
    const testsByNodeId = new Map<string, TestResult>();

    for (const line of lines) {
      const match = line.match(linePattern);
      if (!match) continue;
      const [, file, name, status] = match;
      const trimmedName = name.trim();
      const nodeid = `${file}::${trimmedName}`;
      const result: TestResult = {
        name: trimmedName.split('::').pop() ?? trimmedName,
        fullName: `${file} > ${trimmedName.replace(/::/g, ' > ')}`,
        status: status === 'PASSED' || status === 'XPASS' ? 'passed'
          : status === 'FAILED' || status === 'ERROR' ? 'failed'
          : 'skipped',
        duration: 0,
        sourceContext: status === 'FAILED' || status === 'ERROR'
          ? { testFile: file, testLine: 0 }
          : undefined,
      };
      tests.push(result);
      testsByNodeId.set(nodeid, result);
    }

    // --- Step 2: Parse the FAILURES section for full tracebacks ---
    const failureTracebacks = this.parseFailureSections(lines);
    for (const [nodeid, traceback] of failureTracebacks) {
      const test = testsByNodeId.get(nodeid);
      if (test) {
        test.fullError = traceback;
        // Extract line number from traceback (e.g. "tests/unit/test_foo.py:15: AssertionError")
        const lineNoMatch = traceback.match(/^(.+\.py):(\d+):/m);
        if (lineNoMatch && test.sourceContext) {
          test.sourceContext.testLine = parseInt(lineNoMatch[2], 10);
        }
      }
    }

    // --- Step 3: Parse short test summary info for failureMessage ---
    // Lines like: "FAILED tests/unit/test_foo.py::test_broken - AssertionError: assert 20 == 42"
    const summaryInfoPattern = /^FAILED\s+(.+?)\s+-\s+(.+)$/;
    let inSummaryInfo = false;
    for (const line of lines) {
      if (line.includes('short test summary info')) {
        inSummaryInfo = true;
        continue;
      }
      // The summary info section ends at the next separator line (all = signs)
      if (inSummaryInfo && /^={3,}/.test(line)) {
        inSummaryInfo = false;
        continue;
      }
      if (!inSummaryInfo) continue;

      const match = line.match(summaryInfoPattern);
      if (!match) continue;
      const [, nodeid, message] = match;
      const test = testsByNodeId.get(nodeid);
      if (test) {
        test.failureMessage = message.length > 500 ? message.slice(0, 500) + '...' : message;
        // If we didn't get a fullError from the FAILURES section, use the summary line
        if (!test.fullError) {
          test.fullError = message;
        }
      } else {
        // Test wasn't found in verbose lines — could happen if verbose line was missed.
        // Create a minimal TestResult from the summary info.
        const file = nodeid.split('::')[0];
        const nameParts = nodeid.split('::');
        const testName = nameParts[nameParts.length - 1];
        const result: TestResult = {
          name: testName,
          fullName: `${file} > ${nameParts.slice(1).join(' > ')}`,
          status: 'failed',
          duration: 0,
          failureMessage: message.length > 500 ? message.slice(0, 500) + '...' : message,
          fullError: message,
          sourceContext: { testFile: file, testLine: 0 },
        };
        tests.push(result);
        testsByNodeId.set(nodeid, result);
      }
    }

    // For failed tests that have fullError but no failureMessage, derive failureMessage from fullError
    for (const test of tests) {
      if (test.status === 'failed' && test.fullError && !test.failureMessage) {
        const msg = test.fullError;
        test.failureMessage = msg.length > 500 ? msg.slice(0, 500) + '...' : msg;
      }
    }

    // --- Step 4: Parse final summary line for accurate counts ---
    // e.g. "1 failed, 2 passed in 0.5s" or "1 failed, 2 passed, 3 skipped in 1.23s"
    const finalSummary = this.parseFinalSummaryLine(lines);

    const passed = finalSummary?.passed ?? tests.filter(t => t.status === 'passed').length;
    const failed = finalSummary?.failed ?? tests.filter(t => t.status === 'failed').length;
    const skipped = finalSummary?.skipped ?? tests.filter(t => t.status === 'skipped').length;
    const total = finalSummary ? (finalSummary.passed + finalSummary.failed + finalSummary.skipped) : tests.length;
    const duration = finalSummary?.duration ?? 0;
    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.fullName);

    return {
      summary: {
        runId,
        framework: 'pytest',
        projectDir: options.projectDir,
        total,
        passed,
        failed,
        skipped,
        duration,
        failedTests,
        timedOut: false,
        partial: tests.length === 0 && exitCode !== 0,
        timestamp: new Date().toISOString(),
        command: 'python -m pytest (fallback parsing — install pytest-json-report for better results)',
      },
      tests,
      rawOutput: stdout + stderr,
    };
  }

  /**
   * Parse the "= FAILURES =" section of pytest output.
   * Each failure block starts with "_ test_name _" and ends at the next such header or a "=" separator.
   * Returns a Map from nodeid to the full traceback string.
   */
  private parseFailureSections(lines: string[]): Map<string, string> {
    const results = new Map<string, string>();

    // Find the start of the FAILURES section
    let failureStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^={3,}\s*FAILURES\s*={3,}$/.test(lines[i].trim())) {
        failureStart = i + 1;
        break;
      }
    }
    if (failureStart === -1) return results;

    // Parse individual failure blocks
    // Each block header: "________ test_name ________" (or "________ TestClass.test_name ________")
    const blockHeaderPattern = /^_{3,}\s+(.+?)\s+_{3,}$/;
    let currentTestName: string | null = null;
    let currentLines: string[] = [];

    for (let i = failureStart; i < lines.length; i++) {
      const line = lines[i];

      // End of FAILURES section — a line of "=" chars that is NOT the FAILURES header itself
      if (/^={3,}/.test(line) && !/FAILURES/.test(line)) {
        // Save the last block
        if (currentTestName) {
          results.set(currentTestName, currentLines.join('\n').trim());
        }
        break;
      }

      const headerMatch = line.match(blockHeaderPattern);
      if (headerMatch) {
        // Save previous block if any
        if (currentTestName) {
          results.set(currentTestName, currentLines.join('\n').trim());
        }
        currentTestName = headerMatch[1].trim();
        currentLines = [];
      } else if (currentTestName) {
        currentLines.push(line);
      }
    }

    // Now we need to match block names (e.g. "test_broken") back to nodeids (e.g. "tests/unit/test_foo.py::test_broken").
    // The traceback itself usually contains the file path and line number, which we can use for matching.
    // But the simplest approach: the block name is typically the last component(s) of the nodeid.
    // We'll return using the block name as key and let the caller try to match.
    // Actually, let's extract the file path from the traceback to build a full nodeid.
    const resolved = new Map<string, string>();
    for (const [blockName, traceback] of results) {
      // Try to find a file reference in the traceback, e.g. "tests/unit/test_foo.py:15: AssertionError"
      const fileMatch = traceback.match(/^(.+\.py):\d+:/m);
      if (fileMatch) {
        // Reconstruct nodeid: file::blockName (blockName may be "TestClass.test_method" → "TestClass::test_method")
        const file = fileMatch[1].trim();
        const nodeid = `${file}::${blockName.replace(/\./g, '::')}`;
        resolved.set(nodeid, traceback);
      } else {
        // Can't resolve file; use blockName as-is (caller won't match, but we tried)
        resolved.set(blockName, traceback);
      }
    }

    return resolved;
  }

  /**
   * Parse the final summary line, e.g. "1 failed, 2 passed in 0.5s" or "3 passed in 0.12s".
   * Returns extracted counts and duration, or null if not found.
   */
  private parseFinalSummaryLine(lines: string[]): {
    passed: number; failed: number; skipped: number; duration: number;
  } | null {
    // The final summary line is typically the last non-empty line or preceded by "="
    // Pattern: "={N} <counts> in <duration> ={N}" or just "<counts> in <duration>"
    const summaryPattern = /(\d+\s+failed)?[,\s]*(\d+\s+passed)?[,\s]*(\d+\s+skipped)?[,\s]*(?:.*?)in\s+([\d.]+)s/;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // Look for lines containing " passed" or " failed" followed by "in <N>s"
      if (!/\b(?:passed|failed)\b/.test(line) || !/\bin\s+[\d.]+s\b/.test(line)) continue;

      const match = line.match(summaryPattern);
      if (!match) continue;

      const failed = match[1] ? parseInt(match[1], 10) : 0;
      const passed = match[2] ? parseInt(match[2], 10) : 0;
      const skipped = match[3] ? parseInt(match[3], 10) : 0;
      const duration = Math.round(parseFloat(match[4]) * 1000);

      return { passed, failed, skipped, duration };
    }

    return null;
  }

  private async parseCoverage(projectDir: string): Promise<CoverageSummary | undefined> {
    try {
      const covPath = join(projectDir, 'coverage.json');
      const content = await readFile(covPath, 'utf-8');
      const data = JSON.parse(content);
      const totals = data.totals;

      const mapMetric = (covered: number, total: number): CoverageMetric => ({
        total,
        covered,
        pct: total > 0 ? Math.round((covered / total) * 10000) / 100 : 100,
      });

      return {
        lines: mapMetric(totals.covered_lines, totals.num_statements),
        branches: mapMetric(totals.covered_branches ?? 0, totals.num_branches ?? 0),
        functions: { total: 0, covered: 0, pct: 0 },
        statements: mapMetric(totals.covered_lines, totals.num_statements),
      };
    } catch {
      return undefined;
    }
  }
}
