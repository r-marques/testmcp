import { describe, it, expect } from 'vitest';
import { detectFrameworkFromLog, cleanLogText, parseLog } from '../ci/log-parser.js';

describe('detectFrameworkFromLog', () => {
  it('detects pytest from verbose output', () => {
    const text = `tests/test_math.py::test_add PASSED [  50%]
tests/test_math.py::test_divide FAILED [ 100%]`;
    expect(detectFrameworkFromLog(text)).toBe('pytest');
  });

  it('detects pytest from session header', () => {
    const text = `============================= test session starts ==============================
collected 5 items`;
    expect(detectFrameworkFromLog(text)).toBe('pytest');
  });

  it('detects pytest from FAILURES section', () => {
    const text = `================================= FAILURES =================================
_______________________________ test_divide ________________________________`;
    expect(detectFrameworkFromLog(text)).toBe('pytest');
  });

  it('detects jest from PASS/FAIL lines', () => {
    const text = `PASS src/utils.test.ts
FAIL src/api.test.ts`;
    expect(detectFrameworkFromLog(text)).toBe('jest');
  });

  it('detects jest from summary line', () => {
    const text = `Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total`;
    expect(detectFrameworkFromLog(text)).toBe('jest');
  });

  it('detects vitest from summary', () => {
    const text = ` Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)`;
    expect(detectFrameworkFromLog(text)).toBe('vitest');
  });

  it('returns null for non-test output', () => {
    const text = `Building project...
Compilation successful.
Deploying to staging...`;
    expect(detectFrameworkFromLog(text)).toBeNull();
  });
});

describe('cleanLogText', () => {
  it('strips ANSI escape codes', () => {
    const text = '\u001b[32mPASS\u001b[39m src/test.ts';
    expect(cleanLogText(text)).toBe('PASS src/test.ts');
  });

  it('strips ISO timestamp prefixes', () => {
    const text = '2024-01-15T10:30:00.000Z PASS src/test.ts\n2024-01-15T10:30:01.000Z FAIL src/api.test.ts';
    expect(cleanLogText(text)).toBe('PASS src/test.ts\nFAIL src/api.test.ts');
  });

  it('handles text with no timestamps or ANSI', () => {
    const text = 'plain text';
    expect(cleanLogText(text)).toBe('plain text');
  });
});

describe('parseLog', () => {
  describe('pytest', () => {
    it('parses pytest verbose CI output', async () => {
      const text = `============================= test session starts ==============================
collecting ... collected 3 items

tests/test_math.py::test_add PASSED [  33%]
tests/test_math.py::test_subtract PASSED [  66%]
tests/test_math.py::test_divide FAILED [ 100%]

================================= FAILURES =================================
________________________________ test_divide _______________________________

    def test_divide():
>       assert divide(10, 3) == 3
E       AssertionError: assert 3.33 == 3

tests/test_math.py:15: AssertionError
========================= short test summary info ==========================
FAILED tests/test_math.py::test_divide - AssertionError: assert 3.33 == 3
======================== 1 failed, 2 passed in 0.15s ======================`;

      const result = await parseLog(text);
      expect(result.summary.framework).toBe('pytest');
      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.failedTests).toHaveLength(1);
    });
  });

  describe('jest', () => {
    it('parses jest human-readable CI output', async () => {
      const text = `PASS src/utils.test.ts
FAIL src/api.test.ts
  ● auth > login > rejects expired token

    expect(received).toBe(expected)

    Expected: 401
    Received: 200

      15 |   const res = await login(expiredToken);
    > 16 |   expect(res.status).toBe(401);
         |                      ^

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 3 passed, 4 total
Time:        1.234 s`;

      const result = await parseLog(text);
      expect(result.summary.framework).toBe('jest');
      expect(result.summary.total).toBe(4);
      expect(result.summary.passed).toBe(3);
      expect(result.summary.failed).toBe(1);

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.fullName).toBe('auth > login > rejects expired token');
      expect(failed!.fullError).toContain('expect(received).toBe(expected)');
    });

    it('handles all-passing jest output', async () => {
      const text = `PASS src/utils.test.ts
PASS src/api.test.ts

Test Suites: 2 passed, 2 total
Tests:       5 passed, 5 total
Time:        0.5 s`;

      const result = await parseLog(text);
      expect(result.summary.total).toBe(5);
      expect(result.summary.passed).toBe(5);
      expect(result.summary.failed).toBe(0);
    });
  });

  describe('vitest', () => {
    it('parses vitest human-readable CI output', async () => {
      const text = ` ✓ src/utils.test.ts (3 tests) 5ms
 × src/api.test.ts (1 test) 12ms
   × auth > login > rejects expired token

    AssertionError: expected 200 to be 401

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)`;

      const result = await parseLog(text);
      expect(result.summary.framework).toBe('vitest');
      expect(result.summary.total).toBe(4);
      expect(result.summary.passed).toBe(3);
      expect(result.summary.failed).toBe(1);

      const failed = result.tests.find(t => t.status === 'failed');
      expect(failed).toBeDefined();
      expect(failed!.fullName).toBe('auth > login > rejects expired token');
    });
  });

  describe('framework override', () => {
    it('uses specified framework instead of auto-detecting', async () => {
      const text = `tests/test_math.py::test_add PASSED [100%]
======================== 1 passed in 0.05s ======================`;

      const result = await parseLog(text, { framework: 'pytest' });
      expect(result.summary.framework).toBe('pytest');
      expect(result.summary.passed).toBe(1);
    });
  });

  describe('unknown framework', () => {
    it('returns partial result for unrecognized output', async () => {
      const text = 'Building project... done.\nDeploy successful.';
      const result = await parseLog(text);
      expect(result.summary.partial).toBe(true);
      expect(result.tests).toHaveLength(0);
    });
  });

  describe('CI noise handling', () => {
    it('strips timestamps and ANSI from CI log before parsing', async () => {
      const text = `2024-01-15T10:30:00.000Z \u001b[32mPASS\u001b[39m src/utils.test.ts
2024-01-15T10:30:01.000Z \u001b[31mFAIL\u001b[39m src/api.test.ts
2024-01-15T10:30:01.100Z   ● auth > login > rejects expired token
2024-01-15T10:30:01.200Z
2024-01-15T10:30:01.300Z     Expected: 401
2024-01-15T10:30:01.400Z     Received: 200
2024-01-15T10:30:02.000Z Tests:       1 failed, 1 passed, 2 total`;

      const result = await parseLog(text);
      expect(result.summary.framework).toBe('jest');
      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(1);
    });
  });
});
