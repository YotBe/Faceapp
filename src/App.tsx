import { useState } from 'react';
import { startDemo, startLive } from './pipeline/session.js';
import { useGloss } from './store.js';
import { CheatSheet } from './ui/CheatSheet.js';
import { CardsIcon, ScreenIcon, SpeakerIcon } from './ui/icons.js';
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
        <main className="screen home">
          <nav className="navbar">
            <span />
            <button className="navbtn text" onClick={() => setSettings('open')}>Settings</button>
          </nav>
          <h1 className="large-title">Gloss</h1>
          <p className="lede">Explains the jargon in a meeting while it’s being said.</p>

          <ul className="group tips">
            <li><span className="tip-icon"><SpeakerIcon /></span><div><b>Play the call out loud</b><span>Gloss hears the room through this phone’s microphone. It can’t hear headphones.</span></div></li>
            <li><span className="tip-icon"><ScreenIcon /></span><div><b>Keep Gloss open</b><span>Listening stops if you switch apps or lock the phone.</span></div></li>
            <li><span className="tip-icon"><CardsIcon /></span><div><b>Glance when you need to</b><span>A card appears only for terms you might not know.</span></div></li>
          </ul>

          <div className="home-actions">
            {error && <p className="banner error" role="alert">{error}</p>}
            <button className="btn filled" onClick={listen}>Start Listening</button>
            <button className="btn plain" onClick={() => void startDemo()}>Watch Demo</button>
          </div>
        </main>
      )}
      {(phase === 'listening' || phase === 'paused') && <Live />}
      {phase === 'ended' && <CheatSheet />}
      {settings && <Settings needKeys={settings === 'needKeys'} onClose={() => setSettings(null)} />}
    </>
  );
}
