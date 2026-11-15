// Test helper, run as a separate process (`node --import tsx log.child.ts <file> <tag> <count>`): appends <count> events as fast as it can.
import { EventLog, LOG_VERSION } from './log.js';

const [file, tag, count] = process.argv.slice(2);
const log = new EventLog<{ v: number; tag: string; n: number; pad: string }>(file!);
const pad = 'x'.repeat(2_000); // long enough that a torn write would be visible
await Promise.all(Array.from({ length: Number(count) }, (_, n) => log.append({ v: LOG_VERSION, tag: tag!, n, pad })));
