import { useEffect, useRef, useState } from 'react';
import { end, pause, resume } from '../pipeline/session.js';
import { splitHighlights, type Card, type Relation } from '../pipeline/policy.js';
import { useGloss } from '../store.js';
import { CheckIcon, Chevron, LinkIcon, PauseIcon, PinIcon, PlayIcon, WaveIcon } from './icons.js';

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** What Gloss is doing right now, at a glance. */
function Status() {
  const phase = useGloss((s) => s.phase);
  const demo = useGloss((s) => s.demo);
  const level = useGloss((s) => s.level);
  const elapsed = useGloss((s) => s.elapsedMs);
  const listening = phase === 'listening';
  // Five bars, tallest in the middle, all driven by the one microphone level.
  const shape = [0.45, 0.8, 1, 0.7, 0.4];
  return (
    <div className={`pill ${listening ? 'on' : 'off'}`} role="status">
      <span className="bars" aria-hidden="true">
        {shape.map((k, i) => (
          <i key={i} style={{ height: `${listening ? 3 + level * k * 13 : 3}px` }} />
        ))}
      </span>
      <span className="state">{listening ? 'Listening' : 'Paused'}</span>
      <span className="time">{clock(elapsed)}</span>
      {demo && <span className="tag">Demo</span>}
    </div>
  );
}

function Transcript() {
  const lines = useGloss((s) => s.lines);
  const interim = useGloss((s) => s.interim);
  const spoken = useGloss((s) => s.spoken);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines, interim]);
  const recent = lines.slice(-3);
  return (
    <section className="transcript" aria-label="Live transcript">
      <div className="said" ref={box} dir="auto">
        {recent.length === 0 && !interim && <span className="placeholder">Waiting for someone to speak…</span>}
        {recent.map((l) => (
          <p key={l.id} dir="auto">
            {splitHighlights(l.text, spoken).map((p, i) => (p.term ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
          </p>
        ))}
        {interim && <p className="interim" dir="auto">{interim}</p>}
      </div>
    </section>
  );
}

function Actions({ card }: { card: Card }) {
  const markKnown = useGloss((s) => s.markKnown);
  const togglePin = useGloss((s) => s.togglePin);
  return (
    <div className="actions">
      <button onClick={() => markKnown(card.key)}><CheckIcon />Know It</button>
      <button aria-pressed={card.pinned} onClick={() => togglePin(card.key)}><PinIcon filled={card.pinned} />{card.pinned ? 'Pinned' : 'Pin'}</button>
    </div>
  );
}

const kindLabel = (card: Card) => card.kind.charAt(0).toUpperCase() + card.kind.slice(1);

function Hero({ card }: { card: Card }) {
  return (
    <article className="hero" key={card.key}>
      <div className="eyebrow">
        <span>{kindLabel(card)}</span>
        {card.unsure && <span className="unsure">Unverified</span>}
        {card.latencyS !== undefined && <span>{card.latencyS.toFixed(1)} s</span>}
      </div>
      <h2 dir="auto">{card.canonical}</h2>
      <p className="one" dir="auto">{card.oneLiner}</p>
      {card.bullets.length > 0 && (
        <ul dir="auto">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
      )}
      {card.whyHere && <p className="why" dir="auto">{card.whyHere}</p>}
      <Actions card={card} />
    </article>
  );
}

function Fit({ relation }: { relation: Relation }) {
  return (
    <article className="fit">
      <div className="fit-head"><LinkIcon /><span>How They Fit</span></div>
      <h3 dir="auto">{relation.terms.join(' + ')}</h3>
      <p dir="auto">{relation.how}</p>
      {relation.gotcha && <p className="gotcha" dir="auto"><b>Watch for</b> {relation.gotcha}</p>}
    </article>
  );
}

function Row({ card, open, onToggle }: { card: Card; open: boolean; onToggle(): void }) {
  return (
    <li className={`row ${open ? 'open' : ''}`}>
      <button className="row-head" onClick={onToggle} aria-expanded={open}>
        <span className="row-text">
          <span className="term" dir="auto">{card.canonical}{card.unsure && <span className="unsure"> · Unverified</span>}</span>
          <span className="one" dir="auto">{card.oneLiner}</span>
        </span>
        <Chevron down={open} />
      </button>
      {open && (
        <div className="row-body">
          <ul dir="auto">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {card.whyHere && <p className="why" dir="auto">{card.whyHere}</p>}
          <Actions card={card} />
        </div>
      )}
    </li>
  );
}

export function Live() {
  const phase = useGloss((s) => s.phase);
  const cards = useGloss((s) => s.cards);
  const relations = useGloss((s) => s.relations);
  const fresh = useGloss((s) => s.fresh);
  const thinking = useGloss((s) => s.thinking);
  const notice = useGloss((s) => s.notice);
  const error = useGloss((s) => s.error);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const hero = cards.find((c) => c.key === fresh) ?? cards[0];
  const pinned = cards.filter((c) => c.pinned && c.key !== hero?.key);
  const earlier = cards.filter((c) => c.key !== hero?.key);
  const fit = relations[0];

  return (
    <div className="screen live">
      <header className="live-bar"><Status /></header>

      <div className="scroll">
        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}
        <Transcript />

        {pinned.length > 0 && (
          <div className="pins" aria-label="Pinned terms">
            {pinned.map((c) => <button key={c.key} onClick={() => setOpenKey(c.key)} dir="auto"><PinIcon filled />{c.canonical}</button>)}
          </div>
        )}

        {hero ? <Hero card={hero} /> : (
          <div className="empty">
            <WaveIcon />
            <h2>{thinking ? 'Checking for Jargon' : 'No Terms Yet'}</h2>
            <p>A card appears when someone uses a term you might not know. Most sentences don’t need one.</p>
          </div>
        )}
        {fit && <Fit relation={fit} />}
        {hero && thinking && <p className="thinking">Checking the last sentence…</p>}

        {earlier.length > 0 && (
          <section aria-label="Earlier terms">
            <h3 className="section-title">Earlier</h3>
            <ul className="group">
              {earlier.map((c) => (
                <Row key={c.key} card={c} open={openKey === c.key} onToggle={() => setOpenKey(openKey === c.key ? null : c.key)} />
              ))}
            </ul>
          </section>
        )}
        {relations.slice(1).map((r) => <Fit key={r.key} relation={r} />)}
      </div>

      <footer className="toolbar">
        {phase === 'listening'
          ? <button className="tool" onClick={pause}><PauseIcon />Pause</button>
          : <button className="tool tint" onClick={() => void resume()}><PlayIcon />Resume</button>}
        <button className="tool end" onClick={end}>End</button>
      </footer>
    </div>
  );
}
