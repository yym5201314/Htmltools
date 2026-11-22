import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'child_process';

// When packaged inside an Electron asar, the ffmpeg binary is unpacked to
// app.asar.unpacked, because binaries can't run from inside the asar archive.
const FFMPEG = ffmpegStatic && ffmpegStatic.includes('app.asar')
  ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
  : ffmpegStatic;

/** Does this file carry a decodable audio stream? */
export function hasAudioStream(file) {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(false); }, 8000);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(/Stream #\d+:\d+.*: Audio:/.test(stderr));
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/** Keep only files that really contain audio. */
export async function playableAudio(tracks, onLog = () => {}) {
  const out = [];
  for (const track of tracks) {
    const ok = await hasAudioStream(track.path);
    if (ok) out.push(track);
    else onLog(`跳过没有音轨的文件：${track.path}`);
  }
  return out;
}

/**
 * Streaming encoder.
 *
 * Frames arrive on stdin as an image stream (image2pipe) and go straight into
 * FFmpeg, so rendering and encoding overlap with no intermediate PNGs.
 * Page audio (if any) is looped to the video length and mixed in as AAC.
 */
export class Encoder {
  constructor(options = {}) {
    this.fps = options.fps || 30;
    this.duration = options.duration || 0;
    this.quality = options.quality || 'standard';
    this.audio = options.audio || [];
    this.onLog = options.onLog || (() => {});
    this.process = null;
    this.donePromise = null;
    this.cancelled = false;
  }

  getCrf() {
    switch (this.quality) {
      case 'draft': return '28';
      case 'high': return '17';
      default: return '21';
    }
  }

  getPreset() {
    switch (this.quality) {
      case 'draft': return 'veryfast';
      case 'high': return 'slow';
      default: return 'medium';
    }
  }

  async start(outputPath) {
    const audio = await playableAudio(this.audio, this.onLog);

    const args = [
      '-y',
      '-f', 'image2pipe',
      '-framerate', String(this.fps),
      '-i', 'pipe:0',
    ];
    for (const track of audio) {
      args.push('-i', track.path);
    }

    // Even dimensions are required by yuv420p / H.264.
    const pad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
    if (audio.length > 0) {
      // Pad each track up to the video length so a short audio file leaves
      // silence instead of cutting the video short. `whole_dur` (rather than an
      // endless apad) keeps FFmpeg from running away past the last frame.
      const padTo = this.duration > 0 ? `,apad=whole_dur=${(this.duration + 0.5).toFixed(3)}` : '';
      const parts = [`[0:v]${pad}[v]`];
      audio.forEach((track, i) => {
        const volume = Math.max(0, Math.min(2, Number(track.volume) || 1)).toFixed(3);
        parts.push(`[${i + 1}:a]volume=${volume}${padTo}[a${i}]`);
      });
      const mixIn = audio.map((_, i) => `[a${i}]`).join('');
      parts.push(
        audio.length === 1
          ? `[a0]anull[a]`
          : `${mixIn}amix=inputs=${audio.length}:duration=longest:normalize=0[a]`
      );
      args.push('-filter_complex', parts.join(';'));
      args.push('-map', '[v]', '-map', '[a]');
    } else {
      args.push('-map', '0:v:0', '-vf', pad);
    }

    args.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', this.getCrf(),
      '-preset', this.getPreset(),
      '-movflags', '+faststart'
    );
    if (audio.length > 0) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    }
    // Trim to the exact frame count: padded audio would otherwise stretch the
    // container past the last frame.
    if (this.duration > 0) {
      const outDuration = Math.ceil(this.fps * this.duration) / this.fps;
      args.push('-t', outDuration.toFixed(3));
    }
    args.push(outputPath);

    this.onLog(`编码 → ${outputPath}${audio.length ? `（音轨 ${audio.length} 条）` : ''}`);
    this.process = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    let stderrTail = '';
    this.process.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    this.donePromise = new Promise((resolve, reject) => {
      this.process.on('close', (code) => {
        this.process = null;
        if (this.cancelled) return reject(new Error('编码已取消'));
        if (code === 0) resolve(outputPath);
        else reject(new Error(`FFmpeg 退出，代码 ${code}：\n${stderrTail.slice(-600)}`));
      });
      this.process.on('error', (err) => {
        this.process = null;
        reject(new Error(`FFmpeg 错误：${err.message}`));
      });
    });

    // Swallow EPIPE if the process dies while we're still writing.
    this.process.stdin.on('error', () => {});

    // Resolve as soon as FFmpeg is running: awaiting donePromise here would
    // deadlock, since FFmpeg cannot finish before we feed it frames.
    return { done: this.donePromise };
  }

  /** Write one encoded frame (PNG or JPEG buffer), honoring backpressure. */
  writeFrame(buffer) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin.writable) {
        return reject(new Error('编码器数据流不可写'));
      }
      const ok = this.process.stdin.write(buffer);
      if (ok) resolve();
      else this.process.stdin.once('drain', resolve);
    });
  }

  /** Close the input stream and wait for FFmpeg to finish muxing. */
  async finish() {
    if (this.process && this.process.stdin.writable) {
      this.process.stdin.end();
    }
    return this.donePromise;
  }

  cancel() {
    this.cancelled = true;
    if (this.process) {
      try { this.process.stdin.destroy(); } catch {}
      this.process.kill('SIGKILL');
    }
  }
}
