import { useEffect, useRef, useState } from 'react';
import { end, pause, resume } from '../pipeline/session.js';
import { splitHighlights, type Card, type Relation } from '../pipeline/policy.js';
import { useGloss } from '../store.js';

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** The pill at the top: what Gloss is doing right now, at a glance. */
function StatusPill() {
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
          <i key={i} style={{ height: `${listening ? 4 + level * k * 14 : 4}px` }} />
        ))}
      </span>
      <span>{listening ? 'Listening' : 'Paused'}</span>
      {demo && <span className="tag">Demo</span>}
      <span className="time">{clock(elapsed)}</span>
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
      <div className="label"><span className="dot" />Live</div>
      <div className="said" ref={box} dir="auto">
        {recent.length === 0 && !interim && <span className="faint">Waiting for someone to speak…</span>}
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
      <button onClick={() => markKnown(card.key)}>I know this</button>
      <button aria-pressed={card.pinned} onClick={() => togglePin(card.key)}>{card.pinned ? 'Pinned' : 'Pin'}</button>
    </div>
  );
}

function Meta({ card }: { card: Card }) {
  return (
    <div className="meta">
      <span>{card.kind}</span>
      {card.unsure && <span className="unsure" title="Gloss is not sure about this one">? unverified</span>}
      {card.latencyS !== undefined && <span>{card.latencyS.toFixed(1)} s</span>}
    </div>
  );
}

function Hero({ card }: { card: Card }) {
  return (
    <article className="hero" key={card.key}>
      <div className="label accent">Heard just now</div>
      <h2 dir="auto">{card.canonical}</h2>
      <Meta card={card} />
      <p className="one" dir="auto">{card.oneLiner}</p>
      {card.bullets.length > 0 && (
        <ul dir="auto">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
      )}
      {card.whyHere && <p className="why" dir="auto"><b>Why here</b> {card.whyHere}</p>}
      <Actions card={card} />
    </article>
  );
}

function Fit({ relation }: { relation: Relation }) {
  return (
    <article className="fit">
      <div className="label">How it fits</div>
      <h3 dir="auto">{relation.terms.join(' + ')}</h3>
      <p dir="auto">{relation.how}</p>
      {relation.gotcha && <p className="gotcha" dir="auto"><b>Gotcha</b> {relation.gotcha}</p>}
    </article>
  );
}

function Row({ card, open, onToggle }: { card: Card; open: boolean; onToggle(): void }) {
  return (
    <article className={`row ${open ? 'open' : ''}`}>
      <button className="row-head" onClick={onToggle} aria-expanded={open}>
        <span className="term" dir="auto">{card.canonical}{card.unsure && <span className="unsure"> ?</span>}</span>
        <span className="one" dir="auto">{card.oneLiner}</span>
      </button>
      {open && (
        <div className="row-body">
          <ul dir="auto">{card.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {card.whyHere && <p className="why" dir="auto"><b>Why here</b> {card.whyHere}</p>}
          <Actions card={card} />
        </div>
      )}
    </article>
  );
}

export function Live({ onSettings }: { onSettings(): void }) {
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
    <div className="live">
      <header>
        <StatusPill />
        <button className="icon" onClick={onSettings} aria-label="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 7h10v2H4zm12 0h4v2h-4zM4 15h4v2H4zm6 0h10v2H10zm4-10h2v6h-2zm-6 8h2v6H8z" /></svg>
        </button>
      </header>

      <div className="scroll">
        {error && <p className="banner error" role="alert">{error}</p>}
        {notice && <p className="banner" role="status">{notice}</p>}
        <Transcript />

        {pinned.length > 0 && (
          <div className="pins" aria-label="Pinned terms">
            {pinned.map((c) => <button key={c.key} onClick={() => setOpenKey(c.key)} dir="auto">{c.canonical}</button>)}
          </div>
        )}

        {hero ? <Hero card={hero} /> : (
          <div className="empty">
            <p>{thinking ? 'Checking that for jargon…' : 'Cards appear here when a term comes up.'}</p>
            <p className="faint">Most sentences need none. That’s the idea.</p>
          </div>
        )}
        {fit && <Fit relation={fit} />}
        {hero && thinking && <p className="thinking">Checking the last sentence…</p>}

        {earlier.length > 0 && (
          <section className="earlier" aria-label="Earlier terms">
            <div className="label">Earlier</div>
            {earlier.map((c) => (
              <Row key={c.key} card={c} open={openKey === c.key} onToggle={() => setOpenKey(openKey === c.key ? null : c.key)} />
            ))}
          </section>
        )}
        {relations.slice(1).map((r) => <Fit key={r.key} relation={r} />)}
      </div>

      <footer>
        {phase === 'listening'
          ? <button className="btn" onClick={pause}>Pause</button>
          : <button className="btn primary" onClick={() => void resume()}>Resume</button>}
        <button className="btn" onClick={end}>End</button>
      </footer>
    </div>
  );
}
