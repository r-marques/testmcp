import type { TestRunResult, TestRunSummary, TestResult } from './types.js';

const MAX_RUNS = 50;
const MAX_RAW_OUTPUT_RUNS = 5;

export class RunStore {
  private runs = new Map<string, TestRunResult>();

  save(result: TestRunResult): void {
    const { runId } = result.summary;

    // Evict oldest if at capacity
    if (this.runs.size >= MAX_RUNS) {
      const oldest = this.runs.keys().next().value!;
      this.runs.delete(oldest);
    }

    this.runs.set(runId, result);

    // Trim rawOutput from older runs to save memory
    const entries = [...this.runs.entries()];
    for (let i = 0; i < entries.length - MAX_RAW_OUTPUT_RUNS; i++) {
      const run = entries[i][1];
      if (run.rawOutput) {
        run.rawOutput = undefined;
      }
    }
  }

  get(runId: string): TestRunResult | undefined {
    return this.runs.get(runId);
  }

  list(limit = 10): TestRunSummary[] {
    const entries = [...this.runs.values()];
    return entries
      .slice(-limit)
      .reverse()
      .map(r => r.summary);
  }

  getFailures(runId: string): TestResult[] | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return run.tests.filter(t => t.status === 'failed');
  }

  getTestDetail(runId: string, testName: string): TestResult | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return run.tests.find(
      t => t.fullName === testName || t.name === testName
    );
  }
}
