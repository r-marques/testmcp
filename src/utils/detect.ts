import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameworkDetection, FrameworkName } from '../types.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function detectPackageManager(projectDir: string): Promise<string | undefined> {
  if (await fileExists(join(projectDir, 'yarn.lock'))) return 'yarn';
  if (await fileExists(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(join(projectDir, 'package-lock.json'))) return 'npm';
  if (await fileExists(join(projectDir, 'poetry.lock'))) return 'poetry';
  if (await fileExists(join(projectDir, 'bun.lockb'))) return 'bun';
  return undefined;
}

async function detectVitest(projectDir: string): Promise<FrameworkDetection | null> {
  const configFiles = [
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
    'vitest.workspace.ts', 'vitest.workspace.js',
  ];

  for (const file of configFiles) {
    if (await fileExists(join(projectDir, file))) {
      return {
        framework: 'vitest',
        configFile: file,
        testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  // Check package.json for vitest in devDependencies
  const pkg = await readJson(join(projectDir, 'package.json'));
  if (pkg) {
    const devDeps = pkg.devDependencies as Record<string, string> | undefined;
    const deps = pkg.dependencies as Record<string, string> | undefined;
    if (devDeps?.vitest || deps?.vitest) {
      return {
        framework: 'vitest',
        configFile: 'package.json (vitest dependency)',
        testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  return null;
}

async function detectJest(projectDir: string): Promise<FrameworkDetection | null> {
  const configFiles = [
    'jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json',
  ];

  for (const file of configFiles) {
    if (await fileExists(join(projectDir, file))) {
      return {
        framework: 'jest',
        configFile: file,
        testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  // Check package.json for jest config key or dependency
  const pkg = await readJson(join(projectDir, 'package.json'));
  if (pkg) {
    if (pkg.jest) {
      return {
        framework: 'jest',
        configFile: 'package.json (jest config)',
        testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
    const devDeps = pkg.devDependencies as Record<string, string> | undefined;
    if (devDeps?.jest) {
      return {
        framework: 'jest',
        configFile: 'package.json (jest dependency)',
        testFilePatterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  return null;
}

async function detectPytest(projectDir: string): Promise<FrameworkDetection | null> {
  // Check pyproject.toml for pytest config
  if (await fileExists(join(projectDir, 'pyproject.toml'))) {
    const content = await readFile(join(projectDir, 'pyproject.toml'), 'utf-8').catch(() => '');
    if (content.includes('[tool.pytest') || content.includes('pytest')) {
      return {
        framework: 'pytest',
        configFile: 'pyproject.toml',
        testFilePatterns: ['**/test_*.py', '**/*_test.py'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  // Check for pytest.ini
  if (await fileExists(join(projectDir, 'pytest.ini'))) {
    return {
      framework: 'pytest',
      configFile: 'pytest.ini',
      testFilePatterns: ['**/test_*.py', '**/*_test.py'],
      packageManager: await detectPackageManager(projectDir),
    };
  }

  // Check for setup.cfg with pytest section
  if (await fileExists(join(projectDir, 'setup.cfg'))) {
    const content = await readFile(join(projectDir, 'setup.cfg'), 'utf-8').catch(() => '');
    if (content.includes('[tool:pytest]')) {
      return {
        framework: 'pytest',
        configFile: 'setup.cfg',
        testFilePatterns: ['**/test_*.py', '**/*_test.py'],
        packageManager: await detectPackageManager(projectDir),
      };
    }
  }

  // Check for conftest.py
  if (await fileExists(join(projectDir, 'conftest.py'))) {
    return {
      framework: 'pytest',
      configFile: 'conftest.py',
      testFilePatterns: ['**/test_*.py', '**/*_test.py'],
      packageManager: await detectPackageManager(projectDir),
    };
  }

  return null;
}

export async function detectFrameworks(projectDir: string): Promise<FrameworkDetection[]> {
  const detectors: Array<() => Promise<FrameworkDetection | null>> = [
    () => detectVitest(projectDir),
    () => detectJest(projectDir),
    () => detectPytest(projectDir),
  ];

  const results = await Promise.all(detectors.map(d => d()));
  return results.filter((r): r is FrameworkDetection => r !== null);
}

export function selectAdapter(
  detected: FrameworkDetection[],
  preferred?: FrameworkName,
): FrameworkDetection | null {
  if (preferred) {
    return detected.find(d => d.framework === preferred) ?? null;
  }
  // Prefer vitest over jest when both are detected
  if (detected.length > 1) {
    const vitest = detected.find(d => d.framework === 'vitest');
    if (vitest) return vitest;
  }
  return detected[0] ?? null;
}
