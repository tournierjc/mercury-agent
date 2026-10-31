import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config.js';

/**
 * The environment half of the per-endpoint transport.
 *
 * `transport: compatible` is how an owner says "this endpoint sends its thinking
 * as `reasoning_content`" without editing the YAML. Every other endpoint must stay
 * on OpenAI's client, and a misspelled value must fail loudly — silently falling
 * back to the default is exactly the bug this option exists to fix.
 */
const TRANSPORT_KEYS = [
  'OPENAI_COMPAT_TRANSPORT',
  'LM_STUDIO_TRANSPORT',
  'LITELLM_TRANSPORT',
  'ATLASCLOUD_TRANSPORT',
  'OLLAMA_CLOUD_TRANSPORT',
  'OLLAMA_LOCAL_TRANSPORT',
  'ATOMIC_CHAT_TRANSPORT',
];

afterEach(() => {
  for (const key of TRANSPORT_KEYS) delete process.env[key];
});

describe('provider transports', () => {
  it('are unset by default, so every endpoint keeps the client it had', () => {
    const providers = getDefaultConfig().providers;

    for (const name of ['openaiCompat', 'lmStudio', 'litellm', 'atlascloud', 'ollamaCloud'] as const) {
      expect(providers[name].transport).toBeUndefined();
    }
  });

  it('are read from the provider\'s own variable', () => {
    process.env.OPENAI_COMPAT_TRANSPORT = 'compatible';
    process.env.LITELLM_TRANSPORT = 'openai';

    const providers = getDefaultConfig().providers;

    expect(providers.openaiCompat.transport).toBe('compatible');
    expect(providers.litellm.transport).toBe('openai');
    // One provider's choice does not move another's.
    expect(providers.lmStudio.transport).toBeUndefined();
  });

  it('ignore the case and the surrounding spaces an .env file may carry', () => {
    process.env.OPENAI_COMPAT_TRANSPORT = ' Compatible ';

    expect(getDefaultConfig().providers.openaiCompat.transport).toBe('compatible');
  });

  it('refuse a value that is neither, naming the variable', () => {
    process.env.OPENAI_COMPAT_TRANSPORT = 'compat';

    expect(() => getDefaultConfig()).toThrow(/OPENAI_COMPAT_TRANSPORT="compat" — expected "openai" or "compatible"/);
  });
});
