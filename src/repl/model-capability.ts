/**
 * Heuristics for excluding models that cannot answer a text chat request.
 *
 * Provider catalogues mix chat models in with speech, embedding, image and
 * video models. A `listModels()` filter based on the provider's own metadata
 * does not catch all of them — Gemini's TTS models advertise
 * `generateContent` support and then reject a text-only request with a 400 —
 * so the automatic fallback chain needs a name-based guard as well.
 *
 * This only ever removes candidates from an automatic retry. A model the user
 * picks by hand is still honoured; being wrong here costs a fallback option,
 * not access.
 */

const NON_CHAT_PATTERNS: RegExp[] = [
  /\btts\b|-tts\b|text-to-speech/i,
  /\bstt\b|speech-to-text|\bwhisper\b/i,
  /\bembed(ding)?s?\b/i,
  /\bimagen\b|\bdall-?e\b|stable-diffusion|\bflux\b|\bsdxl\b/i,
  /\bveo\b|text-to-video|image-to-video/i,
  /\baqa\b/i,
  /\brerank(er)?\b/i,
  /-audio\b|\baudio-/i,
  /\bmoderation\b|\bguard\b/i,
  /\bocr\b/i,
];

export function isChatCapableModel(model: string): boolean {
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(model));
}
