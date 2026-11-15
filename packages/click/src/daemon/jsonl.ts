// PROMPTS 112 / SPEC §14: append-only JSONL logs under `.click/` (contexts.jsonl, outcomes.jsonl).
// Appends are queued so lines never interleave or reorder, and a failure is reported to the caller's logger, never thrown:
// losing a log line must not fail a request.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../../../core/src/util/log.js';

export class JsonlWriter {
  private tail: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(
    readonly file: string,
    private readonly log?: Logger,
  ) {}

  append(record: unknown): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.tail = this.tail.then(async () => {
      try {
        if (!this.dirReady) {
          await mkdir(dirname(this.file), { recursive: true });
          this.dirReady = true;
        }
        await appendFile(this.file, line, 'utf8');
      } catch (e) {
        this.log?.warn('could not append to log', { file: this.file, error: e });
      }
    });
    return this.tail;
  }

  /** Resolves when everything appended so far is on disk. */
  flush(): Promise<void> {
    return this.tail;
  }
}
