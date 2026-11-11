// Stage B spike: one utterance -> streamed, schema-constrained term extraction.
// Shared by the Node script (s3-extract.ts) and the phone check page.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Fixture } from './fixtures.js';

export const FAST_MODEL = 'claude-haiku-5-5';

// Structured outputs constrain shape, not length: word limits live in the prompt.
export const Extraction = z.object({
  terms: z.array(
    z.object({
      canonical: z.string(),
      heard_as: z.string(),
      kind: z.enum(['product', 'board', 'chip', 'sdk', 'model', 'protocol', 'interface', 'format', 'metric', 'concept', 'org', 'other']),
      one_liner: z.string(),
      bullets: z.array(z.string()),
      why_here: z.string().nullable(),
      related: z.array(z.string()),
      confidence: z.number(),
      knowledge: z.enum(['known', 'unsure', 'unknown']),
      needs_grounding: z.boolean(),
    }),
  ),
  relations: z.array(z.object({ terms: z.array(z.string()), how: z.string(), gotcha: z.string().nullable() })),
});
export type Extraction = z.infer<typeof Extraction>;

export const SYSTEM = `You watch the live transcript of a conversation, meeting or lecture and pick out the terms the listener may not know, so a short card explaining each one can appear on their phone while the speaker is still talking.

The conversation can be about anything: technology, medicine, law, finance, science, business, politics, history. The listener is an intelligent adult who is usually not an expert in the subject being discussed. If a "listener" note is given, it says who they are and what they already know: trust it, and never explain what such a person obviously knows.

They read a card in one glance, mid-conversation, so a wrong or obvious card costs them attention. Missing a term is better than explaining an ordinary word. Most sentences contain nothing worth a card, and an empty terms list is the usual, correct answer.

What qualifies: technical terms and jargon of any field, acronyms, named products, technologies, methods, standards, laws, organisations and concepts that a non-expert would have to look up. What does not: everyday vocabulary, words any educated adult knows, and things the speaker has just explained themselves. At most two terms per sentence: the ones the listener most needs.

The transcript comes from speech recognition, often Hebrew mixed with English terms, picked up by a phone microphone. Terms arrive garbled, split, or spelled phonetically in the other language's letters. Work out the term that was meant from the sound and the context; put what was actually written in heard_as, copied exactly from the transcript, and the proper name in canonical, in its usual script.

For each term:
- one_liner: what it is, at most 14 words, in plain language.
- bullets: at most 3, at most 12 words each: the facts most useful for following this conversation.
- why_here: one sentence tying it to what was just said, or null.
- confidence: 0 to 1, how sure you are that canonical is the term that was meant.
- knowledge: "known" if you are sure of the facts, "unsure" if you may be out of date or mixing things up, "unknown" if you do not know it. When unsure or unknown, say less: never invent specs, versions, dates or numbers.
- needs_grounding: true for versioned products, recent releases, and anything not "known".

When two or more terms relate, add a relation: concretely how they connect, and the typical gotcha when there is one.

Write every explanation in the language named by explain_language. When that is "he", write natural, everyday Hebrew, and keep the term itself and other proper names in their original script. Extract only from the utterance marked NEW; the earlier transcript is context. Skip every term listed as already shown.`;

export type LatencyConfig = { name: string; thinking?: Anthropic.ThinkingConfigParam; effort: 'low' | 'medium' };
// Haiku 5.5 thinks by default. For a 2 s budget the candidate is thinking off;
// adaptive is measured alongside it for comparison.
export const CONFIGS: LatencyConfig[] = [
  { name: 'thinking off, effort low', thinking: { type: 'disabled' }, effort: 'low' },
  { name: 'adaptive thinking, effort low', effort: 'low' },
];

export type ExtractionRun = {
  ttftMs: number | undefined;
  headerMs: number | undefined;
  totalMs: number;
  parsed: Extraction;
  usage: Anthropic.Usage;
};

/** Card header can render once canonical and one_liner have both closed. */
const HEADER_READY = /"canonical"\s*:\s*"(?:[^"\\]|\\.)*"[\s\S]*"one_liner"\s*:\s*"(?:[^"\\]|\\.)*"/;

export async function runExtraction(
  client: Anthropic,
  input: { utterance: string; transcriptSoFar?: string; alreadyShown?: string[]; explainLanguage?: 'en' | 'he'; listener?: string },
  cfg: LatencyConfig = CONFIGS[0]!,
  model: string = FAST_MODEL,
  timeoutMs?: number,
): Promise<ExtractionRun> {
  const t0 = performance.now();
  let ttftMs: number | undefined;
  let headerMs: number | undefined;
  let json = '';

  const stream = client.messages.stream(
   {
    model,
    max_tokens: 2000,
    ...(cfg.thinking ? { thinking: cfg.thinking } : {}),
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: cfg.effort, format: zodOutputFormat(Extraction) },
    messages: [
      {
        role: 'user',
        content:
          `explain_language: ${input.explainLanguage ?? 'en'}\n` +
          (input.listener ? `listener: ${input.listener}\n` : '') +
          `already shown: ${input.alreadyShown?.length ? input.alreadyShown.join(', ') : '(none)'}\n\n` +
          `transcript so far:\n${input.transcriptSoFar || '(none)'}\n\nNEW: ${input.utterance}`,
      },
    ],
   },
   // Without a deadline a stalled request would block every later sentence.
   timeoutMs ? { timeout: timeoutMs } : undefined,
  );
  stream.on('text', (delta) => {
    ttftMs ??= performance.now() - t0;
    json += delta;
    if (headerMs === undefined && HEADER_READY.test(json)) headerMs = performance.now() - t0;
  });

  const msg = await stream.finalMessage();
  if (msg.stop_reason !== 'end_turn') throw new Error(`model stopped early: ${msg.stop_reason}`);
  return { ttftMs, headerMs, totalMs: performance.now() - t0, parsed: Extraction.parse(JSON.parse(json)), usage: msg.usage };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function score(fx: Fixture, parsed: Extraction) {
  const got = parsed.terms.map((t) => t.canonical);
  const missed = fx.expected_terms.filter((e) => !got.some((g) => norm(g).includes(norm(e)) || norm(e).includes(norm(g))));
  const forbidden = got.filter((g) => fx.forbidden_terms.some((f) => norm(f) === norm(g)));
  const unexpected = fx.expected_terms.length === 0 ? got : [];
  return { got, missed, forbidden, unexpected, ok: missed.length === 0 && forbidden.length === 0 && unexpected.length === 0 };
}
