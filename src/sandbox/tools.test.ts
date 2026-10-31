import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    for (const wanted of ['gh', 'az', 'git', 'jq', 'rg', 'ssh']) expect(ids).toContain(wanted);
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

describe('uninstalling', () => {
  /** A tools dir with the files a recipe leaves, so the removal has something real to delete. */
  function installedDir(files: string[], dirs: string[] = []): string {
    const dir = projectDir();
    mkdirSync(join(dir, 'bin'), { recursive: true });
    for (const f of files) writeFileSync(join(dir, 'bin', f), '#!/bin/sh\n', { mode: 0o755 });
    for (const d of dirs) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'leftover'), 'x');
    }
    return dir;
  }

  it('removes the binary and the private tree of a tool we installed', () => {
    const dir = installedDir(['ffmpeg']);
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir, runner });

    const result = tools.remove('ffmpeg');

    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, 'bin', 'ffmpeg'))).toBe(false);
    expect(tools.installStatus('ffmpeg')?.state).toBe('removed');
  });

  it('takes the whole ssh bundle and its extracted tree with it', () => {
    const dir = installedDir(['ssh', 'scp', 'sftp', 'ssh-keygen', 'ssh-keyscan', 'ssh-add', 'ssh-agent'], ['ssh-extract']);
    const tools = new SandboxTools({ dir, runner: fakeRun({}).runner });

    tools.remove('ssh');

    expect(existsSync(join(dir, 'bin', 'ssh'))).toBe(false);
    expect(existsSync(join(dir, 'bin', 'ssh-keyscan'))).toBe(false);
    expect(existsSync(join(dir, 'ssh-extract'))).toBe(false);
  });

  it('leaves the other installed tools alone', () => {
    const dir = installedDir(['gh', 'ffmpeg'], ['gh-extract']);
    const tools = new SandboxTools({ dir, runner: fakeRun({}).runner });

    tools.remove('gh');

    expect(existsSync(join(dir, 'bin', 'gh'))).toBe(false);
    expect(existsSync(join(dir, 'bin', 'ffmpeg'))).toBe(true);
  });

  it('refuses a tool the image ships, because it is not ours to delete', () => {
    const dir = installedDir([]);
    const tools = new SandboxTools({ dir, runner: fakeRun({}).runner });

    expect(() => tools.remove('git')).toThrow(/shipped with the image/);
    expect(() => tools.remove('python3')).toThrow(/shipped with the image/);
  });

  it('refuses an unknown id and a tool that is not installed', () => {
    const dir = installedDir([]);
    const tools = new SandboxTools({ dir, runner: fakeRun({}).runner });

    expect(() => tools.remove('nope')).toThrow(/unknown tool/);
    expect(() => tools.remove('ffmpeg')).toThrow(/not installed/);
  });

  it('marks ours as removable and an image tool as not removable', async () => {
    const { runner } = fakeRun({
      'command -v git': { code: 0, stdout: '/usr/bin/git\n', stderr: '' },
      'git --version': { code: 0, stdout: 'git version 2.39.5\n', stderr: '' },
      'command -v gh': { code: 0, stdout: '/home/node/.mercury/tools/bin/gh\n', stderr: '' },
      'gh --version': { code: 0, stdout: 'gh version 2.62.0\n', stderr: '' },
    });
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const rows = await tools.list();
    const git = rows.find((t) => t.id === 'git')!;
    const gh = rows.find((t) => t.id === 'gh')!;

    expect(gh.removable).toBe(true);
    expect(git.removable).toBe(false);
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
  it('installs ffmpeg without root, instead of refusing it for wanting apt', async () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    const ffmpeg = (await tools.list()).find((t) => t.id === 'ffmpeg')!;

    // The owner's report: the row said "requires root (apt)" and offered no button. A static build
    // needs neither — the recipe is a download, and the screen must offer it.
    expect(ffmpeg.present).toBe(false);
    expect(ffmpeg.installable).toBe(true);
    expect(ffmpeg.installBlocked).toBe('');
  });

  it('keeps a per-tool "cannot install here" reason when the catalogue declares one', async () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    // The mechanism outlives this catalogue: a tool with no rootless path says why, and the screen
    // draws that sentence instead of a button that would fail.
    TOOL_CATALOG.push({
      id: 'needs-root',
      label: 'needs-root',
      description: 'test fixture',
      bin: 'needs-root',
      versionArgs: ['needs-root', '--version'],
      recipe: 'gh-tarball',
      installBlocked: 'Ce conteneur tourne en uid 1000 sans sudo : apt est impossible ici.',
    });
    try {
      const row = (await tools.list()).find((t) => t.id === 'needs-root')!;
      expect(row.installable).toBe(false);
      expect(row.installBlocked).toMatch(/uid 1000/);
      expect(() => tools.install('needs-root')).toThrow(/uid 1000/);
    } finally {
      TOOL_CATALOG.pop();
    }
  });

  it('refuses a tool that ships with the image', () => {
    const { runner } = fakeRun({});
    const tools = new SandboxTools({ dir: projectDir(), runner });
    expect(() => tools.install('git')).toThrow(/shipped with the image/);
  });

  it('downloads the static ffmpeg binary into the tools bin', async () => {
    const dir = projectDir();
    const { runner, calls } = fakeRun({ 'curl -sSL': { code: 0, stdout: 'downloading\n', stderr: '' } });
    const tools = new SandboxTools({ dir, runner });

    tools.install('ffmpeg');
    for (let i = 0; i < 100 && tools.installStatus('ffmpeg')?.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const record = tools.installStatus('ffmpeg')!;
    const script = calls.map((c) => c.join(' ')).join('\n');

    expect(record.state).toBe('done');
    // No apt, no root: one gzipped binary, unpacked with python3 (the image has no xz).
    expect(script).toContain('ffmpeg-linux-arm64.gz');
    expect(script).not.toContain('apt-get');
    expect(script).toContain('gzip.open');
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

  describe('ssh — the apt tool that installs without root', () => {
    it('offers ssh as installable, unlike the plain apt recipes', async () => {
      const { runner } = fakeRun({});
      const tools = new SandboxTools({ dir: projectDir(), runner });
      const ssh = (await tools.list()).find((t) => t.id === 'ssh')!;

      expect(ssh.present).toBe(false);
      expect(ssh.installable).toBe(true);
      expect(ssh.installBlocked).toBe('');
    });

    it('unpacks the pinned Debian package into the tools bin instead of refusing like apt', async () => {
      const dir = projectDir();
      const { runner, calls } = fakeRun({
        'dpkg-deb -x': { code: 0, stdout: '', stderr: '' },
        'ssh -V': { code: 0, stdout: 'OpenSSH_9.2p1 Debian-2+deb12u7, OpenSSL 3.0.17\n', stderr: '' },
      });
      const tools = new SandboxTools({ dir, runner });

      tools.install('ssh');
      for (let i = 0; i < 100 && tools.installStatus('ssh')?.state === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const record = tools.installStatus('ssh')!;
      const script = calls.map((c) => c.join(' ')).find((c) => c.includes('dpkg-deb')) ?? '';

      expect(record.state).toBe('done');
      // The download is the pinned Debian 12 client, for this machine's arch — not "latest".
      expect(script).toMatch(/openssh-client_9\.2p1-2\+deb12u7_(amd64|arm64)\.deb/);
      expect(script).toMatch(/dpkg-deb -x/);
      // The binaries a bot needs: the client plus the probes and copy tools an ops prompt asks for.
      // The copy loop carries them as "$b" — assert the loop, not a per-binary literal.
      expect(script).toMatch(/for b in ssh scp sftp ssh-keygen ssh-keyscan/);
      // No root anywhere in the recipe.
      expect(script).not.toMatch(/\bsudo\b|apt-get install/);
    });

    it('records a missing dpkg-deb as a failure the phone can read', async () => {
      const { runner } = fakeRun({
        'dpkg-deb': { code: 3, stdout: '', stderr: 'dpkg-deb introuvable' },
      });
      const tools = new SandboxTools({ dir: projectDir(), runner });

      tools.install('ssh');
      for (let i = 0; i < 100 && tools.installStatus('ssh')?.state === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(tools.installStatus('ssh')!.state).toBe('failed');
      expect(tools.installStatus('ssh')!.log).toMatch(/dpkg-deb/);
    });
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
