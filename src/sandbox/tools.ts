import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export type ToolRecipe = 'gh-tarball' | 'az-venv' | 'apt';

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
    description: 'Requiert root (apt) — indisponible dans ce conteneur.',
    bin: 'ffmpeg',
    versionArgs: ['ffmpeg', '-version'],
    recipe: 'apt',
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
}

export interface InstallRecord {
  id: string;
  startedAt: number;
  finishedAt?: number;
  state: 'running' | 'done' | 'failed';
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
export { toolsDir, toolsPath } from './paths.js';

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
    const blocked = def.recipe === 'apt' ? 'Ce conteneur tourne en uid 1000 sans sudo : apt est impossible ici.' : '';
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      present,
      path: present ? found.stdout.trim().split('\n')[0]! : '',
      version,
      auth,
      authDetail,
      installable: Boolean(def.recipe) && def.recipe !== 'apt' && !present,
      installBlocked: def.recipe && !present ? blocked : '',
    };
  }

  /** Installs are minutes long on a phone connection: they are a job, not a request. */
  install(id: string): InstallRecord {
    const def = TOOL_CATALOG.find((t) => t.id === id);
    if (!def) throw new Error(`unknown tool: ${id}`);
    if (!def.recipe) throw new Error(`${id} is shipped with the image — nothing to install`);
    if (def.recipe === 'apt') throw new Error(`${id} needs root (apt) and this container runs as uid 1000`);
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
