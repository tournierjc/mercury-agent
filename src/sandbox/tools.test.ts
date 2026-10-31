import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxTools, TOOL_CATALOG, type RunResult } from './tools.js';

/**
 * The catalogue and the installer, with the machine faked out: what a phone sees must not depend on
 * which binaries this host happens to have.
 */
function fakeRun(answers: Record<string, RunResult | ((cmd: string[]) => RunResult)>) {
  const calls: string[][] = [];
  const runner = async (cmd: string[], opts: { timeoutMs: number; onOutput?: (c: string) => void }): Promise<RunResult> => {
    calls.push(cmd);
    // The presence probe is a shell string; match on the joined command so `command -v gh` is found.
    const key = Object.keys(answers).find((k) => cmd.join(' ').includes(k));
    if (!key) {
      opts.onOutput?.('');
      return { code: 1, stdout: '', stderr: 'not found' };
    }
    const answer = answers[key]!;
    const result = typeof answer === 'function' ? answer(cmd) : answer;
    opts.onOutput?.(result.stdout);
    return result;
  };
  return { runner, calls };
}

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), 'mercury-tools-'));
}

describe('the tool catalogue', () => {
  it('offers the shortcuts the owner asked for', () => {
    const ids = TOOL_CATALOG.map((t) => t.id);
    for (const wanted of ['gh', 'az', 'git', 'jq', 'rg']) expect(ids).toContain(wanted);
  });

  it('says why an apt tool cannot be installed here instead of hiding it', async () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const ffmpeg = (await tools.list()).find((t) => t.id === 'ffmpeg')!;

    expect(ffmpeg.present).toBe(false);
    expect(ffmpeg.installable).toBe(false);
    expect(ffmpeg.installBlocked).toMatch(/uid 1000/);
  });

  it('reports a shipped tool as present, with its version', async () => {
    const { runner } = fakeRun({
      'command -v git': { code: 0, stdout: '/usr/bin/git\n', stderr: '' },
      'git --version': { code: 0, stdout: 'git version 2.39.5\n', stderr: '' },
    });
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const git = (await tools.list()).find((t) => t.id === 'git')!;

    expect(git.present).toBe(true);
    expect(git.path).toBe('/usr/bin/git');
    expect(git.version).toBe('git version 2.39.5');
    expect(git.installable).toBe(false);
  });
});

describe('the sign-in state', () => {
  it('reads a signed-in gh as connected', async () => {
    const { runner } = fakeRun({
      'command -v gh': { code: 0, stdout: '/home/node/.mercury/tools/bin/gh\n', stderr: '' },
      'gh --version': { code: 0, stdout: 'gh version 2.62.0\n', stderr: '' },
      'gh auth status': { code: 0, stdout: 'github.com\n  ✓ Logged in to github.com account herbert\n', stderr: '' },
    });
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const gh = (await tools.list()).find((t) => t.id === 'gh')!;

    expect(gh.auth).toBe('connected');
    expect(gh.authDetail).toContain('herbert');
  });

  it('reads a signed-out gh as not connected, and keeps the reason', async () => {
    const { runner } = fakeRun({
      'command -v gh': { code: 0, stdout: '/home/node/.mercury/tools/bin/gh\n', stderr: '' },
      'gh --version': { code: 0, stdout: 'gh version 2.62.0\n', stderr: '' },
      'gh auth status': { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' },
    });
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const gh = (await tools.list()).find((t) => t.id === 'gh')!;

    expect(gh.auth).toBe('no');
    expect(gh.authDetail).toMatch(/not logged/);
  });

  it('an absent tool cannot be connected, and a tool without sign-in stays unknown', async () => {
    const { runner } = fakeRun({
      'command -v git': { code: 0, stdout: '/usr/bin/git\n', stderr: '' },
      'git --version': { code: 0, stdout: 'git version 2.39.5\n', stderr: '' },
    });
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const list = await tools.list();

    expect(list.find((t) => t.id === 'gh')!.auth).toBe('no');
    expect(list.find((t) => t.id === 'git')!.auth).toBe('unknown');
  });
});

describe('installing', () => {
  it('refuses an apt tool with the reason, not a silent no-op', () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    expect(() => tools.install('ffmpeg')).toThrow(/uid 1000/);
  });

  it('refuses a tool that ships with the image', () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    expect(() => tools.install('git')).toThrow(/shipped with the image/);
  });

  it('runs the recipe, keeps a log, and records the outcome on disk', async () => {
    const dir = projectDir();
    const { runner, calls } = fakeRun({
      'curl -sSL': { code: 0, stdout: 'downloading\n', stderr: '' },
    });
    const tools = new SandboxTools({ dir, runner });

    const started = tools.install('gh');
    expect(started.state).toBe('running');
    // The recipe runs in the background; wait for the record to settle.
    for (let i = 0; i < 100 && tools.installStatus('gh')?.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const record = tools.installStatus('gh')!;

    expect(record.state).toBe('done');
    expect(record.finishedAt).toBeGreaterThan(0);
    expect(calls.some((c) => c.join(' ').includes('curl'))).toBe(true);
    // The state file is what survives a container upgrade, so it must actually be written.
    const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'));
    expect(persisted.at(-1).id).toBe('gh');
  });

  it('records a failed recipe instead of claiming success', async () => {
    const dir = projectDir();
    const { runner } = fakeRun({ 'curl -sSL': { code: 22, stdout: '', stderr: 'curl: (22) 404' } });
    const tools = new SandboxTools({ dir, runner });

    tools.install('gh');
    for (let i = 0; i < 100 && tools.installStatus('gh')?.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const record = tools.installStatus('gh')!;

    expect(record.state).toBe('failed');
    expect(record.log).toMatch(/404/);
  });

  it('does not start a second install of the same tool while one runs', () => {
    const { runner } = fakeRun({ 'curl -sSL': { code: 0, stdout: '', stderr: '' } });
    const tools = new SandboxTools({ dir: projectDir(), runner });

    const first = tools.install('gh');
    const second = tools.install('gh');

    expect(second.startedAt).toBe(first.startedAt);
  });
});

describe('connecting a tool', () => {
  it('scrapes the one-time code and the URL from the device flow', async () => {
    // The exact two lines a real `gh auth login --web` prints headless (captured from the container).
    const printed =
      '! First copy your one-time code: F5ED-CED0\n' +
      'Open this URL to continue in your web browser: https://github.com/login/device\n';
    const spawnProcess = (() => {
      const listeners: Record<string, ((arg: unknown) => void)[]> = {};
      const child = {
        stdout: { on: (_e: string, cb: (d: Buffer) => void) => setTimeout(() => cb(Buffer.from(printed)), 5) },
        stderr: { on: () => undefined },
        on: (event: string, cb: (arg: unknown) => void) => {
          (listeners[event] ??= []).push(cb);
        },
        kill: () => undefined,
      };
      return child as never;
    }) as never;
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner, spawnProcess });
    const flow = await tools.connect('gh');

    expect(flow.code).toBe('F5ED-CED0');
    expect(flow.url).toBe('https://github.com/login/device');
    expect(flow.state).toBe('pending');
  });

  it('refuses a tool that has no sign-in', async () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    await expect(tools.connect('git')).rejects.toThrow(/no sign-in/);
  });
});

describe('the install history', () => {
  it('reads back what a previous run wrote', () => {
    const dir = projectDir();
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify([{ id: 'gh', startedAt: 1, finishedAt: 2, state: 'done', log: 'ok' }]),
      'utf-8',
    );
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir, runner });

    expect(tools.history()).toHaveLength(1);
    expect(tools.installStatus('gh')?.state).toBe('done');
    expect(tools.installStatus('nope')).toBeUndefined();
  });
});
