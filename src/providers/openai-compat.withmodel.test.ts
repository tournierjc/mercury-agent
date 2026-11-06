import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from './openai-compat';
import type { ProviderConfig } from '../utils/config';

const base: ProviderConfig = {
  name: 'openaiCompat',
  apiKey: 'test',
  baseUrl: 'http://127.0.0.1:8083/v1',
  model: 'qwen3.8-flash-next',
  enabled: true,
  vision: true,
  transport: 'compatible',
} as ProviderConfig;

describe('OpenAICompatProvider.withModel', () => {
  it('answers as the named slug, not the configured one', () => {
    const p = new OpenAICompatProvider(base);
    const q = p.withModel('other-model');
    expect(q.getModel()).toBe('other-model');
    // The original is untouched — the clone is a copy of the endpoint, not a mutation.
    expect(p.getModel()).toBe('qwen3.8-flash-next');
    expect(q.name).toBe(p.name);
    expect(q.transport).toBe(p.transport);
  });

  it('keeps speaking through the same transport', () => {
    const p = new OpenAICompatProvider(base);
    const q = p.withModel('other-model');
    // The compat client is chosen by transport; a clone of a `compatible`
    // endpoint must not silently switch to the OpenAI client.
    expect(q.transport).toBe('compatible');
    // A model instance exists (the SDK's language model for the new slug).
    expect(q.getModelInstance()).toBeTruthy();
  });
});
