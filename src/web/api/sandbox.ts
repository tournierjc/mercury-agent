import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SandboxTools } from '../../sandbox/tools.js';

const app = new Hono();

let tools: SandboxTools | undefined;

export function setSandboxTools(t: SandboxTools | undefined): void {
  tools = t;
}

const down = (c: Context) => c.json({ error: 'Sandbox tools not available' }, 400);

/**
 * What the bots can run, what is signed in, and how to change either.
 *
 * A tool installed here is shared: the sandbox confines *paths*, not processes, so every bot and the
 * main agent see the same binaries. The screen says so rather than letting a per-bot reading stand.
 */
app.get('/api/sandbox/tools', async (c: Context) => {
  if (!tools) return down(c);
  return c.json({ tools: await tools.list() });
});

/** Starts an install. Minutes long on a phone connection, so it answers with the job, not the result. */
app.post('/api/sandbox/tools/:id/install', (c: Context) => {
  if (!tools) return down(c);
  const id = String(c.req.param('id') ?? '');
  try {
    return c.json(tools.install(id), 202);
  } catch (err) {
    return c.json({ error: String((err as Error)?.message ?? err) }, 400);
  }
});

app.get('/api/sandbox/tools/:id/install', (c: Context) => {
  if (!tools) return down(c);
  const record = tools.installStatus(String(c.req.param('id') ?? ''));
  if (!record) return c.json({ error: 'No install for this tool' }, 404);
  return c.json(record);
});

app.get('/api/sandbox/tools/installs', (c: Context) => {
  if (!tools) return down(c);
  return c.json({ installs: tools.history() });
});

/**
 * Removes a tool we installed.
 *
 * Synchronous, unlike an install: deleting a binary and its private tree is one filesystem call,
 * and answering with a job the phone would then have to poll would be a ceremony around `rm`. The
 * route refuses the tools the image ships (the service says why) — a 400 carries that sentence.
 */
app.delete('/api/sandbox/tools/:id', (c: Context) => {
  if (!tools) return down(c);
  const id = String(c.req.param('id') ?? '');
  try {
    return c.json(tools.remove(id));
  } catch (err) {
    return c.json({ error: String((err as Error)?.message ?? err) }, 400);
  }
});

/** Starts the device flow and returns the one-time code the owner has to type. */
app.post('/api/sandbox/tools/:id/connect', async (c: Context) => {
  if (!tools) return down(c);
  const id = String(c.req.param('id') ?? '');
  try {
    return c.json(await tools.connect(id), 202);
  } catch (err) {
    return c.json({ error: String((err as Error)?.message ?? err) }, 400);
  }
});

app.get('/api/sandbox/tools/:id/connect', (c: Context) => {
  if (!tools) return down(c);
  const flow = tools.connectStatus(String(c.req.param('id') ?? ''));
  if (!flow) return c.json({ error: 'No sign-in in progress' }, 404);
  return c.json(flow);
});

export default app;
