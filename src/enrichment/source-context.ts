import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { TestResult, SourceContext } from '../types.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_ENRICHMENTS = 10;
const CONTEXT_LINES = 3;

interface StackFrame {
  file: string;
  line: number;
}

export function parseStackTrace(error: string): StackFrame[] {
  const frames: StackFrame[] = [];

  // Node.js / Jest / Vitest: "at Object.<anonymous> (/path/to/file.ts:42:10)"
  const nodePattern = /at\s+.+?\((.+?):(\d+):\d+\)/g;
  let match: RegExpExecArray | null;
  while ((match = nodePattern.exec(error)) !== null) {
    frames.push({ file: match[1], line: parseInt(match[2], 10) });
  }

  // Node.js without parens: "at /path/to/file.ts:42:10"
  const nodeSimplePattern = /at\s+([^\s(]+):(\d+):\d+/g;
  while ((match = nodeSimplePattern.exec(error)) !== null) {
    if (!frames.some(f => f.file === match![1] && f.line === parseInt(match![2], 10))) {
      frames.push({ file: match[1], line: parseInt(match[2], 10) });
    }
  }

  // Pytest: "file.py:42: AssertionError" or "file.py:42"
  const pytestPattern = /^(.+\.py):(\d+)/gm;
  while ((match = pytestPattern.exec(error)) !== null) {
    frames.push({ file: match[1], line: parseInt(match[2], 10) });
  }

  return frames;
}

async function readSnippet(filePath: string, line: number): Promise<string | undefined> {
  try {
    const fileInfo = await stat(filePath);
    if (fileInfo.size > MAX_FILE_SIZE) return undefined;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    if (line < 1 || line > lines.length) return undefined;

    const start = Math.max(0, line - CONTEXT_LINES - 1);
    const end = Math.min(lines.length, line + CONTEXT_LINES);

    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const marker = lineNum === line ? '>>>' : '   ';
        return `${marker} ${String(lineNum).padStart(4)} | ${l}`;
      })
      .join('\n');
  } catch {
    return undefined;
  }
}

function resolveFilePath(file: string, projectDir: string): string {
  return isAbsolute(file) ? file : join(projectDir, file);
}

export async function enrichTestResult(
  test: TestResult,
  projectDir: string,
): Promise<TestResult> {
  if (test.status !== 'failed') return test;

  const error = test.fullError || test.failureMessage || '';
  if (!error) return test;

  const frames = parseStackTrace(error);
  if (frames.length === 0 && test.sourceContext?.testFile) {
    // No stack frames parsed — keep existing sourceContext as-is
    return test;
  }

  // Separate test file frames from source file frames
  let testFrame: StackFrame | undefined;
  let sourceFrame: StackFrame | undefined;

  for (const frame of frames) {
    const isTestFile = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(frame.file)
      || /test_.*\.py$/.test(frame.file)
      || /__tests__\//.test(frame.file);

    if (isTestFile && !testFrame) {
      testFrame = frame;
    } else if (!isTestFile && !sourceFrame) {
      sourceFrame = frame;
    }

    if (testFrame && sourceFrame) break;
  }

  const context: SourceContext = {
    testFile: test.sourceContext?.testFile ?? testFrame?.file ?? '',
    testLine: testFrame?.line ?? test.sourceContext?.testLine ?? 0,
    sourceFile: sourceFrame?.file,
    sourceLine: sourceFrame?.line,
  };

  // Read code snippets
  if (testFrame) {
    const absPath = resolveFilePath(testFrame.file, projectDir);
    context.codeSnippet = await readSnippet(absPath, testFrame.line);
  }

  if (sourceFrame) {
    const absPath = resolveFilePath(sourceFrame.file, projectDir);
    const sourceSnippet = await readSnippet(absPath, sourceFrame.line);
    if (sourceSnippet) {
      context.codeSnippet = context.codeSnippet
        ? `--- Test File ---\n${context.codeSnippet}\n\n--- Source File ---\n${sourceSnippet}`
        : sourceSnippet;
    }
  }

  return { ...test, sourceContext: context };
}

export async function enrichTestResults(
  tests: TestResult[],
  projectDir: string,
): Promise<TestResult[]> {
  const failed = tests.filter(t => t.status === 'failed');
  const toEnrich = failed.slice(0, MAX_ENRICHMENTS);

  const enriched = await Promise.all(
    toEnrich.map(t => enrichTestResult(t, projectDir))
  );

  // Replace enriched tests in the original array
  const enrichedMap = new Map(enriched.map(t => [t.fullName, t]));
  return tests.map(t => enrichedMap.get(t.fullName) ?? t);
}
