import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

console.log('html2mp4 依赖检查\n');

const checks = [];

// Node version
const nodeMajor = parseInt(process.version.slice(1));
checks.push({
  name: 'Node.js',
  ok: nodeMajor >= 18,
  detail: nodeMajor >= 18 ? `${process.version} ✓` : `${process.version}（需要 v18+）`,
});

// FFmpeg (bundled binary used for encoding)
try {
  const ffmpegPath = (await import('ffmpeg-static')).default;
  const exists = !!ffmpegPath && fs.existsSync(ffmpegPath);
  checks.push({ name: 'FFmpeg', ok: exists, detail: exists ? `${ffmpegPath} ✓` : '未找到二进制文件' });
} catch {
  checks.push({ name: 'FFmpeg', ok: false, detail: 'ffmpeg-static 未安装，请运行：npm install' });
}

// Electron (the runtime + the Chromium used for rendering)
try {
  const electronPath = require('electron');
  const exists = typeof electronPath === 'string' && fs.existsSync(electronPath);
  checks.push({ name: 'Electron', ok: exists, detail: exists ? `${electronPath} ✓` : '未找到二进制文件' });
} catch {
  checks.push({ name: 'Electron', ok: false, detail: '未安装，请运行：npm install' });
}

console.log('检查结果：');
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}`);

const allGood = checks.every((c) => c.ok);
console.log('');
console.log(allGood ? '依赖齐全，运行 npm start 启动应用' : '部分依赖缺失，请运行：npm install');
process.exit(allGood ? 0 : 1);
