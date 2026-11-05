/**
 * The keeper's automatic trigger: the cut fires *by itself* once the history
 * crosses the budget (the whole point — no manual action), and the moment it
 * fires it is announced twice: a `tool-call` session entry in the trace's own
 * `- context_compression … → …` grammar, and a notice on the web channel.
 * A conversation under the threshold must never see either.
 */
import { describe, expect, it } from 'vitest';
import { ContextKeeper, type NotesWriter } from './context-keeper.js';
import { parseDelta } from './context-notes.js';
import { selectKeeperHistory, turnsOfSession } from './context-keeper-agent.js';
import { CONTEXT_COMPRESSION_HEADER, CONTEXT_COMPRESSION_TOOL, formatContextCompressionReport } from './context-window.js';
import type { SessionMessage } from '../sessions/types.js';

const msg = (role: 'user' | 'assistant', content: string): SessionMessage =>
  ({ id: content.slice(0, 8) + role, role, content, kind: 'message', sequence: 0, timestamp: 0, sessionId: 's', metadata: {} }) as unknown as SessionMessage;

// The model's reply, scripted straight through the real layout parser (a
// hand-built delta would skip the gate's own entry point). Rich enough to
// clear the collapse floor: a lot archived, near-empty notes coming in, is
// refused on purpose.
const writer: NotesWriter = async (_current, leaving) => {
  const changes = leaving.slice(0, 6).map((t, i) => `fact_${i}: ${t.content.slice(0, 120)}`);
  const rules = ['the keeper keeps every standing rule the turns state, in their own words',
    'numbers and names are copied exactly, never paraphrased',
    'what the model does not mention in CHANGES stays as it was'].map((r, i) => `rule_${i}: ${r}`);
  return parseDelta(['NEW RULES', ...rules, 'CHANGES', ...changes, 'OPEN', 'waiting on the next step', 'watch the budget'].join('\n'));
};

function bigConversation(turns: number, chars: number): SessionMessage[] {
  const out: SessionMessage[] = [msg('user', 'kickoff')];
  for (let i = 0; i < turns; i++) {
    out.push(msg('assistant', `turn ${i} ` + 'lorem ipsum dolor sit amet '.repeat(Math.max(1, Math.floor(chars / 27)))));
  }
  return out;
}

const keeper = (budget: number) => new ContextKeeper({ budget, stateDir: null });

describe('the automatic threshold', () => {
  it('under the budget: fits, nothing announced', async () => {
    const k = keeper(4096);
    const messages = [msg('user', 'bonjour'), msg('assistant', 'salut')];
    const sel = await selectKeeperHistory(k, turnsOfSession(messages), writer);
    expect(sel.outcome).toBe('fits');
    expect(k.cuts).toBe(0);
    // The trigger really is the budget: the same conversation is not "needs compression".
    expect(k.needsCompression(turnsOfSession(messages))).toBe(false);
  });

  it('over the budget: the cut fires on its own, with its numbers', async () => {
    const k = keeper(4096);
    const messages = bigConversation(30, 900);
    expect(k.needsCompression(turnsOfSession(messages))).toBe(true);
    const sel = await selectKeeperHistory(k, turnsOfSession(messages), writer);
    expect(sel.outcome).toBe('cut');
    expect(sel.report!.afterTokens).toBeLessThan(sel.report!.beforeTokens);
    expect(k.cuts).toBe(1);
  });

  it('the announced entry is one trace line in the run_command grammar', () => {
    const content = formatContextCompressionReport({ beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 }, 13);
    const lines = content.split('\n');
    expect(lines[0]).toBe(CONTEXT_COMPRESSION_HEADER);
    expect(lines[1]).toMatch(new RegExp(`^- ${CONTEXT_COMPRESSION_TOOL} .* → `));
    // Same header/arrow vocabulary the clients already parse for run_command.
    expect(lines[1]).toContain(' → ');
  });

  it('re-running on the kept view is idempotent: no second cut of the same turns', async () => {
    const k = keeper(4096);
    const messages = bigConversation(30, 900);
    const first = await selectKeeperHistory(k, turnsOfSession(messages), writer);
    expect(first.outcome).toBe('cut');
    // What the next request sends is the kept view, not the journal: the
    // keeper asked for it again must find it inside the budget and no-op.
    const view: SessionMessage[] = first.turns
      .filter((t) => t.number >= 0)
      .map((t) => msg(t.role, t.content));
    const second = await selectKeeperHistory(k, turnsOfSession(view), writer);
    expect(second.outcome).toBe('fits');
    expect(k.cuts).toBe(1);
  });
});
