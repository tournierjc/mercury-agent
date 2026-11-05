/**
 * The two helpers the context API runs on: the snapshot (what the model sees,
 * what the archive holds, the notes as they stand — no model call) and the
 * manual compression (the turn loop's cut on demand, same gate).
 */
import { describe, expect, it } from 'vitest';
import { ContextKeeper, type NotesWriter } from './context-keeper.js';
import { compressNow, snapshotContext, turnsOfSession } from './context-keeper-agent.js';
import type { SessionMessage } from '../sessions/types.js';

const msg = (role: 'user' | 'assistant', content: string, kind: SessionMessage['kind'] = 'message'): SessionMessage =>
  ({ id: content.slice(0, 8) + role, role, content, kind, sequence: 0, timestamp: 0, sessionId: 's', metadata: {} }) as unknown as SessionMessage;

function longConversation(turns: number, chars: number): SessionMessage[] {
  const out: SessionMessage[] = [msg('user', 'kickoff. stand by.')];
  for (let i = 0; i < turns; i++) {
    out.push(msg('assistant', `turn ${i} the codename is cedar-77 ` + 'lorem ipsum dolor sit amet '.repeat(Math.floor(chars / 27) + 1)));
    if (i % 3 === 2) out.push(msg('user', `step ${i} ` + 'command '.repeat(Math.floor(chars / 8) + 1)));
  }
  return out;
}

const perfectWriter: NotesWriter = async (_current, leaving) => ({
  rules: [],
  changes: leaving.slice(0, 3).map((t, i) => ({ name: `fact${i}`, value: t.content.slice(0, 40) })),
  open: ['waiting on the next step'],
});

const keeper = (stateDir = null): ContextKeeper => new ContextKeeper({ budget: 4096, stateDir });

describe('snapshotContext (GET /api/context payload)', () => {
  it('on a fitting conversation: everything in view, archive empty, no notes', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const snap = snapshotContext(keeper(), messages, true, false);
    expect(snap.enabled).toBe(true);
    expect(snap.needsCompression).toBe(false);
    expect(snap.archivedTurns).toBe(0);
    expect(snap.archivedThrough).toBe(-1);
    expect(snap.cuts).toBe(0);
    expect(snap.lastReport).toBeNull();
    expect(snap.viewTokens).toBeLessThanOrEqual(snap.historyTokens);
    expect(snap.notesText).toMatch(/^RULES/);
  });

  it('after a real cut: the numbers the dashboard shows', async () => {
    const messages = longConversation(30, 900);
    const k = keeper();
    await k.maybeCompress(turnsOfSession(messages), perfectWriter);
    const snap = snapshotContext(k, messages, true, false);
    expect(snap.cuts).toBe(1);
    expect(snap.archivedTurns).toBeGreaterThan(0);
    expect(snap.archivedThrough).toBe(snap.archivedTurns - 1);
    expect(snap.lastReport).not.toBeNull();
    expect(snap.lastReport!.afterTokens).toBeLessThan(snap.lastReport!.beforeTokens);
    expect(snap.viewTokens).toBeLessThan(snap.historyTokens);
    expect(snap.notes.state.length).toBeGreaterThan(0);
    expect(snap.notesText).toContain('fact0:');
  });

  it('saver mode flips the budget it reports', () => {
    const messages = [msg('user', 'hello')];
    expect(snapshotContext(keeper(), messages, true, true).budget)
      .toBeLessThan(snapshotContext(keeper(), messages, true, false).budget);
  });

  it('tool-call traces stay counted, system and non-message kinds do not', () => {
    const messages = [
      msg('user', 'hello'),
      msg('assistant', 'trace of the work', 'tool-call'),
      { role: 'system', content: 'x'.repeat(4000), kind: 'message', id: 'sys', sequence: 0, timestamp: 0, sessionId: 's', metadata: {} },
    ] as unknown as SessionMessage[];
    const snap = snapshotContext(keeper(), messages, false, false);
    expect(snap.historyTokens).toBeLessThan(1100); // the fat system message is not history
    expect(snap.historyTokens).toBeGreaterThan(0); // the trace is
  });
});

describe('compressNow (POST /api/context/compress)', () => {
  it('fits: nothing happens and the outcome says so', async () => {
    const k = keeper();
    const messages = [msg('user', 'short'), msg('assistant', 'ok')];
    const sel = await compressNow(k, messages, perfectWriter);
    expect(sel.outcome).toBe('fits');
    expect(k.archivedCount).toBe(0);
  });

  it('cut: strictly shrinks, archives verbatim, writes the notes', async () => {
    const k = keeper();
    const messages = longConversation(30, 900);
    const sel = await compressNow(k, messages, perfectWriter);
    expect(sel.outcome).toBe('cut');
    expect(sel.report!.afterTokens).toBeLessThan(sel.report!.beforeTokens);
    expect(k.archivedCount).toBe(sel.report!.removedTurns);
    expect(k.currentNotes().state.length).toBeGreaterThan(0);
  });

  it('notes_rejected: a writer that returns nothing refuses, nothing moves', async () => {
    const k = keeper();
    const messages = longConversation(30, 900);
    const sel = await compressNow(k, messages, async () => null);
    expect(sel.outcome).toBe('notes_rejected');
    expect(k.archivedCount).toBe(0);
    expect(k.cuts).toBe(0);
  });

  it('too_short: one huge turn has nothing to cut', async () => {
    const k = new ContextKeeper({ budget: 512 });
    const sel = await compressNow(k, [msg('user', 'x'.repeat(4000))], perfectWriter);
    expect(sel.outcome).toBe('too_short');
    expect(k.archivedCount).toBe(0);
  });
});
