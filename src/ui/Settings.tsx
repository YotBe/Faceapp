import { useState } from 'react';
import { getKey, setKey } from '../keys.js';
import { useGloss } from '../store.js';
import { Chevron } from './icons.js';

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
        <div className="grabber" aria-hidden="true" />
        <nav className="sheet-nav">
          <button className="navbtn text" onClick={onClose}>Cancel</button>
          <strong>Settings</strong>
          <button className="navbtn text bold" onClick={save}>Save</button>
        </nav>

        {needKeys && <p className="banner">Add both keys to start listening. The demo works without them.</p>}

        <h3 className="section-title">Transcription</h3>
        <div className="group">
          <label className="field">
            <span>Soniox key</span>
            <input type="password" value={soniox} onChange={(e) => setSoniox(e.target.value)} placeholder="Paste key" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
        </div>
        <p className="footnote">
          Turns speech into text. Create an account at <a href="https://console.soniox.com/signup" target="_blank" rel="noreferrer">console.soniox.com</a>, open <b>My First Project</b>, then <b>API Keys</b>.
        </p>

        <h3 className="section-title">Explanations</h3>
        <div className="group">
          <label className="field">
            <span>Anthropic key</span>
            <input type="password" value={anthropic} onChange={(e) => setAnthropic(e.target.value)} placeholder="Paste key" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
        </div>
        <p className="footnote">
          Writes the cards. Sign in at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">platform.claude.com</a>, add credit under <b>Billing</b>, then create a key under <b>API Keys</b>.
        </p>
        <p className="footnote">Keys are stored on this phone only. Audio goes to Soniox and the transcript to Anthropic; nothing else leaves the phone.</p>

        <h3 className="section-title">Known Terms</h3>
        <div className="group">
          <div className="cell"><span>Marked “Know It”</span><span className="value">{known.length}</span></div>
          {known.length > 0 && <button className="cell destructive" onClick={forget}>Reset Known Terms</button>}
        </div>
        <p className="footnote">Terms you mark “Know It” are never shown again.</p>

        <div className="group">
          <a className="cell link" href="/check.html"><span>Run Phone Check</span><Chevron /></a>
        </div>
        <p className="footnote">Tests the microphone and both services, and gives you a log to send if something doesn’t work.</p>
      </div>
    </div>
  );
}
