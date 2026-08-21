/**
 * Whether the media tools can be offered at all, and with which models.
 *
 * They exist only when Gemini is logged in, because that key is the whole
 * credential story here. Offering tools that would always answer "run `robin
 * login gemini`" would be worse than not offering them: a model that can see a
 * tool keeps reaching for it, and every attempt costs a turn.
 */

import { AuthStore } from '../auth-store.js';
import { SettingsStore } from '../settings/store.js';
import { createGeminiMedia, type MediaClient, type MediaModels } from './client.js';

export async function mediaModels(
  settings: SettingsStore = new SettingsStore()
): Promise<MediaModels> {
  return {
    image: String(await settings.get('media.imageModel')),
    speech: String(await settings.get('media.speechModel')),
    transcribe: String(await settings.get('media.transcribeModel')),
    vision: String(await settings.get('media.visionModel')),
  };
}

export async function mediaIfAvailable(
  auth: AuthStore = new AuthStore(),
  settings: SettingsStore = new SettingsStore()
): Promise<MediaClient | undefined> {
  let apiKey: string | undefined;
  try {
    const stored = await auth.get('gemini');
    apiKey = typeof stored?.apiKey === 'string' ? stored.apiKey : undefined;
  } catch {
    // An unreadable auth store means no media, not a failed session.
    return undefined;
  }
  if (!apiKey) return undefined;

  return createGeminiMedia({ apiKey, models: await mediaModels(settings) });
}
