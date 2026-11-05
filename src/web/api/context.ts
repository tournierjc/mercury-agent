/**
 * Context inspector: the state of one conversation's context through the
 * keeper, and a manual compression on demand.
 *
 *   GET  /api/context/threads/:id          → the snapshot the model sees now
 *     { enabled, saverActive, budget, historyTokens, viewTokens,
 *       needsCompression, cuts, archivedTurns, archivedThrough,
 *       lastReport: { beforeTokens, afterTokens, removedTurns } | null,
 *       notes: { rules, state, open }, notesText }
 *
 *   POST /api/context/threads/:id/compress → force a keeper cut now
 *     { ok: true, outcome: 'cut'|'fits'|'too_short'|'notes_rejected', report? }
 *     A cut that would not strictly shrink the view is refused by the keeper
 *     gate and changes nothing; the outcome says why.
 *
 *   GET  /api/context/threads/:id/archive?query=…&limit=…
 *     → { turns: n, hits: ["turn 12 (user): …", …] } — sentence-level search
 *       over the verbatim archive (the same search the recall tool answers with).
 *
 * The routes read the live keeper through callbacks the runtime registers at
 * boot; without them (bare web server) they answer 503, like stop/undo.
 */
import { Hono } from 'hono';

const context = new Hono();

export interface ContextControls {
  snapshot: (sessionId: string) => unknown;
  compress: (sessionId: string) => Promise<{ outcome: string; report?: unknown }>;
  recall: (sessionId: string, query: string, limit: number) => { turns: number; hits: string[] };
  busy: (sessionId: string) => boolean;
}

let controls: ContextControls | undefined;
export function setContextControls(c: ContextControls | undefined): void { controls = c; }

function notFound(c: { json: (b: unknown, s?: number) => Response }, err: unknown): Response | null {
  if (err instanceof Error && /not found/i.test(err.message)) return c.json({ error: 'Thread not found' }, 404);
  return null;
}

context.get('/api/context/threads/:id', (c) => {
  if (!controls) return c.json({ error: 'Context inspector is not available on this runtime' }, 503);
  const id = c.req.param('id');
  try {
    return c.json(controls.snapshot(id));
  } catch (err) {
    return notFound(c, err) ?? c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

context.post('/api/context/threads/:id/compress', async (c) => {
  if (!controls) return c.json({ error: 'Context inspector is not available on this runtime' }, 503);
  const id = c.req.param('id');
  if (controls.busy(id)) return c.json({ error: 'Mercury is still working on this. Stop it first.', busy: true }, 409);
  try {
    const { outcome, report } = await controls.compress(id);
    return c.json({ ok: true, outcome, ...(report ? { report } : {}) });
  } catch (err) {
    return notFound(c, err) ?? c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

context.get('/api/context/threads/:id/archive', (c) => {
  if (!controls) return c.json({ error: 'Context inspector is not available on this runtime' }, 503);
  const id = c.req.param('id');
  const query = c.req.query('query') ?? '';
  const limitRaw = Number(c.req.query('limit') ?? '20');
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.round(limitRaw))) : 20;
  try {
    return c.json(controls.recall(id, query, limit));
  } catch (err) {
    return notFound(c, err) ?? c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default context;
