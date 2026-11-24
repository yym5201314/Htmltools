import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { ElectronRenderer } from './electron-renderer.js';

// Deterministic, headless-friendly offscreen rendering.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Pages that drive their timeline with <audio>/<video> call play() before any
// user gesture; allow it so their clock can start.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || '38470';
process.env.PORT = PORT;

// Render with Electron's own Chromium; no extra browser is bundled.
globalThis.__h2m_createRenderer = (opts) => new ElectronRenderer(opts);

let mainWindow;

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http.get(url, (res) => { res.destroy(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error('服务启动超时'));
          else setTimeout(tryOnce, 250);
        });
    };
    tryOnce();
  });
}

function defaultOutputDir() {
  return path.join(os.homedir(), 'html2mp4-output');
}

function registerIpc() {
  ipcMain.handle('h2m:pick-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择 HTML 文件',
      properties: ['openFile'],
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('h2m:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择包含 index.html 的文件夹',
      properties: ['openDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('h2m:pick-audio', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择音频文件（可选）',
      properties: ['openFile'],
      filters: [{ name: '音频/视频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'mp4'] }],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('h2m:pick-output', async (_event, suggested) => {
    // The UI passes the full "sibling of the HTML" path, so the dialog opens in
    // the piece's own folder and pre-fills its name.
    let defaultPath = typeof suggested === 'string' ? suggested.trim() : '';
    if (!defaultPath) {
      defaultPath = path.join(defaultOutputDir(), 'html2mp4-导出.mp4');
    } else if (!path.isAbsolute(defaultPath)) {
      defaultPath = path.join(defaultOutputDir(), defaultPath);
    }
    if (!/\.mp4$/i.test(defaultPath)) defaultPath += '.mp4';
    try { fs.mkdirSync(path.dirname(defaultPath), { recursive: true }); } catch {}

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存 MP4',
      defaultPath,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    });
    return canceled ? null : filePath;
  });

  ipcMain.handle('h2m:open-path', async (_event, target) => {
    if (!target) return false;
    // A missing file (e.g. the video was moved) falls back to its folder.
    const openTarget = fs.existsSync(target) ? target : path.dirname(target);
    try { return shell.openPath(openTarget); } catch { return false; }
  });

  ipcMain.handle('h2m:version', () => app.getVersion());
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 900,
    minWidth: 820,
    minHeight: 720,
    backgroundColor: '#F6F7F9',
    title: 'HTML 转视频',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the user's browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Start the embedded Express server (dynamic import so env vars above apply first).
  await import('../src/server.js');
  await waitForServer(`http://localhost:${PORT}/api/presets`);

  await mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.show();
}

app.whenReady().then(() => {
  // The default Electron menu is English and every entry duplicates something
  // the OS window or the inputs already provide, so drop the whole bar.
  Menu.setApplicationMenu(null);
  registerIpc();
  return createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
