import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, providerTransport } from './openai-compat.js';
import type { ProviderConfig } from '../utils/config.js';

/**
 * Which client an endpoint is reached through.
 *
 * The default matters more than the option: every provider here used OpenAI's own
 * client until now, and this change must not move any of them silently. The
 * `compatible` case is the one that carries a server's `reasoning_content` as
 * stream parts — the difference the agent and the bot turn record thinking from.
 */
function config(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'openaiCompat',
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:8083/v1',
    model: 'qwen3.8-flash-next',
    enabled: true,
    ...over,
  };
}

describe('providerTransport', () => {
  it('is OpenAI\'s own client when the config says nothing', () => {
    expect(providerTransport(config())).toBe('openai');
  });

  it('takes the compatible client when asked', () => {
    expect(providerTransport(config({ transport: 'compatible' }))).toBe('compatible');
  });

  it('refuses a word that is neither, instead of quietly using the default', () => {
    // A typo must not look like "this endpoint simply has no thinking to give".
    expect(() => providerTransport(config({ transport: 'compat' as never }))).toThrow(
      /transport "compat" is not one of "openai", "compatible"/,
    );
  });
});

describe('OpenAICompatProvider', () => {
  it('reaches the endpoint through the OpenAI client by default', () => {
    const provider = new OpenAICompatProvider(config());

    expect(provider.transport).toBe('openai');
    expect((provider.getModelInstance() as { provider: string }).provider).toBe('openai.responses');
  });

  it('reaches it through the compatible client when the transport asks for it', () => {
    const provider = new OpenAICompatProvider(config({ transport: 'compatible' }));

    expect(provider.transport).toBe('compatible');
    expect((provider.getModelInstance() as { provider: string }).provider).toBe('openaiCompat.chat');
  });

  it('names the model after the provider, so a stream says who answered', () => {
    const provider = new OpenAICompatProvider(config({ name: 'litellm', transport: 'compatible' }));

    expect((provider.getModelInstance() as { provider: string }).provider).toBe('litellm.chat');
  });

  it('leaves every other endpoint on the client it already used', () => {
    for (const name of ['lmStudio', 'litellm', 'atlascloud', 'ollamaCloud']) {
      expect(new OpenAICompatProvider(config({ name })).transport).toBe('openai');
    }
  });

  it('refuses an unknown transport before any request is made', () => {
    expect(() => new OpenAICompatProvider(config({ transport: 'openai-compatible' as never }))).toThrow(
      /is not one of "openai", "compatible"/,
    );
  });
});
