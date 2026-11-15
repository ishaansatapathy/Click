// Entry point of dist/hooks/stop.js. Reads the hook payload from stdin, reports the turn's file activity to the daemon, prints
// nothing, and always exits 0.

import { runStopHook, STOP_DEADLINE_MS } from './stop.js';

const MAX_STDIN_BYTES = 1024 * 1024;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, 1_000);
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_STDIN_BYTES) return finish();
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  await Promise.race([runStopHook(raw, { deadlineMs: STOP_DEADLINE_MS }), new Promise((r) => setTimeout(r, STOP_DEADLINE_MS + 150).unref())]);
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 200).unref(); // normally the event loop is already empty and this never fires
}

main().catch(() => void (process.exitCode = 0));
