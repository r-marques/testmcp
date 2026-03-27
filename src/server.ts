import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RunStore } from './store.js';
import { JestAdapter } from './adapters/jest.js';
import { VitestAdapter } from './adapters/vitest.js';
import { PytestAdapter } from './adapters/pytest.js';
import { BaseAdapter } from './adapters/base.js';
import { detectFrameworks, selectAdapter } from './utils/detect.js';
import { runProcess } from './utils/process.js';
import { enrichTestResults } from './enrichment/source-context.js';
import { getAffectedTests } from './git/diff-analyzer.js';
import type { FrameworkName, RunOptions, TestRunResult } from './types.js';

const store = new RunStore();
const adapters: BaseAdapter[] = [new JestAdapter(), new VitestAdapter(), new PytestAdapter()];

function getAdapter(framework: FrameworkName): BaseAdapter {
  const adapter = adapters.find(a => a.framework === framework);
  if (!adapter) throw new Error(`No adapter for framework: ${framework}`);
  return adapter;
}

function jsonResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(code: string, message: string, hint?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, hint }) }],
    isError: true,
  };
}

async function executeRun(adapter: BaseAdapter, options: RunOptions): Promise<TestRunResult> {
  let buildOptions = options;
  let { command, args, env } = adapter.buildCommand(buildOptions);

  let mergedOptions = {
    ...buildOptions,
    env: { ...buildOptions.env, ...env },
  };

  let processResult = await runProcess({
    command,
    args,
    cwd: options.projectDir,
    env: mergedOptions.env,
    timeout: options.timeout,
  });

  // Pytest retry: if --json-report is unrecognized, retry in fallback (verbose) mode
  if (
    adapter.framework === 'pytest'
    && processResult.exitCode !== 0
    && processResult.stderr.includes('unrecognized arguments: --json-report')
  ) {
    buildOptions = { ...options, fallbackMode: true } as RunOptions & { fallbackMode?: boolean };
    const retry = adapter.buildCommand(buildOptions);
    command = retry.command;
    args = retry.args;
    env = retry.env;
    mergedOptions = { ...buildOptions, env: { ...buildOptions.env, ...env } };

    processResult = await runProcess({
      command,
      args,
      cwd: options.projectDir,
      env: mergedOptions.env,
      timeout: options.timeout,
    });
  }

  const result = await adapter.parseOutput(
    processResult.stdout,
    processResult.stderr,
    processResult.exitCode,
    mergedOptions,
  );

  // Update timeout/partial flags from process result
  if (processResult.timedOut) {
    result.summary.timedOut = true;
    result.summary.partial = true;
  }

  // Enrich failures with source context
  result.tests = await enrichTestResults(result.tests, options.projectDir);

  // Store the result
  store.save(result);

  return result;
}

export function registerTools(server: McpServer): void {

  // --- discover ---
  server.tool(
    'discover',
    'Auto-detect test frameworks configured in a project directory',
    { projectDir: z.string().describe('Absolute path to the project directory') },
    async ({ projectDir }) => {
      try {
        const frameworks = await detectFrameworks(projectDir);
        if (frameworks.length === 0) {
          return jsonResponse({
            frameworks: [],
            message: 'No test frameworks detected. Ensure Jest, Vitest, or Pytest is configured.',
          });
        }
        return jsonResponse({ frameworks });
      } catch (err) {
        return errorResponse('detection_failed', `Failed to detect frameworks: ${err}`);
      }
    },
  );

  // --- run_tests ---
  server.tool(
    'run_tests',
    'Run tests and return a compact summary. Use get_failures to drill into failures.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      fileGlob: z.string().optional().describe('Glob pattern to filter test files'),
      testNamePattern: z.string().optional().describe('Regex pattern to filter test names'),
      timeout: z.number().optional().describe('Time budget in milliseconds. Process is killed if exceeded.'),
      coverage: z.boolean().optional().describe('Enable coverage collection'),
      framework: z.enum(['jest', 'vitest', 'pytest']).optional().describe('Force a specific framework'),
    },
    async ({ projectDir, fileGlob, testNamePattern, timeout, coverage, framework }) => {
      try {
        const detected = await detectFrameworks(projectDir);
        const selected = framework
          ? detected.find(d => d.framework === framework) ?? null
          : selectAdapter(detected);

        if (!selected) {
          return errorResponse(
            'framework_not_found',
            `No test framework detected in ${projectDir}`,
            'Run discover to check available frameworks.',
          );
        }

        const adapter = getAdapter(selected.framework);
        const result = await executeRun(adapter, {
          projectDir, fileGlob, testNamePattern, timeout, coverage,
          packageManager: selected.packageManager,
        });

        return jsonResponse(result.summary);
      } catch (err) {
        return errorResponse('execution_failed', `Test execution failed: ${err}`);
      }
    },
  );

  // --- run_affected ---
  server.tool(
    'run_affected',
    'Run only tests affected by git changes. Analyzes diff to find related test files.',
    {
      projectDir: z.string().describe('Absolute path to the project directory'),
      base: z.string().optional().describe('Git ref to diff against (e.g., "main", "HEAD~3"). Defaults to unstaged/staged changes.'),
      timeout: z.number().optional().describe('Time budget in milliseconds'),
      coverage: z.boolean().optional().describe('Enable coverage collection'),
    },
    async ({ projectDir, base, timeout, coverage }) => {
      try {
        const detected = await detectFrameworks(projectDir);
        const selected = selectAdapter(detected);
        if (!selected) {
          return errorResponse('framework_not_found', `No test framework detected in ${projectDir}`);
        }

        const adapter = getAdapter(selected.framework);
        const allTestFiles = await adapter.listTestFiles(projectDir, selected.packageManager);
        const affected = await getAffectedTests(projectDir, allTestFiles, base);

        if (affected.affectedFiles.length === 0) {
          return jsonResponse({
            message: 'No affected tests found',
            changedFiles: affected.changedFiles,
            hint: 'No test files match the changed source files. Run run_tests to execute all tests.',
          });
        }

        const result = await executeRun(adapter, {
          projectDir,
          testFiles: affected.affectedFiles,
          timeout,
          coverage,
          packageManager: selected.packageManager,
        });

        return jsonResponse({
          ...result.summary,
          affectedFiles: affected.affectedFiles,
          reasons: affected.reasons,
        });
      } catch (err) {
        return errorResponse('execution_failed', `Affected test analysis failed: ${err}`);
      }
    },
  );

  // --- get_failures ---
  server.tool(
    'get_failures',
    'Get detailed failure information for a test run, including source context around each failure.',
    { runId: z.string().describe('The run ID from a previous run_tests or run_affected call') },
    async ({ runId }) => {
      const failures = store.getFailures(runId);
      if (failures === undefined) {
        return errorResponse('run_not_found', `No run found with ID: ${runId}`);
      }
      if (failures.length === 0) {
        return jsonResponse({ message: 'No failures in this run', runId });
      }
      // Return failures with sourceContext but without fullError (that's for get_test_detail)
      const concise = failures.map(({ fullError: _, ...rest }) => rest);
      return jsonResponse({ runId, count: failures.length, failures: concise });
    },
  );

  // --- get_test_detail ---
  server.tool(
    'get_test_detail',
    'Get complete details for a single test, including full stack trace.',
    {
      runId: z.string().describe('The run ID from a previous test run'),
      testName: z.string().describe('The test fullName or name to look up'),
    },
    async ({ runId, testName }) => {
      const test = store.getTestDetail(runId, testName);
      if (!test) {
        const run = store.get(runId);
        if (!run) return errorResponse('run_not_found', `No run found with ID: ${runId}`);
        return errorResponse('test_not_found', `No test matching "${testName}" in run ${runId}`);
      }
      return jsonResponse(test);
    },
  );

  // --- rerun_failed ---
  server.tool(
    'rerun_failed',
    'Re-execute only the tests that failed in a previous run.',
    {
      runId: z.string().describe('The run ID whose failed tests should be re-run'),
      timeout: z.number().optional().describe('Time budget in milliseconds'),
    },
    async ({ runId, timeout }) => {
      const previousRun = store.get(runId);
      if (!previousRun) {
        return errorResponse('run_not_found', `No run found with ID: ${runId}`);
      }
      if (previousRun.summary.failedTests.length === 0) {
        return jsonResponse({ message: 'No failures to rerun', runId });
      }

      const adapter = getAdapter(previousRun.summary.framework);

      // Extract test file paths from failed tests
      const failedFiles = new Set<string>();
      for (const test of previousRun.tests) {
        if (test.status === 'failed' && test.sourceContext?.testFile) {
          failedFiles.add(test.sourceContext.testFile);
        }
      }

      // Build a name pattern from failed test names
      const namePattern = previousRun.summary.failedTests
        .map(name => {
          // Get the last part (actual test name) and escape regex
          const lastPart = name.split(' > ').pop() ?? name;
          return lastPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('|');

      const result = await executeRun(adapter, {
        projectDir: previousRun.summary.projectDir,
        testFiles: failedFiles.size > 0 ? [...failedFiles] : undefined,
        testNamePattern: namePattern,
        timeout,
      });

      return jsonResponse(result.summary);
    },
  );

  // --- get_coverage ---
  server.tool(
    'get_coverage',
    'Get coverage data from a previous test run.',
    {
      runId: z.string().describe('The run ID from a test run with coverage enabled'),
      files: z.array(z.string()).optional().describe('Filter coverage to specific file paths'),
    },
    async ({ runId, files }) => {
      const run = store.get(runId);
      if (!run) {
        return errorResponse('run_not_found', `No run found with ID: ${runId}`);
      }
      if (!run.coverage) {
        return errorResponse(
          'no_coverage_data',
          'No coverage data in this run',
          'Rerun with coverage: true to collect coverage.',
        );
      }
      if (files?.length && run.coverage.files) {
        const filtered = run.coverage.files.filter(f =>
          files.some(pattern => f.file.includes(pattern))
        );
        return jsonResponse({ ...run.coverage, files: filtered });
      }
      return jsonResponse(run.coverage);
    },
  );

  // --- list_runs ---
  server.tool(
    'list_runs',
    'List recent test run summaries.',
    { limit: z.number().optional().describe('Maximum number of runs to return (default: 10)') },
    async ({ limit }) => {
      const runs = store.list(limit);
      if (runs.length === 0) {
        return jsonResponse({ message: 'No test runs recorded yet', runs: [] });
      }
      return jsonResponse({ runs });
    },
  );
}
