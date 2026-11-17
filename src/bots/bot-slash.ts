/**
 * Slash commands answered for the fleet, by the daemon.
 *
 * A message typed into a bot's conversation is enqueued as a job and runs as
 * a bot turn — right for everything the model should do, wrong for a slash
 * command: `/compact` has a deterministic answer kept by the daemon's keeper,
 * and the bot's own context is fresh every run, so "I have no compaction
 * tool" was the *honest* answer it could give. Two entry points, one truth:
 *
 * - answerBotSlashCommand: recognized commands typed into a bot's own thread
 *   are answered before the job exists (the gauge reads that thread's
 *   session, `cli` / `bot:<id>` — the binding the transcript uses).
 * - answerCompactForBot: typing `/compact <bot> [now|on|off]` — from any
 *   surface — gets the daemon's reading for that bot, delivered to the
 *   target's thread and back to the requester.
 *
 * Anything else falls through to the model untouched: `/bots …` is a task for
 * the fleet tools, and a cron or mailbox prompt that happens to start with
 * "/" must reach the model, never be intercepted.
 */
import type { Agent } from '../core/agent.js';
import type { BotManager } from './bot-manager.js';
import { compactGaugeText } from '../core/commands/compact-command.js';

/**
 * The slash vocabulary the daemon answers inside a bot conversation — the
 * subset of the command list that has a deterministic answer there. Kept in
 * sync with the matchers below; the turn prompt advertises it verbatim.
 */
export const BOT_SLASH_HINTS: ReadonlyArray<[string, string]> = [
  ['/compact', "the daemon's context gauge for this conversation"],
  ['/compact now', "force the daemon's keeper cut on this conversation"],
  ['/compact on|off', "the daemon's context keeper switch"],
  ['/compact <bot> [now|on|off]', "the daemon's reading for another bot's conversation"],
];

/**
 * Answer `text` if it is a slash command this thread owns; return false when
 * the message should run as a normal bot turn. `deliver` writes to the bot's
 * thread (and any remote surface the message came from).
 */
export async function answerBotSlashCommand(
  agent: Agent,
  manager: BotManager,
  botId: string,
  text: string,
  deliver: (message: string) => Promise<void>,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  if (trimmed === '/help' || trimmed === '/commands') {
    const lines = ['**Commands answered in a bot conversation:**', ...BOT_SLASH_HINTS.map(([cmd, what]) => `- \`${cmd}\` — ${what}`)];
    lines.push('', 'Everything else runs as a turn, as usual. `/bots …` stays a task for the fleet tools.');
    await deliver(lines.join('\n'));
    return true;
  }

  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const sub = trimmed.replace(/^\/compact\b/, '').trim().toLowerCase();

    // `/compact <other-bot> …` targets the fleet, not this thread.
    if (sub && !/^(now|force|on|off)$/.test(sub)) {
      return answerCompactForBot(agent, manager, botId, trimmed);
    }

    if (sub === 'on' || sub === 'off') {
      agent.setKeeperEnabled(sub === 'on');
      await deliver(sub === 'on'
        ? 'Context keeper on — history is kept by notes + archive instead of dropped.'
        : 'Context keeper off — the plain window is back.');
      return true;
    }

    // The bot's own thread session — the binding the transcript uses. A bot
    // that has never been through the main loop has no session there (its
    // turns run in runBotTurn, outside the session store): the gauge then
    // reads the bot's real conversation history, kept on disk per bot.
    const session = agent.sessions.getByBinding('cli', `bot:${botId}`)
      ?? agent.sessions.getOrCreateBound('cli' as never, `bot:${botId}`, undefined);

    if (sub === 'now' || sub === 'force') {
      if (agent.isBusyWith(session.id)) {
        await deliver('This thread is still working — stop it first, then `/compact now`.');
        return true;
      }
      const { outcome, report } = await agent.compressSessionContext(session.id);
      await deliver(outcome === 'cut' && report
        ? `Compressed: ${report.beforeTokens.toLocaleString()} → ${report.afterTokens.toLocaleString()} tokens (${report.removedTurns} turns archived, verbatim).`
        : outcome === 'fits'
          ? 'Nothing to compress — this thread still fits the context.'
          : outcome === 'too_short'
            ? 'This thread is too short to compress.'
            : 'The notes were rejected, so nothing was cut — the history was kept verbatim.');
      return true;
    }

    await deliver(await compactGaugeText(agent, session.id, () => manager.threadHistoryTokens(botId)));
    return true;
  }

  return false;
}

/**
 * `/compact <bot> [now|on|off]` from any surface: the daemon answers for the
 * named bot, its gauge delivered to that bot's thread and back to whoever
 * asked. Returns false when the target is not a bot of the fleet and no
 * subcommand applies — then the text was a task, not a command, and the turn
 * runs with it.
 */
export async function answerCompactForBot(
  agent: Agent,
  manager: BotManager,
  requesterBotId: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!/^\/compact\b/.test(trimmed)) return false;
  const rest = trimmed.replace(/^\/compact\b/, '').trim();
  const [targetRaw, ...subParts] = rest.split(/\s+/);
  if (!targetRaw) return false;
  const botId = manager.resolveBotId(targetRaw.toLowerCase());
  if (!botId) return false; // not a bot of the fleet: the text is the task
  const sub = subParts.join(' ').trim().toLowerCase();
  if (sub && !/^(now|force|on|off)$/.test(sub)) return false; // unknown argument = task text

  const deliver = async (message: string): Promise<void> => {
    await manager.notifyBotThread(botId, message);
    if (requesterBotId !== botId) {
      await manager.notifyBotThread(requesterBotId, `**/compact ${targetRaw}** → ${message}`);
    }
  };

  if (sub === 'on' || sub === 'off') {
    agent.setKeeperEnabled(sub === 'on');
    await deliver(sub === 'on'
      ? 'Context keeper on — history is kept by notes + archive instead of dropped.'
      : 'Context keeper off — the plain window is back.');
    return true;
  }

  if (sub === 'now' || sub === 'force') {
    const session = agent.sessions.getByBinding('cli', `bot:${botId}`)
      ?? agent.sessions.getOrCreateBound('cli' as never, `bot:${botId}`, undefined);
    if (agent.isBusyWith(session.id)) {
      await deliver(`${botId} is still working — stop it first, then try again.`);
      return true;
    }
    const { outcome, report } = await agent.compressSessionContext(session.id);
    await deliver(outcome === 'cut' && report
      ? `Compressed: ${report.beforeTokens.toLocaleString()} → ${report.afterTokens.toLocaleString()} tokens (${report.removedTurns} turns archived, verbatim).`
      : outcome === 'fits'
        ? 'Nothing to compress — this bot still fits the context.'
        : outcome === 'too_short'
          ? 'This bot is too short to compress.'
          : 'The notes were rejected, so nothing was cut — the history was kept verbatim.');
    return true;
  }

  const session = agent.sessions.getOrCreateBound('cli' as never, `bot:${botId}`, undefined);
  await deliver(await compactGaugeText(agent, session.id, () => manager.threadHistoryTokens(botId)));
  return true;
}
