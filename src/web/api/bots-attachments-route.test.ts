import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fixed home: attachments land under MERCURY_HOME/uploads.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-bot-attachments-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultConfig } from '../../utils/config.js';
import { BotManager } from '../../bots/bot-manager.js';
import { BotStore } from '../../bots/store.js';
import app, { setBotManager } from './bots.js';

/**
 * `POST /api/bots/:id/message` with files: the route every bot is driven by. Until now a bot
 * could only be *told* what a screenshot showed; a vision model needs the bytes.
 */

let root: string;
let manager: BotManager;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const stubProviders = {
  get: () => undefined,
  getDefault: () => ({
    name: 'stub', model: 'stub-model',
    generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: 'stub' }),
    streamText: async function* () { yield { text: 'ok', done: true }; },
    isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model',
  } as never),
} as never;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mercury-web-bots-files-'));
  const store = new BotStore(join(root, 'bots'));
  const config = getDefaultConfig() as never;
  (config as any).bots.maxConcurrent = 4;
  manager = new BotManager({
    config,
    providers: stubProviders,
    tokenBudget: { recordUsage: () => {}, getRemaining: () => 100000, getStatusText: () => '', getUsagePercentage: () => 0 } as never,
    store,
    userMemoryFactory: () => null,
  } as never);
  setBotManager(manager);
  await app.request('/api/bots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'oeil', name: 'Œil', tier: 'operator' }),
  });
});

afterEach(() => {
  manager.dispose();
  setBotManager(undefined);
  rmSync(root, { recursive: true, force: true });
});

function send(id: string, body: unknown) {
  return app.request(`/api/bots/${id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The uploads folder this process writes to, with everything currently in it. */
function uploads(): string[] {
  const dir = join(process.env.MERCURY_HOME!, 'uploads');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const month of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, month))) out.push(join(dir, month, f));
  }
  return out;
}

describe('POST /api/bots/:id/message with attachments', () => {
  it('hands the photo to the job, stored on disk and named in the answer', async () => {
    const enqueue = vi.spyOn(manager, 'enqueue');

    const res = await send('oeil', { message: 'Revois cette capture', attachments: [{ name: 'dot.png', data: PNG_BASE64 }] });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ accepted: true, attachments: [{ name: 'dot.png', kind: 'image' }] });

    const job = enqueue.mock.calls[0][1] as { prompt: string; attachments?: Array<{ kind: string; path: string }> };
    expect(job.prompt).toBe('Revois cette capture');
    expect(job.attachments).toHaveLength(1);
    expect(job.attachments![0]).toMatchObject({ kind: 'image' });
    expect(existsSync(job.attachments![0].path)).toBe(true);
  });

  it('a photo with no words says what it is', async () => {
    const enqueue = vi.spyOn(manager, 'enqueue');

    const res = await send('oeil', { attachments: [{ name: 'dot.png', data: PNG_BASE64 }] });

    expect(res.status).toBe(202);
    // An empty text block is rejected by models: the file is named instead.
    expect((enqueue.mock.calls[0][1] as { prompt: string }).prompt).toBe('(Attached: dot.png)');
  });

  it('still requires something to say when nothing is attached', async () => {
    const res = await send('oeil', { message: '   ' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'message is required' });
  });

  it('refuses a file it cannot hand to a model', async () => {
    const res = await send('oeil', { message: 'lis ça', attachments: [{ name: 'notes.txt', data: Buffer.from('hello').toString('base64') }] });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('not a supported image') });
  });

  it('leaves no orphan file when the job is refused', async () => {
    const before = uploads().length;
    const res = await send('personne', { message: 'regarde', attachments: [{ name: 'dot.png', data: PNG_BASE64 }] });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ accepted: false, reasonCode: 'target_unknown' });
    // The files of a job that never ran would sit in uploads forever.
    expect(uploads().length).toBe(before);
  });
});
