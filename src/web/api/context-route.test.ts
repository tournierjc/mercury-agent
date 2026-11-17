/**
 * The context inspector routes with scripted controls: the shapes the client
 * depends on, the 409 while the thread is busy, the 404 for a missing thread,
 * and the refused-cut vocabulary (the gate's `fits` / `too_short` /
 * `notes_rejected` must survive the round trip — a compression that did not
 * happen has to be reportable as such).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-context-route-'));
  process.env.MERCURY_HOME = dir;
});

import context, { setContextControls, type ContextControls } from './context.js';

const snapshotBody = {
  enabled: true,
  saverActive: false,
  budget: 6000,
  historyTokens: 9200,
  viewTokens: 4100,
  needsCompression: false,
  cuts: 2,
  archivedTurns: 14,
  archivedThrough: 13,
  lastReport: { beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 },
  notes: { rules: ['always answer in French'], state: [{ name: 'codename', value: 'cedar-77' }], open: ['waiting on deploy'] },
  notesText: 'RULES\nalways answer in French\nSTATE\ncodename: cedar-77\nOPEN\nwaiting on deploy',
};

let controls: ContextControls;
let busy = false;
let keeperOn = true;
let compressOutcome: { outcome: string; report?: { beforeTokens: number; afterTokens: number; removedTurns: number } } =
  { outcome: 'cut', report: { beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 } };

beforeEach(() => {
  busy = false;
  compressOutcome = { outcome: 'cut', report: { beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 } };
  controls = {
    snapshot: (id) => {
      if (id === 'missing') throw new Error('Session missing not found');
      return { ...snapshotBody, sessionId: id };
    },
    compress: async (id) => {
      if (id === 'missing') throw new Error('Session missing not found');
      return compressOutcome;
    },
    recall: (id, query, limit) => {
      if (id === 'missing') throw new Error('Session missing not found');
      return { turns: 14, hits: query ? [`turn 3 (user): the codename is ${query}`].slice(0, limit) : [] };
    },
    busy: () => busy,
    keeperEnabled: () => keeperOn,
    setKeeperEnabled: (on) => { keeperOn = on; },
  };
  setContextControls(controls);
});

const get = (path: string) => context.request(`http://127.0.0.1${path}`);
const post = (path: string) => context.request(`http://127.0.0.1${path}`, { method: 'POST' });

describe('/api/context/threads/:id', () => {
  it('reports what the model sees and what the keeper holds', async () => {
    const res = await get('/api/context/threads/t1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: true,
      budget: 6000,
      historyTokens: 9200,
      viewTokens: 4100,
      cuts: 2,
      archivedTurns: 14,
      lastReport: { beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 },
      notes: { rules: ['always answer in French'] },
    });
  });

  it('404s a thread that does not exist', async () => {
    expect((await get('/api/context/threads/missing')).status).toBe(404);
  });

  it('503s without runtime controls', async () => {
    setContextControls(undefined);
    expect((await get('/api/context/threads/t1')).status).toBe(503);
  });
});

describe('/api/context/threads/:id/compress', () => {
  it('reports the cut with its numbers', async () => {
    const body = await (await post('/api/context/threads/t1/compress')).json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, outcome: 'cut', report: { beforeTokens: 9500, afterTokens: 4100, removedTurns: 6 } });
  });

  it('a refused cut is reported, not hidden — nothing changed', async () => {
    for (const outcome of ['fits', 'too_short', 'notes_rejected']) {
      compressOutcome = { outcome };
      const body = await (await post('/api/context/threads/t1/compress')).json() as Record<string, unknown>;
      expect(body).toEqual({ ok: true, outcome });
    }
  });

  it('409s while the thread is busy', async () => {
    busy = true;
    const res = await post('/api/context/threads/t1/compress');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).busy).toBe(true);
  });

  it('404s a thread that does not exist', async () => {
    expect((await post('/api/context/threads/missing/compress')).status).toBe(404);
  });
});

describe('/api/context (the keeper switch)', () => {
  it('reports and flips the master switch live', async () => {
    expect(((await (await get('/api/context')).json()) as Record<string, unknown>).enabled).toBe(true);
    const off = await context.request('http://127.0.0.1/api/context', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(await off.json()).toEqual({ enabled: false });
    expect(keeperOn).toBe(false);
    expect(((await (await get('/api/context')).json()) as Record<string, unknown>).enabled).toBe(false);
  });

  it('rejects a body that is not a boolean', async () => {
    const res = await context.request('http://127.0.0.1/api/context', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('/api/context/threads/:id/archive', () => {
  it('searches the archive with the turn numbers', async () => {
    const body = await (await get('/api/context/threads/t1/archive?query=cedar-77')).json() as Record<string, unknown>;
    expect(body).toMatchObject({ turns: 14, hits: ['turn 3 (user): the codename is cedar-77'] });
  });

  it('clamps the limit into 1..100', async () => {
    const seen: number[] = [];
    setContextControls({ ...controls, recall: (_id, _q, limit) => { seen.push(limit); return { turns: 0, hits: [] }; } });
    await get('/api/context/threads/t1/archive?query=x&limit=9999');
    await get('/api/context/threads/t1/archive?query=x&limit=0');
    await get('/api/context/threads/t1/archive?query=x');
    expect(seen).toEqual([100, 1, 20]);
  });

  it('404s a thread that does not exist', async () => {
    expect((await get('/api/context/threads/missing/archive?query=x')).status).toBe(404);
  });
});
