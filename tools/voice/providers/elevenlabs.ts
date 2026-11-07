// ElevenLabs text to speech, with timing (ADR 0017). The with-timestamps
// endpoint answers JSON: the audio as base64, and every character's times,
// which become words here. Multilingual v2 speaks both languages with any of
// these voices, so the list only says who speaks what well.

import { ProviderError, type GeneratedWord, type Provider } from '../types.ts';

const MODEL = 'eleven_multilingual_v2';
const FORMAT = 'mp3_44100_128';

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Words from per-character times: each run of non-space characters. */
export function wordsFromAlignment(alignment: Alignment): GeneratedWord[] {
  const words: GeneratedWord[] = [];
  let text = '';
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text !== '') words.push({ text, start, end });
    text = '';
  };
  alignment.characters.forEach((char, i) => {
    if (/\s/.test(char)) return flush();
    if (text === '') start = alignment.character_start_times_seconds[i];
    text += char;
    end = alignment.character_end_times_seconds[i];
  });
  flush();
  return words;
}

const BOTH = ['en', 'es'] as const;

export const elevenlabs: Provider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  host: 'api.elevenlabs.io',
  keyPage: 'https://elevenlabs.io/app/settings/api-keys',
  kinds: ['voice'],
  // The published API rate for Multilingual v2 in late 2026. A subscription's credits work out differently.
  price: { usdPer1000Characters: 0.1 },
  voices: [
    { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', langs: BOTH, detail: 'Calm, narration' },
    { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah', langs: BOTH, detail: 'Soft, warm' },
    { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam', langs: BOTH, detail: 'Deep, narration' },
    { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni', langs: BOTH, detail: 'Rounded, friendly' },
    { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel', langs: BOTH, detail: 'British, news' },
  ],
  async generate(request, key, http) {
    const res = await http(`/v1/text-to-speech/${encodeURIComponent(request.voice)}/with-timestamps?output_format=${FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text: request.text, model_id: MODEL, language_code: request.lang }),
    });
    if (!res.ok) throw new ProviderError('ElevenLabs', res.status);
    const answer = (await res.json()) as { audio_base64?: unknown; alignment?: Alignment | null };
    if (typeof answer.audio_base64 !== 'string') throw new Error('ElevenLabs sent no audio.');
    return {
      bytes: Buffer.from(answer.audio_base64, 'base64'),
      ext: '.mp3',
      ...(answer.alignment ? { words: wordsFromAlignment(answer.alignment) } : {}),
    };
  },
};
