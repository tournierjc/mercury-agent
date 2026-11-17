/**
 * The notes block the keeper maintains per conversation — the ctxkeeper layout.
 *
 * Ported from the keeper policy proven in tournierjc/mercury-android PR #140
 * (`core/.../context/`), where every invariant below is pinned by
 * `ContextKeeperConsistencyTest`. Three sections, exact headings, `(none)` for
 * "nothing": RULES (standing rules and methods, permanent — a rule can never
 * disappear), STATE (current facts later work depends on, one `name: value`
 * per line), OPEN (what is unfinished, at most a few short lines).
 */

const HEADINGS = ['RULES', 'STATE', 'OPEN'] as const;
const DELTA_HEADINGS = ['NEW RULES', 'CHANGES', 'OPEN'] as const;

export interface Notes {
  rules: string[];
  /** Ordered `name -> value` facts; a name keeps its place, a new name appends. */
  state: Array<{ name: string; value: string }>;
  open: string[];
}

export interface NotesDelta {
  rules: string[];
  /** One entry per STATE change, in the order the turns give them. */
  changes: Array<{ name: string; value: string }>;
  /** null = the reply carried no OPEN heading: the old OPEN section stays. */
  open: string[] | null;
}

export const EMPTY_NOTES: Notes = { rules: [], state: [], open: [] };

export function notesIsEmpty(n: Notes): boolean {
  return n.rules.length === 0 && n.state.length === 0 && n.open.length === 0;
}

/** The block as the model sees it — the exact layout {@link parseNotes} accepts back. */
export function renderNotes(n: Notes): string {
  const lines: string[] = ['RULES'];
  lines.push(...(n.rules.length ? n.rules : ['(none)']));
  lines.push('STATE');
  lines.push(...(n.state.length ? n.state.map((f) => `${f.name}: ${f.value}`) : ['(none)']));
  lines.push('OPEN');
  lines.push(...(n.open.length ? n.open : ['(none)']));
  return lines.join('\n');
}

/** The notes as shown in the kept view: the pinned heading says how much lives in the archive. */
export function pinnedNotes(n: Notes, archivedCount: number): string {
  return `[[NOTES kept by the context keeper: ${archivedCount} earlier messages are in the archive]]\n${renderNotes(n)}`;
}

function isNone(line: string): boolean {
  return line.toLowerCase() === '(none)';
}

function normalize(text: string): string[] {
  return text.split('\n').map((l) => l.trim());
}

/**
 * Read a full NOTES block back from a model reply; null when it does not use the
 * layout (a reply with no `RULES` heading is the model continuing the task —
 * ctxkeeper's `has_layout` rejects it for the same reason).
 */
export function parseNotes(text: string): Notes | null {
  const lines = normalize(text);
  const start = lines.indexOf('RULES');
  if (start < 0) return null;
  const notes: Notes = { rules: [], state: [], open: [] };
  let section: (typeof HEADINGS)[number] = 'RULES';
  for (const line of lines.slice(start + 1)) {
    if ((HEADINGS as readonly string[]).includes(line)) {
      section = line as (typeof HEADINGS)[number];
      continue;
    }
    if (!line || isNone(line)) continue;
    if (section === 'RULES') notes.rules.push(line);
    else if (section === 'STATE') {
      const { name, value } = factOf(line);
      notes.state.push({ name, value });
    } else notes.open.push(line);
  }
  return notes;
}

/** `(name, value)` of a STATE/CHANGES line: `name: value`, `name = value`, or `name rest`. */
export function factOf(line: string): { name: string; value: string } {
  const colon = line.indexOf(':');
  const eq = line.indexOf('=');
  const cut = colon >= 0 && (eq < 0 || colon < eq) ? colon : eq >= 0 ? eq : -1;
  if (cut <= 0) {
    const sp = line.indexOf(' ');
    return sp > 0 ? { name: line.slice(0, sp).trim(), value: line.slice(sp + 1).trim() } : { name: line, value: '' };
  }
  return { name: line.slice(0, cut).trim(), value: line.slice(cut + 1).trim() };
}

/**
 * Read the changes-only reply the model writes before a cut (the `NEW RULES /
 * CHANGES / OPEN` layout). Null when the reply does not use the layout: a
 * missing `CHANGES` heading means the model answered the task instead of
 * writing notes, and accepting it would silently pass a cut that folds nothing.
 */
export function parseDelta(text: string): NotesDelta | null {
  const lines = normalize(text);
  const start = lines.indexOf('NEW RULES');
  if (start < 0) return null;
  let section: (typeof DELTA_HEADINGS)[number] = 'NEW RULES';
  let sawChanges = false;
  let sawOpen = false;
  const delta: NotesDelta = { rules: [], changes: [], open: [] };
  for (const line of lines.slice(start + 1)) {
    if ((DELTA_HEADINGS as readonly string[]).includes(line)) {
      section = line as (typeof DELTA_HEADINGS)[number];
      if (line === 'CHANGES') sawChanges = true;
      if (line === 'OPEN') sawOpen = true;
      continue;
    }
    if (!line || isNone(line)) continue;
    if (section === 'NEW RULES') delta.rules.push(line);
    else if (section === 'CHANGES') delta.changes.push(factOf(line));
    else delta.open!.push(line);
  }
  if (!sawChanges) return null;
  delta.open = sawOpen ? delta.open : null;
  return delta;
}

/**
 * Verify a value given as working (`stock: 120 + 49 = 169`) and return it for
 * storage; null when a `left = right` chain is false — the caller asks the
 * model once more rather than trusting a lying summary. Values without a plain
 * +- chain are never wrongly refused.
 */
export function resolveWorking(value: string): string | null {
  const eq = value.lastIndexOf('=');
  if (eq <= 0 || eq === value.length - 1) return value;
  const left = value.slice(0, eq).trim();
  const right = value.slice(eq + 1).trim();
  if (!/^\d+$/.test(right)) return value;
  let sum = 0;
  let i = 0;
  let sign = 1;
  let expectNumber = true;
  while (i < left.length) {
    const c = left[i];
    if (c === ' ') { i++; continue; }
    if (c === '+' || c === '-') {
      sign = c === '+' ? 1 : -1;
      expectNumber = true;
      i++;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < left.length && /\d/.test(left[j])) j++;
      sum += sign * Number(left.slice(i, j));
      sign = 1;
      expectNumber = false;
      i = j;
    } else {
      return value; // not a plain +- chain: not our check to make
    }
  }
  if (expectNumber) return value; // trailing operator: a chain we cannot judge
  return sum === Number(right) ? value : null;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/**
 * Is `candidate` a restatement of `existing`? When the candidate's own words are
 * ≥60% already in the existing rule, the candidate only drifts the original —
 * it must not stack beside it (ctxkeeper's `same_rule`, on the candidate side).
 */
export function sameRule(existing: string, candidate: string): boolean {
  const wOld = words(existing);
  const wNew = words(candidate);
  if (wOld.size === 0 || wNew.size === 0) return false;
  let shared = 0;
  for (const w of wNew) if (wOld.has(w)) shared++;
  return shared * 100 >= wNew.size * 60;
}

export type ApplyOutcome =
  | { kind: 'applied'; notes: Notes }
  | { kind: 'rejected'; reason: string };

/**
 * Apply a delta with the safety rules that turn a model-written summary from a
 * lossy compression into a safe one:
 *
 * - **A RULES line can never disappear** — lines the model does not mention
 *   stay, in order; a candidate that restates an existing rule is not added.
 * - **A STATE line keeps its place**; `removed` deletes; a working is verified
 *   before it is stored, and a false one rejects the whole delta.
 * - No OPEN heading keeps the old OPEN section.
 */
export function applyDelta(current: Notes, delta: NotesDelta): ApplyOutcome {
  const rules = [...current.rules];
  for (const candidate of delta.rules) {
    if (!rules.some((r) => sameRule(r, candidate))) rules.push(candidate);
  }
  const state = current.state.map((f) => ({ ...f }));
  for (const { name, value } of delta.changes) {
    if (value.toLowerCase() === 'removed') {
      const at = state.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
      if (at >= 0) state.splice(at, 1);
      continue;
    }
    const stored = resolveWorking(value);
    if (stored === null) {
      return { kind: 'rejected', reason: `the working of '${name}: ${value}' does not compute — rewrite the line with the correct result` };
    }
    const at = state.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) state[at] = { name, value: stored };
    else state.push({ name, value: stored });
  }
  return { kind: 'applied', notes: { rules, state, open: delta.open ?? current.open } };
}
