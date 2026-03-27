import { readFile } from 'node:fs/promises';
import { join, basename, dirname, relative } from 'node:path';
import { runProcess } from '../utils/process.js';

export interface AffectedTestResult {
  affectedFiles: string[];
  changedFiles: string[];
  reasons: Record<string, string>;
}

export async function getChangedFiles(
  projectDir: string,
  base?: string,
): Promise<string[]> {
  // Unstaged + staged changes
  const unstaged = await runProcess({
    command: 'git',
    args: ['diff', '--name-only'],
    cwd: projectDir,
  });

  const staged = await runProcess({
    command: 'git',
    args: ['diff', '--name-only', '--cached'],
    cwd: projectDir,
  });

  const files = new Set<string>();

  for (const line of unstaged.stdout.split('\n').concat(staged.stdout.split('\n'))) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }

  // If base is provided, also include committed changes since base
  if (base) {
    const committed = await runProcess({
      command: 'git',
      args: ['diff', '--name-only', `${base}...HEAD`],
      cwd: projectDir,
    });
    for (const line of committed.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }

  return [...files];
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)
    || /test_.*\.py$/.test(file)
    || /.*_test\.py$/.test(file)
    || /\/__tests__\//.test(file);
}

function generateTestCandidates(sourceFile: string): string[] {
  const base = basename(sourceFile).replace(/\.[^.]+$/, '');
  const dir = dirname(sourceFile);
  const candidates: string[] = [];

  // TypeScript/JavaScript patterns
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(sourceFile)) {
    const extensions = ['test.ts', 'test.tsx', 'spec.ts', 'spec.tsx', 'test.js', 'spec.js'];
    for (const ext of extensions) {
      // Same directory: src/utils/parser.test.ts
      candidates.push(join(dir, `${base}.${ext}`));
      // __tests__ directory: src/utils/__tests__/parser.test.ts
      candidates.push(join(dir, '__tests__', `${base}.${ext}`));
      // Mirror in tests/: tests/utils/parser.test.ts
      candidates.push(join('tests', dirname(sourceFile).replace(/^src\//, ''), `${base}.${ext}`));
      candidates.push(join('test', dirname(sourceFile).replace(/^src\//, ''), `${base}.${ext}`));
    }
  }

  // Python patterns
  if (/\.py$/.test(sourceFile)) {
    const pyDir = dirname(sourceFile);
    // test_<name>.py in tests/ mirror
    candidates.push(join('tests', pyDir, `test_${base}.py`));
    candidates.push(join('tests', `test_${base}.py`));
    candidates.push(join('tests', 'unit', `test_${base}.py`));
    candidates.push(join('tests', 'integration', `test_${base}.py`));
    // Same directory
    candidates.push(join(pyDir, `test_${base}.py`));
    candidates.push(join(pyDir, `${base}_test.py`));
  }

  return candidates;
}

async function scanImports(
  projectDir: string,
  changedFiles: string[],
  testFiles: string[],
): Promise<Map<string, string>> {
  const matches = new Map<string, string>();

  if (changedFiles.length > 200) return matches; // Too many, skip

  for (const changed of changedFiles) {
    if (isTestFile(changed)) continue;

    const base = basename(changed).replace(/\.[^.]+$/, '');
    // Escape for regex
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Grep test files for imports of this module
    const result = await runProcess({
      command: 'grep',
      args: ['-rl', '--include=*.ts', '--include=*.tsx', '--include=*.js',
             '--include=*.py', '-E',
             `(from|import).*${escaped}`,
             ...testFiles.length > 0 ? testFiles : ['.']],
      cwd: projectDir,
      timeout: 10000,
    });

    if (result.exitCode === 0) {
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && isTestFile(trimmed)) {
          const rel = relative(projectDir, join(projectDir, trimmed));
          if (!matches.has(rel)) {
            matches.set(rel, `imports ${changed}`);
          }
        }
      }
    }
  }

  return matches;
}

export async function getAffectedTests(
  projectDir: string,
  allTestFiles: string[],
  base?: string,
): Promise<AffectedTestResult> {
  const changedFiles = await getChangedFiles(projectDir, base);
  if (changedFiles.length === 0) {
    return { affectedFiles: [], changedFiles: [], reasons: {} };
  }

  const affected = new Map<string, string>();
  const testFileSet = new Set(allTestFiles);

  // Layer 1: Direct test file changes
  for (const file of changedFiles) {
    if (isTestFile(file)) {
      affected.set(file, 'direct change');
    }
  }

  // Layer 2: Naming convention mapping
  for (const file of changedFiles) {
    if (isTestFile(file)) continue;
    const candidates = generateTestCandidates(file);
    for (const candidate of candidates) {
      // Normalize path separators and check against known test files
      const normalized = candidate.replace(/\\/g, '/');
      for (const testFile of testFileSet) {
        if (testFile.replace(/\\/g, '/').endsWith(normalized) || normalized === testFile.replace(/\\/g, '/')) {
          if (!affected.has(testFile)) {
            affected.set(testFile, `naming convention for ${file}`);
          }
        }
      }
    }
  }

  // Layer 3: Import scanning (grep-based, lightweight)
  const sourceChanges = changedFiles.filter(f => !isTestFile(f));
  if (sourceChanges.length > 0 && sourceChanges.length <= 200) {
    const importMatches = await scanImports(projectDir, sourceChanges, allTestFiles);
    for (const [testFile, reason] of importMatches) {
      if (!affected.has(testFile)) {
        affected.set(testFile, reason);
      }
    }
  }

  const reasons: Record<string, string> = {};
  for (const [file, reason] of affected) {
    reasons[file] = reason;
  }

  return {
    affectedFiles: [...affected.keys()],
    changedFiles,
    reasons,
  };
}
