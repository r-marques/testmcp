import { randomUUID } from 'node:crypto';
import { PytestAdapter } from '../adapters/pytest.js';
import { JestAdapter } from '../adapters/jest.js';
import { VitestAdapter } from '../adapters/vitest.js';
import type { FrameworkName, TestRunResult, TestResult, TestStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Strip common CI timestamp prefixes (ISO timestamps, GitHub Actions format) */
function stripTimestamps(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, ''))
    .join('\n');
}

/** Clean raw CI log text for parsing */
export function cleanLogText(text: string): string {
  return stripTimestamps(stripAnsi(text));
}

// ---------------------------------------------------------------------------
// Framework detection from log content
// ---------------------------------------------------------------------------

export function detectFrameworkFromLog(text: string): FrameworkName | null {
  // Pytest indicators
  if (
    /\.py::[\w\[\]]+\s+(PASSED|FAILED|SKIPPED|ERROR)/m.test(text)
    || /={3,}\s*test session starts\s*={3,}/m.test(text)
    || /={3,}\s*FAILURES\s*={3,}/m.test(text)
    || /\bpytest\b.*\d+\s+passed/m.test(text)
  ) {
    return 'pytest';
  }

  // Jest indicators
  if (
    /^(PASS|FAIL)\s+\S+\.(test|spec)\.(ts|tsx|js|jsx)/m.test(text)
    || /Test Suites?:\s+\d+/m.test(text)
    || /Tests:\s+\d+\s+(failed|passed)/m.test(text)
  ) {
    return 'jest';
  }

  // Vitest indicators
  if (
    /^\s*[✓×✗]\s+/m.test(text)
    || /Test Files\s+\d+\s+(failed|passed)/m.test(text)
    || /\bvitest\b/im.test(text)
  ) {
    return 'vitest';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Framework-specific parsers
// ---------------------------------------------------------------------------

function parseJestLog(runId: string, text: string): TestRunResult {
  const lines = text.split('\n');
  const tests: TestResult[] = [];

  // Parse "PASS/FAIL filepath" file markers and "● suite > test" failure blocks
  let currentFile = '';
  let inFailure = false;
  let failureName = '';
  let failureLines: string[] = [];

  const flushFailure = () => {
    if (failureName) {
      const fullError = failureLines.join('\n').trim();
      const firstLine = fullError.split('\n')[0] ?? '';
      tests.push({
        name: failureName.split(' > ').pop() ?? failureName,
        fullName: failureName,
        status: 'failed',
        duration: 0,
        failureMessage: firstLine.length > 500 ? firstLine.slice(0, 500) + '...' : firstLine,
        fullError,
        sourceContext: currentFile ? { testFile: currentFile, testLine: 0 } : undefined,
      });
    }
    inFailure = false;
    failureName = '';
    failureLines = [];
  };

  for (const line of lines) {
    // File result: "PASS src/foo.test.ts" or "FAIL src/foo.test.ts"
    const fileMatch = line.match(/^(PASS|FAIL)\s+(\S+)/);
    if (fileMatch) {
      flushFailure();
      currentFile = fileMatch[2];
      if (fileMatch[1] === 'PASS') {
        // We don't know individual test names from PASS lines in human output
      }
      continue;
    }

    // Failure block header: "● suite > test name"
    const failureHeader = line.match(/^\s*●\s+(.+)/);
    if (failureHeader) {
      flushFailure();
      inFailure = true;
      failureName = failureHeader[1].trim();
      continue;
    }

    if (inFailure) {
      // Empty line after failure block content ends the block
      if (line.trim() === '' && failureLines.length > 0) {
        // Could be spacing within the block — keep going unless next line is a new block
      }
      failureLines.push(line);
    }
  }
  flushFailure();

  // Parse summary line: "Tests:  1 failed, 3 passed, 4 total"
  const summaryMatch = text.match(/Tests:\s+(.+?)(?:\n|$)/);
  let passed = 0, failed = 0, skipped = 0, total = 0;
  if (summaryMatch) {
    const s = summaryMatch[1];
    const failedM = s.match(/(\d+)\s+failed/);
    const passedM = s.match(/(\d+)\s+passed/);
    const skippedM = s.match(/(\d+)\s+(?:skipped|pending|todo)/);
    const totalM = s.match(/(\d+)\s+total/);
    failed = failedM ? parseInt(failedM[1], 10) : 0;
    passed = passedM ? parseInt(passedM[1], 10) : 0;
    skipped = skippedM ? parseInt(skippedM[1], 10) : 0;
    total = totalM ? parseInt(totalM[1], 10) : (passed + failed + skipped);
  } else {
    failed = tests.filter(t => t.status === 'failed').length;
    total = tests.length;
  }

  return {
    summary: {
      runId,
      framework: 'jest',
      projectDir: '',
      total,
      passed,
      failed,
      skipped,
      duration: 0,
      failedTests: tests.filter(t => t.status === 'failed').map(t => t.fullName),
      timedOut: false,
      partial: false,
      timestamp: new Date().toISOString(),
      command: 'parse_log (Jest CI output)',
    },
    tests,
  };
}

function parseVitestLog(runId: string, text: string): TestRunResult {
  const lines = text.split('\n');
  const tests: TestResult[] = [];

  // Parse "✓ file (N tests)" and "× file (N tests)" lines
  // Parse "× suite > test name" failure detail lines
  let inFailureBlock = false;
  let failureName = '';
  let failureLines: string[] = [];

  const flushFailure = () => {
    if (failureName) {
      const fullError = failureLines.join('\n').trim();
      const firstLine = fullError.split('\n')[0] ?? '';
      tests.push({
        name: failureName.split(' > ').pop() ?? failureName,
        fullName: failureName,
        status: 'failed',
        duration: 0,
        failureMessage: firstLine.length > 500 ? firstLine.slice(0, 500) + '...' : firstLine,
        fullError,
      });
    }
    inFailureBlock = false;
    failureName = '';
    failureLines = [];
  };

  for (const line of lines) {
    // File result line: " ✓ src/foo.test.ts (3 tests)" or " × src/foo.test.ts (1 test)"
    // Must be checked BEFORE individual test failure lines
    if (/^\s*[✓×✗]\s+\S+\.(test|spec)\.(ts|tsx|js|jsx)/.test(line)) {
      flushFailure();
      continue;
    }

    // Individual test failure: "   × suite > test name" (more deeply indented)
    const failMatch = line.match(/^\s{2,}[×✗]\s+(.+)/);
    if (failMatch) {
      flushFailure();
      inFailureBlock = true;
      failureName = failMatch[1].trim();
      continue;
    }

    if (inFailureBlock) {
      failureLines.push(line);
    }
  }
  flushFailure();

  // Parse summary: "Test Files  1 failed | 1 passed (2)" and "Tests  1 failed | 3 passed (4)"
  const testSummary = text.match(/Tests\s+(.+?)(?:\n|$)/);
  let passed = 0, failed = 0, skipped = 0, total = 0;
  if (testSummary) {
    const s = testSummary[1];
    const failedM = s.match(/(\d+)\s+failed/);
    const passedM = s.match(/(\d+)\s+passed/);
    const skippedM = s.match(/(\d+)\s+(?:skipped|todo)/);
    const totalM = s.match(/\((\d+)\)/);
    failed = failedM ? parseInt(failedM[1], 10) : 0;
    passed = passedM ? parseInt(passedM[1], 10) : 0;
    skipped = skippedM ? parseInt(skippedM[1], 10) : 0;
    total = totalM ? parseInt(totalM[1], 10) : (passed + failed + skipped);
  } else {
    failed = tests.filter(t => t.status === 'failed').length;
    total = tests.length;
  }

  return {
    summary: {
      runId,
      framework: 'vitest',
      projectDir: '',
      total,
      passed,
      failed,
      skipped,
      duration: 0,
      failedTests: tests.filter(t => t.status === 'failed').map(t => t.fullName),
      timedOut: false,
      partial: false,
      timestamp: new Date().toISOString(),
      command: 'parse_log (Vitest CI output)',
    },
    tests,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function parseLog(
  rawText: string,
  options?: { framework?: FrameworkName },
): Promise<TestRunResult> {
  const text = cleanLogText(rawText);
  const runId = randomUUID();
  const framework = options?.framework ?? detectFrameworkFromLog(text);

  if (!framework) {
    return {
      summary: {
        runId,
        framework: 'jest', // placeholder
        projectDir: '',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        failedTests: [],
        timedOut: false,
        partial: true,
        timestamp: new Date().toISOString(),
        command: 'parse_log (unable to detect framework)',
      },
      tests: [],
      rawOutput: text,
    };
  }

  switch (framework) {
    case 'pytest': {
      const adapter = new PytestAdapter();
      return adapter.parseOutput(text, '', 1, {
        projectDir: '',
        env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
      });
    }
    case 'jest': {
      // Try JSON first (some CI logs contain raw JSON output)
      const adapter = new JestAdapter();
      try {
        const jsonStart = text.indexOf('{"numTotalTests"');
        if (jsonStart >= 0) {
          return await adapter.parseOutput(text.slice(jsonStart), '', 0, { projectDir: '' });
        }
      } catch { /* fall through to human-readable parsing */ }
      return parseJestLog(runId, text);
    }
    case 'vitest': {
      // Try JSON first
      const adapter = new VitestAdapter();
      try {
        const jsonStart = text.indexOf('{"numTotalTests"');
        if (jsonStart >= 0) {
          return await adapter.parseOutput(text.slice(jsonStart), '', 0, { projectDir: '' });
        }
      } catch { /* fall through to human-readable parsing */ }
      return parseVitestLog(runId, text);
    }
  }
}
