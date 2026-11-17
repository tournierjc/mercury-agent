/**
 * The context keeper — the policy that replaces the plain sliding window.
 *
 * Ported from the ctxkeeper keeper policy (skindeepai/ctxkeeper) and the
 * keeper already proven in the Android client (tournierjc/mercury-android PR
 * #140, `core/.../context/ContextKeeper.kt` + `ContextKeeperConsistencyTest`).
 * `context-window.ts`'s `selectHistoryWindow` is the *repli*: it picks the
 * newest turns under a budget and throws the rest away. The keeper instead:
 *
 * 1. keeps the opening turns verbatim (the task lives there) and the newest
 *    exchange whole (an answer is never drawn without its question);
 * 2. before turns leave, asks the model itself for a changes-only notes delta
 *    (`NEW RULES / CHANGES / OPEN` — see `context-notes.ts`);
 * 3. moves every removed turn to an on-disk verbatim archive, searchable with
 *    the `recall` tool (a model that needs an old turn searches for it instead
 *    of guessing);
 * 4. refuses any cut that does not **strictly shrink** the view: the gate
 *    measures before and after, and a cut that cannot prove it is rolled back
 *    entirely — archive included — and reported, never faked.
 *
 * The notes are kept per conversation in the state directory (the same place
 * the daemon keeps its session files); nothing ever leaves the machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EMPTY_NOTES,
  applyDelta,
  notesIsEmpty,
  pinnedNotes,
  renderNotes,
  type Notes,
  type NotesDelta,
} from './context-notes.js';
import { estimateTokens } from './context-window.js';

/** One archived/kept turn, in the shape the keeper works with. */
export interface KeeperTurn {
  number: number;
  role: 'user' | 'assistant';
  content: string;
}

export type SkipReason = 'fits' | 'too_short' | 'notes_rejected' | 'cut';

export interface CutReport {
  beforeTokens: number;
  afterTokens: number;
  droppedChars: number;
  removedTurns: number;
  archivedThrough: number;
}

export interface KeepOutcome {
  skip: SkipReason;
  report?: CutReport;
}

/** The one callback that talks to the model: write the changes-only delta for the turns leaving. */
export type NotesWriter = (current: Notes, leaving: KeeperTurn[]) => Promise<NotesDelta | null>;

export interface KeeperOptions {
  /** Tokens the kept view may use, reply reserve and headroom subtracted internally. */
  budget: number;
  /** Room for the answer (ctxkeeper's `reply_reserve`). */
  replyReserve?: number;
  /** Slack for a low estimate: the trigger fires before the view truly reaches the budget. */
  headroom?: number;
  /** Where the per-conversation archive lives; null keeps it in memory only. */
  stateDir?: string | null;
}

/** The archive: append-only, verbatim. Nothing is lost, only moved out of view. */
export class TurnArchive {
  private turns: KeeperTurn[] = [];
  private path: string | null;

  constructor(path: string | null) {
    this.path = path;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as KeeperTurn;
          if (typeof row.number === 'number' && typeof row.content === 'string') this.turns.push(row);
        } catch {
          /* a torn last line from a crash: skipped, the tail is rewritten from memory */
        }
      }
    }
  }

  get size(): number {
    return this.turns.length;
  }

  all(): KeeperTurn[] {
    return this.turns.slice();
  }

  append(turns: KeeperTurn[]): void {
    this.turns = this.turns.concat(turns);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      for (const t of turns) appendFileSync(this.path, JSON.stringify(t) + '\n');
    }
  }

  /** Only a rolled-back cut removes (the exact tail it had just appended). */
  removeTail(count: number): void {
    this.turns = this.turns.slice(0, Math.max(0, this.turns.length - count));
  }

  /** Sentence-level search, newest first — what the `recall` tool answers with. */
  search(pattern: string, limit = 20): string[] {
    const needle = pattern.toLowerCase();
    if (!needle.trim()) return [];
    const hits: string[] = [];
    for (const turn of [...this.turns].reverse()) {
      if (hits.length >= limit) break;
      for (const sentence of turn.content.split(/[.!?]\s+|\n+/)) {
        const s = sentence.trim();
        if (s.length >= 2 && s.toLowerCase().includes(needle)) {
          hits.push(`turn ${turn.number} (${turn.role}): ${s.slice(0, 300)}`);
          if (hits.length >= limit) break;
        }
      }
    }
    return hits;
  }
}

export const KEEP_HEAD_PIN = (n: number): string =>
  `[[NOTES kept by the context keeper: ${n} earlier messages are in the archive (search it with the recall notes above)]]`;

/**
 * The per-conversation keeper. One instance per session id, held by the agent
 * for the process lifetime (and re-loadable: the archive lives on disk).
 */
export class ContextKeeper {
  readonly budget: number;
  private readonly replyReserve: number;
  private readonly headroom: number;
  private readonly archive: TurnArchive;
  private notes: Notes = EMPTY_NOTES;
  private archivedThrough = -1;
  private _cuts = 0;
  private _lastReport: CutReport | null = null;

  constructor(options: KeeperOptions) {
    this.budget = options.budget;
    this.replyReserve = options.replyReserve ?? 2048;
    this.headroom = options.headroom ?? 1024;
    this.archive = new TurnArchive(options.stateDir ? join(options.stateDir, 'archive.jsonl') : null);
  }

  get cuts(): number {
    return this._cuts;
  }

  get lastReport(): CutReport | null {
    return this._lastReport;
  }

  get archivedCount(): number {
    return this.archive.size;
  }

  /** The number of the last archived turn (-1 when the archive is empty). */
  get lastArchivedNumber(): number {
    const all = this.archive.all();
    return all.length ? all[all.length - 1]!.number : -1;
  }

  currentNotes(): Notes {
    return this.notes;
  }

  archivedTurns(): KeeperTurn[] {
    return this.archive.all();
  }

  recall(pattern: string, limit = 20): string[] {
    return this.archive.search(pattern, limit);
  }

  private get effectiveBudget(): number {
    return Math.max(MIN_EFFECTIVE_BUDGET, this.budget - this.replyReserve - this.headroom);
  }

  needsCompression(turns: KeeperTurn[]): boolean {
    return turns.length > 0 && turns.reduce((s, t) => s + estimateTokens(t.content), 0) > this.effectiveBudget;
  }

  /**
   * The view the model should see: opening turns, the pinned notes when there
   * are any, then the newest turns that fit. Never calls the model — the real
   * cut (archive + notes + gate) is {@link maybeCompress}.
   */
  viewFor(turns: KeeperTurn[]): KeeperTurn[] {
    if (turns.length === 0) return [];
    const head = openingOf(turns);
    const body = turns.slice(head.length);
    const notesTurn = notesTurnOf(this.notes, this.archive.size);
    const kept: KeeperTurn[] = [];
    let cost = head.reduce((s, t) => s + estimateTokens(t.content), 0) + (notesTurn ? estimateTokens(notesTurn.content) : 0);
    for (let i = body.length - 1; i >= 0; i--) {
      const extra = estimateTokens(body[i].content);
      if (kept.length > 0 && cost + extra > this.effectiveBudget) break;
      kept.unshift(body[i]);
      cost += extra;
    }
    return [...head, ...(notesTurn ? [notesTurn] : []), ...kept];
  }

  /**
   * Cut if the conversation overruns the budget. A cut is only reported when
   * all four things happened: notes written first, turns archived verbatim,
   * RULES kept, and the view **measurably smaller**. Anything else rolls back
   * completely and reports why (`notes_rejected` / `too_short` / `fits`).
   */
  async maybeCompress(turns: KeeperTurn[], writer: NotesWriter | null): Promise<KeepOutcome> {
    if (turns.length === 0 || !this.needsCompression(turns)) {
      return { skip: 'fits' };
    }
    if (!writer) return { skip: 'notes_rejected' };
    const head = openingOf(turns);
    const body = turns.slice(head.length);
    const cutAt = newestExchangeStart(body);
    if (cutAt <= 0) return { skip: 'too_short' };
    const leaving = body.slice(0, cutAt);
    if (leaving.length === 0) return { skip: 'too_short' };

    const beforeTokens = turns.reduce((s, t) => s + estimateTokens(t.content), 0);

    // 1. Ask for the notes *before* anything leaves.
    const delta = await writer(this.notes, leaving);
    if (!delta) return { skip: 'notes_rejected' };
    const applied = applyDelta(this.notes, delta);
    if (applied.kind === 'rejected') return { skip: 'notes_rejected' };

    // 2. Archive verbatim first (a cut can still be rolled back — but an
    //    archive that lost material is the bug this module exists to prevent).
    const firstNumber = this.archivedThrough + 1;
    const renumbered = leaving.map((t, i) => ({ ...t, number: firstNumber + i }));
    this.archive.append(renumbered);
    const oldNotes = this.notes;
    const oldThrough = this.archivedThrough;
    this.notes = applied.notes;
    this.archivedThrough = firstNumber + renumbered.length - 1;

    // 3. Measure. Strictly smaller, or the cut did not happen.
    const keptTail = body.slice(cutAt);
    const afterTokens =
      head.reduce((s, t) => s + estimateTokens(t.content), 0) +
      keptTail.reduce((s, t) => s + estimateTokens(t.content), 0) +
      (notesIsEmpty(this.notes) ? 0 : estimateTokens(pinnedNotes(this.notes, this.archive.size)));
    if (afterTokens >= beforeTokens) {
      this.notes = oldNotes;
      this.archivedThrough = oldThrough;
      this.archive.removeTail(renumbered.length);
      return { skip: 'notes_rejected' };
    }
    // The archive must actually hold every turn that left — the app must never
    // *trust* the append, so it checks.
    for (const t of renumbered) {
      if (this.archive.all().find((a) => a.number === t.number)?.content !== t.content) {
        this.notes = oldNotes;
        this.archivedThrough = oldThrough;
        this.archive.removeTail(renumbered.length);
        return { skip: 'notes_rejected' };
      }
    }
    // 4. The collapse floor: a lot left, near-empty notes came in — refuse.
    const leavingChars = leaving.reduce((s, t) => s + t.content.length, 0);
    if (leavingChars > NOTES_FLOOR_TRIGGER_CHARS && renderNotes(this.notes).length < NOTES_FLOOR_MIN_CHARS) {
      this.notes = oldNotes;
      this.archivedThrough = oldThrough;
      this.archive.removeTail(renumbered.length);
      return { skip: 'notes_rejected' };
    }

    this._cuts += 1;
    this._lastReport = {
      beforeTokens,
      afterTokens,
      droppedChars: leavingChars,
      removedTurns: renumbered.length,
      archivedThrough: this.archivedThrough,
    };
    return { skip: 'cut', report: this._lastReport };
  }
}

const MIN_EFFECTIVE_BUDGET = 512;
const NOTES_FLOOR_TRIGGER_CHARS = 4000;
const NOTES_FLOOR_MIN_CHARS = 120;
const ARCHIVED_NOTES_NUMBER = -1;

/** The opening turn: the first user message — kept verbatim, always. */
function openingOf(turns: KeeperTurn[]): KeeperTurn[] {
  const i = turns.findIndex((t) => t.role === 'user');
  return i >= 0 ? turns.slice(0, i + 1) : turns.slice(0, 1);
}

/**
 * Index in `body` where the newest exchange starts: the newest user message
 * and everything after it always stay whole — an answer whose question was
 * archived is how a compressed conversation starts reading as nonsense.
 */
function newestExchangeStart(body: KeeperTurn[]): number {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].role === 'user') return i;
  }
  return Math.max(0, body.length - 1);
}

function notesTurnOf(notes: Notes, archivedCount: number): KeeperTurn | null {
  if (notesIsEmpty(notes)) return null;
  return { number: ARCHIVED_NOTES_NUMBER, role: 'user', content: pinnedNotes(notes, archivedCount) };
}
