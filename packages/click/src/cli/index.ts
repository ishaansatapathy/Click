// `click <command>`. Each command lives in its own module; this file only dispatches.
// Commands are added by their prompts (115 adds serve / index / context / status, Lane A adds init / push / pull / probe).

import { runMap } from './map.js';

const USAGE = `click <command>

  map     inspect the code graph: --stats | --node <id|name> | --path <file>
`;

const io = {
  out: (t: string) => void process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t: string) => void process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'map':
      return runMap(rest, io);
    case undefined:
    case '-h':
    case '--help':
      io.out(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      io.err(`unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => void (process.exitCode = code),
  (e: unknown) => {
    io.err(`click: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
