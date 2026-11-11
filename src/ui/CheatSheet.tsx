import { useState } from 'react';
import { home } from '../pipeline/session.js';
import { cheatSheetText } from '../pipeline/policy.js';
import { useGloss } from '../store.js';
import { ShareIcon } from './icons.js';

export function CheatSheet() {
  const cards = useGloss((s) => s.cards);
  const relations = useGloss((s) => s.relations);
  const elapsed = useGloss((s) => s.elapsedMs);
  const demo = useGloss((s) => s.demo);
  const [shared, setShared] = useState('');

  const inOrder = [...cards].sort((a, b) => a.at - b.at);
  const minutes = Math.max(1, Math.round(elapsed / 60000));
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const title = `Gloss cheat sheet — ${date}`;

  const share = async () => {
    const text = cheatSheetText(cards, relations, title);
    try {
      if (navigator.share) await navigator.share({ title, text });
      else {
        await navigator.clipboard.writeText(text);
        setShared('Copied to the clipboard.');
      }
    } catch (e) {
      // Closing the share sheet is not an error worth showing.
      if (!(e instanceof DOMException && e.name === 'AbortError')) setShared('Sharing isn’t available in this browser.');
    }
  };

  return (
    <main className="screen sheet">
      <nav className="navbar">
        <button className="navbtn text" onClick={home}>Done</button>
        {inOrder.length > 0 && <button className="navbtn" onClick={() => void share()} aria-label="Share"><ShareIcon /></button>}
      </nav>
      <h1 className="large-title">Cheat Sheet</h1>
      <p className="lede">
        {demo ? 'Demo' : date} · {minutes} min ·{' '}
        {inOrder.length === 0 ? 'no new terms' : `${inOrder.length} ${inOrder.length === 1 ? 'term' : 'terms'}`}
      </p>
      {shared && <p className="banner" role="status">{shared}</p>}

      {inOrder.length === 0 && (
        <div className="empty">
          <h2>Nothing to Look Up</h2>
          <p>No unfamiliar terms came up in this session.</p>
        </div>
      )}

      {inOrder.length > 0 && (
        <ul className="group">
          {inOrder.map((c) => (
            <li key={c.key} className="sheet-item">
              <h2 dir="auto">{c.canonical}{c.unsure && <span className="unsure"> · Unverified</span>}</h2>
              <p dir="auto">{c.oneLiner}</p>
              {c.bullets.length > 0 && <ul dir="auto">{c.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
            </li>
          ))}
        </ul>
      )}

      {relations.length > 0 && (
        <>
          <h3 className="section-title">How They Fit</h3>
          <ul className="group">
            {relations.map((r) => (
              <li key={r.key} className="sheet-item">
                <h2 dir="auto">{r.terms.join(' + ')}</h2>
                <p dir="auto">{r.how}</p>
                {r.gotcha && <p className="gotcha" dir="auto"><b>Watch for</b> {r.gotcha}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
