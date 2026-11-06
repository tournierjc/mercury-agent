/**
 * Slash commands answered in a bot's own conversation.
 *
 * A message typed into a bot thread is enqueued as a job and runs as a bot
 * turn — that is right for everything the model should do, and wrong for a
 * slash command: `/compact` has a deterministic answer, and the bot has no
 * tool for it (its context is fresh every turn, so "I have no compaction
 * tool" was the *honest* answer it gave). The owner typing into a thread
 * should get the same catalog behaviour as typing into the main chat, so a
 * recognized command is answered here, before the job exists.
 *
 * The gauge and the cut read the bot's own thread session (`cli` / `bot:<id>`
 * — the same binding CLIChannel.send writes the transcript to), not the
 * main conversation. `/help` prints the subset a bot conversation actually
 * answers; anything else falls through to the turn unchanged.
 */
import type { Agent } from '../core/agent.js';
import type { BotManager } from './bot-manager.js';
import { compactGaugeText } from '../core/commands/compact-command.js';

/** The commands a bot thread answers directly, and their one-line help. */
export const BOT_SLASH_HELP: ReadonlyArray<[string, string]> = [
  ['/compact', 'context gauge for this thread — tokens used, keeper state'],
  ['/compact now', 'force a keeper cut on this thread now'],
  ['/compact on|off', 'the context keeper switch'],
  ['/help', 'this list'],
];

/**
 * Answer `text` if it is a slash command this thread owns; return null when
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

  if (trimmed === '/help' || trimmed === '/help bots' || trimmed === '/commands') {
    const lines = ['**Commands in a bot conversation:**', ...BOT_SLASH_HELP.map(([cmd, what]) => `- \`${cmd}\` — ${what}`)];
    lines.push('', 'Everything else runs as a turn, as usual.');
    await deliver(lines.join('\n'));
    return true;
  }

  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const sub = trimmed.replace(/^\/compact\b/, '').trim().toLowerCase();

    if (sub === 'on' || sub === 'off') {
      agent.setKeeperEnabled(sub === 'on');
      await deliver(sub === 'on'
        ? 'Context keeper on — history is kept by notes + archive instead of dropped.'
        : 'Context keeper off — the plain window is back.');
      return true;
    }

    // The bot's own thread session: the binding the transcript is written to.
    const session = agent.sessions.getByBinding('cli', `bot:${botId}`);
    if (!session) {
      await deliver('No context recorded for this thread yet — nothing to compact.');
      return true;
    }

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

    await deliver(await compactGaugeText(agent, session.id));
    return true;
  }

  return false;
}
