import { describe, it, expect } from 'vitest';
import { PytestAdapter } from '../adapters/pytest.js';
import type { RunOptions } from '../types.js';

const adapter = new PytestAdapter();

const baseOptions: RunOptions = {
  projectDir: '/test/project',
};

describe('PytestAdapter', () => {
  describe('buildCommand', () => {
    it('uses python by default', () => {
      const { command, args } = adapter.buildCommand(baseOptions);
      expect(command).toBe('python');
      expect(args[0]).toBe('-m');
      expect(args[1]).toBe('pytest');
    });

    it('uses poetry run when packageManager is poetry', () => {
      const { command, args } = adapter.buildCommand({ ...baseOptions, packageManager: 'poetry' });
      expect(command).toBe('poetry');
      expect(args.slice(0, 4)).toEqual(['run', 'python', '-m', 'pytest']);
    });

    it('includes json-report flags in normal mode', () => {
      const { args } = adapter.buildCommand(baseOptions);
      expect(args).toContain('--json-report');
    });

    it('uses verbose mode in fallback', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, fallbackMode: true } as any);
      expect(args).toContain('-v');
      expect(args).not.toContain('--json-report');
    });

    it('adds -k for testNamePattern', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, testNamePattern: 'test_foo' });
      const kIdx = args.indexOf('-k');
      expect(kIdx).toBeGreaterThan(0);
      expect(args[kIdx + 1]).toBe('test_foo');
    });
  });

  describe('parseOutput (JSON report)', () => {
    it('parses pytest-json-report format', async () => {
      // Simulate reading from the output file by providing it through env
      // Since parseOutput tries to read a file first then falls back to parsing,
      // we test the fallback path by not providing the env file
      const result = await adapter.parseOutput('', '', 0, baseOptions);
      // Without a JSON file or verbose output, should get fallback result
      expect(result.summary.framework).toBe('pytest');
    });
  });

  describe('parseFallbackOutput (verbose mode)', () => {
    it('parses verbose PASSED/FAILED lines', async () => {
      const stdout = `============================= test session starts ==============================
collecting ... collected 3 items

tests/test_math.py::test_add PASSED [  33%]
tests/test_math.py::test_subtract PASSED [  66%]
tests/test_math.py::test_divide FAILED [ 100%]

================================= FAILURES =================================
________________________________ test_divide _______________________________

    def test_divide():
        result = divide(10, 3)
>       assert result == 3
E       AssertionError: assert 3.3333333333333335 == 3

tests/test_math.py:15: AssertionError
========================= short test summary info ==========================
FAILED tests/test_math.py::test_divide - AssertionError: assert 3.3333333333333335 == 3
======================== 1 failed, 2 passed in 0.15s ======================`;

      // Trigger fallback by having empty env (no output file)
      const options: RunOptions = { ...baseOptions, env: { __TEST_SOLVER_OUTPUT_FILE: '' } };
      const result = await adapter.parseOutput(stdout, '', 1, options);

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.tests).toHaveLength(3);

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.name).toBe('test_divide');
      expect(failed!.failureMessage).toContain('AssertionError');
    });

    it('parses parametrized test names', async () => {
      const stdout = `tests/test_validation.py::test_check[case1-valid] PASSED [  50%]
tests/test_validation.py::test_check[case2-invalid] FAILED [ 100%]

========================= short test summary info ==========================
FAILED tests/test_validation.py::test_check[case2-invalid] - ValueError: bad
======================== 1 failed, 1 passed in 0.10s ======================`;

      const options: RunOptions = { ...baseOptions, env: { __TEST_SOLVER_OUTPUT_FILE: '' } };
      const result = await adapter.parseOutput(stdout, '', 1, options);

      expect(result.tests).toHaveLength(2);
      expect(result.tests[1].name).toBe('test_check[case2-invalid]');
      expect(result.tests[1].failureMessage).toContain('ValueError');
    });

    it('handles output with no test results', async () => {
      const stdout = `============================= test session starts ==============================
ERROR: not found: /test/project/tests/nonexistent.py
======================== no tests ran in 0.01s =============================`;

      const options: RunOptions = { ...baseOptions, env: { __TEST_SOLVER_OUTPUT_FILE: '' } };
      const result = await adapter.parseOutput(stdout, '', 4, options);

      expect(result.summary.total).toBe(0);
      expect(result.tests).toEqual([]);
    });

    it('handles SKIPPED tests', async () => {
      const stdout = `tests/test_math.py::test_add PASSED [  50%]
tests/test_math.py::test_slow SKIPPED [ 100%]

======================== 1 passed, 1 skipped in 0.05s =====================`;

      const options: RunOptions = { ...baseOptions, env: { __TEST_SOLVER_OUTPUT_FILE: '' } };
      const result = await adapter.parseOutput(stdout, '', 0, options);

      expect(result.tests).toHaveLength(2);
      expect(result.tests[1].status).toBe('skipped');
    });
  });
});
