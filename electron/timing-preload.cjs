// Runs in the page's main world (contextIsolation:false) BEFORE page scripts.
// Freezes time so frames can be captured deterministically, and exposes
// window.__h2m_* controls that the Electron main process drives per frame.
(() => {
  let currentTime = 0;
  let callbacks = [];
  let nextId = 1;

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    callbacks.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    callbacks = callbacks.filter((c) => c.id !== id);
  };

  performance.now = () => currentTime;
  const startDate = Date.now();
  Date.now = () => startDate + currentTime;

  // --- Media clocks -------------------------------------------------------
  // Pages whose timeline is driven by <audio>/<video> playback never advance
  // while the clock is frozen: the media would have to play in real time.
  // Instead we seek the media to the frame's timestamp, honoring the playback
  // rate the page assigned (e.g. a 5s clip slowed to 0.67x to fill a shot).
  const videoStart = new WeakMap();
  const SEEK_TIMEOUT = 220;

  function isVisible(el) {
    if (!el.isConnected) return false;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
        return false;
      }
    }
    return true;
  }

  function seekMedia(seconds) {
    const waits = [];
    for (const el of document.querySelectorAll('audio, video')) {
      if (!el.readyState) continue; // nothing decoded yet
      const duration = Number.isFinite(el.duration) ? el.duration : seconds;
      let target;

      if (el.tagName === 'AUDIO') {
        target = seconds; // audio is normally the master clock
      } else if (isVisible(el)) {
        if (!videoStart.has(el)) videoStart.set(el, seconds); // a clip starts when its shot shows up
        target = (seconds - videoStart.get(el)) * (el.playbackRate || 1);
      } else {
        videoStart.delete(el);
        continue;
      }

      target = Math.max(0, Math.min(target, duration));
      if (Math.abs(el.currentTime - target) < 0.002) continue;

      try {
        // Do NOT pause: pausing rejects a still-pending play() promise with
        // AbortError, and pages treat that as "playback refused" (they fall
        // back to their cover screen). Seeking alone pins the clock; the few
        // ms of real playback between frames is overwritten next frame.
        waits.push(
          new Promise((resolve) => {
            const done = () => {
              el.removeEventListener('seeked', done);
              resolve();
            };
            el.addEventListener('seeked', done);
            setTimeout(done, SEEK_TIMEOUT); // never let a stuck seek stall the render
            el.currentTime = target;
          })
        );
      } catch (e) {
        /* element not seekable, skip */
      }
    }
    if (waits.length === 0) return Promise.resolve();
    return Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, SEEK_TIMEOUT))]);
  }

  function flush() {
    if (document.getAnimations) {
      for (const a of document.getAnimations()) {
        try { a.currentTime = currentTime; } catch {}
      }
    }
    const pending = callbacks;
    callbacks = [];
    for (const { cb } of pending) {
      try { cb(currentTime); } catch (e) { /* noop */ }
    }
  }

  // Absolute seek (used by the probe) and per-frame advance (used by the renderer).
  window.__h2m_seek = (t) => {
    currentTime = t;
    return seekMedia(currentTime / 1000).then(() => {
      flush();
      return currentTime;
    });
  };
  window.__h2m_advance = (dt) => {
    currentTime += dt;
    return seekMedia(currentTime / 1000).then(() => {
      flush();
      return currentTime;
    });
  };
  window.__h2m_pause = () => {
    if (document.getAnimations) {
      for (const a of document.getAnimations()) { try { a.pause(); } catch {} }
    }
  };
  window.__h2m_time = () => currentTime;

  // Many pieces wait for a click on a cover / play button before starting their
  // timeline. Nobody clicks during a render, so dispatch a real click for them.
  const silentForUs = new WeakSet();

  window.__h2m_autostart = () => {
    // Silence media first: muted playback is never blocked, so the page's
    // play() promise resolves and its clock loop actually starts. Remember
    // which elements were audible, so the audio collector still reports them.
    for (const el of document.querySelectorAll('audio, video')) {
      if (!el.muted && !el.defaultMuted) silentForUs.add(el);
      el.muted = true;
      el.defaultMuted = true;
    }

    const groups = [
      '#cover, .cover, [class*="cover" i]',
      '.start, #start, .play, #play, [class*="start" i], [class*="play" i]',
      'button, [role="button"]',
    ];
    let target = null;
    for (const selector of groups) {
      const found = Array.from(document.querySelectorAll(selector)).filter((el) => isVisible(el));
      if (found.length > 0) {
        target = found[0];
        break;
      }
    }
    if (target == null) return false;

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch {}
    }
    return true;
  };

  // Audio that the page actually plays, so it can be muxed into the MP4.
  window.__h2m_audio = () => {
    const media = [...document.querySelectorAll('audio'), ...document.querySelectorAll('video')];
    const out = [];
    const seen = new Set();
    for (const m of media) {
      const silencedByUs = silentForUs.has(m);
      if (!silencedByUs && (m.muted || m.defaultMuted)) continue;
      const src = m.currentSrc || m.src || (m.querySelector('source[src]') || {}).src;
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push({ src, volume: typeof m.volume === 'number' ? m.volume : 1 });
    }
    return out;
  };

  // Best-effort guess of how long the piece runs. Pages expose this in wildly
  // different ways, so try the common ones in order of reliability.
  window.__h2m_probe = () => {
    const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0.2 && n <= 3600;

    for (const name of ['TOTAL', 'DURATION', 'TOTAL_TIME', 'TOTAL_DURATION', 'totalDuration', 'totalTime', 'videoDuration']) {
      try {
        const n = (0, eval)(name);
        if (valid(n)) return { duration: n, source: name };
      } catch (_) {}
    }

    for (const name of ['TL', 'SHOTS', 'SCENES', 'SEGMENTS', 'CLIPS', 'TIMELINE', 'scenes', 'timeline']) {
      try {
        const array = (0, eval)(name);
        if (!Array.isArray(array) || !array.length) continue;
        for (const key of ['d', 'dur', 'duration']) {
          if (array.every((x) => x && valid(x[key]))) {
            const n = array.reduce((a, x) => a + x[key], 0);
            if (valid(n)) return { duration: n, source: `${name}.${key}` };
          }
        }
      } catch (_) {}
    }

    const data = Number(document.body.dataset.duration || document.documentElement.dataset.duration);
    if (valid(data)) return { duration: data, source: 'data-duration' };

    const total = document.querySelector('#tcAll,#tc-all,.total-time,.total-duration');
    if (total) {
      const m = /(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)/.exec(total.textContent || '');
      if (m) {
        const n = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        if (valid(n)) return { duration: n, source: '时间码' };
      }
    }

    let max = 0;
    let mediaSource = '';
    for (const m of document.querySelectorAll('audio, video')) {
      if (valid(m.duration) && m.duration > max) {
        max = m.duration;
        mediaSource = '媒体时长';
      }
    }
    if (max) return { duration: max, source: mediaSource };

    for (const a of document.getAnimations()) {
      try {
        const timing = a.effect.getComputedTiming();
        if (typeof timing.endTime === 'number' && timing.endTime / 1000 > max) {
          max = timing.endTime / 1000;
          mediaSource = 'CSS 动画';
        }
      } catch (_) {}
    }
    return { duration: max, source: max ? mediaSource : '' };
  };
})();
