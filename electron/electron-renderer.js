import { BrowserWindow, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

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
  [aria-label="Player controls" i],
  #hud, [class*="hud" i], [class*="player-ui" i], [class*="playbar" i],
  [class*="play-bar" i], [class*="timecode" i], [class*="time-code" i] { display: none !important; }
`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForPaint(wc, timeout) {
  return new Promise((resolve) => {
    const onPaint = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { wc.removeListener('paint', onPaint); resolve(); }, timeout);
    wc.once('paint', onPaint);
  });
}

// Center-crop to the target aspect ratio, then scale. Scaling a capture that is
// one pixel off would stretch the picture ("拉扯"), so crop first: geometry stays
// exact and consecutive frames keep identical framing.
function fitToSize(img, width, height) {
  const size = img.getSize();
  if (size.width === width && size.height === height) return img;

  const targetRatio = width / height;
  const sourceRatio = size.width / size.height;
  let out = img;

  if (Math.abs(sourceRatio - targetRatio) > 1e-3) {
    let crop;
    if (sourceRatio > targetRatio) {
      const w = Math.max(1, Math.min(size.width, Math.round(size.height * targetRatio)));
      crop = { x: Math.round((size.width - w) / 2), y: 0, width: w, height: size.height };
    } else {
      const h = Math.max(1, Math.min(size.height, Math.round(size.width / targetRatio)));
      crop = { x: 0, y: Math.round((size.height - h) / 2), width: size.width, height: h };
    }
    out = img.crop(crop);
  }

  return out.resize({ width, height, quality: 'good' });
}

/**
 * Renders HTML to frames using Electron's own bundled Chromium (offscreen
 * BrowserWindow + capturePage). Ships ZERO extra browser; it reuses the
 * Chromium that Electron already contains.
 *
 * Usage: open() loads the page and reports what the page needs (duration,
 * audio files), then capture() streams frames. open() is separate so the
 * encoder can be started with the audio tracks already known.
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
    this.wc = null;
    this.opened = null;
  }

  async cancel() {
    this.cancelled = true;
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
    this.win = null;
    this.wc = null;
  }

  async close() {
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
    this.win = null;
    this.wc = null;
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

  /** Load the page and report duration + audio sources. */
  async open(inputPath) {
    const file = this.resolveFile(inputPath);
    this.onLog(`正在载入 ${file}`);

    // An offscreen window always captures at the display's device scale factor
    // (2x on Retina), so size the window to target/scaleFactor and zoom the page
    // by the inverse: the captured surface lands at exactly the target size.
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
    const captureScale = this.quality === 'high' ? 2 : 1;
    const zoom = captureScale / scaleFactor;
    const winW = Math.max(1, Math.round((this.width * captureScale) / scaleFactor));
    const winH = Math.max(1, Math.round((this.height * captureScale) / scaleFactor));

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
    const wc = (this.wc = this.win.webContents);
    wc.setFrameRate(60);

    await this.win.loadFile(file);
    wc.setZoomFactor(zoom);

    if (this.hideControls) {
      await wc.insertCSS(HIDE_CONTROLS_CSS);
      this.onLog('导出时隐藏播放器控件');
    }

    await wc.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
    );
    await delay(300);

    // Click through any "start / play" cover so the page's own clock begins.
    const started = await wc
      .executeJavaScript('window.__h2m_autostart ? window.__h2m_autostart() : false')
      .catch(() => false);
    if (started) {
      await delay(250);
    }

    const info = await wc
      .executeJavaScript(
        'JSON.stringify({ probe: window.__h2m_probe ? window.__h2m_probe() : null, audio: window.__h2m_audio ? window.__h2m_audio() : [] })'
      )
      .then((s) => JSON.parse(s))
      .catch(() => ({ probe: null, audio: [] }));

    await wc.executeJavaScript('window.__h2m_pause && window.__h2m_pause()');

    const audio = [];
    for (const item of info.audio || []) {
      const local = toLocalPath(item.src);
      if (!local || !fs.existsSync(local)) continue;
      if (audio.some((a) => a.path === local)) continue;
      audio.push({ path: local, volume: Number(item.volume) || 1 });
    }

    const pageDuration = info.probe && Number.isFinite(info.probe.duration) ? info.probe.duration : 0;
    this.opened = {
      file,
      audio,
      pageDuration,
      durationSource: (info.probe && info.probe.source) || '',
      started,
    };

    if (pageDuration > 0) {
      this.onLog(`页面时长：${pageDuration.toFixed(2)} 秒（${this.opened.durationSource}）`);
    }
    if (audio.length > 0) {
      this.onLog(`找到 ${audio.length} 个音轨：${audio.map((a) => path.basename(a.path)).join('、')}`);
    }

    return this.opened;
  }

  /** Capture one frame per tick until the requested duration is covered. */
  async capture({ onFrame }) {
    if (!this.wc) throw new Error('渲染器尚未打开页面（先调用 open）；');
    const wc = this.wc;
    const totalFrames = Math.ceil(this.fps * this.duration);
    const frameDuration = 1000 / this.fps;
    const captureType = this.quality === 'high' ? 'png' : 'jpeg';

    this.onLog(`渲染：${this.width}x${this.height} @ ${this.fps}fps · ${this.duration}s · ${totalFrames} 帧`);
    this.onLog('正在捕获帧…');

    for (let i = 0; i < totalFrames; i++) {
      if (this.cancelled) {
        this.onLog('渲染已取消');
        return null;
      }

      // The page resolves this only after a real compositor frame, so the
      // captured surface already holds the state for this frame index.
      await wc.executeJavaScript(`window.__h2m_advance(${frameDuration})`);
      await waitForPaint(wc, 16);

      let img = await wc.capturePage();
      const size = img.getSize();
      if (i === 0) this.onLog(`捕获画布：${size.width}x${size.height}（目标 ${this.width}x${this.height}）`);
      img = fitToSize(img, this.width, this.height);

      const buffer = captureType === 'jpeg' ? img.toJPEG(92) : img.toPNG();
      await onFrame(buffer, i);
      this.onProgress(Math.round(((i + 1) / totalFrames) * 95));
    }

    this.onLog(`已捕获 ${totalFrames} 帧`);
    return { totalFrames };
  }

  /** Convenience path: open + capture in one call. */
  async render(inputPath, { onFrame }) {
    try {
      await this.open(inputPath);
      return await this.capture({ onFrame });
    } finally {
      await this.close();
    }
  }
}

function toLocalPath(src) {
  if (!src) return null;
  try {
    if (src.startsWith('file:')) return fileURLToPath(src);
    return path.resolve(decodeURIComponent(src));
  } catch {
    return null;
  }
}

export { pathToFileURL };
