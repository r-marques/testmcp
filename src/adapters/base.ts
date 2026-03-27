import type { FrameworkDetection, FrameworkName, RunOptions, TestRunResult } from '../types.js';

export abstract class BaseAdapter {
  abstract readonly framework: FrameworkName;

  abstract detect(projectDir: string): Promise<FrameworkDetection | null>;

  abstract buildCommand(options: RunOptions): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  abstract parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    options: RunOptions,
  ): Promise<TestRunResult>;

  abstract listTestFiles(projectDir: string, packageManager?: string): Promise<string[]>;
}
