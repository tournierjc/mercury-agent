/**
 * The consistency contract for the keeper — the tests that make "compression"
 * mean something. The headline invariant is JC's: **after a compression the
 * context size must always be lower**. The invariants that make a shrinking lie
 * impossible (nothing lost, no rule lost, no rollback leaving debris) sit beside
 * it. Mirrors the Kotlin suite in tournierjc/mercury-android PR #140.
 */
import { describe, expect, it } from 'vitest';
import {
  ContextKeeper,
  type KeeperTurn,
  type NotesWriter,
} from './context-keeper.js';
import {
  EMPTY_NOTES,
  applyDelta,
  parseDelta,
  parseNotes,
  pinnedNotes,
  renderNotes,
  resolveWorking,
  sameRule,
} from './context-notes.js';
import { estimateTokens } from './context-window.js';

const turn = (number: number, role: KeeperTurn['role'], content: string): KeeperTurn => ({ number, role, content });

function longConversation(turns: number, chars: number, codename = 'cedar-77'): KeeperTurn[] {
  const out: KeeperTurn[] = [turn(0, 'user', 'kickoff. stand by.')];
  let n = 1;
  for (let i = 0; i < turns; i++) {
    const seed = i === 1 ? `the codename is ${codename}. ` : '';
    out.push(turn(n++, 'assistant', seed + `turn ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(Math.floor(chars / 27) + 1)));
    if (i % 3 === 2) out.push(turn(n++, 'user', `step ${i} ` + 'command '.repeat(Math.floor(chars / 8) + 1)));
  }
  return out;
}

const perfectWriter: NotesWriter = async (_current, leaving) =>
  parseDelta(
    'NEW RULES\n(none)\nCHANGES\n' +
      leaving.slice(0, 3).map((t, i) => `fact${i}: ${t.content.slice(0, 40)}`).join('\n') +
      '\nOPEN\nwaiting on the next step',
  );

const nullWriter: NotesWriter = async () => null;

const hugeRulesWriter: NotesWriter = async () =>
  parseDelta('NEW RULES\n' + 'rule '.repeat(2500) + '\nCHANGES\n(none)\nOPEN\n(none)');

const emptyLayoutWriter: NotesWriter = async () =>
  parseDelta('NEW RULES\n(none)\nCHANGES\n(none)\nOPEN\n(none)');

const viewTokens = (turns: KeeperTurn[]): number => turns.reduce((s, t) => s + estimateTokens(t.content), 0);

const keeper = (writer: NotesWriter, budget = 4096): ContextKeeper =>
  new ContextKeeper({ budget, stateDir: null });

describe('the headline invariant', () => {
  it('every cut strictly shrinks the view', async () => {
    const conversation = longConversation(30, 900);
    const k = keeper(perfectWriter);
    const outcome = await k.maybeCompress(conversation, perfectWriter);
    expect(outcome.skip).toBe('cut');
    const report = outcome.report!;
    expect(report.afterTokens).toBeLessThan(report.beforeTokens);
    expect(report.beforeTokens).toBe(viewTokens(conversation));
  });

  it('repeated cuts keep shrinking: every cut is smaller than what it replaced', async () => {
    const conversation: KeeperTurn[] = [turn(0, 'user', 'kickoff')];
    const k = keeper(perfectWriter, 4096);
    let n = 1;
    let cuts = 0;
    for (let i = 0; i < 40; i++) {
      conversation.push(turn(n++, 'assistant', `answer ${i}: ` + 'blah '.repeat(150)));
      conversation.push(turn(n++, 'user', `next step ${i}`));
      const outcome = await k.maybeCompress(conversation.slice(), perfectWriter);
      if (outcome.skip === 'cut') {
        cuts++;
        expect(outcome.report!.afterTokens).toBeLessThan(outcome.report!.beforeTokens);
      }
    }
    expect(cuts).toBeGreaterThan(0);
    expect(k.lastReport).not.toBeNull();
  });
});

describe('nothing is lost, only moved out of view', () => {
  it('every turn a cut removes is in the archive verbatim', async () => {
    const conversation = longConversation(24, 800);
    const k = keeper(perfectWriter);
    const outcome = await k.maybeCompress(conversation, perfectWriter);
    expect(outcome.skip).toBe('cut');
    const archived = k.archivedTurns();
    expect(archived.length).toBe(outcome.report!.removedTurns);
    const viewTexts = new Set(k.viewFor(conversation).map((t) => t.content));
    const archivedTexts = new Set(archived.map((t) => t.content));
    for (const t of conversation) {
      expect(viewTexts.has(t.content) || archivedTexts.has(t.content)).toBe(true);
    }
    const numbers = archived.map((t) => t.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('a refused cut archives nothing and leaves the notes untouched', async () => {
    const k = keeper(nullWriter);
    const outcome = await k.maybeCompress(longConversation(20, 900), nullWriter);
    expect(outcome.skip).toBe('notes_rejected');
    expect(k.archivedTurns()).toHaveLength(0);
    expect(k.currentNotes()).toEqual(EMPTY_NOTES);
    expect(k.cuts).toBe(0);
  });

  it('a cut rolled back for not shrinking leaves no archive debris', async () => {
    const k = keeper(hugeRulesWriter);
    const outcome = await k.maybeCompress(longConversation(16, 400), hugeRulesWriter);
    expect(outcome.skip).toBe('notes_rejected');
    expect(k.archivedTurns()).toHaveLength(0);
    expect(k.currentNotes()).toEqual(EMPTY_NOTES);
    expect(k.cuts).toBe(0);
  });

  it('a keeper with no writer never compresses', async () => {
    const k = keeper(nullWriter);
    const outcome = await k.maybeCompress(longConversation(30, 900), null);
    expect(outcome.skip).toBe('notes_rejected');
    expect(k.archivedTurns()).toHaveLength(0);
  });

  it('a cut that moves out a lot on near-empty notes is refused', async () => {
    const k = keeper(emptyLayoutWriter);
    const outcome = await k.maybeCompress(longConversation(14, 700), emptyLayoutWriter);
    expect(outcome.skip).toBe('notes_rejected');
    expect(k.archivedTurns()).toHaveLength(0);
  });
});

describe('the kept view', () => {
  it('archived material is searchable with its turn number', async () => {
    const k = keeper(perfectWriter);
    await k.maybeCompress(longConversation(24, 800, 'cedar-77'), perfectWriter);
    expect(k.archivedTurns().length).toBeGreaterThan(0);
    const hits = k.recall('cedar-77');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatch(/^turn \d+ \((user|assistant)\):/);
  });

  it('the opening turn always stays in the view', async () => {
    const conversation = longConversation(30, 900);
    const k = keeper(perfectWriter);
    await k.maybeCompress(conversation, perfectWriter);
    const view = k.viewFor(conversation);
    expect(view[0].role).toBe('user');
    expect(view[0].content).toMatch(/^kickoff/);
  });

  it('the newest exchange never splits', async () => {
    const conversation = longConversation(24, 800);
    const k = keeper(perfectWriter);
    await k.maybeCompress(conversation, perfectWriter);
    const view = k.viewFor(conversation);
    const archived = k.archivedTurns();
    const lastUser = [...conversation].reverse().find((t) => t.role === 'user')!;
    expect(view.some((t) => t.role === 'user' && t.content === lastUser.content)).toBe(true);
    expect(archived.some((t) => t.number >= lastUser.number)).toBe(false);
  });

  it('a fitting conversation is not compressed', async () => {
    const k = keeper(nullWriter);
    const small = [turn(0, 'user', 'short'), turn(1, 'assistant', 'ok')];
    const outcome = await k.maybeCompress(small, nullWriter);
    expect(outcome.skip).toBe('fits');
  });
});

describe('the notes contract (ctxkeeper layout)', () => {
  it('parses the exact layout and round-trips', () => {
    const notes = parseNotes('RULES\nalways answer in French\nSTATE\ncodename: cedar-77\nOPEN\nwaiting on deploy')!;
    expect(notes.rules).toEqual(['always answer in French']);
    expect(notes.state).toEqual([{ name: 'codename', value: 'cedar-77' }]);
    expect(notes.open).toEqual(['waiting on deploy']);
    expect(parseNotes(renderNotes(notes))).toEqual(notes);
  });

  it('rejects a reply that does not use the layout', () => {
    expect(parseNotes('Sure! Here is the answer...')).toBeNull();
    expect(parseDelta('Sure! Here is the answer...')).toBeNull();
    expect(parseDelta('NEW RULES\nsome rule\nOPEN\nsomething')).toBeNull();
  });

  it('a missing OPEN heading keeps the old open section', () => {
    expect(parseDelta('NEW RULES\n(none)\nCHANGES\nk: v')!.open).toBeNull();
  });

  it('rules can never be dropped by a delta', () => {
    const current = { rules: ['answer in French', 'never push to main'], state: [{ name: 'a', value: '1' }], open: [] };
    const outcome = applyDelta(current, parseDelta('NEW RULES\n(none)\nCHANGES\na: 2\nOPEN\n(none)')!);
    expect(outcome.kind).toBe('applied');
    const notes = (outcome as { notes: { rules: string[]; state: unknown[] } }).notes;
    expect(notes.rules).toEqual(['answer in French', 'never push to main']);
    expect(notes.state).toEqual([{ name: 'a', value: '2' }]);
  });

  it('a reworded rule does not stack; a genuinely extended rule is added', () => {
    const current = { rules: ['always run the tests before shipping anything'], state: [], open: [] };
    const reword = applyDelta(current, parseDelta('NEW RULES\nalways run the tests before shipping\nCHANGES\n(none)')!);
    expect((reword as { notes: { rules: string[] } }).notes.rules).toHaveLength(1);
    const extended = applyDelta({ rules: ['run the tests'], state: [], open: [] },
      parseDelta('NEW RULES\nrun the tests and the linter and the integration suite before any release\nCHANGES\n(none)')!);
    expect((extended as { notes: { rules: string[] } }).notes.rules).toHaveLength(2);
  });

  it('a state line keeps its place, a new name appends, removed deletes', () => {
    const current = { rules: [], state: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'c', value: '3' }], open: [] };
    const outcome = applyDelta(current, parseDelta('NEW RULES\n(none)\nCHANGES\nb: 9\nd: 4\nc: removed')!);
    expect((outcome as { notes: { state: unknown[] } }).notes.state).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '9' },
      { name: 'd', value: '4' },
    ]);
  });

  it('a working that computes is kept; a working that lies is refused', () => {
    expect(resolveWorking('120 + 49 = 169')).toBe('120 + 49 = 169');
    expect(resolveWorking('120 + 49 = 168')).toBeNull();
    expect(resolveWorking('the deploy failed on the staging box')).toBe('the deploy failed on the staging box');
    expect(resolveWorking('v2.1.0-beta')).toBe('v2.1.0-beta');
    const rejected = applyDelta(EMPTY_NOTES, parseDelta('NEW RULES\n(none)\nCHANGES\nstock: 120 + 49 = 168')!);
    expect(rejected.kind).toBe('rejected');
  });

  it('sameRule reads containment from the candidate side', () => {
    expect(sameRule('always run the tests before shipping anything', 'always run the tests before shipping')).toBe(true);
    expect(sameRule('run the tests', 'keep every commit signed off')).toBe(false);
  });

  it('pinned notes tell the model how much is in the archive', () => {
    const pinned = pinnedNotes({ rules: ['r'], state: [], open: [] }, 7);
    expect(pinned.startsWith('[[NOTES kept by the context keeper: 7 earlier messages are in the archive]]')).toBe(true);
    expect(pinned).toContain('r');
  });
});
