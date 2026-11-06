import { describe, expect, it, vi } from 'vitest';
import { answerBotSlashCommand } from './bot-slash.js';

/**
 * Slash commands in a bot thread are answered by the daemon, not by a bot
 * turn: the bot's context is fresh every run, so only the agent's keeper
 * state holds a real gauge. The manager hook must answer recognized commands
 * into the thread and let everything else fall through to the model.
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
  sessions: { getByBinding: vi.fn(() => ({ id: 'sess-bot-1' })) },
  ...overrides,
}) as any;

const managerStub = {} as any;

describe('answerBotSlashCommand', () => {
  it('answers /compact with the thread session gauge', async () => {
    const agent = agentStub();
    const deliver = vi.fn(async () => {});
    const answered = await answerBotSlashCommand(agent, managerStub, 'smith', '/compact', deliver);
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
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agent, managerStub, 'smith', '/compact now', deliver)).toBe(true);
    expect(agent.compressSessionContext).toHaveBeenCalledWith('sess-bot-1');
    expect(deliver.mock.calls[0][0]).toContain('Compressed');
  });

  it('the keeper switch answers without touching a session', async () => {
    const agent = agentStub();
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agent, managerStub, 'smith', '/compact off', deliver)).toBe(true);
    expect(agent.setKeeperEnabled).toHaveBeenCalledWith(false);
    expect(agent.sessions.getByBinding).not.toHaveBeenCalled();
  });

  it('/help lists the bot-thread commands', async () => {
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub, 'smith', '/help', deliver)).toBe(true);
    expect(deliver.mock.calls[0][0]).toContain('/compact');
  });

  it('unknown slash commands fall through to the turn', async () => {
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub, 'smith', '/bots list', deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a plain message is never answered here', async () => {
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agentStub(), managerStub, 'smith', 'digest stp', deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('an empty thread answers instead of crashing', async () => {
    const agent = agentStub({ sessions: { getByBinding: vi.fn(() => null) } });
    const deliver = vi.fn(async () => {});
    expect(await answerBotSlashCommand(agent, managerStub, 'smith', '/compact', deliver)).toBe(true);
    expect(deliver.mock.calls[0][0]).toContain('No context recorded');
  });
});
