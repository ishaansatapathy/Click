// Coordination state in MAIN/coord/ (PLAN §14.7). One writer per file, so no locking is needed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Seat } from './lib.js';

export const SEATS: readonly Seat[] = ['a', 'b'];
export const SEAT_STATES = ['working', 'waiting', 'blocked', 'idle', 'done'] as const;
export type SeatState = (typeof SEAT_STATES)[number];

export interface SeatInfo {
  worktree: string;
  branch: string;
  agent: string;
}

export interface PairJson {
  v: 1;
  main: string;
  createdAt: string;
  seats: Record<Seat, SeatInfo>;
}

export interface SeatStatus {
  seat: Seat;
  prompt: string | null;
  state: SeatState;
  note: string;
  since: string;
  lastIntegrated: string | null;
  /** Prompts marked done by hand (e.g. ASK prompts that produce no commit). */
  done: string[];
}

export const coordDir = (main: string): string => join(main, 'coord');
export const pairJsonPath = (main: string): string => join(main, 'coord', 'pair.json');
export const statusPath = (main: string, seat: Seat): string => join(main, 'coord', `status-${seat}.json`);
export const stopPath = (main: string): string => join(main, 'coord', 'STOP');
export const requestsDir = (main: string): string => join(main, 'coord', 'requests');
export const branchFor = (seat: Seat): string => `lane/${seat}`;

/** Worktrees live next to MAIN, never inside it, so tsc/vitest/eslint in MAIN never scan them. */
export const worktreePath = (main: string, seat: Seat): string => resolve(main, '..', `${basename(resolve(main))}-wt`, seat);

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function initialStatus(seat: Seat, now: Date = new Date()): SeatStatus {
  return { seat, prompt: null, state: 'idle', note: '', since: now.toISOString(), lastIntegrated: null, done: [] };
}

export function readStatus(main: string, seat: Seat): SeatStatus {
  const s = readJson<Partial<SeatStatus>>(statusPath(main, seat));
  return { ...initialStatus(seat, new Date(0)), ...s, seat, done: s?.done ?? [] };
}

export function writeStatus(main: string, status: SeatStatus): void {
  writeJsonAtomic(statusPath(main, status.seat), status);
}

export function readStop(main: string): string | null {
  const p = stopPath(main);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8').trim() || '(no reason given)';
  } catch {
    return '(unreadable)';
  }
}
