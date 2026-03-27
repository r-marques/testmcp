import { describe, it, expect, beforeEach } from 'vitest';
import { RunStore } from '../store.js';
import type { TestRunResult } from '../types.js';

function makeRun(runId: string, overrides: Partial<TestRunResult['summary']> = {}): TestRunResult {
  return {
    summary: {
      runId,
      framework: 'jest',
      projectDir: '/test',
      total: 5,
      passed: 4,
      failed: 1,
      skipped: 0,
      duration: 100,
      failedTests: ['test > fails'],
      timedOut: false,
      partial: false,
      timestamp: new Date().toISOString(),
      command: 'jest',
      ...overrides,
    },
    tests: [
      { name: 'passes', fullName: 'test > passes', status: 'passed', duration: 10 },
      { name: 'fails', fullName: 'test > fails', status: 'failed', duration: 20, failureMessage: 'Expected 1 to be 2', fullError: 'Error: Expected 1 to be 2\n    at Object.<anonymous> (test.ts:5:10)' },
      { name: 'skipped', fullName: 'test > skipped', status: 'skipped', duration: 0 },
    ],
    rawOutput: 'raw output for ' + runId,
  };
}

describe('RunStore', () => {
  let store: RunStore;

  beforeEach(() => {
    store = new RunStore();
  });

  it('saves and retrieves a run', () => {
    const run = makeRun('run-1');
    store.save(run);
    expect(store.get('run-1')).toBe(run);
  });

  it('returns undefined for unknown run ID', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('lists runs in reverse chronological order', () => {
    store.save(makeRun('run-1'));
    store.save(makeRun('run-2'));
    store.save(makeRun('run-3'));

    const list = store.list();
    expect(list.map(r => r.runId)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('respects the limit parameter', () => {
    store.save(makeRun('run-1'));
    store.save(makeRun('run-2'));
    store.save(makeRun('run-3'));

    const list = store.list(2);
    expect(list).toHaveLength(2);
    expect(list.map(r => r.runId)).toEqual(['run-3', 'run-2']);
  });

  it('getFailures returns only failed tests', () => {
    store.save(makeRun('run-1'));
    const failures = store.getFailures('run-1');
    expect(failures).toHaveLength(1);
    expect(failures![0].fullName).toBe('test > fails');
  });

  it('getFailures returns undefined for unknown run', () => {
    expect(store.getFailures('nonexistent')).toBeUndefined();
  });

  it('getTestDetail finds by fullName', () => {
    store.save(makeRun('run-1'));
    const detail = store.getTestDetail('run-1', 'test > fails');
    expect(detail).toBeDefined();
    expect(detail!.name).toBe('fails');
    expect(detail!.fullError).toContain('Expected 1 to be 2');
  });

  it('getTestDetail finds by name', () => {
    store.save(makeRun('run-1'));
    const detail = store.getTestDetail('run-1', 'passes');
    expect(detail).toBeDefined();
    expect(detail!.fullName).toBe('test > passes');
  });

  it('getTestDetail returns undefined for unknown test', () => {
    store.save(makeRun('run-1'));
    expect(store.getTestDetail('run-1', 'nonexistent')).toBeUndefined();
  });

  it('evicts oldest runs when capacity exceeded', () => {
    // Store has max 50 runs
    for (let i = 0; i < 55; i++) {
      store.save(makeRun(`run-${i}`));
    }

    // First 5 should be evicted
    expect(store.get('run-0')).toBeUndefined();
    expect(store.get('run-4')).toBeUndefined();
    // Run 5 onwards should still exist
    expect(store.get('run-5')).toBeDefined();
    expect(store.get('run-54')).toBeDefined();
  });

  it('trims rawOutput from older runs', () => {
    // Max 5 runs keep rawOutput
    for (let i = 0; i < 10; i++) {
      store.save(makeRun(`run-${i}`));
    }

    // Oldest runs should have rawOutput trimmed
    expect(store.get('run-0')!.rawOutput).toBeUndefined();
    expect(store.get('run-4')!.rawOutput).toBeUndefined();
    // Recent 5 should keep rawOutput
    expect(store.get('run-5')!.rawOutput).toBeDefined();
    expect(store.get('run-9')!.rawOutput).toBeDefined();
  });
});
