import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../utils/process.js';
import { PytestAdapter } from '../adapters/pytest.js';
import { JestAdapter } from '../adapters/jest.js';
import { VitestAdapter } from '../adapters/vitest.js';
import type { TestRunResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArtifactInfo {
  name: string;
  sizeInBytes: number;
  createdAt: string;
  expired: boolean;
}

export interface ListArtifactsResult {
  runId: string;
  repo: string;
  artifacts: ArtifactInfo[];
}

// ---------------------------------------------------------------------------
// List artifacts
// ---------------------------------------------------------------------------

export async function listArtifacts(
  repo: string,
  runId: string,
): Promise<ListArtifactsResult> {
  const result = await runProcess({
    command: 'gh',
    args: ['api', `repos/${repo}/actions/runs/${runId}/artifacts`],
    cwd: tmpdir(),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to list artifacts: ${result.stderr}`);
  }

  const data = JSON.parse(result.stdout);
  const artifacts: ArtifactInfo[] = (data.artifacts ?? []).map((a: any) => ({
    name: a.name,
    sizeInBytes: a.size_in_bytes,
    createdAt: a.created_at,
    expired: a.expired,
  }));

  return { runId, repo, artifacts };
}

// ---------------------------------------------------------------------------
// Parse artifact
// ---------------------------------------------------------------------------

/** Try to detect and parse a test result file */
async function tryParseFile(
  filePath: string,
  content: string,
): Promise<TestRunResult | null> {
  const lower = filePath.toLowerCase();
  const runId = randomUUID();
  const baseOptions = { projectDir: '' };

  // JUnit XML
  if (lower.endsWith('.xml') || content.trimStart().startsWith('<?xml') || content.includes('<testsuite')) {
    try {
      const adapter = new PytestAdapter();
      return adapter.parseJunitXml(runId, content, '', '', baseOptions);
    } catch { /* not valid JUnit XML */ }
  }

  // JSONL (reportlog)
  if (lower.endsWith('.jsonl') || (content.includes('"$report_type"') && content.includes('\n'))) {
    try {
      const adapter = new PytestAdapter();
      return adapter.parseReportLog(runId, content, '', '', baseOptions);
    } catch { /* not valid reportlog */ }
  }

  // JSON — could be Jest or Vitest output
  if (lower.endsWith('.json') || content.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(content);

      // Jest/Vitest JSON (has numTotalTests)
      if ('numTotalTests' in parsed && 'testResults' in parsed) {
        // Check if it's Vitest-style (has filepath in testResults) or Jest-style (has name)
        const firstResult = parsed.testResults?.[0];
        if (firstResult?.filepath || firstResult?.tasks) {
          const adapter = new VitestAdapter();
          return await adapter.parseOutput(content, '', 0, baseOptions);
        }
        const adapter = new JestAdapter();
        return await adapter.parseOutput(content, '', 0, baseOptions);
      }

      // pytest-json-report format (has summary.total and tests[])
      if (parsed.summary?.total !== undefined && Array.isArray(parsed.tests)) {
        // This is the old pytest-json-report format — parse manually
        const adapter = new PytestAdapter();
        return await adapter.parseOutput('', '', 0, {
          ...baseOptions,
          env: { __TESTMCP_PARSE_MODE: 'verbose', __TESTMCP_OUTPUT_FILE: '' },
        });
      }
    } catch { /* not valid JSON */ }
  }

  return null;
}

export async function parseArtifact(
  repo: string,
  runId: string,
  artifactName: string,
): Promise<TestRunResult> {
  // Download artifact to a temp directory
  const tempDir = await mkdtemp(join(tmpdir(), 'testmcp-artifact-'));

  try {
    const dlResult = await runProcess({
      command: 'gh',
      args: ['run', 'download', runId, '-n', artifactName, '-D', tempDir, '-R', repo],
      cwd: tmpdir(),
      timeout: 30000,
    });

    if (dlResult.exitCode !== 0) {
      throw new Error(`Failed to download artifact "${artifactName}": ${dlResult.stderr}`);
    }

    // Scan extracted files and try to parse each one
    const files = await scanDir(tempDir);

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const result = await tryParseFile(filePath, content);
        if (result && result.tests.length > 0) {
          result.summary.command = `parse_artifact (${artifactName})`;
          return result;
        }
      } catch {
        // Skip files that can't be read as text
      }
    }

    // No parseable file found — return empty result
    const fileList = files.map(f => f.replace(tempDir + '/', ''));
    throw new Error(
      `No parseable test results found in artifact "${artifactName}". `
      + `Files found: ${fileList.join(', ')}. `
      + `Supported formats: JUnit XML, Jest JSON, Vitest JSON, pytest-reportlog JSONL.`,
    );
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Recursively scan a directory for files */
async function scanDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await scanDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}
