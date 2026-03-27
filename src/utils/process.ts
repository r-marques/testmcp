import { spawn } from 'node:child_process';
import type { ProcessResult } from '../types.js';

const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
}

export async function runProcess(options: SpawnOptions): Promise<ProcessResult> {
  const { command, args, cwd, env, timeout } = options;
  const start = Date.now();

  const mergedEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CI: 'true',
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...env,
  };

  return new Promise((resolve) => {
    const controller = timeout ? new AbortController() : undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, args, {
      cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      signal: controller?.signal,
    });

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;
    let stderrLen = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdoutLen + text.length <= MAX_BUFFER) {
        stdout += text;
        stdoutLen += text.length;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderrLen + text.length <= MAX_BUFFER) {
        stderr += text;
        stderrLen += text.length;
      }
    });

    if (timeout && controller) {
      timer = setTimeout(() => {
        timedOut = true;
        // Kill the process group
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          // Process may have already exited
        }
        // Force kill after 5 seconds
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // Already dead
          }
        }, 5000);
      }, timeout);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
        duration: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: 1,
        timedOut,
        duration: Date.now() - start,
      });
    });
  });
}
