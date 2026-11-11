import { useState } from 'react';
import { startDemo, startLive } from './pipeline/session.js';
import { useGloss } from './store.js';
import { CheatSheet } from './ui/CheatSheet.js';
import { Live } from './ui/Live.js';
import { Settings } from './ui/Settings.js';

export function App() {
  const phase = useGloss((s) => s.phase);
  const error = useGloss((s) => s.error);
  const [settings, setSettings] = useState<null | 'open' | 'needKeys'>(null);

  const listen = async () => {
    if (!(await startLive())) setSettings('needKeys');
  };

  return (
    <>
      {phase === 'idle' && (
        <main className="home">
          <div className="home-top">
            <div className="logo" aria-hidden="true">G</div>
            <h1>Gloss</h1>
            <p className="tagline">Understand the jargon while it’s being said.</p>
          </div>
          <div className="home-actions">
            {error && <p className="banner error" role="alert">{error}</p>}
            <button className="btn primary" onClick={listen}>Start listening</button>
            <button className="btn" onClick={() => void startDemo()}>Watch a demo</button>
            <button className="btn quiet" onClick={() => setSettings('open')}>Keys and settings</button>
            <p className="fine">Put the phone near the speaker. Gloss hears the room, so the call has to play out loud — it can’t hear headphones.</p>
          </div>
        </main>
      )}
      {(phase === 'listening' || phase === 'paused') && <Live onSettings={() => setSettings('open')} />}
      {phase === 'ended' && <CheatSheet />}
      {settings && <Settings needKeys={settings === 'needKeys'} onClose={() => setSettings(null)} />}
    </>
  );
}
