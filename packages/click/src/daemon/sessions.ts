// PROMPTS 112: what the daemon remembers about each agent session.
//   sent       node ids whose bodies were already delivered, so the packer can send a short ref next time (sessionDedupe)
//   startCommit HEAD at the session's first /context; the Stop hook diffs against it to see what the agent changed
//   contexts / tokens for /stats
// LRU over 200 sessions: a long-lived daemon never grows without bound.

export const MAX_SESSIONS = 200;
const MAX_SENT_PER_SESSION = 5_000;

export interface Session {
  readonly id: string;
  readonly sent: Set<string>;
  contexts: number;
  tokens: number;
  /** undefined until resolved, null when the repo has no HEAD (not a git repo, or no commits yet). */
  startCommit: string | null | undefined;
  /** Files that were already modified (uncommitted) when the session began: they are not the agent's doing. undefined until resolved. */
  baseline: Set<string> | undefined;
  /** Every context this session was sent, oldest first. */
  contextIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export class SessionMemory {
  private readonly sessions = new Map<string, Session>(); // insertion order = recency order

  constructor(
    private readonly max = MAX_SESSIONS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /** The session, created on first use and moved to the most recent position. */
  touch(id: string): Session {
    let s = this.sessions.get(id);
    if (s) this.sessions.delete(id);
    else s = { id, sent: new Set(), contexts: 0, tokens: 0, startCommit: undefined, baseline: undefined, contextIds: [], firstSeen: this.now(), lastSeen: this.now() };
    s.lastSeen = this.now();
    this.sessions.set(id, s);
    while (this.sessions.size > this.max) this.sessions.delete(this.sessions.keys().next().value as string);
    return s;
  }

  /** Read without creating or reordering. */
  peek(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  sent(id: string | undefined): ReadonlySet<string> | undefined {
    return id ? this.sessions.get(id)?.sent : undefined;
  }

  record(id: string, delivered: readonly string[], tokens: number, contextId?: string): void {
    const s = this.touch(id);
    s.contexts++;
    s.tokens += tokens;
    if (contextId) {
      s.contextIds.push(contextId);
      if (s.contextIds.length > 500) s.contextIds.shift();
    }
    for (const n of delivered) {
      if (s.sent.size >= MAX_SENT_PER_SESSION && !s.sent.has(n)) s.sent.delete(s.sent.values().next().value as string); // forget the oldest
      s.sent.add(n);
    }
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }
}
