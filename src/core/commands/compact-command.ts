/**
 * The /compact command — the conversation's own handle on the context keeper.
 *
 * `/compact`          → the context gauge: what the model sees, how full it is
 * `/compact now`      → force a keeper cut through the same route the desktop
 *                       inspector uses (busy guard and the shrink gate included)
 * `/compact on|off`   → the keeper switch (GET/PUT /api/context are its HTTP twin)
 */
import type { Agent } from '../agent.js';
import type { ChannelMessage } from '../../types/channel.js';

function percent(view: number, budget: number): string {
  if (budget <= 0) return '?';
  return `${Math.round((view / budget) * 100)}%`;
}

function formatGauge(snapshot: {
  enabled: boolean; saverActive: boolean; budget: number;
  historyTokens: number; viewTokens: number; needsCompression: boolean;
  cuts: number; archivedTurns: number;
}): string {
  const lines = [
    `Context: ${snapshot.viewTokens.toLocaleString()} / ${snapshot.budget.toLocaleString()} tokens (${percent(snapshot.viewTokens, snapshot.budget)})`,
    `Keeper: ${snapshot.enabled ? 'on' : 'off'}${snapshot.saverActive ? ' (saver active)' : ''} · cuts: ${snapshot.cuts} · archived turns: ${snapshot.archivedTurns}`,
  ];
  if (snapshot.enabled && snapshot.historyTokens > snapshot.viewTokens) {
    lines.push(`Full history would cost ${snapshot.historyTokens.toLocaleString()} tokens — the keeper keeps ${snapshot.viewTokens.toLocaleString()}.`);
  }
  if (snapshot.needsCompression) lines.push('Over budget: the next turn compresses on its own. `/compact now` to do it this second.');
  return lines.join('\n');
}

/** The session this message's conversation answers to — the same binding the turn loop uses. */
function sessionForMessage(agent: Agent, msg: ChannelMessage): string {
  const supplied = msg.sessionId ?? (typeof msg.metadata?.sessionId === 'string' ? msg.metadata.sessionId : undefined);
  if (supplied) return supplied;
  const external = msg.channelType === 'cli'
    ? 'current'
    : typeof msg.metadata?.externalConversationId === 'string' ? msg.metadata.externalConversationId : msg.channelId;
  return agent.sessions.getOrCreateBound(msg.channelType as never, external, undefined).id;
}

/**
 * The gauge text for one conversation, shared by every surface that answers
 * `/compact`: the chat fast-path (handleCompactCommand) and the bot threads
 * (BotManager.answerSlashCommand), which have a thread to answer into instead
 * of a Channel.
 *
 * A bot conversation lives outside the session store (its turns run fresh in
 * runBotTurn), so the session's own history is empty by design. `botHistory`
 * supplies what the owner's thread actually costs, read from the bot's durable
 * transcripts — without it a bot gauge would read 0 and say "nothing to
 * compact" while a week of exchanges sits on disk.
 */
export async function compactGaugeText(
  agent: Agent,
  sessionId: string,
  botHistory?: () => { tokens: number; turns: number },
): Promise<string> {
  const snapshot = agent.contextSnapshot(sessionId);
  if (snapshot.historyTokens === 0 && botHistory) {
    const { tokens, turns } = botHistory();
    if (tokens > 0) {
      return [
        `Context: ${tokens.toLocaleString()} tokens across ${turns} turn${turns === 1 ? '' : 's'}`,
        `Keeper: ${snapshot.enabled ? 'on' : 'off'}${snapshot.saverActive ? ' (saver active)' : ''} · cuts: ${snapshot.cuts} · archived turns: ${snapshot.archivedTurns}`,
        'A bot answers each message from a fresh context plus its own notes and journal — this thread carries no window to compact.',
      ].join('\n');
    }
  }
  return formatGauge(snapshot);
}

export async function handleCompactCommand(agent: Agent, msg: ChannelMessage): Promise<void> {
  const channel = agent.channels.getChannelForMessage(msg);
  if (!channel) return;
  const sub = msg.content.trim().replace(/^\/compact\b/, '').trim().toLowerCase();
  const sessionId = sessionForMessage(agent, msg);

  if (sub === 'on' || sub === 'off') {
    agent.setKeeperEnabled(sub === 'on');
    await channel.send(sub === 'on'
      ? 'Context keeper on — history is kept by notes + archive instead of dropped.'
      : 'Context keeper off — the plain window is back.', msg.channelId);
    return;
  }

  if (sub === 'now' || sub === 'force') {
    if (agent.isBusyWith(sessionId)) {
      await channel.send('Mercury is still working on this conversation — stop it first (`/stop`), then `/compact now`.', msg.channelId);
      return;
    }
    const { outcome, report } = await agent.compressSessionContext(sessionId);
    if (outcome === 'cut' && report) {
      await channel.send(
        `Compressed: ${report.beforeTokens.toLocaleString()} → ${report.afterTokens.toLocaleString()} tokens (${report.removedTurns} turns archived, verbatim).`,
        msg.channelId,
      );
    } else {
      await channel.send(
        outcome === 'fits'
          ? 'Nothing to compress — the conversation still fits the context.'
          : outcome === 'too_short'
            ? 'The conversation is too short to compress.'
            : 'The notes were rejected, so nothing was cut — the history was kept verbatim.',
        msg.channelId,
      );
    }
    return;
  }

  const snapshot = agent.contextSnapshot(sessionId);
  await channel.send(formatGauge(snapshot), msg.channelId);
}
