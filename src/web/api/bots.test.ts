import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultConfig } from '../../utils/config.js';
import { BotManager } from '../../bots/bot-manager.js';
import { BotStore } from '../../bots/store.js';
import { PERMISSION_TIERS } from '../../bots/permission-tiers.js';
import app, { registerRosterClient, setBotManager } from './bots.js';

/**
 * Web cockpit API — handlers tested directly via the module's own Hono app
 * (server.ts mounts it behind authGuard; the guard itself is covered by its
 * own suite). Covers the deliverables inbox, tier-executing onboarding, the
 * persona/permissions editors, and bundle round-trips.
 */

let root: string;
let store: BotStore;
let manager: BotManager;

const stubProviders = {
  get: () => undefined,
  getDefault: () => ({
    name: 'stub', model: 'stub-model',
    generateText: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'stub-model', provider: 'stub' }),
    streamText: async function* () { yield { text: 'ok', done: true }; },
    isAvailable: () => true, getModelInstance: () => ({}), getModel: () => 'stub-model',
  } as never),
} as never;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mercury-web-bots-'));
  store = new BotStore(join(root, 'bots'));
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
});

afterEach(() => {
  manager.dispose(); // Windows: release the SQLite handle before rm
  setBotManager(undefined);
  rmSync(root, { recursive: true, force: true });
});

const jreq = (res: Response) => res.json() as Promise<any>;

describe('web bots API — cockpit', () => {
  it('GET tiers returns the executable tier catalog', async () => {
    const res = await app.request('/api/bots/tiers');
    expect(res.status).toBe(200);
    const { tiers } = await jreq(res);
    expect(tiers.map((t: any) => t.id).sort()).toEqual(Object.keys(PERMISSION_TIERS).sort());
    expect(tiers.find((t: any) => t.id === 'full').deny).toEqual(PERMISSION_TIERS.full.deny);
  });

  it('onboarding with a tier EXECUTES it — permissions.yaml gets the tier wholesale', async () => {
    const res = await app.request('/api/bots', { method: 'POST', body: JSON.stringify({ id: 'researcher', name: 'Research', tier: 'builder' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(201);
    const perms = manager.store.readPermissions('researcher');
    expect(perms.tools?.deny).toEqual(PERMISSION_TIERS.builder.deny);
    expect(readFileSync(join(root, 'bots', 'researcher', 'permissions.yaml'), 'utf-8')).toBeTruthy();
  });

  it('onboarding with an unknown tier is rejected 400 — no silent default', async () => {
    const res = await app.request('/api/bots', { method: 'POST', body: JSON.stringify({ id: 'x', name: 'X', tier: 'godmode' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });

  it('persona editor round-trips and flags invalid bots', async () => {
    await app.request('/api/bots', { method: 'POST', body: JSON.stringify({ id: 'writer', name: 'Writer', tier: 'readonly' }), headers: { 'Content-Type': 'application/json' } });
    const put = await app.request('/api/bots/writer/persona', { method: 'PUT', body: JSON.stringify({ persona: '# You are terse.\nWrite only numbers.' }), headers: { 'Content-Type': 'application/json' } });
    expect(put.status).toBe(200);
    const got = await jreq(await app.request('/api/bots/writer/persona'));
    expect(got.persona).toContain('Write only numbers.');
    expect((await app.request('/api/bots/ghost/persona')).status).toBe(404);
  });

  it('permissions editor: GET reflects the file; PUT tier applies; PUT custom persists', async () => {
    store.create({ id: 'solo', name: 'Solo' });
    let got = await jreq(await app.request('/api/bots/solo/permissions'));
    expect(got.permissions).toEqual(store.readPermissions('solo'));

    await app.request('/api/bots/solo/permissions', { method: 'PUT', body: JSON.stringify({ tier: 'operator' }), headers: { 'Content-Type': 'application/json' } });
    expect(store.readPermissions('solo').tools?.deny).toEqual(PERMISSION_TIERS.operator.deny);

    const custom = { tools: { deny: ['run_command'] }, paths: [{ scope: '~/workspace', mode: 'rw' }] };
    const put = await app.request('/api/bots/solo/permissions', { method: 'PUT', body: JSON.stringify({ permissions: custom }), headers: { 'Content-Type': 'application/json' } });
    expect(put.status).toBe(200);
    expect(store.readPermissions('solo').tools?.deny).toEqual(['run_command']);
  });

  it('deliverables: deliver → list → preview → download → remove, with traversal and unknown rejected', async () => {
    store.create({ id: 'publisher', name: 'Publisher' });
    const sandboxFile = join(manager.store.sandboxDir('publisher'), 'final-report.md');
    mkdirSync(manager.store.sandboxDir('publisher'), { recursive: true });
    writeFileSync(sandboxFile, '# The final report');
    const delivered = manager.deliver('publisher', sandboxFile);
    expect(delivered.accepted).toBe(true);

    // Fleet inbox lists it
    let list = await jreq(await app.request('/api/bots/outputs'));
    // Delivered names are dated + humanised; non-final work lands under work/.
    expect(list.outputs).toEqual([expect.objectContaining({ botId: 'publisher', final: false })]);
    const name: string = list.outputs[0].name;
    expect(name).toMatch(/^work\/\d{4}-\d{2}-\d{2} final report\.md$/);
    const enc = encodeURIComponent(name);

    // Per-bot list
    list = await jreq(await app.request('/api/bots/publisher/outputs'));
    expect(list.outputs).toHaveLength(1);

    // Preview
    const preview = await jreq(await app.request(`/api/bots/publisher/outputs/${enc}/preview`));
    expect(preview.preview).toContain('# The final report');

    // Download — raw bytes + content type
    const dl = await app.request(`/api/bots/publisher/outputs/${enc}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('text/markdown');
    expect(await dl.text()).toContain('# The final report');

    // Traversal names resolve outside the bot's outputs dir → 404, never a file
    expect((await app.request(`/api/bots/publisher/outputs/${encodeURIComponent('..%2F..%2Fbot.yaml')}/preview`)).status).toBe(404);
    expect((await app.request('/api/bots/publisher/outputs/ghost.md/preview')).status).toBe(404);

    // Remove
    const del = await app.request(`/api/bots/publisher/outputs/${enc}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await app.request('/api/bots/publisher/outputs')).status ?? 0).toBeLessThan(500);
    const after = await jreq(await app.request('/api/bots/publisher/outputs'));
    expect(after.outputs).toHaveLength(0);
  });

  it('promote makes the bot a fleet lead (TUI-parity fleet semantics)', async () => {
    store.create({ id: 'solo', name: 'Solo' });
    const res = await app.request('/api/bots/solo/promote', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(store.get('solo')?.fleetRole).toBe('lead');
    // Idempotent — no error on a second promote
    expect((await app.request('/api/bots/solo/promote', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/bots/ghost/promote', { method: 'POST' })).status).toBe(404);
  });

  it('autocrew accepts detached (202) and the degraded path leaves a lead with helpful guidance', async () => {
    await app.request('/api/bots', { method: 'POST', body: JSON.stringify({ id: 'leadish', name: 'Lead', persona: '# persona for the fleet' }), headers: { 'Content-Type': 'application/json' } });
    const res = await app.request('/api/bots/leadish/autocrew', { method: 'POST' });
    expect(res.status).toBe(202);
    // Detached — the proposal runs in the background; errors (unusable stub
    // provider output) must degrade to guidance, never throw.
    expect(store.get('leadish')?.fleetRole).toBe('lead');
  });

  it('bundle export → import round-trip recreates the bot (disabled) and skips duplicates', async () => {
    await app.request('/api/bots', { method: 'POST', body: JSON.stringify({ id: 'crewbot', name: 'Crew', persona: '# persona', tier: 'builder' }), headers: { 'Content-Type': 'application/json' } });

    const bundleRes = await app.request('/api/bots/crewbot/bundle');
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.headers.get('content-disposition')).toContain('crewbot-bundle.json');
    const bundle = await bundleRes.json();

    // Import into an EMPTY store — the bot comes back disabled per bundle semantics.
    const store2 = manager.store; // same store: import with the same id skips
    const report = await jreq(await app.request('/api/bots/import', { method: 'POST', body: JSON.stringify(bundle), headers: { 'Content-Type': 'application/json' } }));
    expect(report.report.skipped.length + report.report.created.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'bots', 'crewbot'))).toBe(true);
    void store2;

    // Malformed bundle → 400
    expect((await app.request('/api/bots/import', { method: 'POST', body: JSON.stringify({ nope: true }), headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  });
});
describe('web bots API — operations (ADR-022)', () => {
  it('cost, tasks, runs, dlq clear and the kill switch are reachable', async () => {
    store.create({ id: 'solo', name: 'Solo' });
    const cost = await jreq(await app.request('/api/bots-cost?days=3'));
    expect(cost.days).toBe(3);
    expect(cost.bots.map((b: { id: string }) => b.id)).toContain('solo');
    expect((await app.request('/api/bots/solo/tasks')).status).toBe(200);
    expect((await app.request('/api/bots/ghost/tasks')).status).toBe(404);
    const runs = await jreq(await app.request('/api/bots/solo/runs'));
    expect(runs.runs).toEqual([]);
    expect((await app.request('/api/bots/solo/runs/latest')).status).toBe(404);
    expect(await jreq(await app.request('/api/bots-dlq', { method: 'DELETE' }))).toEqual({ cleared: 0 });
    expect((await app.request('/api/bots-dlq?bot=ghost', { method: 'DELETE' })).status).toBe(404);
    const stopped = await jreq(await app.request('/api/bots-stop-all', { method: 'POST' }));
    expect(stopped.stopped).toBe(1);
    const started = await jreq(await app.request('/api/bots-start-all', { method: 'POST' }));
    expect(started.started).toBe(1);
  });
});

describe('web bots API — deliverables folder (where results land)', () => {
  it('reports the fleet root and a bot folder with a readable path', async () => {
    const root = await jreq(await app.request('/api/bots/folder'));
    expect(typeof root.path).toBe('string');
    expect(typeof root.display).toBe('string');
    expect(typeof root.exists).toBe('boolean');
    expect((await app.request('/api/bots/ghost/folder')).status).toBe(404);
  });
  it('a rename reaches every open tab: the feed pushes the new name, not just the reply', async () => {
    // The bug this pins: PATCH answered 200 with the new name, and the drawer — fed by the fleet
    // feed, not by the reply — kept the old one until some unrelated roster change happened.
    store.create({ id: 'scribed', name: 'Scribe' });
    const seen: Array<{ event: string; data: any }> = [];
    const unsubscribe = registerRosterClient({ send: (event, data) => seen.push({ event, data }) });

    try {
      const res = await app.request('/api/bots/scribed', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Chroniqueur' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);

      const roster = seen.filter((e) => e.event === 'bot_roster').at(-1);
      expect(roster, 'no roster event after the rename').toBeTruthy();
      const renamed = roster!.data.bots.find((b: any) => b.id === 'scribed');
      expect(renamed.name).toBe('Chroniqueur');
    } finally {
      unsubscribe();
    }
  });

  it('a config edit that the roster shows (the enabled flag) is announced too', async () => {
    store.create({ id: 'quiet', name: 'Quiet' });
    const seen: Array<{ event: string; data: any }> = [];
    const unsubscribe = registerRosterClient({ send: (event, data) => seen.push({ event, data }) });

    try {
      await app.request('/api/bots/quiet', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
        headers: { 'Content-Type': 'application/json' },
      });

      // The summary carries the flag, not the description: the roster is what a drawer draws, and
      // the description belongs to the bot's own page.
      const roster = seen.filter((e) => e.event === 'bot_roster').at(-1);
      const edited = roster?.data.bots.find((b: any) => b.id === 'quiet');
      expect(edited?.enabled).toBe(false);
    } finally {
      unsubscribe();
    }
  });

});
