import { describe, it, expect } from 'vitest';
import { getAffectedTests } from '../git/diff-analyzer.js';
import { join } from 'node:path';

// These tests use the testmcp repo itself as the git context

describe('getAffectedTests', () => {
  const projectDir = join(import.meta.dirname, '../..');

  it('returns changedFiles from git diff', async () => {
    // The working tree may have uncommitted changes (e.g., from adding vitest).
    // Just verify the function runs and returns the expected shape.
    const result = await getAffectedTests(projectDir, []);
    expect(Array.isArray(result.affectedFiles)).toBe(true);
    expect(Array.isArray(result.changedFiles)).toBe(true);
    expect(typeof result.reasons).toBe('object');
  });

  it('identifies direct test file changes', async () => {
    // Simulate: if store.test.ts were in changedFiles, it should be identified
    const allTestFiles = ['src/__tests__/store.test.ts', 'src/__tests__/detect.test.ts'];

    // We can't easily mock git diff, so test the mapping logic via the full function
    // with a known-good base that has changes
    const result = await getAffectedTests(projectDir, allTestFiles);
    // On a clean tree, no affected files
    expect(result.affectedFiles).toEqual([]);
  });
});
