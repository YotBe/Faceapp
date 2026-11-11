// Pure card rules: dedup, known-term suppression, confidence thresholds, and
// finding the spoken form of a term in the transcript. No DOM, no network.
import type { Extraction } from '../llm/extraction.js';

export type Card = {
  key: string;
  canonical: string;
  heardAs: string;
  kind: string;
  oneLiner: string;
  bullets: string[];
  whyHere: string | null;
  unsure: boolean;
  pinned: boolean;
  at: number;
  /** Seconds from the end of speech to the card, when measured. */
  latencyS?: number;
};

export type Relation = { key: string; terms: string[]; how: string; gotcha: string | null };

export const DROP_BELOW = 0.5;
export const UNSURE_BELOW = 0.75;

/** "RF-DETR Nano", "rf detr nano" and "RFDETR-nano" are one term. */
export const termKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

export type Merge = { cards: Card[]; relations: Relation[]; bumped: string[]; highlights: string[] };

/**
 * Turn one extraction into the cards to add. A term already on screen is not
 * added again — it is reported in `bumped` so the caller can lift it to the
 * top. Known terms and low-confidence guesses are dropped.
 */
export function mergeExtraction(x: Extraction, existing: readonly Card[], known: ReadonlySet<string>, now: number, latencyS?: number): Merge {
  const have = new Set(existing.map((c) => c.key));
  const out: Merge = { cards: [], relations: [], bumped: [], highlights: [] };
  for (const t of x.terms) {
    const key = termKey(t.canonical);
    if (!key || known.has(key) || t.confidence < DROP_BELOW) continue;
    if (t.heard_as.trim()) out.highlights.push(t.heard_as.trim());
    if (have.has(key)) {
      out.bumped.push(key);
      continue;
    }
    have.add(key);
    out.cards.push({
      key,
      canonical: t.canonical,
      heardAs: t.heard_as,
      kind: t.kind,
      oneLiner: t.one_liner,
      bullets: t.bullets.slice(0, 3),
      whyHere: t.why_here,
      unsure: t.confidence < UNSURE_BELOW || t.knowledge !== 'known',
      pinned: false,
      // Terms from one sentence keep the order they were said in.
      at: now + out.cards.length,
      latencyS,
    });
  }
  for (const r of x.relations) {
    const keys = r.terms.map(termKey).filter(Boolean).sort();
    // A relation is only worth showing between terms that have cards.
    if (keys.length < 2 || !keys.every((k) => have.has(k))) continue;
    out.relations.push({ key: keys.join('+'), terms: r.terms, how: r.how, gotcha: r.gotcha });
  }
  return out;
}

export type Part = { text: string; term: boolean };

/** Split transcript text around the spoken forms of terms, longest first. */
export function splitHighlights(text: string, spoken: readonly string[]): Part[] {
  const forms = [...new Set(spoken.map((s) => s.trim()).filter((s) => s.length > 1))].sort((a, b) => b.length - a.length);
  if (forms.length === 0 || !text) return text ? [{ text, term: false }] : [];
  const escaped = forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  const lower = new Set(forms.map((f) => f.toLowerCase()));
  return text
    .split(re)
    .filter((p) => p !== '')
    .map((p) => ({ text: p, term: lower.has(p.toLowerCase()) }));
}

/** Plain-text cheat sheet for sharing. */
export function cheatSheetText(cards: readonly Card[], relations: readonly Relation[], title: string): string {
  const lines = [title, ''];
  for (const c of [...cards].sort((a, b) => a.at - b.at)) {
    lines.push(`${c.canonical}${c.unsure ? ' (unverified)' : ''} — ${c.oneLiner}`);
    for (const b of c.bullets) lines.push(`  • ${b}`);
    lines.push('');
  }
  for (const r of relations) {
    lines.push(`How they fit: ${r.terms.join(' + ')} — ${r.how}${r.gotcha ? ` Gotcha: ${r.gotcha}` : ''}`, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}
