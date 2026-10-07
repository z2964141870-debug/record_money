import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './config.js';

export function watchSystemWake(onWake: () => void) {
  const binary = join(root, 'bin', 'wake-monitor');
  let child: ChildProcess | undefined, retry: NodeJS.Timeout | undefined, stopped = false;
  function start() {
    if (stopped || process.platform !== 'darwin' || !existsSync(binary)) return;
    let buffer = '';
    child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) if (line === 'wake' && !stopped) onWake();
    });
    child.on('error', () => {});
    child.on('close', () => {
      if (!stopped) { retry = setTimeout(start, 5000); retry.unref(); }
    });
  }
  start();
  return () => { stopped = true; if (retry) clearTimeout(retry); child?.kill(); };
}
