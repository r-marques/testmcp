import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BaseAdapter } from './base.js';
import { detectFrameworks } from '../utils/detect.js';
import { runProcess } from '../utils/process.js';
import type {
  FrameworkDetection, RunOptions, TestRunResult, TestResult, TestStatus,
  CoverageSummary, CoverageMetric,
} from '../types.js';

interface VitestTask {
  id: string;
  name: string;
  type: 'test' | 'suite';
  mode: 'run' | 'skip' | 'todo' | 'only';
  result?: {
    state: 'pass' | 'fail' | 'skip' | 'todo';
    duration?: number;
    errors?: Array<{
      message: string;
      stack?: string;
    }>;
  };
  tasks?: VitestTask[];
}

interface VitestFileResult {
  filepath: string;
  tasks: VitestTask[];
}

interface VitestJsonOutput {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  startTime: number;
  testResults: VitestFileResult[];
}

function mapStatus(state?: string, mode?: string): TestStatus {
  if (mode === 'skip') return 'skipped';
  if (mode === 'todo') return 'todo';
  switch (state) {
    case 'pass': return 'passed';
    case 'fail': return 'failed';
    case 'skip': return 'skipped';
    case 'todo': return 'todo';
    default: return 'skipped';
  }
}

function flattenTests(tasks: VitestTask[], ancestors: string[] = []): TestResult[] {
  const results: TestResult[] = [];
  for (const task of tasks) {
    if (task.type === 'suite' && task.tasks) {
      results.push(...flattenTests(task.tasks, [...ancestors, task.name]));
    } else if (task.type === 'test') {
      const parts = [...ancestors, task.name];
      const errors = task.result?.errors ?? [];
      const errorMsg = errors.map(e => e.message).join('\n').replace(/\u001b\[[0-9;]*m/g, '').trim();
      const fullError = errors.map(e => [e.message, e.stack].filter(Boolean).join('\n')).join('\n\n')
        .replace(/\u001b\[[0-9;]*m/g, '').trim();

      results.push({
        name: task.name,
        fullName: parts.join(' > '),
        status: mapStatus(task.result?.state, task.mode),
        duration: task.result?.duration ?? 0,
        failureMessage: errorMsg ? (errorMsg.length > 500 ? errorMsg.slice(0, 500) + '...' : errorMsg) : undefined,
        fullError: fullError || undefined,
      });
    }
  }
  return results;
}

export class VitestAdapter extends BaseAdapter {
  readonly framework = 'vitest' as const;

  async detect(projectDir: string): Promise<FrameworkDetection | null> {
    const all = await detectFrameworks(projectDir);
    return all.find(d => d.framework === 'vitest') ?? null;
  }

  buildCommand(options: RunOptions): { command: string; args: string[]; env?: Record<string, string> } {
    const args = [
      'vitest',
      'run',
      '--reporter=json',
      '--no-color',
    ];

    if (options.fileGlob) {
      args.push(options.fileGlob);
    }
    if (options.testNamePattern) {
      args.push('--testNamePattern', options.testNamePattern);
    }
    if (options.testFiles?.length) {
      args.push('--', ...options.testFiles);
    }
    if (options.coverage) {
      args.push('--coverage', '--coverage.reporter=json-summary');
    }

    return { command: 'npx', args };
  }

  async parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    options: RunOptions,
  ): Promise<TestRunResult> {
    const runId = randomUUID();
    let vitestOutput: VitestJsonOutput | null = null;

    // Vitest JSON goes to stdout
    try {
      vitestOutput = JSON.parse(stdout);
    } catch {
      // Try extracting JSON from mixed output (vitest sometimes prepends text)
      const jsonStart = stdout.indexOf('{');
      if (jsonStart >= 0) {
        try {
          vitestOutput = JSON.parse(stdout.slice(jsonStart));
        } catch {
          // Complete failure
        }
      }
    }

    if (!vitestOutput) {
      return this.fallbackResult(runId, stdout, stderr, exitCode, options);
    }

    const tests: TestResult[] = [];
    for (const fileResult of vitestOutput.testResults) {
      const relPath = relative(options.projectDir, fileResult.filepath);
      const fileTests = flattenTests(fileResult.tasks);
      for (const test of fileTests) {
        if (test.status === 'failed' && !test.sourceContext) {
          test.sourceContext = { testFile: relPath, testLine: 0 };
        }
        tests.push(test);
      }
    }

    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.fullName);

    let coverage: CoverageSummary | undefined;
    if (options.coverage) {
      coverage = await this.parseCoverage(options.projectDir);
    }

    return {
      summary: {
        runId,
        framework: 'vitest',
        projectDir: options.projectDir,
        total: vitestOutput.numTotalTests,
        passed: vitestOutput.numPassedTests,
        failed: vitestOutput.numFailedTests,
        skipped: vitestOutput.numPendingTests + vitestOutput.numTodoTests,
        duration: Date.now() - vitestOutput.startTime,
        failedTests,
        timedOut: false,
        partial: false,
        timestamp: new Date().toISOString(),
        command: 'npx vitest run --reporter=json',
      },
      tests,
      coverage,
      rawOutput: stdout + stderr,
    };
  }

  async listTestFiles(projectDir: string): Promise<string[]> {
    const result = await runProcess({
      command: 'npx',
      args: ['vitest', 'list', '--reporter=json'],
      cwd: projectDir,
    });
    if (result.exitCode !== 0) return [];
    try {
      const data = JSON.parse(result.stdout);
      if (Array.isArray(data)) {
        return data.map((t: { file: string }) => relative(projectDir, t.file));
      }
    } catch { /* fallback */ }
    return result.stdout.trim().split('\n').filter(Boolean);
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
        framework: 'vitest',
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
        command: 'npx vitest run --reporter=json',
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
