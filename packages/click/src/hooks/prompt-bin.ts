// Entry point of dist/hooks/prompt.js. Reads the hook payload from stdin, runs the hook, prints at most one JSON object, and
// always exits 0 (Claude Code treats any other exit code as an error, and 2 would block the user's prompt).

import { HOOK_DEADLINE_MS, runPromptHook } from './prompt.js';

const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const STDIN_WAIT_MS = 500;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(''); // run by hand, nothing piped in
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8')); // invalid UTF-8 becomes U+FFFD; JSON.parse decides what to do with it
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS * 4);
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
  const used = process.uptime() * 1_000; // node's own start-up counts against the deadline
  const result = await Promise.race([
    runPromptHook(raw, { deadlineMs: Math.max(100, HOOK_DEADLINE_MS - used - 30) }),
    new Promise<null>((r) => setTimeout(() => r(null), HOOK_DEADLINE_MS + 150).unref()),
  ]);
  process.exitCode = 0;
  if (result?.stdout) process.stdout.write(result.stdout);
  else if (!result || result.outcome.startsWith('skip:')) process.exit(0); // nothing was sent anywhere, so there is nothing to close: leave at once
  // Leave by letting the event loop drain (no open sockets: the client closes its own). Only if something still holds the process
  // open, force the exit shortly after: the timer is unref'd, so it never delays a normal exit.
  setTimeout(() => process.exit(0), 300).unref();
}

main().catch(() => void (process.exitCode = 0));
