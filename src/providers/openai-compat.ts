import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig, ProviderTransport } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';
import { aimlapiHeaders } from './aimlapi-attribution.js';
import { applyReasoningToBody, effectiveReasoning, providerHasReasoningControl } from '../utils/model-prefs.js';

/**
 * fetch that applies the user's reasoning level for the requested model.
 * Done on the wire because the AI SDK drops reasoningEffort for model ids it
 * doesn't recognise as reasoning models (every Ollama model, for one).
 */
function withReasoningPref(providerName: string): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        // Only levels this model accepts (e.g. never an effort for gpt-4o).
        const level = typeof body.model === 'string' ? effectiveReasoning(providerName, body.model) : undefined;
        if (level) {
          applyReasoningToBody(body, level);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch { /* not JSON — pass through */ }
    }
    return globalThis.fetch(input, init);
  };
}

/**
 * The client an endpoint is reached through.
 *
 * `openai` is the default and stays the default: it is what every provider here
 * already uses, and the two clients differ in more than thinking — tool calls and
 * multi-part messages are placed slightly differently.
 *
 * `compatible` exists because of a measured loss. OpenAI's own client reads the
 * `reasoning` field of OpenAI's API; a compatible server answers with
 * `reasoning_content`, which the client counts as reasoning tokens and drops. On
 * our local Qwen and on OpenRouter the stream carried zero reasoning parts while
 * the API reported 16 to 85 reasoning tokens. The agent (`core/agent.ts`) and the
 * bot turn (`bots/bot-turn.ts`) both record thinking from those parts, so with
 * `openai` the thinking was fetched, paid for, and thrown away.
 */
export function providerTransport(config: ProviderConfig): ProviderTransport {
  const transport = config.transport ?? 'openai';
  if (transport !== 'openai' && transport !== 'compatible') {
    throw new Error(
      `[${config.name}] transport "${String(config.transport)}" is not one of "openai", "compatible"`,
    );
  }
  return transport;
}

export class OpenAICompatProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  /** Which client this instance speaks through — read by the doctor and by tests. */
  readonly transport: ProviderTransport;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: LanguageModel;

  constructor(config: ProviderConfig, { useChatApi }: { useChatApi?: boolean } = {}) {
    super(config);
    this.name = config.name;
    this.model = config.model;
    this.transport = providerTransport(config);

    const headers = aimlapiHeaders(config.baseUrl);
    // Only providers with a reasoning control get the hook; the rest keep
    // the SDK's default fetch untouched.
    const fetchImpl = providerHasReasoningControl(config.name) ? withReasoningPref(config.name) : undefined;

    if (this.transport === 'compatible') {
      // The compatible client speaks Chat Completions only, so `useChatApi` has
      // nothing to choose here — that surface is what it is.
      const compatible = createOpenAICompatible({
        name: config.name,
        apiKey: config.apiKey || 'no-key',
        baseURL: config.baseUrl,
        headers,
        fetch: fetchImpl,
      });
      this.client = createOpenAI({ apiKey: config.apiKey || 'no-key', baseURL: config.baseUrl, headers, fetch: fetchImpl });
      this.modelInstance = compatible.chatModel(config.model);
      logger.debug({ provider: config.name, model: config.model }, 'openai-compatible transport');
      return;
    }

    this.client = createOpenAI({
      apiKey: config.apiKey || 'no-key',
      baseURL: config.baseUrl,
      // `undefined` for every host but AI/ML API's, so no other provider
      // reached through this class sends anything extra.
      headers: aimlapiHeaders(config.baseUrl),
      // Only providers with a reasoning control get the hook; the rest keep
      // the SDK's default fetch untouched.
      fetch: providerHasReasoningControl(config.name) ? withReasoningPref(config.name) : undefined,
    });
    this.modelInstance = useChatApi
      ? this.client.chat(config.model)
      : this.client(config.model);
  }

  private formatApiError(err: unknown): Error {
    if (err instanceof Error) {
      const msg = err.message || '';
      // Surface common HTTP error codes with actionable messages
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        return new Error(`[${this.name}] Authentication failed - check your API key or proxy credentials.`);
      }
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        return new Error(`[${this.name}] Model "${this.model}" not found - verify the model name and base URL.`);
      }
      if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many')) {
        return new Error(`[${this.name}] Rate limited - wait a moment before retrying.`);
      }
      return new Error(`[${this.name}] ${msg}`);
    }
    return new Error(`[${this.name}] Unknown error during API call.`);
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    try {
      const result = await generateText({
        model: this.modelInstance,
        system: systemPrompt,
        prompt,
      });

      return {
        text: result.text,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
        model: this.model,
        provider: this.name,
      };
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    try {
      const result = streamText({
        model: this.modelInstance,
        system: systemPrompt,
        prompt,
      });

      for await (const chunk of (await result).textStream) {
        yield { text: chunk, done: false };
      }
      yield { text: '', done: true };
    } catch (err) {
      throw this.formatApiError(err);
    }
  }

  isAvailable(): boolean {
    // LiteLLM proxies and local Ollama can run without an API key
    if (this.config.name === 'litellm' || this.config.name === 'ollamaLocal') {
      return this.config.baseUrl.length > 0;
    }
    return this.config.apiKey.length > 0;
  }

  getModelInstance(): any {
    return this.modelInstance;
  }
}