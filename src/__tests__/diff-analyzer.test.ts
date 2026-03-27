import { describe, it, expect } from 'vitest';
import { getAffectedTests } from '../git/diff-analyzer.js';
import { join } from 'node:path';

// These tests use the testmcp repo itself as the git context.
// The working tree may have uncommitted changes, so tests verify
// structure and logic rather than asserting specific file lists.

describe('getAffectedTests', () => {
  const projectDir = join(import.meta.dirname, '../..');

  it('returns the expected result shape', async () => {
    const result = await getAffectedTests(projectDir, []);
    expect(Array.isArray(result.affectedFiles)).toBe(true);
    expect(Array.isArray(result.changedFiles)).toBe(true);
    expect(typeof result.reasons).toBe('object');
  });

  it('includes a reason for each affected file', async () => {
    // Use all actual test files so the subset check is meaningful
    const allTestFiles = [
      'src/__tests__/store.test.ts',
      'src/__tests__/detect.test.ts',
      'src/__tests__/diff-analyzer.test.ts',
      'src/__tests__/jest-adapter.test.ts',
      'src/__tests__/pytest-adapter.test.ts',
      'src/__tests__/source-context.test.ts',
      'src/__tests__/log-parser.test.ts',
    ];
    const result = await getAffectedTests(projectDir, allTestFiles);

    for (const f of result.affectedFiles) {
      expect(result.reasons[f]).toBeDefined();
      expect(typeof result.reasons[f]).toBe('string');
    }
  });
});
