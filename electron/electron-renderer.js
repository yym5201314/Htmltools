import { BrowserWindow, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(__dirname, 'timing-preload.cjs');

// Hides player chrome that would otherwise be baked into the export: native
// <video> controls plus common player-control bars (Remotion's player, custom
// video players, scrubbers/timelines). Toggleable from the UI.
const HIDE_CONTROLS_CSS = `
  video::-webkit-media-controls,
  video::-webkit-media-controls-enclosure,
  video::-webkit-media-controls-panel { display: none !important; opacity: 0 !important; }
  [class*="player-controls" i], [class*="PlayerControls" i],
  [class*="controls-container" i], [class*="ControlsContainer" i],
  [class*="control-bar" i], [class*="controlBar" i],
  [class*="video-controls" i], [class*="VideoControls" i],
  [class*="media-controls" i], [class*="playback-controls" i],
  [class*="timeline-bar" i], [class*="scrubber" i],
  [class*="seekbar" i], [class*="seek-bar" i],
  [class*="player-bar" i], [data-remotion-player-controls],
  [aria-label="Player controls" i] { display: none !important; }
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForPaint(wc, timeout) {
  return new Promise((resolve) => {
    const onPaint = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { wc.removeListener('paint', onPaint); resolve(); }, timeout);
    wc.once('paint', onPaint);
  });
}

/**
 * Renders HTML to frames using Electron's own bundled Chromium (offscreen
 * BrowserWindow + capturePage). Ships ZERO extra browser; it reuses the
 * Chromium that Electron already contains. The server calls render(input,
 * { onFrame }) and stays agnostic to the rendering backend.
 */
export class ElectronRenderer {
  constructor(options = {}) {
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.fps = options.fps || 30;
    this.duration = options.duration || 5;
    this.quality = options.quality || 'standard';
    this.hideControls = options.hideControls !== false;
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || (() => {});
    this.cancelled = false;
    this.win = null;
  }

  async cancel() {
    this.cancelled = true;
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
  }

  resolveFile(inputPath) {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      const indexPath = path.join(inputPath, 'index.html');
      if (!fs.existsSync(indexPath)) {
        throw new Error('文件夹里没有 index.html，请选择包含主 HTML 文件的文件夹。');
      }
      return indexPath;
    }
    return path.resolve(inputPath);
  }

  async render(inputPath, { onFrame }) {
    const totalFrames = Math.ceil(this.fps * this.duration);
    const frameDuration = 1000 / this.fps;
    const captureType = this.quality === 'high' ? 'png' : 'jpeg';

    // Key speed trick: an offscreen window always captures at the display's
    // device scale factor (e.g. 2x on Retina). We instead size the window to
    // target/scaleFactor and zoom the page by the inverse, so the captured
    // surface lands at exactly the target resolution, since reading back up to 4x
    // fewer pixels per frame. "high" captures at 2x for supersampling.
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
    const captureScale = this.quality === 'high' ? 2 : 1;
    const zoom = captureScale / scaleFactor;
    const winW = Math.max(1, Math.round((this.width * captureScale) / scaleFactor));
    const winH = Math.max(1, Math.round((this.height * captureScale) / scaleFactor));

    const qualityName = { draft: '草稿', high: '高画质' }[this.quality] || '标准';
    this.onLog(`渲染：${this.width}x${this.height} @ ${this.fps}fps · ${this.duration}s · ${totalFrames} 帧 · ${qualityName}`);

    this.win = new BrowserWindow({
      width: winW,
      height: winH,
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        zoomFactor: zoom,
        preload: PRELOAD,
      },
    });
    const wc = this.win.webContents;
    // Cap the offscreen paint rate; we drive time manually anyway.
    wc.setFrameRate(60);

    try {
      const file = this.resolveFile(inputPath);
      this.onLog(`正在载入 ${file}`);
      await this.win.loadFile(file);
      wc.setZoomFactor(zoom);

      if (this.hideControls) {
        await wc.insertCSS(HIDE_CONTROLS_CSS);
        this.onLog('导出时隐藏播放器控件');
      }

      // Let fonts + layout settle before the first capture.
      await wc.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
      await delay(300);

      // Click through any "start / play" cover so the page's own clock begins.
      const started = await wc
        .executeJavaScript('window.__h2m_autostart ? window.__h2m_autostart() : false')
        .catch(() => false);
      if (started) {
        this.onLog('已触发页面的开始播放交互');
        await delay(250);
      }

      await wc.executeJavaScript('window.__h2m_pause && window.__h2m_pause()');

      this.onLog('正在捕获帧…');

      for (let i = 0; i < totalFrames; i++) {
        if (this.cancelled) {
          this.onLog('渲染已取消');
          return null;
        }

        await wc.executeJavaScript(`window.__h2m_advance(${frameDuration})`);
        await waitForPaint(wc, 24);

        let img = await wc.capturePage();
        // Normalize to the exact target size (handles Retina 2x → crisp downscale).
        const size = img.getSize();
        if (i === 0) this.onLog(`捕获画布：${size.width}x${size.height}（目标 ${this.width}x${this.height}）`);
        if (size.width !== this.width || size.height !== this.height) {
          img = img.resize({ width: this.width, height: this.height, quality: 'good' });
        }

        const buffer = captureType === 'jpeg' ? img.toJPEG(92) : img.toPNG();
        await onFrame(buffer, i);
        this.onProgress(Math.round(((i + 1) / totalFrames) * 95));
      }

      this.onLog(`已捕获 ${totalFrames} 帧`);
      return { totalFrames };
    } finally {
      if (this.win && !this.win.isDestroyed()) {
        this.win.destroy();
      }
      this.win = null;
    }
  }
}
