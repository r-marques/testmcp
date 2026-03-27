import { describe, it, expect } from 'vitest';
import { JestAdapter } from '../adapters/jest.js';
import type { RunOptions } from '../types.js';

const adapter = new JestAdapter();

const baseOptions: RunOptions = {
  projectDir: '/test/project',
};

describe('JestAdapter', () => {
  describe('buildCommand', () => {
    it('builds basic command with required flags', () => {
      const { command, args } = adapter.buildCommand(baseOptions);
      expect(command).toBe('npx');
      expect(args).toContain('jest');
      expect(args).toContain('--json');
      expect(args).toContain('--watchAll=false');
      expect(args).toContain('--forceExit');
      expect(args).toContain('--no-color');
    });

    it('adds testPathPattern for fileGlob', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, fileGlob: 'unit' });
      expect(args.some(a => a.includes('--testPathPattern=unit'))).toBe(true);
    });

    it('adds testNamePattern', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, testNamePattern: 'should add' });
      expect(args.some(a => a.includes('--testNamePattern=should add'))).toBe(true);
    });

    it('adds coverage flags', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, coverage: true });
      expect(args).toContain('--coverage');
      expect(args).toContain('--coverageReporters=json-summary');
    });

    it('passes explicit test files after --', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, testFiles: ['a.test.ts', 'b.test.ts'] });
      const dashIdx = args.indexOf('--');
      expect(dashIdx).toBeGreaterThan(0);
      expect(args.slice(dashIdx + 1)).toEqual(['a.test.ts', 'b.test.ts']);
    });
  });

  describe('parseOutput', () => {
    it('parses valid Jest JSON output', async () => {
      const jestJson = JSON.stringify({
        numTotalTests: 3,
        numPassedTests: 2,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: Date.now() - 500,
        testResults: [{
          name: '/test/project/tests/math.test.ts',
          assertionResults: [
            { ancestorTitles: ['math'], title: 'adds', status: 'passed', duration: 5, failureMessages: [] },
            { ancestorTitles: ['math'], title: 'subtracts', status: 'passed', duration: 3, failureMessages: [] },
            { ancestorTitles: ['math'], title: 'divides', status: 'failed', duration: 2, failureMessages: ['Expected 3, received 3.33'] },
          ],
        }],
      });

      const result = await adapter.parseOutput(jestJson, '', 1, baseOptions);

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.framework).toBe('jest');
      expect(result.tests).toHaveLength(3);

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.fullName).toBe('math > divides');
      expect(failed!.failureMessage).toContain('Expected 3');
    });

    it('handles empty test results', async () => {
      const jestJson = JSON.stringify({
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: Date.now(),
        testResults: [],
      });

      const result = await adapter.parseOutput(jestJson, '', 0, baseOptions);
      expect(result.summary.total).toBe(0);
      expect(result.tests).toEqual([]);
    });

    it('returns fallback result for unparseable output', async () => {
      const result = await adapter.parseOutput('not json', 'some error', 1, baseOptions);
      expect(result.summary.partial).toBe(true);
      expect(result.summary.failed).toBe(1);
    });

    it('truncates long failure messages', async () => {
      const longMessage = 'x'.repeat(1000);
      const jestJson = JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: Date.now(),
        testResults: [{
          name: '/test/project/test.ts',
          assertionResults: [
            { ancestorTitles: [], title: 'test', status: 'failed', duration: 1, failureMessages: [longMessage] },
          ],
        }],
      });

      const result = await adapter.parseOutput(jestJson, '', 1, baseOptions);
      expect(result.tests[0].failureMessage!.length).toBeLessThanOrEqual(503); // 500 + "..."
    });
  });
});
