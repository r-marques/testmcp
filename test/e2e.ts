/**
 * End-to-end test of the progressive disclosure flow.
 * Spawns the testmcp server as a child process and sends MCP requests.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROJECT_DIR = process.argv[2] || '/tmp/testmcp-fixture';
let requestId = 0;

function makeRequest(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params,
  });
}

function makeNotification(method: string) {
  return JSON.stringify({ jsonrpc: '2.0', method });
}

async function main() {
  const server = spawn('node', ['dist/index.js'], {
    cwd: '/home/rodmar/code/testmcp',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: server.stdout });
  const responses: Record<number, unknown> = {};

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id) responses[msg.id] = msg;
    } catch { /* ignore non-JSON */ }
  });

  function send(msg: string): void {
    server.stdin.write(msg + '\n');
  }

  function waitForResponse(id: number, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (responses[id]) {
          clearInterval(check);
          resolve(responses[id]);
        }
      }, 50);
      setTimeout(() => { clearInterval(check); reject(new Error(`Timeout waiting for response ${id}`)); }, timeoutMs);
    });
  }

  function parseContent(resp: any): any {
    return JSON.parse(resp.result.content[0].text);
  }

  try {
    // Initialize
    send(makeRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '0.1.0' },
    }));
    const initResp = await waitForResponse(requestId);
    console.log('=== Server initialized:', initResp.result.serverInfo.name, initResp.result.serverInfo.version, '===\n');
    send(makeNotification('notifications/initialized'));

    // Step 1: Discover
    send(makeRequest('tools/call', {
      name: 'discover',
      arguments: { projectDir: PROJECT_DIR },
    }));
    const discoverResp = await waitForResponse(requestId);
    const discoverData = parseContent(discoverResp);
    console.log('--- Step 1: discover ---');
    for (const fw of discoverData.frameworks) {
      console.log(`  ${fw.framework}: ${fw.configFile} (${fw.packageManager || 'unknown'})`);
    }

    // Step 2: Run tests
    console.log('\n--- Step 2: run_tests ---');
    send(makeRequest('tools/call', {
      name: 'run_tests',
      arguments: { projectDir: PROJECT_DIR, timeout: 30000 },
    }));
    const runResp = await waitForResponse(requestId);
    const summary = parseContent(runResp);
    console.log(`  Total: ${summary.total}, Passed: ${summary.passed}, Failed: ${summary.failed}, Skipped: ${summary.skipped}`);
    console.log(`  Duration: ${summary.duration}ms`);
    console.log(`  Run ID: ${summary.runId}`);
    if (summary.failedTests.length) {
      console.log('  Failed tests:');
      for (const t of summary.failedTests) console.log(`    - ${t}`);
    }

    // Step 3: Get failures (drill down)
    if (summary.failed > 0) {
      console.log('\n--- Step 3: get_failures (drill-down) ---');
      send(makeRequest('tools/call', {
        name: 'get_failures',
        arguments: { runId: summary.runId },
      }));
      const failResp = await waitForResponse(requestId);
      const failData = parseContent(failResp);

      for (const f of failData.failures) {
        console.log(`\n  FAIL: ${f.fullName}`);
        if (f.failureMessage) {
          const msg = f.failureMessage.split('\n').slice(0, 3).join('\n    ');
          console.log(`    ${msg}`);
        }
        if (f.sourceContext?.codeSnippet) {
          console.log('    Source context:');
          for (const line of f.sourceContext.codeSnippet.split('\n').slice(0, 7)) {
            console.log(`      ${line}`);
          }
        }
      }

      // Step 4: Get single test detail (deep dive)
      const firstFailed = summary.failedTests[0];
      console.log(`\n--- Step 4: get_test_detail ("${firstFailed}") ---`);
      send(makeRequest('tools/call', {
        name: 'get_test_detail',
        arguments: { runId: summary.runId, testName: firstFailed },
      }));
      const detailResp = await waitForResponse(requestId);
      const detail = parseContent(detailResp);
      console.log(`  Name: ${detail.fullName}`);
      console.log(`  Status: ${detail.status}`);
      console.log(`  Duration: ${detail.duration}ms`);
      if (detail.fullError) {
        console.log('  Full error (first 10 lines):');
        for (const line of detail.fullError.split('\n').slice(0, 10)) {
          console.log(`    ${line}`);
        }
      }
    }

    // Step 5: List runs
    console.log('\n--- Step 5: list_runs ---');
    send(makeRequest('tools/call', {
      name: 'list_runs',
      arguments: {},
    }));
    const listResp = await waitForResponse(requestId);
    const listData = parseContent(listResp);
    for (const run of listData.runs) {
      console.log(`  ${run.runId.slice(0, 8)}... | ${run.framework} | ${run.total} tests | ${run.passed}/${run.failed}/${run.skipped} | ${run.duration}ms`);
    }

    console.log('\n=== E2E test complete ===');
  } finally {
    server.stdin.end();
    server.kill();
  }
}

main().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
