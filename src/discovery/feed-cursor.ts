/**
 * Opaque feed-continuation cursors for the Reels feed.
 *
 * A cursor is a base64url JSON blob carrying the request context (seed /
 * mood / lang), the page number, and the ids already delivered in this
 * feed session so the next page can exclude them. Bounded: at most
 * MAX_SEEN ids ride along, so a cursor stays small on the wire and a
 * hostile client cannot inflate memory with an unbounded list.
 *
 * Cursors are integrity-checked by shape (not signed — the worst a forged
 * cursor can do is request a differently-seeded page of the same public
 * catalogue).
 */

export interface FeedCursor {
  seed: string;
  mood: string | null;
  lang: string;
  page: number;
  /** Track ids already delivered (oldest first, bounded). */
  seen: string[];
}

export const MAX_SEEN_IDS = 40;
const MAX_CURSOR_BYTES = 1600;

export function encodeFeedCursor(c: FeedCursor): string {
  const payload: FeedCursor = {
    seed: c.seed,
    mood: c.mood || null,
    lang: c.lang,
    page: Math.max(1, Math.floor(c.page || 1)),
    seen: c.seen.filter((s) => typeof s === 'string' && !!s).slice(-MAX_SEEN_IDS),
  };
  const json = JSON.stringify(payload);
  if (json.length > MAX_CURSOR_BYTES) {
    // Defensive: shrink the seen list rather than emit a huge cursor.
    payload.seen = payload.seen.slice(-10);
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Strict decode — any malformed / oversized / wrongly-typed input → null. */
export function decodeFeedCursor(raw: unknown): FeedCursor | null {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
  let parsed: any;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const seed = typeof parsed.seed === 'string' && parsed.seed ? parsed.seed.slice(0, 32) : 'default';
  const mood = typeof parsed.mood === 'string' && parsed.mood ? parsed.mood.slice(0, 32) : null;
  const lang = typeof parsed.lang === 'string' && parsed.lang ? parsed.lang.slice(0, 16) : 'tamil';
  const page = Number.isFinite(Number(parsed.page)) ? Math.max(1, Math.floor(Number(parsed.page))) : 1;
  const seen = Array.isArray(parsed.seen)
    ? parsed.seen.filter((s: unknown): s is string => typeof s === 'string' && !!s).slice(0, MAX_SEEN_IDS)
    : [];
  return { seed, mood, lang, page, seen };
}

/** ids delivered so far → next-page seen list (bounded, oldest dropped). */
export function extendSeen(previous: string[], newIds: string[]): string[] {
  const out = [...previous];
  const have = new Set(out);
  for (const id of newIds) {
    if (!id || have.has(id)) continue;
    have.add(id);
    out.push(id);
  }
  return out.slice(-MAX_SEEN_IDS);
}
