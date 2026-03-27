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

interface JestAssertionResult {
  ancestorTitles: string[];
  title: string;
  status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped';
  duration: number | null;
  failureMessages: string[];
}

interface JestFileResult {
  name: string;
  assertionResults: JestAssertionResult[];
}

interface JestJsonOutput {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  startTime: number;
  testResults: JestFileResult[];
}

function mapStatus(status: string): TestStatus {
  switch (status) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'pending':
    case 'skipped': return 'skipped';
    case 'todo': return 'todo';
    default: return 'skipped';
  }
}

function truncateError(messages: string[]): string | undefined {
  if (!messages.length) return undefined;
  // Take first message, strip ANSI, limit to ~500 chars
  const first = messages[0]
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  return first.length > 500 ? first.slice(0, 500) + '...' : first;
}

export class JestAdapter extends BaseAdapter {
  readonly framework = 'jest' as const;

  async detect(projectDir: string): Promise<FrameworkDetection | null> {
    const all = await detectFrameworks(projectDir);
    return all.find(d => d.framework === 'jest') ?? null;
  }

  buildCommand(options: RunOptions): { command: string; args: string[]; env?: Record<string, string> } {
    const outputFile = join(tmpdir(), `test-solver-jest-${randomUUID()}.json`);
    const args = [
      'jest',
      '--json',
      `--outputFile=${outputFile}`,
      '--watchAll=false',
      '--forceExit',
      '--no-color',
    ];

    if (options.fileGlob) {
      args.push(`--testPathPattern=${options.fileGlob}`);
    }
    if (options.testNamePattern) {
      args.push(`--testNamePattern=${options.testNamePattern}`);
    }
    if (options.testFiles?.length) {
      args.push('--', ...options.testFiles);
    }
    if (options.coverage) {
      args.push('--coverage', '--coverageReporters=json-summary');
    }

    return {
      command: 'npx',
      args,
      env: { __TEST_SOLVER_OUTPUT_FILE: outputFile },
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

    let jestOutput: JestJsonOutput | null = null;

    // Try reading from output file first (more reliable, survives timeout)
    if (outputFile) {
      try {
        const content = await readFile(outputFile, 'utf-8');
        jestOutput = JSON.parse(content);
      } catch {
        // Fall through to stdout parsing
      }
    }

    // Fallback: parse stdout JSON
    if (!jestOutput) {
      try {
        jestOutput = JSON.parse(stdout);
      } catch {
        // Complete failure to parse
        return this.fallbackResult(runId, stdout, stderr, exitCode, options);
      }
    }

    if (!jestOutput) {
      return this.fallbackResult(runId, stdout, stderr, exitCode, options);
    }

    const tests: TestResult[] = [];
    for (const fileResult of jestOutput.testResults) {
      const filePath = fileResult.name;
      const relPath = filePath ? relative(options.projectDir, filePath) : 'unknown';
      for (const test of fileResult.assertionResults) {
        const parts = [...test.ancestorTitles, test.title];
        tests.push({
          name: test.title,
          fullName: parts.join(' > '),
          status: mapStatus(test.status),
          duration: test.duration ?? 0,
          failureMessage: truncateError(test.failureMessages),
          fullError: test.failureMessages.length
            ? test.failureMessages.join('\n\n').replace(/\u001b\[[0-9;]*m/g, '')
            : undefined,
          sourceContext: test.status === 'failed' ? {
            testFile: relPath,
            testLine: 0, // Will be enriched later from stack trace
          } : undefined,
        });
      }
    }

    const failedTests = tests
      .filter(t => t.status === 'failed')
      .map(t => t.fullName);

    // Parse coverage if available
    let coverage: CoverageSummary | undefined;
    if (options.coverage) {
      coverage = await this.parseCoverage(options.projectDir);
    }

    return {
      summary: {
        runId,
        framework: 'jest',
        projectDir: options.projectDir,
        total: jestOutput.numTotalTests,
        passed: jestOutput.numPassedTests,
        failed: jestOutput.numFailedTests,
        skipped: jestOutput.numPendingTests + jestOutput.numTodoTests,
        duration: Date.now() - jestOutput.startTime,
        failedTests,
        timedOut: false,
        partial: false,
        timestamp: new Date().toISOString(),
        command: `npx jest --json`,
      },
      tests,
      coverage,
      rawOutput: stdout + stderr,
    };
  }

  async listTestFiles(projectDir: string): Promise<string[]> {
    const result = await runProcess({
      command: 'npx',
      args: ['jest', '--listTests', '--watchAll=false', '--no-color'],
      cwd: projectDir,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(f => relative(projectDir, f));
  }

  private fallbackResult(
    runId: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    options: RunOptions,
  ): TestRunResult {
    return {
      summary: {
        runId,
        framework: 'jest',
        projectDir: options.projectDir,
        total: 0,
        passed: 0,
        failed: exitCode !== 0 ? 1 : 0,
        skipped: 0,
        duration: 0,
        failedTests: exitCode !== 0 ? ['(unparseable output)'] : [],
        timedOut: false,
        partial: true,
        timestamp: new Date().toISOString(),
        command: 'npx jest --json',
      },
      tests: [],
      rawOutput: stdout + stderr,
    };
  }

  private async parseCoverage(projectDir: string): Promise<CoverageSummary | undefined> {
    try {
      const summaryPath = join(projectDir, 'coverage', 'coverage-summary.json');
      const content = await readFile(summaryPath, 'utf-8');
      const data = JSON.parse(content);
      const total = data.total;

      const mapMetric = (m: { total: number; covered: number; pct: number }): CoverageMetric => ({
        total: m.total,
        covered: m.covered,
        pct: m.pct,
      });

      return {
        lines: mapMetric(total.lines),
        branches: mapMetric(total.branches),
        functions: mapMetric(total.functions),
        statements: mapMetric(total.statements),
      };
    } catch {
      return undefined;
    }
  }
}
