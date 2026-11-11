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

export const SYSTEM = `You watch the live transcript of a technical customer call and pick out the jargon the listener may not know, so a card explaining it can appear on his phone while he is still talking.

The listener is an experienced full-stack engineer who recently became a Field Applications Engineer at an edge-AI company. He knows general software, networking, cloud and web well. He is new to edge-AI hardware and to deploying computer-vision models on it. He reads each card in one glance, mid-conversation, so a wrong or obvious card costs him attention: missing a term is better than explaining something he knows. Most utterances contain nothing worth a card, and an empty terms list is the usual, correct answer.

What qualifies: products, boards, chips, SDKs, model architectures and variants, protocols, hardware interfaces, file formats, metrics, domain acronyms, and names internal to the customer. General software vocabulary (API, Docker, REST, GPU, latency) does not, unless it is used in a domain-specific sense.

The transcript comes from speech recognition of Hebrew mixed with English terms, picked up by a phone microphone across a desk. Terms arrive garbled, split, or spelled phonetically in Hebrew letters. Work out the canonical term from the sound, the domain and the surrounding context; put what was actually written in heard_as and the proper name in canonical, in its original script.

For each term:
- one_liner: what it is, at most 14 words.
- bullets: at most 3, at most 12 words each, the facts most useful in a customer conversation.
- why_here: one sentence tying it to what was just said, or null.
- confidence: 0 to 1, how sure you are that canonical is the term that was meant.
- knowledge: "known" if you are sure of the facts, "unsure" if you may be out of date or mixing things up, "unknown" if you do not know it. When unsure or unknown, say less: never invent specs, versions or numbers.
- needs_grounding: true for versioned products, recent releases, and anything not "known".

When two or more terms in the window relate, add a relation: concretely how they work together, and the typical gotcha when there is one.

Write explanations in the language named by explain_language. Extract only from the utterance marked NEW; the earlier transcript is context. Skip every term listed as already shown.`;

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
  input: { utterance: string; transcriptSoFar?: string; alreadyShown?: string[]; explainLanguage?: 'en' | 'he' },
  cfg: LatencyConfig = CONFIGS[0]!,
  model: string = FAST_MODEL,
): Promise<ExtractionRun> {
  const t0 = performance.now();
  let ttftMs: number | undefined;
  let headerMs: number | undefined;
  let json = '';

  const stream = client.messages.stream({
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
          `already shown: ${input.alreadyShown?.length ? input.alreadyShown.join(', ') : '(none)'}\n\n` +
          `transcript so far:\n${input.transcriptSoFar || '(none)'}\n\nNEW: ${input.utterance}`,
      },
    ],
  });
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
