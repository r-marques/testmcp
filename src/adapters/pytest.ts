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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PytestParseMode = 'reportlog' | 'junitxml' | 'verbose';

/** A single line from pytest-reportlog JSONL output */
interface ReportLogEntry {
  $report_type?: string;
  nodeid?: string;
  outcome?: string;
  duration?: number;
  when?: string;
  longrepr?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PytestAdapter extends BaseAdapter {
  readonly framework = 'pytest' as const;

  async detect(projectDir: string): Promise<FrameworkDetection | null> {
    const all = await detectFrameworks(projectDir);
    return all.find(d => d.framework === 'pytest') ?? null;
  }

  buildCommand(
    options: RunOptions & { parseMode?: PytestParseMode },
  ): { command: string; args: string[]; env?: Record<string, string> } {
    const mode: PytestParseMode = options.parseMode ?? 'reportlog';
    const outputFile = mode !== 'verbose'
      ? join(tmpdir(), `testmcp-pytest-${randomUUID()}.${mode === 'reportlog' ? 'jsonl' : 'xml'}`)
      : '';
    const usePoetry = options.packageManager === 'poetry';

    const command = usePoetry ? 'poetry' : 'python';
    const prefix = usePoetry ? ['run', 'python', '-m', 'pytest'] : ['-m', 'pytest'];
    const args = [...prefix];

    switch (mode) {
      case 'reportlog':
        args.push(
          '--tb=short', '-q', '--no-header',
          `--report-log=${outputFile}`,
          '-p', 'no:cacheprovider',
        );
        break;
      case 'junitxml':
        args.push(
          '--tb=short', '-v', '--no-header',
          `--junitxml=${outputFile}`,
          '-p', 'no:cacheprovider',
        );
        break;
      case 'verbose':
        args.push('--tb=short', '-v', '--no-header', '-p', 'no:cacheprovider');
        break;
    }

    if (options.fileGlob) args.push(options.fileGlob);
    if (options.testNamePattern) args.push('-k', options.testNamePattern);
    if (options.testFiles?.length) args.push(...options.testFiles);
    if (options.coverage) args.push('--cov', '--cov-report=json');

    return {
      command,
      args,
      env: {
        __TESTMCP_PARSE_MODE: mode,
        __TESTMCP_OUTPUT_FILE: outputFile,
      },
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
    const mode = (env?.__TESTMCP_PARSE_MODE ?? 'verbose') as PytestParseMode;
    const outputFile = env?.__TESTMCP_OUTPUT_FILE;

    // Try structured output first (reportlog JSONL or JUnit XML)
    if (outputFile && mode !== 'verbose') {
      try {
        const content = await readFile(outputFile, 'utf-8');
        if (mode === 'reportlog') {
          return this.parseReportLog(runId, content, stdout, stderr, options);
        }
        if (mode === 'junitxml') {
          return this.parseJunitXml(runId, content, stdout, stderr, options);
        }
      } catch {
        // File not readable — fall through to verbose stdout parsing
      }
    }

    // Ultimate fallback: parse verbose stdout
    return this.parseVerboseOutput(runId, stdout, stderr, exitCode, options);
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
      if (match) files.add(relative(projectDir, match[1]));
    }
    return [...files];
  }

  // -------------------------------------------------------------------------
  // Layer 1: pytest-reportlog JSONL
  // -------------------------------------------------------------------------

  parseReportLog(
    runId: string,
    content: string,
    stdout: string,
    stderr: string,
    options: RunOptions,
  ): TestRunResult {
    // Each line is a JSON object. We care about TestReport entries.
    // Group by nodeid — a test can have setup/call/teardown reports.
    const byNodeId = new Map<string, {
      outcome: string;
      duration: number;
      longrepr: string[];
    }>();

    let sessionDuration = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: ReportLogEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.$report_type === 'SessionFinish') {
        sessionDuration = entry.duration ?? 0;
        continue;
      }

      if (entry.$report_type !== 'TestReport' || !entry.nodeid) continue;

      const existing = byNodeId.get(entry.nodeid);
      const longreprStr = typeof entry.longrepr === 'string' ? entry.longrepr : '';

      if (!existing) {
        byNodeId.set(entry.nodeid, {
          outcome: entry.outcome ?? 'passed',
          duration: entry.duration ?? 0,
          longrepr: longreprStr ? [longreprStr] : [],
        });
      } else {
        // Merge: duration from 'call' phase, worst outcome wins
        if (entry.when === 'call') {
          existing.duration = entry.duration ?? existing.duration;
          existing.outcome = entry.outcome ?? existing.outcome;
        }
        // Promote to failed if any phase failed
        if (entry.outcome === 'failed' || entry.outcome === 'error') {
          existing.outcome = entry.outcome;
        }
        if (longreprStr) {
          existing.longrepr.push(longreprStr);
        }
      }
    }

    const tests: TestResult[] = [];
    for (const [nodeid, data] of byNodeId) {
      const status = mapPytestStatus(data.outcome);
      const fullError = data.longrepr.join('\n\n').trim() || undefined;
      const testFile = nodeid.split('::')[0];

      tests.push({
        name: nodeIdToName(nodeid),
        fullName: nodeIdToFullName(nodeid),
        status,
        duration: Math.round(data.duration * 1000),
        failureMessage: fullError ? truncate(fullError) : undefined,
        fullError,
        sourceContext: status === 'failed'
          ? { testFile, testLine: this.extractLineNumber(fullError) }
          : undefined,
      });
    }

    const passed = tests.filter(t => t.status === 'passed').length;
    const failed = tests.filter(t => t.status === 'failed').length;
    const skipped = tests.filter(t => t.status === 'skipped').length;
    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.fullName);

    return {
      summary: {
        runId,
        framework: 'pytest',
        projectDir: options.projectDir,
        total: tests.length,
        passed,
        failed,
        skipped,
        duration: Math.round(sessionDuration * 1000),
        failedTests,
        timedOut: false,
        partial: false,
        timestamp: new Date().toISOString(),
        command: 'python -m pytest --report-log',
      },
      tests,
      rawOutput: stdout + stderr,
    };
  }

  // -------------------------------------------------------------------------
  // Layer 2: JUnit XML (built-in --junitxml)
  // -------------------------------------------------------------------------

  parseJunitXml(
    runId: string,
    xml: string,
    stdout: string,
    stderr: string,
    options: RunOptions,
  ): TestRunResult {
    const tests: TestResult[] = [];

    // Parse <testsuite> attributes for summary
    const suiteMatch = xml.match(
      /<testsuite[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"[^>]*(?:\berrors="(\d+)")?[^>]*(?:\bskipped="(\d+)")?[^>]*\btime="([\d.]+)"[^>]*>/,
    );

    // Parse attributes (use \s to avoid matching <testsuites>)
    const suiteAttrs = this.parseXmlAttributes(xml.match(/<testsuite\s([^>]*)>/)?.[1] ?? '');

    const suiteTotalFromAttr = parseInt(suiteAttrs.tests ?? '0', 10);
    const suiteFailures = parseInt(suiteAttrs.failures ?? '0', 10);
    const suiteErrors = parseInt(suiteAttrs.errors ?? '0', 10);
    const suiteSkipped = parseInt(suiteAttrs.skipped ?? '0', 10);
    const suiteDuration = parseFloat(suiteAttrs.time ?? '0');

    // Parse <testcase> elements — single pass handles both self-closing and body
    // [^>]*? is non-greedy so it stops before /> or > without consuming the /
    const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;

    const processTestcase = (attrStr: string, body: string) => {
      const attrs = this.parseXmlAttributes(attrStr);
      const classname = attrs.classname ?? '';
      const name = attrs.name ?? 'unknown';
      const time = parseFloat(attrs.time ?? '0');

      const testFile = classname
        ? classname.replace(/\./g, '/') + '.py'
        : '';

      let status: TestStatus = 'passed';
      let failureMessage: string | undefined;
      let fullError: string | undefined;

      // Parse child element attributes using parseXmlAttributes for reliability
      const failureTagMatch = body.match(/<failure\b([^>]*)>([\s\S]*?)<\/failure>/);
      const errorTagMatch = body.match(/<error\b([^>]*)>([\s\S]*?)<\/error>/);
      const skipTagMatch = body.match(/<skipped\b([^>]*?)(?:\/>|>)/);

      if (failureTagMatch) {
        status = 'failed';
        const fAttrs = this.parseXmlAttributes(failureTagMatch[1]);
        failureMessage = this.unescapeXml(fAttrs.message ?? '');
        fullError = this.unescapeXml(failureTagMatch[2]?.trim() ?? failureMessage);
        if (failureMessage) failureMessage = truncate(failureMessage);
      } else if (errorTagMatch) {
        status = 'failed';
        const eAttrs = this.parseXmlAttributes(errorTagMatch[1]);
        failureMessage = this.unescapeXml(eAttrs.message ?? '');
        fullError = this.unescapeXml(errorTagMatch[2]?.trim() ?? failureMessage);
        if (failureMessage) failureMessage = truncate(failureMessage);
      } else if (skipTagMatch) {
        status = 'skipped';
      }

      const nodeid = testFile ? `${testFile}::${name}` : name;

      tests.push({
        name,
        fullName: nodeIdToFullName(nodeid),
        status,
        duration: Math.round(time * 1000),
        failureMessage,
        fullError,
        sourceContext: status === 'failed'
          ? { testFile, testLine: this.extractLineNumber(fullError) }
          : undefined,
      });
    };

    let m;
    while ((m = testcaseRe.exec(xml)) !== null) {
      processTestcase(m[1], m[2] ?? '');
    }

    const passed = tests.filter(t => t.status === 'passed').length;
    const failed = tests.filter(t => t.status === 'failed').length;
    const skipped = tests.filter(t => t.status === 'skipped').length;
    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.fullName);

    return {
      summary: {
        runId,
        framework: 'pytest',
        projectDir: options.projectDir,
        total: suiteTotalFromAttr || tests.length,
        passed: suiteTotalFromAttr ? (suiteTotalFromAttr - suiteFailures - suiteErrors - suiteSkipped) : passed,
        failed: suiteFailures + suiteErrors || failed,
        skipped: suiteSkipped || skipped,
        duration: Math.round(suiteDuration * 1000),
        failedTests,
        timedOut: false,
        partial: false,
        timestamp: new Date().toISOString(),
        command: 'python -m pytest --junitxml',
      },
      tests,
      rawOutput: stdout + stderr,
    };
  }

  // -------------------------------------------------------------------------
  // Layer 3: Verbose stdout parsing (ultimate fallback)
  // -------------------------------------------------------------------------

  private parseVerboseOutput(
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
        const lineNoMatch = traceback.match(/^(.+\.py):(\d+):/m);
        if (lineNoMatch && test.sourceContext) {
          test.sourceContext.testLine = parseInt(lineNoMatch[2], 10);
        }
      }
    }

    // --- Step 3: Parse short test summary info for failureMessage ---
    const summaryInfoPattern = /^FAILED\s+(.+?)\s+-\s+(.+)$/;
    let inSummaryInfo = false;
    for (const line of lines) {
      if (line.includes('short test summary info')) {
        inSummaryInfo = true;
        continue;
      }
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
        test.failureMessage = truncate(message);
        if (!test.fullError) test.fullError = message;
      } else {
        const file = nodeid.split('::')[0];
        const nameParts = nodeid.split('::');
        const testName = nameParts[nameParts.length - 1];
        const result: TestResult = {
          name: testName,
          fullName: `${file} > ${nameParts.slice(1).join(' > ')}`,
          status: 'failed',
          duration: 0,
          failureMessage: truncate(message),
          fullError: message,
          sourceContext: { testFile: file, testLine: 0 },
        };
        tests.push(result);
        testsByNodeId.set(nodeid, result);
      }
    }

    // Derive failureMessage from fullError if needed
    for (const test of tests) {
      if (test.status === 'failed' && test.fullError && !test.failureMessage) {
        test.failureMessage = truncate(test.fullError);
      }
    }

    // --- Step 4: Parse final summary line for accurate counts ---
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
        command: 'python -m pytest (verbose fallback)',
      },
      tests,
      rawOutput: stdout + stderr,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private extractLineNumber(text?: string): number {
    if (!text) return 0;
    const match = text.match(/\.py:(\d+):/m);
    return match ? parseInt(match[1], 10) : 0;
  }

  private parseXmlAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const pattern = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = pattern.exec(attrString)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  private unescapeXml(s: string): string {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse the "= FAILURES =" section of pytest output.
   * Returns a Map from nodeid to the full traceback string.
   */
  private parseFailureSections(lines: string[]): Map<string, string> {
    const results = new Map<string, string>();

    let failureStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^={3,}\s*FAILURES\s*={3,}$/.test(lines[i].trim())) {
        failureStart = i + 1;
        break;
      }
    }
    if (failureStart === -1) return results;

    const blockHeaderPattern = /^_{3,}\s+(.+?)\s+_{3,}$/;
    let currentTestName: string | null = null;
    let currentLines: string[] = [];

    for (let i = failureStart; i < lines.length; i++) {
      const line = lines[i];

      if (/^={3,}/.test(line) && !/FAILURES/.test(line)) {
        if (currentTestName) {
          results.set(currentTestName, currentLines.join('\n').trim());
        }
        break;
      }

      const headerMatch = line.match(blockHeaderPattern);
      if (headerMatch) {
        if (currentTestName) {
          results.set(currentTestName, currentLines.join('\n').trim());
        }
        currentTestName = headerMatch[1].trim();
        currentLines = [];
      } else if (currentTestName) {
        currentLines.push(line);
      }
    }

    // Resolve block names to full nodeids using file paths from tracebacks
    const resolved = new Map<string, string>();
    for (const [blockName, traceback] of results) {
      const fileMatch = traceback.match(/^(.+\.py):\d+:/m);
      if (fileMatch) {
        const file = fileMatch[1].trim();
        const nodeid = `${file}::${blockName.replace(/\./g, '::')}`;
        resolved.set(nodeid, traceback);
      } else {
        resolved.set(blockName, traceback);
      }
    }

    return resolved;
  }

  private parseFinalSummaryLine(lines: string[]): {
    passed: number; failed: number; skipped: number; duration: number;
  } | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!/\b(?:passed|failed)\b/.test(line) || !/\bin\s+[\d.]+s\b/.test(line)) continue;

      const passedMatch = line.match(/(\d+)\s+passed/);
      const failedMatch = line.match(/(\d+)\s+failed/);
      const skippedMatch = line.match(/(\d+)\s+skipped/);
      const durationMatch = line.match(/in\s+([\d.]+)s/);

      if (!durationMatch) continue;

      return {
        passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
        failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
        skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
        duration: Math.round(parseFloat(durationMatch[1]) * 1000),
      };
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
