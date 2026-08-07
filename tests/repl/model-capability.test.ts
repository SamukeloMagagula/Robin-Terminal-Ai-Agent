import { describe, it, expect } from 'vitest';
import { isChatCapableModel } from '../../src/repl/model-capability';

describe('isChatCapableModel', () => {
  it.each([
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gpt-4o',
    'gpt-4o-mini',
    'claude-sonnet-4',
    'llama3.1:latest',
    'z-ai/glm-4.7',
    'gemma-4-26b-a4b-it',
    'mistral-large-latest',
  ])('keeps %s', (model) => {
    expect(isChatCapableModel(model)).toBe(true);
  });

  // The model that produced a 400 in the wild, plus its neighbours.
  it.each([
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
    'text-embedding-004',
    'gemini-embedding-exp',
    'imagen-3.0-generate-002',
    'dall-e-3',
    'veo-2.0-generate-001',
    'whisper-large-v3',
    'aqa',
    'stable-diffusion-xl',
    'gpt-4o-audio-preview',
    'omni-moderation-latest',
    'llama-guard-3-8b',
  ])('excludes %s', (model) => {
    expect(isChatCapableModel(model)).toBe(false);
  });
});
