import { describe, expect, it, vi } from 'vitest';
import { handleCompactCommand } from './compact-command.js';

function fakeAgent(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ text: string; channel: string }> = [];
  const channel = { send: async (text: string, channel: string) => { sent.push({ text, channel }); } };
  const agent = {
    channels: { getChannelForMessage: () => channel },
    sessions: { getOrCreateBound: () => ({ id: 'sess-1' }) },
    contextSnapshot: () => ({
      enabled: true, saverActive: false, budget: 200_000,
      historyTokens: 60_000, viewTokens: 40_000, needsCompression: false,
      cuts: 1, archivedTurns: 5,
    }),
    compressSessionContext: async () => ({ outcome: 'cut', report: { beforeTokens: 40_000, afterTokens: 20_000, removedTurns: 3 } }),
    isBusyWith: () => false,
    setKeeperEnabled: vi.fn(),
    ...overrides,
  };
  return { agent, sent };
}

const msg = (content: string) => ({
  id: 'm1', channelId: 'web:default', channelType: 'web', senderId: 'u', senderName: 'You',
  content, timestamp: Date.now(),
}) as never;

describe('/compact', () => {
  it('shows the gauge with the fill percentage', async () => {
    const { agent, sent } = fakeAgent();
    await handleCompactCommand(agent as never, msg('/compact'));
    expect(sent[0].text).toContain('40,000 / 200,000');
    expect(sent[0].text).toContain('20%');
    expect(sent[0].text).toContain('Keeper: on');
  });

  it('warns when the next turn would compress on its own', async () => {
    const { agent, sent } = fakeAgent({
      contextSnapshot: () => ({
        enabled: true, saverActive: false, budget: 100, historyTokens: 300, viewTokens: 250,
        needsCompression: true, cuts: 0, archivedTurns: 0,
      }),
    });
    await handleCompactCommand(agent as never, msg('/compact'));
    expect(sent[0].text).toContain('next turn compresses');
  });

  it('compresses on /compact now and reports the cut', async () => {
    const { agent, sent } = fakeAgent();
    await handleCompactCommand(agent as never, msg('/compact now'));
    expect(sent[0].text).toContain('40,000 → 20,000');
    expect(sent[0].text).toContain('3 turns archived');
  });

  it('refuses to cut while the conversation is working', async () => {
    const { agent, sent } = fakeAgent({ isBusyWith: () => true });
    await handleCompactCommand(agent as never, msg('/compact now'));
    expect(sent[0].text).toContain('stop');
  });

  it('says so when there is nothing to compress', async () => {
    const { agent, sent } = fakeAgent({ compressSessionContext: async () => ({ outcome: 'fits' }) });
    await handleCompactCommand(agent as never, msg('/compact now'));
    expect(sent[0].text).toContain('Nothing to compress');
  });

  it('flips the keeper switch', async () => {
    const { agent, sent } = fakeAgent();
    await handleCompactCommand(agent as never, msg('/compact off'));
    expect(agent.setKeeperEnabled).toHaveBeenCalledWith(false);
    expect(sent[0].text).toContain('off');
  });
});
