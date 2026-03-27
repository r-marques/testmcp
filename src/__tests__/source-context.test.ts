import { describe, it, expect } from 'vitest';
import { parseStackTrace } from '../enrichment/source-context.js';

describe('parseStackTrace', () => {
  it('parses Node.js stack traces with parens', () => {
    const error = `Error: expect(received).toBe(expected)
    at Object.<anonymous> (/home/user/app/tests/math.test.ts:15:18)
    at Promise.then.completed (/home/user/app/node_modules/jest/utils.js:298:28)`;

    const frames = parseStackTrace(error);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]).toEqual({
      file: '/home/user/app/tests/math.test.ts',
      line: 15,
    });
  });

  it('parses Node.js stack traces without parens', () => {
    const error = `Error: something broke
    at /home/user/app/src/handler.ts:42:10`;

    const frames = parseStackTrace(error);
    expect(frames.some(f => f.file === '/home/user/app/src/handler.ts' && f.line === 42)).toBe(true);
  });

  it('parses pytest stack traces', () => {
    const error = `FAILED tests/test_api.py::test_create_user - AssertionError: assert 200 == 201
tests/test_api.py:45: AssertionError`;

    const frames = parseStackTrace(error);
    expect(frames.some(f => f.file === 'tests/test_api.py' && f.line === 45)).toBe(true);
  });

  it('returns empty array for non-stack-trace text', () => {
    const frames = parseStackTrace('just a simple error message');
    expect(frames).toEqual([]);
  });

  it('deduplicates frames with same file and line', () => {
    const error = `Error: fail
    at func (/app/test.ts:10:5)
    at /app/test.ts:10:5`;

    const frames = parseStackTrace(error);
    const matching = frames.filter(f => f.file === '/app/test.ts' && f.line === 10);
    expect(matching).toHaveLength(1);
  });
});
