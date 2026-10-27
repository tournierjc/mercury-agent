import { describe, expect, it } from 'vitest';
import { buildBotSystemPrompt, type BotTurnInput } from './bot-turn.js';

/**
 * A bot run used to have one voice: the worker's. Asking a bot a question in the app got
 * "Nothing to do: the request needed no tool" — the correct answer to "what did you do?"
 * and a useless one to "what do you know?". `mode: 'chat'` is the difference, and these
 * cases pin it: the chat prompt must invite an answer and must not contain the instruction
 * that produces the refusal.
 */

function input(overrides: Partial<BotTurnInput> = {}): BotTurnInput {
  return {
    manifest: {
      id: 'atelier',
      name: 'Atelier',
      description: 'Rendering test bench',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    trigger: 'api',
    prompt: 'Que sais-tu de ce Spark ?',
    persona: 'Tu es un banc dessai de rendu.',
    mail: [],
    pollMail: () => [],
    sandbox: { workspace: '/tmp/ws', shared: '/tmp/shared' },
    capabilities: {} as BotTurnInput['capabilities'],
    tools: {},
    userMemory: null,
    provider: {} as BotTurnInput['provider'],
    tokenBudget: { getRemaining: () => 100_000 } as unknown as BotTurnInput['tokenBudget'],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('bot system prompt', () => {
  it('a work turn keeps the delivery rules', () => {
    const prompt = buildBotSystemPrompt(input());
    expect(prompt).toContain('Operating rules:');
    expect(prompt).toContain('Work, don\'t narrate');
    expect(prompt).toContain('Nothing to do:');
  });

  it('a chat turn asks for an answer and drops the refusal instruction', () => {
    const prompt = buildBotSystemPrompt(input({ mode: 'chat' }));
    expect(prompt).toContain('Conversation rules:');
    expect(prompt).toContain('Your final text IS your reply');
    expect(prompt).not.toContain('Nothing to do:');
    expect(prompt).not.toContain('Work, don\'t narrate');
  });

  it('a chat turn still carries the persona and the sandbox', () => {
    const prompt = buildBotSystemPrompt(input({ mode: 'chat' }));
    expect(prompt).toContain('Atelier');
    expect(prompt).toContain('Tu es un banc dessai de rendu.');
    expect(prompt).toContain('/tmp/ws');
  });
});
