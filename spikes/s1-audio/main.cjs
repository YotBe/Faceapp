// Spike S1: mic + system-audio loopback, two RMS meters, 5 s debug WAVs.
// Throwaway. Run with: npm run spike:s1
const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'out');

app.whenReady().then(async () => {
  // Chromium only hands out system audio as part of a display-media stream.
  // Grant the first screen with loopback audio; the renderer drops the video.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(
      (sources) => {
        if (!sources[0]) return callback(null);
        // 'loopback' is Windows and macOS 14.2+ only. On Linux this yields no
        // audio track; the renderer falls back to an input-device picker.
        callback(process.platform === 'linux' ? { video: sources[0] } : { video: sources[0], audio: 'loopback' });
      },
      () => callback(null),
    );
  });

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  ipcMain.handle('save-wav', (_e, name, bytes) => {
    if (!/^(me|them)$/.test(name)) throw new Error('bad name');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${name}.wav`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return file;
  });
  ipcMain.handle('env', () => ({
    platform: process.platform,
    osRelease: process.getSystemVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    micAccess: process.platform === 'linux' ? 'n/a' : systemPreferences.getMediaAccessStatus('microphone'),
    screenAccess: process.platform === 'linux' ? 'n/a' : systemPreferences.getMediaAccessStatus('screen'),
  }));

  const win = new BrowserWindow({
    width: 760,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
