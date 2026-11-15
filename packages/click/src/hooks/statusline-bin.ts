// Entry point of dist/hooks/statusline.js (Claude Code's statusLine command). Tiny on purpose: node:fs + node:path only, so it
// starts and answers well under 50 ms. Reads Claude Code's JSON payload from stdin if one is piped, prints one line, exits 0.
import { runStatusline } from '../cli/statusline.js';

let raw = '';
const done = (): void => {
  void runStatusline([], { out: (t) => process.stdout.write(`${t}\n`) }, process.cwd(), raw).finally(() => process.exit(0));
};
if (process.stdin.isTTY) done();
else {
  process.stdin.on('data', (c: Buffer) => (raw += c.toString('utf8')));
  process.stdin.on('end', done);
  setTimeout(done, 200).unref();
}
