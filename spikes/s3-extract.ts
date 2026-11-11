// Spike S3 (Node): fixture utterances -> fast Claude model, streaming.
// The phone check page runs the same code from the browser.
//
//   npm run spike:s3                 # all fixtures, both latency configs
//   npm run spike:s3 -- canon-clean  # one fixture
import Anthropic from '@anthropic-ai/sdk';
import { CONFIGS, FAST_MODEL, runExtraction, score } from '../src/llm/extraction.js';
import { FIXTURES } from '../src/llm/fixtures.js';

const MODEL = process.env.GLOSS_FAST_MODEL ?? FAST_MODEL;
const client = new Anthropic();
const only = process.argv[2];
const ms = (n: number | undefined) => (n === undefined ? '   n/a' : `${Math.round(n)}`.padStart(6));

for (const cfg of CONFIGS) {
  console.log(`\n=== ${MODEL} — ${cfg.name} ===`);
  const headers: number[] = [];
  for (const fx of FIXTURES.filter((f) => !only || f.id === only)) {
    try {
      const r = await runExtraction(client, { utterance: fx.text }, cfg, MODEL);
      const s = score(fx, r.parsed);
      if (r.headerMs !== undefined) headers.push(r.headerMs);
      console.log(`${s.ok ? 'ok  ' : 'MISS'} ${fx.id.padEnd(22)} ttft ${ms(r.ttftMs)} ms  header ${ms(r.headerMs)} ms  total ${ms(r.totalMs)} ms  in ${r.usage.input_tokens}+${r.usage.cache_read_input_tokens ?? 0}c out ${r.usage.output_tokens}`);
      for (const t of r.parsed.terms) {
        console.log(`       ${t.canonical}  <- ${JSON.stringify(t.heard_as)}  [${t.kind}, conf ${t.confidence}, ${t.knowledge}${t.needs_grounding ? ', ground' : ''}]\n         ${t.one_liner}`);
      }
      for (const rel of r.parsed.relations) console.log(`       RELATION ${rel.terms.join(' + ')}: ${rel.how}${rel.gotcha ? ` | gotcha: ${rel.gotcha}` : ''}`);
      if (s.missed.length) console.log(`       missed: ${s.missed.join(', ')}`);
      if (s.forbidden.length) console.log(`       forbidden: ${s.forbidden.join(', ')}`);
      if (s.unexpected.length) console.log(`       unexpected cards on a no-term utterance: ${s.unexpected.join(', ')}`);
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
