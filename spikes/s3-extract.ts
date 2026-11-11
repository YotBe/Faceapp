// Spike S3: fixture utterance -> fast Claude model with the extraction schema,
// streaming. Prints time to first token, time until the first card header
// could render (canonical + one_liner streamed), and total.
//
//   npm run spike:s3                 # all fixtures, both latency configs
//   npm run spike:s3 -- canon-clean  # one fixture
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const MODEL = process.env.GLOSS_FAST_MODEL ?? 'claude-haiku-5-5';

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

const SYSTEM = `You watch the live transcript of a technical customer call and pick out the jargon the listener may not know, so a card explaining it can appear on his second screen while he is still talking.

The listener is an experienced full-stack engineer who recently became a Field Applications Engineer at an edge-AI company. He knows general software, networking, cloud and web well. He is new to edge-AI hardware and to deploying computer-vision models on it. He reads each card in one glance, mid-conversation, so a wrong or obvious card costs him attention: missing a term is better than explaining something he knows. Most utterances contain nothing worth a card, and an empty terms list is the usual, correct answer.

What qualifies: products, boards, chips, SDKs, model architectures and variants, protocols, hardware interfaces, file formats, metrics, domain acronyms, and names internal to the customer. General software vocabulary (API, Docker, REST, GPU, latency) does not, unless it is used in a domain-specific sense.

The transcript comes from speech recognition of Hebrew mixed with English terms. Terms arrive garbled, split, or spelled phonetically in Hebrew letters. Work out the canonical term from the sound, the domain and the surrounding context; put what was actually written in heard_as and the proper name in canonical, in its original script.

For each term:
- one_liner: what it is, at most 14 words.
- bullets: at most 3, at most 12 words each, the facts most useful in a customer conversation.
- why_here: one sentence tying it to what was just said, or null.
- confidence: 0 to 1, how sure you are that canonical is the term that was meant.
- knowledge: "known" if you are sure of the facts, "unsure" if you may be out of date or mixing things up, "unknown" if you do not know it. When unsure or unknown, say less: never invent specs, versions or numbers.
- needs_grounding: true for versioned products, recent releases, and anything not "known".

When two or more terms in the window relate, add a relation: concretely how they work together, and the typical gotcha when there is one.

Write explanations in the language named by explain_language. Extract only from the utterance marked NEW; the earlier transcript is context. Skip every term listed as already shown.`;

type Fixture = { id: string; source: 'me' | 'them'; text: string; expected_terms: string[]; forbidden_terms: string[] };

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = fs
  .readFileSync(path.join(here, 'fixtures', 'utterances.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Fixture);

type Config = { name: string; thinking?: Anthropic.ThinkingConfigParam; effort: 'low' | 'medium' };
// Haiku 5.5 thinks by default (effort medium). For a 2 s budget the candidate
// is thinking off; the default is measured alongside it for comparison.
const CONFIGS: Config[] = [
  { name: 'thinking off, effort low', thinking: { type: 'disabled' }, effort: 'low' },
  { name: 'adaptive thinking, effort low', effort: 'low' },
];

const client = new Anthropic();

async function extract(fx: Fixture, cfg: Config) {
  const t0 = performance.now();
  let ttft: number | undefined;
  let header: number | undefined;
  let json = '';

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2000,
    ...(cfg.thinking ? { thinking: cfg.thinking } : {}),
    // The system prompt is static so it can be cached; this spike's prompt is
    // probably below the model's minimum cacheable length — usage shows it.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: cfg.effort, format: zodOutputFormat(Extraction) },
    messages: [
      {
        role: 'user',
        content: `explain_language: en\nalready shown: (none)\n\ntranscript so far:\n(none)\n\nNEW ${fx.source}: ${fx.text}`,
      },
    ],
  });
  stream.on('text', (delta) => {
    ttft ??= performance.now() - t0;
    json += delta;
    // Card header can render once canonical and one_liner have both closed.
    if (header === undefined && /"canonical"\s*:\s*"[^"]*"[\s\S]*"one_liner"\s*:\s*"(?:[^"\\]|\\.)*"/.test(json)) {
      header = performance.now() - t0;
    }
  });

  const msg = await stream.finalMessage();
  const total = performance.now() - t0;
  if (msg.stop_reason !== 'end_turn') throw new Error(`stop_reason ${msg.stop_reason}`);
  const parsed = Extraction.parse(JSON.parse(json));
  return { ttft, header, total, parsed, usage: msg.usage };
}

const only = process.argv[2];
const ms = (n: number | undefined) => (n === undefined ? '   n/a' : `${Math.round(n)}`.padStart(6));

for (const cfg of CONFIGS) {
  console.log(`\n=== ${MODEL} — ${cfg.name} ===`);
  const headers: number[] = [];
  for (const fx of fixtures.filter((f) => !only || f.id === only)) {
    try {
      const r = await extract(fx, cfg);
      const got = r.parsed.terms.map((t) => t.canonical);
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const missed = fx.expected_terms.filter((e) => !got.some((g) => norm(g).includes(norm(e)) || norm(e).includes(norm(g))));
      const forbidden = got.filter((g) => fx.forbidden_terms.some((f) => norm(f) === norm(g)));
      const verdict = missed.length === 0 && forbidden.length === 0 && (fx.expected_terms.length > 0 || got.length === 0) ? 'ok  ' : 'MISS';
      if (r.header !== undefined) headers.push(r.header);
      console.log(`${verdict} ${fx.id.padEnd(22)} ttft ${ms(r.ttft)} ms  header ${ms(r.header)} ms  total ${ms(r.total)} ms  in ${r.usage.input_tokens}+${r.usage.cache_read_input_tokens ?? 0}c out ${r.usage.output_tokens}`);
      for (const t of r.parsed.terms) {
        console.log(`       ${t.canonical}  <- ${JSON.stringify(t.heard_as)}  [${t.kind}, conf ${t.confidence}, ${t.knowledge}${t.needs_grounding ? ', ground' : ''}]\n         ${t.one_liner}`);
      }
      for (const rel of r.parsed.relations) console.log(`       RELATION ${rel.terms.join(' + ')}: ${rel.how}${rel.gotcha ? ` | gotcha: ${rel.gotcha}` : ''}`);
      if (missed.length) console.log(`       missed: ${missed.join(', ')}`);
      if (forbidden.length) console.log(`       forbidden: ${forbidden.join(', ')}`);
      if (fx.expected_terms.length === 0 && got.length) console.log(`       unexpected cards on a no-term utterance: ${got.join(', ')}`);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || (e instanceof Error && /authentication method/.test(e.message))) {
        console.error('ANTHROPIC_API_KEY is missing or invalid (put it in .env)');
        process.exit(1);
      }
      console.log(`ERR  ${fx.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  headers.sort((a, b) => a - b);
  if (headers.length) console.log(`card-header latency: median ${Math.round(headers[Math.floor(headers.length / 2)]!)} ms, worst ${Math.round(headers.at(-1)!)} ms (budget: 2000 p50 / 3500 p95, minus STT endpoint delay)`);
}
