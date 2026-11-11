import { useState } from 'react';
import { getKey, setKey } from '../keys.js';
import { useGloss } from '../store.js';

export function Settings({ needKeys, onClose }: { needKeys: boolean; onClose(): void }) {
  const [soniox, setSoniox] = useState(getKey('soniox'));
  const [anthropic, setAnthropic] = useState(getKey('anthropic'));
  const known = useGloss((s) => s.known);

  const save = () => {
    setKey('soniox', soniox);
    setKey('anthropic', anthropic);
    onClose();
  };
  const forget = () => {
    try {
      localStorage.removeItem('gloss.known');
    } catch {
      // Nothing stored to remove.
    }
    useGloss.setState({ known: [] });
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="panel">
        <h2>Keys and settings</h2>
        {needKeys && <p className="banner">Gloss needs both keys before it can listen. The demo works without them.</p>}
        <p className="fine">Gloss sends audio to Soniox for transcription and the text to Anthropic for the cards. Your keys stay on this phone.</p>
        <label>
          Soniox API key
          <input type="password" value={soniox} onChange={(e) => setSoniox(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <label>
          Anthropic API key
          <input type="password" value={anthropic} onChange={(e) => setAnthropic(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <button className="btn primary" onClick={save}>Save</button>
        <button className="btn quiet" onClick={onClose}>Cancel</button>

        <hr />
        <p className="fine">
          {known.length === 0 ? 'No terms marked “I know this” yet.' : `${known.length} ${known.length === 1 ? 'term' : 'terms'} marked “I know this” and never shown again.`}
        </p>
        {known.length > 0 && <button className="btn quiet" onClick={forget}>Show them again</button>}
        <p className="fine"><a href="/check.html">Run the phone check</a> — tests the microphone and both services.</p>
      </div>
    </div>
  );
}
