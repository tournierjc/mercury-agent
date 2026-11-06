import { describe, expect, it, vi } from 'vitest';
import { answerBotSlashCommand, answerCompactForBot } from './bot-slash.js';

/**
 * Slash commands in a bot conversation are answered by the daemon, not by a
 * bot turn: the bot's context is fresh every run, so only the agent's keeper
 * state holds a real gauge. The hook must answer recognized commands into the
 * thread and let everything else fall through to the model.
 */

const agentStub = (overrides: Partial<Record<string, any>> = {}) => ({
  setKeeperEnabled: vi.fn(),
  isBusyWith: vi.fn(() => false),
  compressSessionContext: vi.fn(async () => ({ outcome: 'fits' as const, report: undefined })),
  contextSnapshot: vi.fn(() => ({
    enabled: true, saverActive: false, budget: 200_000,
    historyTokens: 74_000, viewTokens: 74_000, needsCompression: false,
    cuts: 0, archivedTurns: 0,
  })),
  sessions: {
    getByBinding: vi.fn(() => ({ id: 'sess-bot-1' })),
    getOrCreateBound: vi.fn(() => ({ id: 'sess-bot-1' })),
  },
  ...overrides,
}) as any;

const managerStub = (names: string[] = ['smith'], historyTokens = 0) => ({
  resolveBotId: (id: string) => (names.includes(id) ? id : null),
  notifyBotThread: vi.fn(async (_botId: string, _message: string) => {}),
  threadHistoryTokens: vi.fn(() => ({ tokens: historyTokens, turns: historyTokens ? 3 : 0 })),
}) as any;

describe('answerBotSlashCommand', () => {
  it('answers /compact with the thread session gauge', async () => {
    const agent = agentStub();
    const deliver = vi.fn(async (_m: string) => {});
    const answered = await answerBotSlashCommand(agent, managerStub(), 'smith', '/compact', deliver);
    expect(answered).toBe(true);
    expect(agent.sessions.getByBinding).toHaveBeenCalledWith('cli', 'bot:smith');
    expect(agent.contextSnapshot).toHaveBeenCalledWith('sess-bot-1');
    const text = deliver.mock.calls[0][0] as string;
    expect(text).toContain('74,000 / 200,000');
    expect(text).toContain('37%');
  });

  it('forces a cut on /compact now', async () => {
    const agent = agentStub({
      compressSessionContext: vi.fn(async () => ({
        outcome: 'cut',
        report: { beforeTokens: 190_000, afterTokens: 60_000, removedTurns: 12 },
      })),
    });
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agent, managerStub(), 'smith', '/compact now', deliver)).toBe(true);
    expect(agent.compressSessionContext).toHaveBeenCalledWith('sess-bot-1');
    expect(deliver.mock.calls[0][0]).toContain('Compressed');
  });

  it('the keeper switch answers without touching a session', async () => {
    const agent = agentStub();
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agent, managerStub(), 'smith', '/compact off', deliver)).toBe(true);
    expect(agent.setKeeperEnabled).toHaveBeenCalledWith(false);
    expect(agent.sessions.getByBinding).not.toHaveBeenCalled();
  });

  it('/help lists the answered commands', async () => {
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub(), 'smith', '/help', deliver)).toBe(true);
    expect(deliver.mock.calls[0][0]).toContain('/compact');
  });

  it('unknown slash commands fall through to the turn', async () => {
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub(), 'smith', '/bots list', deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a plain message is never answered here', async () => {
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub(), 'smith', 'digest stp', deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a sessionless thread (a bot: turns run fresh) reads the durable history', async () => {
    // An empty session — historyTokens 0 — is what a bot thread really is.
    const emptySession = {
      enabled: true, saverActive: false, budget: 200_000,
      historyTokens: 0, viewTokens: 0, needsCompression: false,
      cuts: 0, archivedTurns: 0,
    };
    const agent = agentStub({
      contextSnapshot: vi.fn(() => emptySession),
      sessions: { getByBinding: vi.fn(() => null), getOrCreateBound: vi.fn(() => ({ id: 'x' })) },
    });
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agent, managerStub(['smith'], 12_500), 'smith', '/compact', deliver)).toBe(true);
    expect(deliver.mock.calls[0][0]).toContain('12,500 tokens across 3 turns');
    expect(deliver.mock.calls[0][0]).toContain('fresh context');
  });

  it('a sessionless thread with no history says so plainly', async () => {
    const agent = agentStub({
      contextSnapshot: vi.fn(() => ({
        enabled: true, saverActive: false, budget: 200_000,
        historyTokens: 0, viewTokens: 0, needsCompression: false,
        cuts: 0, archivedTurns: 0,
      })),
      sessions: { getByBinding: vi.fn(() => null), getOrCreateBound: vi.fn(() => ({ id: 'x' })) },
    });
    const deliver = vi.fn(async (_m: string) => {});
    expect(await answerBotSlashCommand(agent, managerStub(), 'smith', '/compact', deliver)).toBe(true);
    // No durable history either: the plain gauge, no per-turn claim.
    expect(deliver.mock.calls[0][0]).toContain('Context: 0');
    expect(deliver.mock.calls[0][0]).not.toMatch(/across \d+ turns/);
  });
});

describe('answerCompactForBot', () => {
  it('/compact <bot> answers with that bot gauge, to its thread and the requester', async () => {
    const agent = agentStub();
    const manager = managerStub(['smith', 'watcher']);
    expect(await answerCompactForBot(agent, manager, 'smith', '/compact watcher')).toBe(true);
    const [targetThread, gauge] = manager.notifyBotThread.mock.calls[0];
    expect(targetThread).toBe('watcher');
    expect(gauge).toContain('37%');
    const [requester, echoed] = manager.notifyBotThread.mock.calls[1];
    expect(requester).toBe('smith');
    expect(echoed).toContain('/compact watcher');
  });

  it('a target that is not a bot is a task, not a command', async () => {
    const manager = managerStub(['smith']);
    expect(await answerCompactForBot(agentStub(), manager, 'smith', '/compact le rapport svp')).toBe(false);
    expect(manager.notifyBotThread).not.toHaveBeenCalled();
  });

  it('an unknown sub-argument stays a task', async () => {
    const manager = managerStub(['smith', 'watcher']);
    expect(await answerCompactForBot(agentStub(), manager, 'smith', '/compact watcher xyz')).toBe(false);
  });

  it('/compact <bot> now cuts that bot session', async () => {
    const agent = agentStub({
      compressSessionContext: vi.fn(async () => ({
        outcome: 'cut',
        report: { beforeTokens: 190_000, afterTokens: 40_000, removedTurns: 9 },
      })),
    });
    const manager = managerStub(['smith', 'watcher']);
    expect(await answerCompactForBot(agent, manager, 'smith', '/compact watcher now')).toBe(true);
    expect(agent.compressSessionContext).toHaveBeenCalledWith('sess-bot-1');
  });
});
