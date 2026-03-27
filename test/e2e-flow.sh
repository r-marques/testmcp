#!/usr/bin/env bash
# End-to-end test of the progressive disclosure flow
# Sends multiple MCP requests to a single server process

set -euo pipefail

SERVER="node $(dirname "$0")/../dist/index.js"
PROJECT_DIR="${1:-/tmp/testmcp-fixture}"

# Build all JSON-RPC messages
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'
NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized"}'
DISCOVER="{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"discover\",\"arguments\":{\"projectDir\":\"$PROJECT_DIR\"}}}"
RUN_TESTS="{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"run_tests\",\"arguments\":{\"projectDir\":\"$PROJECT_DIR\",\"timeout\":30000}}}"

# We need to extract the runId from run_tests to use in get_failures
# So we pipe all at once and process the output

echo "=== testmcp E2E Test ==="
echo "Project: $PROJECT_DIR"
echo ""

# Send all messages and capture output
OUTPUT=$(printf '%s\n%s\n%s\n%s\n' "$INIT" "$NOTIF" "$DISCOVER" "$RUN_TESTS" | timeout 60 $SERVER 2>/dev/null)

# Parse each response line
echo "--- discover ---"
echo "$OUTPUT" | sed -n '2p' | python3 -c "
import sys, json
resp = json.loads(sys.stdin.read())
data = json.loads(resp['result']['content'][0]['text'])
for fw in data.get('frameworks', []):
    print(f\"  {fw['framework']}: {fw['configFile']} ({fw.get('packageManager', 'unknown')})\")
"

echo ""
echo "--- run_tests ---"
RUN_ID=$(echo "$OUTPUT" | sed -n '3p' | python3 -c "
import sys, json
resp = json.loads(sys.stdin.read())
data = json.loads(resp['result']['content'][0]['text'])
print(data.get('runId', ''))
s = data
print(f\"  Total: {s['total']}, Passed: {s['passed']}, Failed: {s['failed']}, Skipped: {s['skipped']}\", file=sys.stderr)
print(f\"  Duration: {s['duration']}ms\", file=sys.stderr)
if s['failedTests']:
    print(f\"  Failed tests:\", file=sys.stderr)
    for t in s['failedTests']:
        print(f\"    - {t}\", file=sys.stderr)
" 2>&1 | tee /dev/stderr | head -1)

echo ""
echo "Run ID: $RUN_ID"

if [ -n "$RUN_ID" ]; then
  echo ""
  echo "--- get_failures (drill-down) ---"
  GET_FAILURES="{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"get_failures\",\"arguments\":{\"runId\":\"$RUN_ID\"}}}"

  OUTPUT2=$(printf '%s\n%s\n%s\n%s\n%s\n' "$INIT" "$NOTIF" "$RUN_TESTS" "$GET_FAILURES" "" | timeout 60 $SERVER 2>/dev/null)

  # get_failures is the 3rd response (after init and run_tests)
  echo "$OUTPUT2" | sed -n '4p' | python3 -c "
import sys, json
resp = json.loads(sys.stdin.read())
data = json.loads(resp['result']['content'][0]['text'])
if 'failures' in data:
    for f in data['failures']:
        print(f\"  FAIL: {f['fullName']}\")
        if f.get('failureMessage'):
            msg = f['failureMessage'][:200]
            print(f\"    {msg}\")
        if f.get('sourceContext', {}).get('codeSnippet'):
            print(f\"    Source:\")
            for line in f['sourceContext']['codeSnippet'].split('\n')[:5]:
                print(f\"      {line}\")
        print()
else:
    print(json.dumps(data, indent=2))
" 2>&1
fi

echo "=== Done ==="
