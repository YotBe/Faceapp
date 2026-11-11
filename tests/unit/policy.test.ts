import { describe, expect, it } from 'vitest';
import type { Extraction } from '../../src/llm/extraction.js';
import { cheatSheetText, mergeExtraction, splitHighlights, termKey, type Card } from '../../src/pipeline/policy.js';

type Term = Extraction['terms'][number];
const term = (canonical: string, over: Partial<Term> = {}): Term => ({
  canonical, heard_as: canonical, kind: 'model', one_liner: 'what it is', bullets: ['a', 'b', 'c', 'd'], why_here: null,
  related: [], confidence: 0.9, knowledge: 'known', needs_grounding: false, ...over,
});
const x = (terms: Term[], relations: Extraction['relations'] = []): Extraction => ({ terms, relations });
const merge = (e: Extraction, existing: Card[] = [], known: string[] = []) => mergeExtraction(e, existing, new Set(known), 1000);

describe('termKey', () => {
  it('treats spacing, case and punctuation variants as one term', () => {
    expect(termKey('RF-DETR Nano')).toBe(termKey('rf detr nano'));
    expect(termKey('RFDETR-nano')).toBe(termKey('RF-DETR Nano'));
    expect(termKey('מודליקס')).toBe('מודליקס');
  });
});

describe('mergeExtraction', () => {
  it('adds a new term and caps bullets at three', () => {
    const m = merge(x([term('RF-DETR Nano')]));
    expect(m.cards.map((c) => c.canonical)).toEqual(['RF-DETR Nano']);
    expect(m.cards[0]!.bullets).toHaveLength(3);
    expect(m.cards[0]!.unsure).toBe(false);
  });
  it('never repeats a card: a re-mention is reported as bumped', () => {
    const first = merge(x([term('RF-DETR Nano')])).cards;
    const again = merge(x([term('rf detr nano'), term('mAP')]), first);
    expect(again.cards.map((c) => c.canonical)).toEqual(['mAP']);
    expect(again.bumped).toEqual([termKey('RF-DETR Nano')]);
  });
  it('does not show the same term twice within one extraction', () => {
    expect(merge(x([term('ONNX'), term('onnx')])).cards).toHaveLength(1);
  });
  it('suppresses known terms for good', () => {
    const m = merge(x([term('ONNX')]), [], [termKey('onnx')]);
    expect(m.cards).toEqual([]);
    expect(m.highlights).toEqual([]);
  });
  it('drops low-confidence guesses and marks middling or unsure ones', () => {
    const m = merge(x([term('A', { confidence: 0.49 }), term('B', { confidence: 0.6 }), term('C', { knowledge: 'unsure' }), term('D')]));
    expect(m.cards.map((c) => [c.canonical, c.unsure])).toEqual([['B', true], ['C', true], ['D', false]]);
  });
  it('keeps a relation only when every term in it has a card', () => {
    const rel = { terms: ['RF-DETR Nano', 'Modalix'], how: 'compiled for it', gotcha: null };
    expect(merge(x([term('RF-DETR Nano')], [rel])).relations).toEqual([]);
    const both = merge(x([term('RF-DETR Nano'), term('Modalix')], [rel]));
    expect(both.relations).toHaveLength(1);
    // Same pair in the other order is the same relation.
    expect(both.relations[0]!.key).toBe(merge(x([term('Modalix'), term('RF-DETR Nano')], [{ ...rel, terms: ['Modalix', 'RF-DETR Nano'] }])).relations[0]!.key);
  });
  it('highlights what was actually said, not the canonical name', () => {
    expect(merge(x([term('SiMa.ai Modalix', { heard_as: 'המודליקס' })])).highlights).toEqual(['המודליקס']);
  });
});

describe('splitHighlights', () => {
  it('marks spoken forms inside mixed Hebrew and English text', () => {
    const parts = splitHighlights('צריך להריץ RF-DETR Nano על המודליקס החדש', ['המודליקס', 'RF-DETR Nano']);
    expect(parts.filter((p) => p.term).map((p) => p.text)).toEqual(['RF-DETR Nano', 'המודליקס']);
    expect(parts.map((p) => p.text).join('')).toBe('צריך להריץ RF-DETR Nano על המודליקס החדש');
  });
  it('prefers the longest form and ignores case', () => {
    expect(splitHighlights('run rf-detr nano now', ['RF-DETR', 'RF-DETR Nano']).filter((p) => p.term).map((p) => p.text)).toEqual(['rf-detr nano']);
  });
  it('treats regex characters in a term literally', () => {
    expect(splitHighlights('H.264 (main) + C++', ['H.264', 'C++']).filter((p) => p.term).map((p) => p.text)).toEqual(['H.264', 'C++']);
    expect(splitHighlights('H2264', ['H.264']).some((p) => p.term)).toBe(false);
  });
  it('returns plain text when there is nothing to mark', () => {
    expect(splitHighlights('hello', [])).toEqual([{ text: 'hello', term: false }]);
    expect(splitHighlights('', ['x'])).toEqual([]);
    expect(splitHighlights('a b', ['a', ' '])).toEqual([{ text: 'a b', term: false }]);
  });
});

describe('cheatSheetText', () => {
  it('lists terms in the order they came up and flags unverified ones', () => {
    const cards = [
      ...mergeExtraction(x([term('Second', { confidence: 0.6 })]), [], new Set(), 2000).cards,
      ...mergeExtraction(x([term('First')]), [], new Set(), 1000).cards,
    ];
    const text = cheatSheetText(cards, [{ key: 'k', terms: ['First', 'Second'], how: 'They connect.', gotcha: 'Careful.' }], 'Title');
    expect(text.indexOf('First —')).toBeLessThan(text.indexOf('Second (unverified) —'));
    expect(text).toContain('How they fit: First + Second — They connect. Gotcha: Careful.');
    expect(text.startsWith('Title\n')).toBe(true);
  });
});

describe('order within one sentence', () => {
  it('keeps terms in spoken order on the cheat sheet', () => {
    const m = mergeExtraction(x([term('Modalix'), term('RF-DETR Nano')]), [], new Set(), 5000);
    const text = cheatSheetText(m.cards.slice().reverse(), [], 'T');
    expect(text.indexOf('Modalix')).toBeLessThan(text.indexOf('RF-DETR Nano'));
  });
});
