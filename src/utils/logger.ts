import pino from 'pino';
import { redactDeep } from './redact.js';

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const level = (process.env.LOG_LEVEL || (verbose ? 'info' : 'silent')) as pino.Level;

/**
 * Error serializer: provider errors carry response bodies that embed API-key
 * fragments — those must never reach persistent logs unredacted.
 */
const redactedError = (err: unknown): unknown => redactDeep(err);

/**
 * Where the logs go.
 *
 * stderr is the default and the right one for a foreground process; a daemon that forks closes its
 * stdio, so `docker logs` shows nothing and a provider failure 200 steps into a turn leaves no
 * trace to read afterwards. `MERCURY_LOG_FILE` adds a file next to the data dir for that case —
 * opt-in, because a log nobody rotates is a disk-hygiene problem of its own.
 */
const file = process.env.MERCURY_LOG_FILE;
const streams: pino.StreamEntry[] = [{ level, stream: pino.destination(2) }];
if (file) {
  try {
    streams.push({ level, stream: pino.destination({ dest: file, mkdir: true, sync: false }) });
  } catch (err) {
    // A log file that cannot be opened must not stop the daemon: say it on stderr, keep running.
    process.stderr.write(`mercury: cannot open MERCURY_LOG_FILE=${file}: ${(err as Error)?.message}\n`);
  }
}

export const logger = pino({
  level,
  name: 'mercury',
  serializers: {
    err: redactedError,
    error: redactedError,
  },
}, streams.length > 1 ? pino.multistream(streams) : streams[0].stream);
