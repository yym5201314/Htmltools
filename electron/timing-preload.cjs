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
  window.__h2m_autostart = () => {
    // Silence media first: muted playback is never blocked, so the page's
    // play() promise resolves and its clock loop actually starts.
    for (const el of document.querySelectorAll('audio, video')) {
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
})();
