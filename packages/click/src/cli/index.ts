// `click <command>`. Each command lives in its own module; this file only dispatches.
// Commands are added by their prompts (115 adds serve / index / context / status; Lane A owns init / push / pull / probe).
// Every command module exports `run<Name>(argv, io, cwd?) => Promise<exitCode>`.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERSION } from '../version.js';
import { runContext } from './context.js';
import { runHooks } from './hooksCmd.js';
import { runIndex } from './indexCmd.js';
import { runInit, runUninstall } from './init.js';
import { runMap } from './map.js';
import { runProbe } from './probe.js';
import { runPull } from './pull.js';
import { runPush } from './push.js';
import { runReindex } from './reindexCmd.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';
import { runWeights } from './weightsCmd.js';

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export type CommandRunner = (argv: readonly string[], io: CliIo, cwd?: string) => Promise<number>;

export const COMMANDS: Readonly<Record<string, { run: CommandRunner; help: string }>> = {
  map: { run: runMap, help: 'inspect the code graph: --stats | --node <id|name> | --path <file>' },
  push: { run: runPush, help: 'index the repo and upload the graph to HydraDB' },
  pull: { run: runPull, help: 'rebuild the local replica from HydraDB' },
  probe: { run: runProbe, help: 'time HydraDB queries and the query embedding (p50 / p95)' },
  serve: { run: runServe, help: 'run the per-repo daemon in the foreground' },
  index: { run: runIndex, help: 'build the code graph and save it locally [--full]' },
  context: { run: runContext, help: 'print the context for a task: "<task>" [--stdin] [--json] [--budget N] [--variant V]' },
  reindex: { run: runReindex, help: 'tell the daemon to refresh its graph [--changed] [paths...]' },
  hooks: { run: runHooks, help: 'install | uninstall | status of the Claude Code (and git) hooks [--local] [--git]' },
  init: { run: runInit, help: 'install Click for the agents in this repository [--dry-run]' },
  uninstall: { run: runUninstall, help: 'remove Click agent integrations; keep graph/cache data' },
  weights: { run: runWeights, help: 'what Click has learned: --show | --rollback' },
  status: { run: runStatus, help: 'is the daemon up, what graph, what it last served [--json]' },
};

export const USAGE = `click <command>\n\n${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(8)} ${c.help}`)
  .join('\n')}\n`;

/** Returns the process exit code. `commands` is injectable for tests. */
export async function dispatch(argv: readonly string[], io: CliIo, cwd: string = process.cwd(), commands: typeof COMMANDS = COMMANDS): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    io.out(USAGE);
    return 2;
  }
  if (cmd === '--version' || cmd === '-v') {
    io.out(VERSION);
    return 0;
  }
  if (cmd === '-h' || cmd === '--help') {
    io.out(USAGE);
    return 0;
  }
  const command = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!command) {
    io.err(`unknown command "${cmd}"\n\n${USAGE}`);
    return 2;
  }
  return command.run(rest, io, cwd);
}

const stdio: CliIo = {
  out: (t) => void process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => void process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  dispatch(process.argv.slice(2), stdio).then(
    (code) => void (process.exitCode = code),
    (e: unknown) => {
      stdio.err(`click: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
