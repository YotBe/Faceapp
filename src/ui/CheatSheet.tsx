import { useState } from 'react';
import { home } from '../pipeline/session.js';
import { cheatSheetText } from '../pipeline/policy.js';
import { useGloss } from '../store.js';

export function CheatSheet() {
  const cards = useGloss((s) => s.cards);
  const relations = useGloss((s) => s.relations);
  const elapsed = useGloss((s) => s.elapsedMs);
  const demo = useGloss((s) => s.demo);
  const [shared, setShared] = useState('');

  const inOrder = [...cards].sort((a, b) => a.at - b.at);
  const minutes = Math.max(1, Math.round(elapsed / 60000));
  const title = `Gloss cheat sheet — ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const share = async () => {
    const text = cheatSheetText(cards, relations, title);
    try {
      if (navigator.share) await navigator.share({ title, text });
      else {
        await navigator.clipboard.writeText(text);
        setShared('Copied.');
      }
    } catch (e) {
      // Closing the share sheet is not an error worth showing.
      if (!(e instanceof DOMException && e.name === 'AbortError')) setShared('Could not share from this browser.');
    }
  };

  return (
    <main className="sheet">
      <div className="sheet-head">
        <div className="label">{demo ? 'Demo' : 'This meeting'} · {minutes} min</div>
        <h1>Cheat sheet</h1>
        <p className="sub">
          {inOrder.length === 0 ? 'No new terms came up.' : `${inOrder.length} ${inOrder.length === 1 ? 'term' : 'terms'} you didn’t have to look up`}
        </p>
      </div>

      {inOrder.map((c) => (
        <article key={c.key}>
          <h2 dir="auto">{c.canonical}{c.unsure && <span className="unsure"> · unverified</span>}</h2>
          <p dir="auto">{c.oneLiner}</p>
          {c.bullets.length > 0 && <ul dir="auto">{c.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
        </article>
      ))}

      {relations.map((r) => (
        <article key={r.key} className="sheet-fit">
          <div className="label">How they fit</div>
          <h2 dir="auto">{r.terms.join(' + ')}</h2>
          <p dir="auto">{r.how}</p>
          {r.gotcha && <p dir="auto"><b>Gotcha</b> {r.gotcha}</p>}
        </article>
      ))}

      <div className="sheet-actions">
        {inOrder.length > 0 && <button className="btn dark" onClick={() => void share()}>Share</button>}
        <button className="btn ghost" onClick={home}>Done</button>
        {shared && <p className="fine" role="status">{shared}</p>}
      </div>
    </main>
  );
}
