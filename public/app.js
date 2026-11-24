// HTML 转视频 · 前端
const $ = (id) => document.getElementById(id);

const el = {
  version: $('version'),
  inputPath: $('inputPath'),
  outputPath: $('outputPath'),
  pickFile: $('pickFile'),
  pickFolder: $('pickFolder'),
  pickOutput: $('pickOutput'),
  audioMode: $('audioMode'),
  audioPath: $('audioPath'),
  pickAudio: $('pickAudio'),
  audioHint: $('audioHint'),
  resChips: $('resChips'),
  width: $('width'),
  height: $('height'),
  fps: $('fps'),
  duration: $('duration'),
  autoDuration: $('autoDuration'),
  durationHint: $('durationHint'),
  quality: $('quality'),
  hideControls: $('hideControls'),
  startBtn: $('startBtn'),
  cancelBtn: $('cancelBtn'),
  openVideo: $('openVideo'),
  openFolder: $('openFolder'),
  barFill: $('barFill'),
  status: $('status'),
  percent: $('percent'),
  log: $('log'),
  fallbackFile: $('fallbackFile'),
};

const desktop = !!window.h2m;

const state = {
  inputPath: '',
  inputName: '',
  outputPath: '',
  audioPath: '',
  durationTouched: false,
  probing: false,
  jobId: '',
  timer: null,
  outputDir: '',
  pageAudio: [],
};

// ---------------------------------------------------------------- helpers
function setStatus(text) {
  el.status.textContent = text;
}

function setPercent(value) {
  const p = Math.max(0, Math.min(100, Math.round(value || 0)));
  el.percent.textContent = `${p}%`;
  el.barFill.style.width = `${p}%`;
}

function appendLog(line) {
  if (!line) return;
  el.log.textContent = el.log.textContent ? `${el.log.textContent}\n${line}` : line;
  el.log.scrollTop = el.log.scrollHeight;
}

function setHint(node, text, cls) {
  node.textContent = text;
  node.className = `hint${cls ? ` ${cls}` : ''}`;
}

function baseName(p) {
  const name = String(p || '').replace(/\\/g, '/').split('/').pop() || '';
  return name.replace(/\.(html?|htm)$/i, '');
}

function dirOf(p) {
  return String(p || '').replace(/[\\/][^\\/]*$/, '');
}

// Output defaults to a sibling of the chosen HTML, named after it.
function defaultOutputFor(p) {
  const dir = dirOf(p);
  const name = baseName(p) || 'html2mp4-导出';
  return dir ? `${dir}\\${name}.mp4` : `${name}.mp4`;
}

// ------------------------------------------------------------- input pick
el.pickFile.addEventListener('click', async () => {
  if (desktop) {
    const p = await window.h2m.pickFile();
    if (p) setInput(p, false);
  } else {
    el.fallbackFile.click();
  }
});

el.pickFolder.addEventListener('click', async () => {
  if (desktop) {
    const p = await window.h2m.pickFolder();
    if (p) setInput(p, true);
  } else {
    setHint(el.durationHint, '浏览器模式下不支持选择文件夹，请用桌面版', 'warn');
  }
});

el.fallbackFile.addEventListener('change', () => {
  const file = el.fallbackFile.files && el.fallbackFile.files[0];
  if (file) setInput(file.name, false);
});

el.pickOutput.addEventListener('click', async () => {
  if (!desktop) return;
  const suggested = state.outputPath || (state.inputPath ? defaultOutputFor(state.inputPath) : '');
  const p = await window.h2m.pickOutput(suggested);
  if (p) {
    state.outputPath = p;
    el.outputPath.value = p;
  }
});

el.audioMode.addEventListener('change', () => {
  const mode = el.audioMode.value;
  el.pickAudio.disabled = mode !== 'file';
  if (mode === 'mute') {
    setHint(el.audioHint, '不生成音轨');
  } else if (mode === 'file') {
    setHint(el.audioHint, state.audioPath ? `使用指定音频：${state.audioPath}` : '请选择一个音频文件');
  } else {
    showPageAudio();
  }
});

el.pickAudio.addEventListener('click', async () => {
  if (!desktop) return;
  const p = await window.h2m.pickAudio();
  if (p) {
    state.audioPath = p;
    el.audioPath.value = p;
    setHint(el.audioHint, `使用指定音频：${p}`);
  }
});

function showPageAudio() {
  if (!state.pageAudio.length) {
    setHint(el.audioHint, state.inputPath ? '页面里没有检测到音轨' : '选择 HTML 后自动检测页面里的音轨');
    return;
  }
  const names = state.pageAudio.map((a) => a.name).join('、');
  setHint(el.audioHint, `页面音轨：${names}`, 'ok');
}

async function setInput(path, isDir) {
  state.inputPath = path;
  state.inputName = baseName(path);
  el.inputPath.value = path;
  el.startBtn.disabled = false;
  state.durationTouched = false;
  state.pageAudio = [];
  showPageAudio();

  // Follow the HTML: same folder, same base name, .mp4 extension. When a folder
  // was picked the HTML lives inside it, so the video goes there too.
  const name = baseName(path) || 'html2mp4-导出';
  state.outputPath = isDir ? `${String(path).replace(/[\\/]+$/, '')}\\${name}.mp4` : defaultOutputFor(path);
  el.outputPath.value = state.outputPath;

  if (isDir) appendLog(`已选择文件夹：${path}`);
  await probe();
}

// ------------------------------------------------------------------ probe
async function probe() {
  if (!state.inputPath || state.probing) return;
  state.probing = true;
  setHint(el.durationHint, '正在识别页面时长…');
  el.autoDuration.disabled = true;

  try {
    const form = new FormData();
    form.append('config', JSON.stringify({ localPath: desktop ? state.inputPath : '', hideControls: el.hideControls.checked }));
    if (!desktop) {
      const file = el.fallbackFile.files && el.fallbackFile.files[0];
      if (!file) throw new Error('请先选择文件');
      form.append('files', file);
    }
    const res = await fetch('/api/probe', { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.pageAudio = data.audio || [];
    if (el.audioMode.value === 'page') showPageAudio();

    if (data.duration > 0) {
      const secs = Number(data.duration.toFixed(2));
      if (!state.durationTouched || !el.duration.value) el.duration.value = secs;
      setHint(el.durationHint, `已识别 ${secs} 秒${data.source ? `（来源：${data.source}）` : ''}`, 'ok');
      appendLog(`识别到页面时长 ${secs} 秒${data.source ? `（${data.source}）` : ''}`);
    } else {
      setHint(el.durationHint, '没能自动识别时长，请手动填写', 'warn');
    }
  } catch (err) {
    setHint(el.durationHint, `识别失败：${err.message}`, 'warn');
  } finally {
    state.probing = false;
    el.autoDuration.disabled = false;
  }
}

el.autoDuration.addEventListener('click', () => {
  state.durationTouched = false;
  probe();
});

el.duration.addEventListener('input', () => {
  state.durationTouched = true;
});

// ------------------------------------------------------------ resolution
el.resChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el.resChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  const w = Number(chip.dataset.w);
  const h = Number(chip.dataset.h);
  if (w > 0 && h > 0) {
    el.width.value = w;
    el.height.value = h;
  }
});

function syncChipsWithSize() {
  const w = Number(el.width.value);
  const h = Number(el.height.value);
  let matched = null;
  el.resChips.querySelectorAll('.chip').forEach((c) => {
    const cw = Number(c.dataset.w);
    const ch = Number(c.dataset.h);
    c.classList.toggle('active', cw === w && ch === h);
    if (cw === w && ch === h) matched = c;
  });
  if (!matched) {
    const custom = el.resChips.querySelector('[data-w="0"]');
    el.resChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    custom.classList.add('active');
  }
}

el.width.addEventListener('input', syncChipsWithSize);
el.height.addEventListener('input', syncChipsWithSize);

// ------------------------------------------------------------------ start
el.startBtn.addEventListener('click', startRender);

async function startRender() {
  if (!state.inputPath) return;
  const width = Number(el.width.value) || 1920;
  const height = Number(el.height.value) || 1080;
  const fps = Number(el.fps.value) || 30;
  const duration = Number(el.duration.value) || 0;
  const audioMode = el.audioMode.value;

  const config = {
    width, height, fps, duration,
    quality: el.quality.value,
    hideControls: el.hideControls.checked,
    mute: audioMode === 'mute',
    audioPath: audioMode === 'file' ? state.audioPath : '',
    localPath: desktop ? state.inputPath : '',
    outputPath: desktop ? state.outputPath : '',
    outputName: baseName(state.inputPath) || `html2mp4-${Date.now()}`,
  };

  const form = new FormData();
  form.append('config', JSON.stringify(config));
  if (!desktop) {
    const file = el.fallbackFile.files && el.fallbackFile.files[0];
    if (!file) {
      setStatus('请先选择文件');
      return;
    }
    form.append('files', file);
  }

  el.log.textContent = '';
  setPercent(0);
  setStatus('正在启动…');
  el.startBtn.disabled = true;
  el.cancelBtn.disabled = false;
  el.openVideo.disabled = true;
  el.openFolder.disabled = true;

  try {
    const res = await fetch('/api/render', { method: 'POST', body: form });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.jobId = data.jobId;
    poll();
  } catch (err) {
    fail(err.message);
  }
}

function poll() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(async () => {
    if (!state.jobId) return;
    try {
      const res = await fetch(`/api/job/${state.jobId}`);
      const job = await res.json();
      if (job.error && job.status !== 'complete') {
        // 任务不存在等接口级错误
        if (!job.status) throw new Error(job.error);
      }

      setPercent(job.progress || 0);
      if (job.progress <= 50) setStatus('正在渲染画面');
      else if (job.status !== 'complete') setStatus('正在编码视频');

      const text = (job.logs || []).join('\n');
      if (text !== el.log.textContent) {
        el.log.textContent = text;
        el.log.scrollTop = el.log.scrollHeight;
      }

      if (job.status === 'complete') {
        done(job);
      } else if (job.status === 'error') {
        fail(job.error || '转换失败', job.logs);
      } else if (job.status === 'cancelled') {
        reset();
        setStatus('已取消');
      }
    } catch (err) {
      if (err && err.message) fail(err.message);
    }
  }, 500);
}

function done(job) {
  clearInterval(state.timer);
  state.timer = null;
  setPercent(100);
  setStatus(`完成，用时 ${job.duration} 秒`);
  el.startBtn.disabled = false;
  el.cancelBtn.disabled = true;
  el.openVideo.disabled = false;
  el.openFolder.disabled = false;
  state.outputPath = job.outputPath;
  state.outputDir = job.outputDir;
  el.outputPath.value = job.outputPath;
}

function fail(message, logs) {
  clearInterval(state.timer);
  state.timer = null;
  el.startBtn.disabled = false;
  el.cancelBtn.disabled = true;
  setStatus('转换失败');
  if (logs && logs.length) el.log.textContent = logs.join('\n');
  appendLog(message);
  setHint(el.durationHint, message, 'warn');
}

function reset() {
  clearInterval(state.timer);
  state.timer = null;
  state.jobId = '';
  el.startBtn.disabled = false;
  el.cancelBtn.disabled = true;
  setPercent(0);
}

el.cancelBtn.addEventListener('click', async () => {
  if (!state.jobId) return;
  el.cancelBtn.disabled = true;
  setStatus('正在取消…');
  try {
    await fetch(`/api/job/${state.jobId}/cancel`, { method: 'POST' });
  } catch {}
  reset();
});

// ------------------------------------------------------------------ open
el.openVideo.addEventListener('click', async () => {
  if (!state.outputPath) return;
  if (desktop) await window.h2m.openPath(state.outputPath);
  else {
    await fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: state.outputPath }),
    });
  }
});

el.openFolder.addEventListener('click', async () => {
  const dir = state.outputDir || (state.outputPath || '').replace(/[\\/][^\\/]+$/, '');
  if (!dir) return;
  if (desktop) await window.h2m.openPath(dir);
  else {
    await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath: dir }),
    });
  }
});

// ------------------------------------------------------------------ init
(async function init() {
  if (desktop) {
    try {
      const v = await window.h2m.version();
      if (v) el.version.textContent = `v${v}`;
    } catch {}
  }

  try {
    const settings = await (await fetch('/api/settings')).json();
    if (settings.width) el.width.value = settings.width;
    if (settings.height) el.height.value = settings.height;
    if (settings.fps) el.fps.value = String(settings.fps);
    if (settings.quality) el.quality.value = settings.quality;
    syncChipsWithSize();
  } catch {}
})();
