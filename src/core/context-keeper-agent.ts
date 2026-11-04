/**
 * The keeper as the agent uses it: one instance per conversation, the notes
 * call routed through the agent's own default provider (ctxkeeper's lesson:
 * **the model keeps its own notes** — a separate, smaller keeper measured
 * worse and slower), and the history selection that replaces the plain
 * sliding window when the keeper is on.
 *
 * The window it replaces (`context-window.ts`'s `selectHistoryWindow`) drops
 * everything over the token budget. The keeper instead moves it to a verbatim
 * archive, folds the removed turns into RULES/STATE/OPEN notes before they
 * leave, and only ever reports a cut that **strictly shrank** the view.
 */
import { join } from 'node:path';
import { generateText } from 'ai';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { ContextKeeper, type KeeperTurn, type NotesWriter } from './context-keeper.js';
import { parseDelta, type Notes } from './context-notes.js';
import { HISTORY_TOKEN_BUDGET, HISTORY_TOKEN_BUDGET_SAVER } from './context-window.js';
import type { SessionMessage } from '../sessions/types.js';
import type { BaseProvider } from '../providers/base.js';

/** The keeper's budget is the history budget: the same money, spent with memory instead of amnesia. */
export const KEEPER_BUDGET = HISTORY_TOKEN_BUDGET;
export const KEEPER_BUDGET_SAVER = HISTORY_TOKEN_BUDGET_SAVER;

/** `tool-call` traces are the model's own words about the turn; they stay history-eligible. */
const HISTORY_KINDS = new Set(['message', 'tool-call']);

/** The session's history as keeper turns (the same eligibility rule as the window). */
export function turnsOfSession(messages: readonly SessionMessage[]): KeeperTurn[] {
  const eligible = messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && HISTORY_KINDS.has(m.kind ?? 'message'),
  );
  return eligible.map((m, i) => ({ number: i, role: m.role as 'user' | 'assistant', content: m.content }));
}

/**
 * The changes-only prompt (ctxkeeper's `INPLACE_REQUEST`, shortened): the model
 * writes only what the turns leaving change in the NOTES; everything it does
 * not mention is kept. Temperature 0, no tools — a notes call, not a turn.
 */
function notesRequest(current: Notes, leaving: KeeperTurn[]): string {
  const turns = leaving.map((t) => `${t.role}: ${t.content}`).join('\n\n');
  const notes = current.rules.length || current.state.length || current.open.length
    ? current.rules.map((r) => r).concat(current.state.map((f) => `${f.name}: ${f.value}`), current.open).join('\n')
    : '(none yet)';
  return (
    `[[Message from the context keeper, not part of the task]] Every turn under TURNS BEING MOVED OUT is about ` +
    `to be moved out of your view. It all stays in a searchable archive, but you will no longer see it. Do not ` +
    `continue the task and do not call any tool. Write only what those turns change in the NOTES; the keeper ` +
    `applies it and keeps every line you do not mention. Use exactly this layout; the first line of your reply ` +
    `is the words NEW RULES:\n\n` +
    `=== CURRENT NOTES ===\n${notes}\n\n` +
    `=== TURNS BEING MOVED OUT ===\n${turns}\n\n` +
    `NEW RULES\none line per standing rule, instruction, method or definition that those turns state and that ` +
    `applies from then on, complete and in its original words. The rules already in the NOTES stay; do not repeat ` +
    `them. If the turns state no new rule, write (none).\n` +
    `CHANGES\none line \`name: value\` per fact of STATE that those turns set or change, in the order in which the ` +
    `turns give the changes. When the new value follows from the old one, write the working and put the result ` +
    `last, like \`stock: 120 + 49 = 169\`. Write \`name: removed\` when something is removed. If the turns change ` +
    `nothing, write (none).\n` +
    `OPEN\nat most three short lines: what is unfinished right now and what to watch for (this replaces the old ` +
    `OPEN section; may be empty).\n\nOutput only these three sections.`
  );
}

/** The notes call through the agent's own default provider — no second model, no second key. */
export function makeNotesWriter(getModel: () => ReturnType<BaseProvider['getModelInstance']> | null): NotesWriter {
  return async (current, leaving) => {
    const model = getModel();
    if (!model) return null;
    try {
      const result = await generateText({
        model,
        system:
          'You keep the NOTES for an AI agent working on a long task. You never do the task yourself and never ' +
          'call tools. Copy names, numbers and wording exactly.',
        messages: [{ role: 'user', content: notesRequest(current, leaving) }],
        temperature: 0,
        maxOutputTokens: 2048,
      });
      const delta = parseDelta(result.text ?? '');
      if (!delta) logger.debug({}, 'keeper: notes reply did not use the layout, cut refused');
      return delta;
    } catch (err) {
      logger.debug({ err: String(err) }, 'keeper: notes call failed, cut refused');
      return null;
    }
  };
}

export interface KeeperSelection {
  /** The history the model should see (opening + pinned notes + newest that fit). */
  turns: KeeperTurn[];
  /** What the keeper did — surfaced to the logs, and to the /context status. */
  outcome: 'fits' | 'too_short' | 'notes_rejected' | 'cut';
  report?: { beforeTokens: number; afterTokens: number; removedTurns: number };
}

/**
 * One turn's history selection through the keeper: keep it if it fits, cut it
 * (notes + archive + gate) if it does not. The sliding window is the repli:
 * a refused cut leaves the conversation whole — the next request pays the full
 * history rather than a lying compression.
 */
export async function selectKeeperHistory(
  keeper: ContextKeeper,
  turns: KeeperTurn[],
  writer: NotesWriter,
): Promise<KeeperSelection> {
  const outcome = await keeper.maybeCompress(turns, writer);
  if (outcome.skip === 'cut') {
    logger.info(
      { before: outcome.report?.beforeTokens, after: outcome.report?.afterTokens, removed: outcome.report?.removedTurns, cuts: keeper.cuts },
      'keeper: context compressed',
    );
  }
  return {
    turns: keeper.viewFor(turns),
    outcome: outcome.skip,
    report: outcome.report
      ? { beforeTokens: outcome.report.beforeTokens, afterTokens: outcome.report.afterTokens, removedTurns: outcome.report.removedTurns }
      : undefined,
  };
}

/** Where one conversation's keeper state lives (the archive survives restarts). */
export function keeperStateDir(sessionId: string): string {
  return join(getMercuryHome(), 'keeper', sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64));
}

/** Rebuild the keeper for a conversation (the archive reloads from disk). */
export function keeperFor(sessionId: string, saverActive: boolean): ContextKeeper {
  return new ContextKeeper({
    budget: saverActive ? KEEPER_BUDGET_SAVER : KEEPER_BUDGET,
    stateDir: keeperStateDir(sessionId),
  });
}
