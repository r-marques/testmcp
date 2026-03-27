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

    it('defaults to reportlog mode', () => {
      const { args, env } = adapter.buildCommand(baseOptions);
      expect(args.some(a => a.startsWith('--report-log='))).toBe(true);
      expect(env?.__TESTMCP_PARSE_MODE).toBe('reportlog');
      expect(env?.__TESTMCP_OUTPUT_FILE).toMatch(/\.jsonl$/);
    });

    it('uses junitxml mode when specified', () => {
      const { args, env } = adapter.buildCommand({ ...baseOptions, parseMode: 'junitxml' } as any);
      expect(args.some(a => a.startsWith('--junitxml='))).toBe(true);
      expect(args.some(a => a.startsWith('--report-log='))).toBe(false);
      expect(env?.__TESTMCP_PARSE_MODE).toBe('junitxml');
      expect(env?.__TESTMCP_OUTPUT_FILE).toMatch(/\.xml$/);
    });

    it('uses verbose mode when specified', () => {
      const { args, env } = adapter.buildCommand({ ...baseOptions, parseMode: 'verbose' } as any);
      expect(args).toContain('-v');
      expect(args.some(a => a.startsWith('--report-log='))).toBe(false);
      expect(args.some(a => a.startsWith('--junitxml='))).toBe(false);
      expect(env?.__TESTMCP_PARSE_MODE).toBe('verbose');
      expect(env?.__TESTMCP_OUTPUT_FILE).toBe('');
    });

    it('adds -k for testNamePattern', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, testNamePattern: 'test_foo' });
      const kIdx = args.indexOf('-k');
      expect(kIdx).toBeGreaterThan(0);
      expect(args[kIdx + 1]).toBe('test_foo');
    });

    it('adds coverage flags', () => {
      const { args } = adapter.buildCommand({ ...baseOptions, coverage: true });
      expect(args).toContain('--cov');
      expect(args).toContain('--cov-report=json');
    });
  });

  // -------------------------------------------------------------------------
  // Layer 1: reportlog JSONL parsing
  // -------------------------------------------------------------------------

  describe('parseReportLog', () => {
    it('parses JSONL with passing and failing tests', () => {
      const jsonl = [
        '{"$report_type": "SessionStart"}',
        '{"$report_type": "TestReport", "nodeid": "tests/test_math.py::test_add", "outcome": "passed", "when": "call", "duration": 0.001}',
        '{"$report_type": "TestReport", "nodeid": "tests/test_math.py::test_subtract", "outcome": "passed", "when": "call", "duration": 0.002}',
        '{"$report_type": "TestReport", "nodeid": "tests/test_math.py::test_divide", "outcome": "failed", "when": "call", "duration": 0.003, "longrepr": "AssertionError: assert 3.33 == 3\\ntests/test_math.py:15: AssertionError"}',
        '{"$report_type": "SessionFinish", "exitstatus": 1, "duration": 0.15}',
      ].join('\n');

      const result = adapter.parseReportLog('run-1', jsonl, '', '', baseOptions);

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(150);
      expect(result.summary.command).toContain('--report-log');

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.name).toBe('test_divide');
      expect(failed!.fullName).toBe('tests/test_math.py > test_divide');
      expect(failed!.failureMessage).toContain('AssertionError');
      expect(failed!.sourceContext?.testFile).toBe('tests/test_math.py');
      expect(failed!.sourceContext?.testLine).toBe(15);
    });

    it('handles setup failures (test never reaches call phase)', () => {
      const jsonl = [
        '{"$report_type": "TestReport", "nodeid": "tests/test_db.py::test_query", "outcome": "failed", "when": "setup", "duration": 0.01, "longrepr": "fixture \'db_conn\' not found"}',
        '{"$report_type": "SessionFinish", "exitstatus": 1, "duration": 0.05}',
      ].join('\n');

      const result = adapter.parseReportLog('run-2', jsonl, '', '', baseOptions);

      expect(result.summary.total).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.tests[0].status).toBe('failed');
      expect(result.tests[0].failureMessage).toContain('fixture');
    });

    it('merges setup + call + teardown reports for same nodeid', () => {
      const jsonl = [
        '{"$report_type": "TestReport", "nodeid": "tests/test_x.py::test_one", "outcome": "passed", "when": "setup", "duration": 0.001}',
        '{"$report_type": "TestReport", "nodeid": "tests/test_x.py::test_one", "outcome": "passed", "when": "call", "duration": 0.005}',
        '{"$report_type": "TestReport", "nodeid": "tests/test_x.py::test_one", "outcome": "passed", "when": "teardown", "duration": 0.001}',
        '{"$report_type": "SessionFinish", "exitstatus": 0, "duration": 0.01}',
      ].join('\n');

      const result = adapter.parseReportLog('run-3', jsonl, '', '', baseOptions);

      // Should produce exactly 1 test, not 3
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].status).toBe('passed');
      expect(result.tests[0].duration).toBe(5); // from call phase
    });

    it('handles skipped tests', () => {
      const jsonl = [
        '{"$report_type": "TestReport", "nodeid": "tests/test_x.py::test_skip", "outcome": "skipped", "when": "setup", "duration": 0.0}',
        '{"$report_type": "SessionFinish", "exitstatus": 0, "duration": 0.01}',
      ].join('\n');

      const result = adapter.parseReportLog('run-4', jsonl, '', '', baseOptions);

      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].status).toBe('skipped');
    });

    it('handles empty JSONL', () => {
      const result = adapter.parseReportLog('run-5', '', '', '', baseOptions);
      expect(result.tests).toHaveLength(0);
      expect(result.summary.total).toBe(0);
    });

    it('ignores malformed JSONL lines', () => {
      const jsonl = [
        '{"$report_type": "TestReport", "nodeid": "tests/t.py::test_ok", "outcome": "passed", "when": "call", "duration": 0.001}',
        'this is not valid json',
        '{"$report_type": "SessionFinish", "exitstatus": 0, "duration": 0.01}',
      ].join('\n');

      const result = adapter.parseReportLog('run-6', jsonl, '', '', baseOptions);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0].status).toBe('passed');
    });

    it('promotes to failed if teardown fails', () => {
      const jsonl = [
        '{"$report_type": "TestReport", "nodeid": "tests/t.py::test_ok", "outcome": "passed", "when": "call", "duration": 0.001}',
        '{"$report_type": "TestReport", "nodeid": "tests/t.py::test_ok", "outcome": "failed", "when": "teardown", "duration": 0.001, "longrepr": "teardown error"}',
        '{"$report_type": "SessionFinish", "exitstatus": 1, "duration": 0.01}',
      ].join('\n');

      const result = adapter.parseReportLog('run-7', jsonl, '', '', baseOptions);
      expect(result.tests[0].status).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // Layer 2: JUnit XML parsing
  // -------------------------------------------------------------------------

  describe('parseJunitXml', () => {
    it('parses JUnit XML with passing and failing tests', () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="0" failures="1" skipped="0" tests="3" time="0.150">
    <testcase classname="tests.test_math" name="test_add" time="0.001"/>
    <testcase classname="tests.test_math" name="test_subtract" time="0.002"/>
    <testcase classname="tests.test_math" name="test_divide" time="0.003">
      <failure message="AssertionError: assert 3.33 == 3">
def test_divide():
    result = divide(10, 3)
&gt;   assert result == 3
E   AssertionError: assert 3.3333333333333335 == 3

tests/test_math.py:15: AssertionError
      </failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = adapter.parseJunitXml('run-1', xml, '', '', baseOptions);

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(150);
      expect(result.summary.command).toContain('--junitxml');

      expect(result.tests).toHaveLength(3);
      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.name).toBe('test_divide');
      expect(failed!.failureMessage).toContain('AssertionError');
      // fullError should unescape XML entities
      expect(failed!.fullError).toContain('>   assert result == 3');
      expect(failed!.sourceContext?.testLine).toBe(15);
    });

    it('parses self-closing testcase elements (passing tests)', () => {
      const xml = `<testsuite tests="2" failures="0" time="0.05">
  <testcase classname="tests.test_simple" name="test_one" time="0.01"/>
  <testcase classname="tests.test_simple" name="test_two" time="0.02"/>
</testsuite>`;

      const result = adapter.parseJunitXml('run-2', xml, '', '', baseOptions);

      expect(result.tests).toHaveLength(2);
      expect(result.tests.every(t => t.status === 'passed')).toBe(true);
    });

    it('handles skipped tests', () => {
      const xml = `<testsuite tests="2" failures="0" skipped="1" time="0.05">
  <testcase classname="tests.test_skip" name="test_fast" time="0.01"/>
  <testcase classname="tests.test_skip" name="test_slow" time="0.00">
    <skipped message="slow test"/>
  </testcase>
</testsuite>`;

      const result = adapter.parseJunitXml('run-3', xml, '', '', baseOptions);

      expect(result.tests).toHaveLength(2);
      expect(result.tests[1].status).toBe('skipped');
      expect(result.summary.skipped).toBe(1);
    });

    it('handles error elements', () => {
      const xml = `<testsuite tests="1" failures="0" errors="1" time="0.05">
  <testcase classname="tests.test_err" name="test_boom" time="0.01">
    <error message="RuntimeError: boom">traceback here</error>
  </testcase>
</testsuite>`;

      const result = adapter.parseJunitXml('run-4', xml, '', '', baseOptions);

      expect(result.tests[0].status).toBe('failed');
      expect(result.tests[0].failureMessage).toContain('RuntimeError');
    });

    it('converts classname to file path', () => {
      const xml = `<testsuite tests="1" failures="0" time="0.01">
  <testcase classname="tests.unit.test_utils" name="test_parse" time="0.001"/>
</testsuite>`;

      const result = adapter.parseJunitXml('run-5', xml, '', '', baseOptions);

      expect(result.tests[0].fullName).toBe('tests/unit/test_utils.py > test_parse');
    });

    it('parses multiple testsuites (Vitest JUnit format)', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="5" failures="1" errors="0" time="0.500">
  <testsuite name="src/utils.test.ts" tests="3" failures="0" time="0.1">
    <testcase classname="src/utils.test.ts" name="adds numbers" time="0.01"/>
    <testcase classname="src/utils.test.ts" name="subtracts numbers" time="0.01"/>
    <testcase classname="src/utils.test.ts" name="multiplies numbers" time="0.01"/>
  </testsuite>
  <testsuite name="src/api.test.ts" tests="2" failures="1" time="0.2">
    <testcase classname="src/api.test.ts" name="handles GET" time="0.01"/>
    <testcase classname="src/api.test.ts" name="handles POST" time="0.05">
      <failure message="expected 200 to be 201">stack trace here</failure>
    </testcase>
  </testsuite>
</testsuites>`;

      const result = adapter.parseJunitXml('run-6', xml, '', '', baseOptions);

      expect(result.tests).toHaveLength(5);
      expect(result.summary.total).toBe(5);
      expect(result.summary.passed).toBe(4);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(500);

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.name).toBe('handles POST');
    });
  });

  // -------------------------------------------------------------------------
  // Layer 3: Verbose stdout parsing (fallback)
  // -------------------------------------------------------------------------

  describe('parseOutput (verbose fallback)', () => {
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

      const options: RunOptions = {
        ...baseOptions,
        env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
      };
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

      const options: RunOptions = {
        ...baseOptions,
        env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
      };
      const result = await adapter.parseOutput(stdout, '', 1, options);

      expect(result.tests).toHaveLength(2);
      expect(result.tests[1].name).toBe('test_check[case2-invalid]');
      expect(result.tests[1].failureMessage).toContain('ValueError');
    });

    it('handles output with no test results', async () => {
      const stdout = `============================= test session starts ==============================
ERROR: not found: /test/project/tests/nonexistent.py
======================== no tests ran in 0.01s =============================`;

      const options: RunOptions = {
        ...baseOptions,
        env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
      };
      const result = await adapter.parseOutput(stdout, '', 4, options);

      expect(result.summary.total).toBe(0);
      expect(result.tests).toEqual([]);
    });

    it('handles SKIPPED tests', async () => {
      const stdout = `tests/test_math.py::test_add PASSED [  50%]
tests/test_math.py::test_slow SKIPPED [ 100%]

======================== 1 passed, 1 skipped in 0.05s =====================`;

      const options: RunOptions = {
        ...baseOptions,
        env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
      };
      const result = await adapter.parseOutput(stdout, '', 0, options);

      expect(result.tests).toHaveLength(2);
      expect(result.tests[1].status).toBe('skipped');
    });
  });

  // -------------------------------------------------------------------------
  // parseOutput dispatch
  // -------------------------------------------------------------------------

  describe('parseOutput dispatch', () => {
    it('defaults to verbose fallback when no env vars set', async () => {
      const result = await adapter.parseOutput('', '', 0, baseOptions);
      expect(result.summary.framework).toBe('pytest');
      expect(result.summary.command).toContain('verbose fallback');
    });

    it('falls back to verbose when output file does not exist', async () => {
      const options: RunOptions = {
        ...baseOptions,
        env: {
          __TESTMCP_PARSE_MODE: 'reportlog',
          __TESTMCP_OUTPUT_FILE: '/nonexistent/path/test.jsonl',
        },
      };
      const result = await adapter.parseOutput('', '', 0, options);
      // Should fall through to verbose parsing without crashing
      expect(result.summary.framework).toBe('pytest');
      expect(result.summary.command).toContain('verbose fallback');
    });
  });
});
