import { create } from 'zustand';
import { termKey, type Card, type Relation } from './pipeline/policy.js';

export type Phase = 'idle' | 'listening' | 'paused' | 'ended';
export type Line = { id: number; text: string; speaker?: string };

const KNOWN_KEY = 'gloss.known';
function loadKnown(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

type State = {
  phase: Phase;
  demo: boolean;
  /** Microphone level, 0..1, for the waveform. */
  level: number;
  startedAt: number;
  elapsedMs: number;
  lines: Line[];
  interim: string;
  /** Spoken forms to highlight in the transcript. */
  spoken: string[];
  cards: Card[];
  relations: Relation[];
  /** Key of the card that just arrived or was re-mentioned. */
  fresh: string | null;
  known: string[];
  thinking: boolean;
  notice: string | null;
  error: string | null;

  reset(demo: boolean): void;
  addCards(cards: Card[], relations: Relation[], spoken: string[], bumped: string[]): void;
  markKnown(key: string): void;
  togglePin(key: string): void;
};

export const useGloss = create<State>((set) => ({
  phase: 'idle',
  demo: false,
  level: 0,
  startedAt: 0,
  elapsedMs: 0,
  lines: [],
  interim: '',
  spoken: [],
  cards: [],
  relations: [],
  fresh: null,
  known: loadKnown(),
  thinking: false,
  notice: null,
  error: null,

  reset: (demo) =>
    set({ demo, phase: 'listening', level: 0, startedAt: Date.now(), elapsedMs: 0, lines: [], interim: '', spoken: [], cards: [], relations: [], fresh: null, thinking: false, notice: null, error: null }),

  addCards: (cards, relations, spoken, bumped) =>
    set((s) => {
      // Newest first; a re-mentioned card moves to the top instead of repeating.
      const lifted = s.cards.filter((c) => bumped.includes(c.key));
      const rest = s.cards.filter((c) => !bumped.includes(c.key));
      const haveRel = new Set(s.relations.map((r) => r.key));
      return {
        cards: [...cards.slice().reverse(), ...lifted, ...rest],
        relations: [...relations.filter((r) => !haveRel.has(r.key)), ...s.relations],
        spoken: [...new Set([...s.spoken, ...spoken])],
        fresh: cards.at(-1)?.key ?? bumped[0] ?? s.fresh,
      };
    }),

  markKnown: (key) =>
    set((s) => {
      const known = [...new Set([...s.known, key])];
      try {
        localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
      } catch {
        // Not persisted; still suppressed for this session.
      }
      return {
        known,
        cards: s.cards.filter((c) => c.key !== key),
        relations: s.relations.filter((r) => !r.terms.some((t) => termKey(t) === key)),
      };
    }),

  togglePin: (key) => set((s) => ({ cards: s.cards.map((c) => (c.key === key ? { ...c, pinned: !c.pinned } : c)) })),
}));
