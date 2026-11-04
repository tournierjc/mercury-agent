import { describe, expect, it } from 'vitest';
import { getDefaultConfig, isProviderConfigured } from '../utils/config.js';
import { createProvider } from './registry.js';
import { OpenAICompatProvider } from './openai-compat.js';

/**
 * OpenRouter was simply absent from Mercury's provider list: no union member, no default entry, no
 * route name. The app could not show it because the daemon never had it — the phone was telling the
 * truth. These cases pin the three halves that make it real: a default with the gateway's base URL,
 * the compatibility client, and the "configured" rule that decides whether it may be used.
 */
describe('OpenRouter provider', () => {
  it('ships a default entry pointing at the gateway', () => {
    const provider = getDefaultConfig().providers.openrouter;

    expect(provider.name).toBe('openrouter');
    expect(provider.baseUrl).toBe('https://openrouter.ai/api/v1');
    // Off until a key is given: an empty key would otherwise fail every turn.
    expect(provider.enabled).toBe(false);
  });

  it('rides the OpenAI-compatible client — one key, many vendors', async () => {
    const provider = await createProvider({
      name: 'openrouter',
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      enabled: true,
    });

    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it('is usable only once a key is set', () => {
    const base = { name: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', model: 'm' };

    expect(isProviderConfigured({ ...base, apiKey: 'sk-or-test', enabled: true })).toBe(true);
    expect(isProviderConfigured({ ...base, apiKey: '', enabled: true })).toBe(false);
    expect(isProviderConfigured({ ...base, apiKey: 'sk-or-test', enabled: false })).toBe(false);
  });
});
