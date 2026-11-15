import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cwdFromPayload, findStatsFile, formatStatus, installStatusline, runStatusline, uninstallStatusline } from './statusline.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'click-sl-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-11-16T10:00:00Z');

describe('formatStatus', () => {
  it('shows the last context: tokens, files, time', () => {
    expect(formatStatus({ last: { tokens: 3_140, files: 7, ms: 240.4, ts: '2026-11-16T09:59:00Z' } }, NOW)).toBe('Click ▸ 3.1k ctx · 7 files · 240 ms');
    expect(formatStatus({ last: { tokens: 812, files: 2, ms: 90, ts: '2026-11-16T09:59:00Z' } }, NOW)).toBe('Click ▸ 812 ctx · 2 files · 90 ms');
  });
  it('says when the graph came from the local replica', () => {
    expect(formatStatus({ last: { tokens: 2_000, files: 3, ms: 300, degraded: ['graph-replica'], ts: '2026-11-16T09:59:00Z' } }, NOW)).toContain('· replica');
  });
  it('is idle with no stats, broken stats, or a context older than 30 minutes', () => {
    expect(formatStatus(null, NOW)).toBe('Click ▸ idle');
    expect(formatStatus({}, NOW)).toBe('Click ▸ idle');
    expect(formatStatus({ last: { tokens: 10, files: 1, ms: 1, ts: '2026-11-16T09:00:00Z' } }, NOW)).toBe('Click ▸ idle');
  });
});

describe('statusline plumbing', () => {
  it('finds the repo from a nested directory and from the Claude Code payload', async () => {
    const repo = tmp();
    mkdirSync(join(repo, '.click'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, '.click', 'stats.json'), JSON.stringify({ last: { tokens: 1_500, files: 4, ms: 120, ts: new Date().toISOString() } }));
    expect(findStatsFile(join(repo, 'src', 'deep'))).toBe(join(repo, '.click', 'stats.json'));
    expect(cwdFromPayload(JSON.stringify({ workspace: { current_dir: repo } }), '/elsewhere')).toBe(repo);
    expect(cwdFromPayload('not json', '/fallback')).toBe('/fallback');
    const out: string[] = [];
    expect(await runStatusline([], { out: (t) => out.push(t) }, tmp(), JSON.stringify({ workspace: { current_dir: join(repo, 'src') } }))).toBe(0);
    expect(out).toEqual(['Click ▸ 1.5k ctx · 4 files · 120 ms']);
  });

  it('installs into settings.local.json, never replaces a statusLine the user already has, and uninstalls only its own', () => {
    const repo = tmp();
    const file = join(repo, '.claude', 'settings.local.json');
    expect(installStatusline(repo, 'C:\\x\\dist\\hooks\\statusline.js')).toBe('installed');
    expect(JSON.parse(readFileSync(file, 'utf8')).statusLine).toEqual({ type: 'command', command: 'node "C:/x/dist/hooks/statusline.js"', padding: 0 });
    expect(installStatusline(repo, 'C:\\x\\dist\\hooks\\statusline.js')).toBe('already');
    expect(uninstallStatusline(repo)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).statusLine).toBeUndefined();

    writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line' }, hooks: {} }));
    expect(installStatusline(repo, '/x/statusline.js')).toBe('kept-existing');
    expect(uninstallStatusline(repo)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).statusLine.command).toBe('my-own-line');
  });
});
