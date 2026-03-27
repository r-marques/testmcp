import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { detectFrameworks, selectAdapter } from '../utils/detect.js';
import type { FrameworkDetection } from '../types.js';

const fixturesDir = join(import.meta.dirname, '../../test/fixtures');

describe('detectFrameworks', () => {
  it('detects Jest from jest.config.json', async () => {
    const results = await detectFrameworks(join(fixturesDir, 'jest-project'));
    expect(results).toHaveLength(1);
    expect(results[0].framework).toBe('jest');
    expect(results[0].configFile).toBe('jest.config.json');
    expect(results[0].packageManager).toBe('npm');
  });

  it('detects testmcp itself as Vitest project', async () => {
    // testmcp uses Vitest — should detect it
    const results = await detectFrameworks(join(import.meta.dirname, '../..'));
    const vitest = results.find(r => r.framework === 'vitest');
    expect(vitest).toBeDefined();
    expect(vitest!.packageManager).toBe('yarn');
  });

  it('returns empty for a directory with no frameworks', async () => {
    const results = await detectFrameworks('/tmp');
    expect(results).toEqual([]);
  });
});

describe('selectAdapter', () => {
  const jest: FrameworkDetection = { framework: 'jest', configFile: 'jest.config.json', testFilePatterns: [] };
  const vitest: FrameworkDetection = { framework: 'vitest', configFile: 'vitest.config.ts', testFilePatterns: [] };
  const pytest: FrameworkDetection = { framework: 'pytest', configFile: 'pyproject.toml', testFilePatterns: [] };

  it('selects the only detected framework', () => {
    expect(selectAdapter([jest])).toBe(jest);
  });

  it('prefers vitest over jest when both detected', () => {
    expect(selectAdapter([jest, vitest])).toBe(vitest);
  });

  it('respects explicit preference', () => {
    expect(selectAdapter([jest, vitest], 'jest')).toBe(jest);
  });

  it('returns null when preferred framework not detected', () => {
    expect(selectAdapter([jest], 'pytest')).toBeNull();
  });

  it('returns null for empty detection list', () => {
    expect(selectAdapter([])).toBeNull();
  });
});
