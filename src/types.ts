export type TestStatus = 'passed' | 'failed' | 'skipped' | 'todo';
export type FrameworkName = 'jest' | 'vitest' | 'pytest';

export interface SourceContext {
  testFile: string;
  testLine: number;
  sourceFile?: string;
  sourceLine?: number;
  codeSnippet?: string;
}

export interface TestResult {
  name: string;
  fullName: string;
  status: TestStatus;
  duration: number;
  failureMessage?: string;
  fullError?: string;
  sourceContext?: SourceContext;
}

export interface TestRunSummary {
  runId: string;
  framework: FrameworkName;
  projectDir: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failedTests: string[];
  timedOut: boolean;
  partial: boolean;
  timestamp: string;
  command: string;
}

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface FileCoverage {
  file: string;
  lines: CoverageMetric;
  branches: CoverageMetric;
  uncoveredLines: number[];
}

export interface CoverageSummary {
  lines: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  statements: CoverageMetric;
  files?: FileCoverage[];
}

export interface TestRunResult {
  summary: TestRunSummary;
  tests: TestResult[];
  coverage?: CoverageSummary;
  rawOutput?: string;
}

export interface FrameworkDetection {
  framework: FrameworkName;
  configFile: string;
  testFilePatterns: string[];
  packageManager?: string;
}

export interface RunOptions {
  projectDir: string;
  fileGlob?: string;
  testNamePattern?: string;
  testFiles?: string[];
  timeout?: number;
  coverage?: boolean;
  env?: Record<string, string>;
  packageManager?: string;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration: number;
}
