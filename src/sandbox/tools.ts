import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Tools the bots can be given, without root and without touching the image.
 *
 * Everything here lands in `~/.mercury/tools/`, which lives in the mounted data volume: a tool
 * installed from the phone is still there after the container is recreated, which is the only way
 * "install it once" can mean anything when upgrades replace the filesystem.
 *
 * The sandbox has no per-bot isolation (`run_command` spawns in the daemon's own process), so a tool
 * installed here is seen by every bot and by the main agent. The catalogue says so instead of
 * implying a per-bot install that cannot exist.
 */

export type ToolAuthState = 'no' | 'unknown' | 'connected';

export type ToolRecipe = 'gh-tarball' | 'az-venv' | 'ssh-deb-bundle' | 'ffmpeg-static';

export interface ToolAuth {
  /** Command that answers "is this tool signed in?" — exit 0 means yes. */
  check: string[];
  /** Command that starts the device flow and prints a code. */
  login: string[];
  /** The one-time code in the login output. */
  code: RegExp;
  /** The page the owner has to open. */
  url: RegExp;
}

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  bin: string;
  versionArgs: string[];
  recipe?: ToolRecipe;
  auth?: ToolAuth;
  /**
   * Why this one cannot be installed here, when it cannot.
   *
   * A *data* field, not a rule about recipes: the screen has to say why a row it offers no button
   * for is un-actionable, and a hard-coded rule is how a tool that becomes installable keeps
   * showing an excuse nobody re-read.
   */
  installBlocked?: string;
}

const GH_AUTH: ToolAuth = {
  check: ['gh', 'auth', 'status'],
  login: ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'],
  code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
  url: /(https:\/\/\S*\/login\/device)/i,
};

const AZ_AUTH: ToolAuth = {
  check: ['az', 'account', 'show'],
  login: ['az', 'login', '--use-device-code'],
  code: /enter the code\s+([A-Z0-9]{6,12})/i,
  url: /(https:\/\/\S*devicelogin)/i,
};

/**
 * Shortcuts the owner asked for by name, plus what the image already ships.
 *
 * `apt` recipes are listed so the screen can say why they are unavailable rather than hiding them:
 * the container runs as uid 1000 with no sudo, so `apt-get install` cannot work from here.
 */
export const TOOL_CATALOG: ToolDef[] = [
  {
    id: 'gh',
    label: 'GitHub CLI',
    description: 'Issues, PRs, Actions, releases — from a bot.',
    bin: 'gh',
    versionArgs: ['gh', '--version'],
    recipe: 'gh-tarball',
    auth: GH_AUTH,
  },
  {
    id: 'az',
    label: 'Azure CLI',
    description: 'Ressources Azure, en lecture comme en écriture.',
    bin: 'az',
    // `az version` answers JSON; the tsv query is what makes the row read "2.91.0" and not "{".
    versionArgs: ['az', 'version', '--output', 'tsv', '--query', '"azure-cli"'],
    recipe: 'az-venv',
    auth: AZ_AUTH,
  },
  { id: 'git', label: 'git', description: 'Fourni par l’image.', bin: 'git', versionArgs: ['git', '--version'] },
  { id: 'jq', label: 'jq', description: 'Fourni par l’image.', bin: 'jq', versionArgs: ['jq', '--version'] },
  { id: 'rg', label: 'ripgrep', description: 'Fourni par l’image.', bin: 'rg', versionArgs: ['rg', '--version'] },
  { id: 'curl', label: 'curl', description: 'Fourni par l’image.', bin: 'curl', versionArgs: ['curl', '--version'] },
  { id: 'node', label: 'Node.js', description: 'Fourni par l’image.', bin: 'node', versionArgs: ['node', '--version'] },
  { id: 'python3', label: 'Python', description: 'Fourni par l’image.', bin: 'python3', versionArgs: ['python3', '--version'] },
  {
    id: 'ffmpeg',
    label: 'ffmpeg',
    // The rootless path is the point: apt needs root, a static build does not. The sentence says
    // what it is for, and that no one has to rebuild the image or find a shell to get it.
    description: 'Convertir, découper, extraire — audio et vidéo, sans root.',
    bin: 'ffmpeg',
    versionArgs: ['ffmpeg', '-version'],
    recipe: 'ffmpeg-static',
  },
  {
    id: 'ssh',
    label: 'OpenSSH client',
    // The recipe name carries the how: dpkg-deb -x of a pinned Debian 12 bundle, no root. The
    // sentence stays non-technical: what it is for, and that the keys are the owner's, not the tool's.
    description: 'Se connecter aux autres machines (ssh, scp, ssh-keyscan).',
    bin: 'ssh',
    versionArgs: ['ssh', '-V'],
    recipe: 'ssh-deb-bundle',
  },
];

export interface ToolStatus {
  id: string;
  label: string;
  description: string;
  present: boolean;
  path: string;
  version: string;
  /** `unknown` when the tool has no way to be signed in, or the check failed to answer. */
  auth: ToolAuthState;
  authDetail: string;
  installable: boolean;
  /** Why it cannot be installed here, when it cannot. */
  installBlocked: string;
  /**
   * True when the binary we see is one *we* put in `~/.mercury/tools`.
   *
   * The screen offers an uninstall on this flag and nowhere else: `git`, `node` or `python3` come
   * from the image, and deleting a shipped binary is not a feature — it is a broken container the
   * next restart silently repairs.
   */
  removable: boolean;
}

export interface InstallRecord {
  id: string;
  startedAt: number;
  finishedAt?: number;
  state: 'running' | 'done' | 'failed' | 'removed';
  log: string;
}

export interface ConnectFlow {
  id: string;
  state: 'pending' | 'connected' | 'failed';
  code: string;
  url: string;
  startedAt: number;
  detail: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[], opts: { timeoutMs: number; onOutput?: (chunk: string) => void }) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, { timeoutMs, onOutput }) =>
  new Promise((resolve) => {
    const [file, ...args] = cmd;
    const child = spawn(file!, args, { env: { ...process.env, PATH: toolsPath() + ':' + (process.env.PATH ?? '') } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      onOutput?.(d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      onOutput?.(d.toString());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Where installs land — inside the mounted home, so they survive a container upgrade. */
// Imported (not just re-exported): runRecipe and the ssh recipe call toolsPath() directly, and a
// bare re-export leaves the name undefined at runtime — the daemon restart-looped while every
// test that never reached an install stayed green.
import { toolsDir, toolsPath } from './paths.js';

export { toolsDir, toolsPath };

export class SandboxTools {
  private readonly dir: string;
  private readonly run: Runner;
  private readonly installs = new Map<string, InstallRecord>();
  private readonly flows = new Map<string, ConnectFlow>();
  private readonly keep = 20;

  constructor(opts: { dir?: string; runner?: Runner; spawnProcess?: typeof spawn } = {}) {
    this.dir = opts.dir ?? toolsDir();
    this.run = opts.runner ?? defaultRunner;
    this.spawn = opts.spawnProcess ?? spawn;
  }

  private readonly spawn: typeof spawn;

  private stateFile(): string {
    return join(this.dir, 'state.json');
  }

  private readState(): InstallRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile(), 'utf-8')) as InstallRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeState(records: InstallRecord[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.stateFile(), JSON.stringify(records.slice(-this.keep), null, 1), 'utf-8');
    } catch {
      // State is a convenience for the screen; a failed write must not fail an install.
    }
  }

  /** What the screen draws: presence, version, and whether the tool is signed in. */
  async list(): Promise<ToolStatus[]> {
    return Promise.all(TOOL_CATALOG.map(async (def) => this.statusOf(def)));
  }

  private async statusOf(def: ToolDef): Promise<ToolStatus> {
    const found = await this.run(['sh', '-c', `command -v ${def.bin}`], { timeoutMs: 5_000 });
    const present = found.code === 0 && found.stdout.trim().length > 0;
    let version = '';
    if (present) {
      const v = await this.run(def.versionArgs, { timeoutMs: 10_000 });
      version = (v.stdout + v.stderr).split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '';
    }
    let auth: ToolAuthState = 'unknown';
    let authDetail = '';
    if (def.auth) {
      if (!present) {
        auth = 'no';
      } else {
        const check = await this.run(def.auth.check, { timeoutMs: 15_000 });
        const text = (check.stdout + check.stderr).trim();
        auth = check.code === 0 ? 'connected' : 'no';
        authDetail = text.split('\n').filter((l) => l.trim()).slice(0, 2).join(' ').slice(0, 200);
      }
    }
    const blocked = def.installBlocked ?? '';
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      present,
      path: present ? found.stdout.trim().split('\n')[0]! : '',
      version,
      auth,
      authDetail,
      installable: Boolean(def.recipe) && !def.installBlocked && !present,
      installBlocked: !present ? blocked : '',
      // Ours only: a recipe is exactly "something we know how to put here and take away again".
      removable: present && Boolean(def.recipe),
    };
  }

  /** Installs are minutes long on a phone connection: they are a job, not a request. */
  install(id: string): InstallRecord {
    const def = TOOL_CATALOG.find((t) => t.id === id);
    if (!def) throw new Error(`unknown tool: ${id}`);
    if (!def.recipe) throw new Error(`${id} is shipped with the image — nothing to install`);
    if (def.installBlocked) throw new Error(`${id}: ${def.installBlocked}`);
    if (def.recipe === 'ssh-deb-bundle') return this.installSshBundle();
    if (def.recipe === 'ffmpeg-static') return this.installFfmpegStatic();
    const existing = this.installs.get(id);
    if (existing?.state === 'running') return existing;

    const record: InstallRecord = { id, startedAt: Date.now(), state: 'running', log: '' };
    this.installs.set(id, record);
    void this.runRecipe(def, record).catch((err) => {
      record.state = 'failed';
      record.finishedAt = Date.now();
      record.log += `\n${String((err as Error)?.message ?? err)}`;
      this.persistRecord(record);
    });
    return record;
  }

  private persistRecord(record: InstallRecord): void {
    const kept = this.readState().filter((r) => r.id !== record.id);
    this.writeState([...kept, record]);
  }

  private async runRecipe(def: ToolDef, record: InstallRecord): Promise<void> {
    const onOutput = (chunk: string): void => {
      record.log = (record.log + chunk).slice(-4_000);
    };
    const bin = toolsPath();
    mkdirSync(bin, { recursive: true });

    if (!existsSync(bin)) throw new Error(`cannot create ${bin}`);

    try {
      if (def.recipe === 'gh-tarball') {
        // A release tarball, unpacked under our own directory: no root, no image rebuild.
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const version = '2.62.0';
        const url = `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_${arch}.tar.gz`;
        const archive = join(this.dir, 'gh.tgz');
        const script =
          `set -e; curl -sSL --max-time 300 -o ${archive} ${url}; ` +
          `rm -rf ${join(this.dir, 'gh-extract')}; mkdir -p ${join(this.dir, 'gh-extract')}; ` +
          `tar xzf ${archive} -C ${join(this.dir, 'gh-extract')}; ` +
          `cp ${join(this.dir, 'gh-extract', `gh_${version}_linux_${arch}`, 'bin', 'gh')} ${join(bin, 'gh')}; ` +
          `rm -rf ${archive} ${join(this.dir, 'gh-extract')}; ` +
          `test -x ${join(bin, 'gh')} && ${join(bin, 'gh')} --version`;
        await this.execOrThrow(script, { timeoutMs: 420_000, onOutput }, 'gh');
      } else if (def.recipe === 'az-venv') {
        // az is a Python application: a venv of its own, so pip never touches the system python.
        // `python3 -m venv` here has no ensurepip (no python3-venv in the image): the venv is made
        // without pip and get-pip.py seeds it. Measured in the container — a plain `python3 -m venv`
        // fails at ensurepip, which is why this is not the obvious one-liner.
        const venv = join(this.dir, 'az');
        const pipBoot = join(this.dir, 'get-pip.py');
        const script =
          `set -e; rm -rf ${venv}; python3 -m venv --without-pip ${venv}; ` +
          `curl -sSL --max-time 120 -o ${pipBoot} https://bootstrap.pypa.io/get-pip.py; ` +
          `${join(venv, 'bin', 'python3')} ${pipBoot} --quiet; ` +
          `${join(venv, 'bin', 'pip')} install --quiet --disable-pip-version-check azure-cli; ` +
          `ln -sf ${join(venv, 'bin', 'az')} ${join(bin, 'az')}; ` +
          `${join(bin, 'az')} version`;
        await this.execOrThrow(script, { timeoutMs: 1_500_000, onOutput }, 'az');
      } else {
        throw new Error('no recipe');
      }
      record.state = 'done';
    } catch (err) {
      record.state = 'failed';
      record.log = (record.log + `\n${String((err as Error)?.message ?? err)}`).slice(-4_000);
    } finally {
      record.finishedAt = Date.now();
      this.persistRecord(record);
    }
  }

  /**
   * ssh is the one tool apt owns on Debian — but the package needs no *dpkg*, only an unpacker.
   *
   * `dpkg-deb -x` extracts a .deb with no root and no database, and the client runs against the
   * host's shared libraries (measured in the container: every dependency is already there). The
   * binaries land in the daemon's own tools bin, which is what the argv lane already trusts.
   *
   * One pinned version, not "latest": the URL is the product here — apt cannot reach this container,
   * so the recipe is what reaches the archive.
   */
  private installSshBundle(): InstallRecord {
    const existing = this.installs.get('ssh');
    if (existing?.state === 'running') return existing;
    const record: InstallRecord = { id: 'ssh', startedAt: Date.now(), state: 'running', log: '' };
    this.installs.set('ssh', record);
    void this.runSshBundle(record).catch((err) => {
      record.state = 'failed';
      record.finishedAt = Date.now();
      record.log += `\n${String((err as Error)?.message ?? err)}`;
      this.persistRecord(record);
    });
    return record;
  }

  private async runSshBundle(record: InstallRecord): Promise<void> {
    const onOutput = (chunk: string): void => {
      record.log = (record.log + chunk).slice(-4_000);
    };
    const bin = toolsPath();
    mkdirSync(bin, { recursive: true });
    const version = '1:9.2p1-2+deb12u7';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const deb = `openssh-client_9.2p1-2+deb12u7_${arch}.deb`;
    const url = `http://deb.debian.org/debian/pool/main/o/openssh/${encodeURIComponent(deb)}`;
    const pkg = join(this.dir, deb);
    const root = join(this.dir, 'ssh-extract');
    const script =
      `set -e; command -v dpkg-deb >/dev/null || { echo 'dpkg-deb introuvable' >&2; exit 3; }; ` +
      `curl -sSL --max-time 120 -o ${pkg} '${url}'; ` +
      `rm -rf ${root}; mkdir -p ${root}; dpkg-deb -x ${pkg} ${root}; ` +
      `for b in ssh scp sftp ssh-keygen ssh-keyscan ssh-add ssh-agent; do ` +
      `cp ${join(root, 'usr', 'bin', '$b')} ${join(bin, '$b')}; done; ` +
      `rm -rf ${pkg} ${root}; ` +
      `test -x ${join(bin, 'ssh')} && ${join(bin, 'ssh')} -V`;
    try {
      await this.execOrThrow(script, { timeoutMs: 300_000, onOutput }, `ssh (${version})`);
      record.state = 'done';
    } catch (err) {
      record.state = 'failed';
      record.log = (record.log + `\n${String((err as Error)?.message ?? err)}`).slice(-4_000);
    } finally {
      record.finishedAt = Date.now();
      this.persistRecord(record);
    }
  }

  /**
   * ffmpeg is the tool apt owned that a *single file* answers: the `ffmpeg-static` releases publish
   * one gzipped arm64 binary, and the image has no `xz` (measured) but it does have python3's lzma
   * and gzip — so the download is a `.gz`, unpacked with the one decompressor we are sure of.
   *
   * No apt, no root, no rebuild: the binary lands in the tools bin, on the PATH the argv lane
   * already trusts, and survives a container upgrade like every other install here.
   */
  private installFfmpegStatic(): InstallRecord {
    const existing = this.installs.get('ffmpeg');
    if (existing?.state === 'running') return existing;
    const record: InstallRecord = { id: 'ffmpeg', startedAt: Date.now(), state: 'running', log: '' };
    this.installs.set('ffmpeg', record);
    void this.runFfmpegStatic(record).catch((err) => {
      record.state = 'failed';
      record.finishedAt = Date.now();
      record.log = (record.log + `\n${String((err as Error)?.message ?? err)}`).slice(-4_000);
      this.persistRecord(record);
    });
    return record;
  }

  private async runFfmpegStatic(record: InstallRecord): Promise<void> {
    const onOutput = (chunk: string): void => {
      record.log = (record.log + chunk).slice(-4_000);
    };
    const bin = toolsPath();
    mkdirSync(bin, { recursive: true });
    // The release names its assets per architecture; the container is arm64, and the x64 name is
    // there so a laptop install does not need a second recipe.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-${arch}.gz`;
    const gz = join(this.dir, 'ffmpeg.gz');
    const target = join(bin, 'ffmpeg');
    const script =
      `set -e; curl -sSL --max-time 600 -o ${gz} '${url}'; ` +
      `python3 -c "import gzip,shutil; i=gzip.open('${gz}','rb'); o=open('${target}','wb'); shutil.copyfileobj(i,o); i.close(); o.close()"; ` +
      `chmod 755 ${target}; rm -f ${gz}; ` +
      `test -x ${target} && ${target} -version | head -1`;
    try {
      await this.execOrThrow(script, { timeoutMs: 700_000, onOutput }, 'ffmpeg');
      record.state = 'done';
    } catch (err) {
      record.state = 'failed';
      record.log = (record.log + `\n${String((err as Error)?.message ?? err)}`).slice(-4_000);
    } finally {
      record.finishedAt = Date.now();
      this.persistRecord(record);
    }
  }

  /**
   * What a recipe put on disk — and the whole of what an uninstall may remove.
   *
   * Listed per tool rather than derived, because the two halves do not share a directory: the
   * binaries sit in `tools/bin` (the one dir on PATH) and the private trees (`az` venv, unpacked
   * archives) in `tools/`. Removing "everything under tools/" would take the *other* installed
   * tools with it.
   */
  private artifactsOf(id: string): { files: string[]; dirs: string[] } {
    switch (id) {
      case 'gh':
        return { files: ['gh'], dirs: ['gh-extract'] };
      case 'az':
        return { files: ['az'], dirs: ['az'] };
      case 'ssh':
        return { files: ['ssh', 'scp', 'sftp', 'ssh-keygen', 'ssh-keyscan', 'ssh-add', 'ssh-agent'], dirs: ['ssh-extract'] };
      case 'ffmpeg':
        return { files: ['ffmpeg'], dirs: [] };
      default:
        return { files: [], dirs: [] };
    }
  }

  /**
   * Removes a tool we installed, and only that.
   *
   * Refuses the tools the image ships: `git` is not installed *here*, and a "delete" that quietly
   * answers ok for it would be a button that lies — the binary is in `/usr/bin`, root owns it, and
   * the next container recreate puts it back anyway.
   */
  remove(id: string): { ok: true; removed: string[] } {
    const def = TOOL_CATALOG.find((t) => t.id === id);
    if (!def) throw new Error(`unknown tool: ${id}`);
    if (!def.recipe) throw new Error(`${id} is shipped with the image — there is nothing of ours to remove`);
    const running = this.installs.get(id);
    if (running?.state === 'running') throw new Error(`${id} is still installing — wait for it to finish`);

    const artifacts = this.artifactsOf(id);
    const removed: string[] = [];
    for (const name of artifacts.files) {
      // Relative to *this* instance's dir, not the module-level one: the daemon and a test both
      // pass a directory, and an uninstall that deleted from `~/.mercury/tools` while the list it
      // was drawn from pointed elsewhere would be the worst kind of "worked on my machine".
      const path = join(this.dir, 'bin', name);
      if (existsSync(path)) {
        rmSync(path, { force: true, recursive: true });
        removed.push(path);
      }
    }
    for (const name of artifacts.dirs) {
      const path = join(this.dir, name);
      if (existsSync(path)) {
        rmSync(path, { force: true, recursive: true });
        removed.push(path);
      }
    }
    if (removed.length === 0) throw new Error(`${id} is not installed`);

    this.installs.delete(id);
    const record: InstallRecord = {
      id,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      state: 'removed',
      log: `removed ${removed.length} path(s): ${removed.join(', ')}`.slice(0, 1_000),
    };
    this.persistRecord(record);
    return { ok: true, removed };
  }

  private async execOrThrow(script: string, opts: { timeoutMs: number; onOutput: (c: string) => void }, label: string): Promise<void> {
    const result = await this.run(['sh', '-c', script], opts);
    if (result.code !== 0) {
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
      throw new Error(`${label} install failed (exit ${result.code}): ${tail}`.slice(0, 300));
    }
  }

  installStatus(id: string): InstallRecord | undefined {
    const live = this.installs.get(id);
    if (live) return live;
    return this.readState().filter((r) => r.id === id).at(-1);
  }

  history(): InstallRecord[] {
    return this.readState();
  }

  /**
   * Starts a device flow and hands back the code the owner has to type.
   *
   * `gh auth login --web` and `az login --use-device-code` both print a code and then poll until the
   * grant lands; the child is left running and its output is scraped for the pair (code, URL). The
   * flow ends by itself, so nothing has to be kept alive by the phone.
   */
  async connect(id: string): Promise<ConnectFlow> {
    const def = TOOL_CATALOG.find((t) => t.id === id);
    if (!def) throw new Error(`unknown tool: ${id}`);
    if (!def.auth) throw new Error(`${id} has no sign-in`);
    const running = this.flows.get(id);
    if (running?.state === 'pending' && Date.now() - running.startedAt < 900_000) return running;

    const flow: ConnectFlow = { id, state: 'pending', code: '', url: '', startedAt: Date.now(), detail: '' };
    this.flows.set(id, flow);

    const child = this.spawn(def.auth.login[0]!, def.auth.login.slice(1), {
      env: { ...process.env, PATH: toolsPath() + ':' + (process.env.PATH ?? ''), GH_PROMPT_DISABLED: '', BROWSER: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const scrape = (chunk: string): void => {
      const text = flow.detail + chunk;
      flow.detail = text.slice(-2_000);
      const code = def.auth!.code.exec(text);
      if (code?.[1]) flow.code = code[1];
      const url = def.auth!.url.exec(text);
      if (url?.[1]) flow.url = url[1];
    };
    child.stdout?.on('data', (d: Buffer) => scrape(d.toString()));
    child.stderr?.on('data', (d: Buffer) => scrape(d.toString()));
    child.on('close', (code) => {
      flow.state = code === 0 ? 'connected' : flow.code ? 'failed' : 'failed';
      if (code !== 0) flow.detail = (flow.detail + `\nexit ${code}`).slice(-2_000);
    });
    child.on('error', (err) => {
      flow.state = 'failed';
      flow.detail = String((err as Error)?.message ?? err);
    });

    // Give the child a moment to print the code before answering the phone.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !flow.code) await new Promise((r) => setTimeout(r, 200));
    if (!flow.code) flow.url = flow.url || '';
    return flow;
  }

  connectStatus(id: string): ConnectFlow | undefined {
    return this.flows.get(id);
  }
}
