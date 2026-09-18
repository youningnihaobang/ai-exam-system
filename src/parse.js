import mammoth from 'mammoth';
import iconv from 'iconv-lite';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 前端 input[accept] 与后端白名单保持一致 */
export const ACCEPT_EXT = ['pdf', 'docx', 'txt', 'md', 'markdown'];
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 拼给 AI 的大纲正文上限（字符），超出部分截断 */
export const MAX_OUTLINE_CHARS = 60000;

function extOf(name = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function isAccepted(name) {
  return ACCEPT_EXT.includes(extOf(name));
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 纯文本解码：自动去 BOM，并在 UTF-8 明显不可读时回退 GBK */
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer, 'utf16le').replace(/^﻿/, '');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer.swap16(), 'utf16le').replace(/^﻿/, '');
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf-8').replace(/^﻿/, '');
  }
  const utf8 = buffer.toString('utf-8');
  const broken = (utf8.match(/�/g) || []).length;
  if (broken > 0 && broken / Math.max(1, utf8.length) > 0.01) {
    try {
      return iconv.decode(buffer, 'gbk');
    } catch {
      /* 退回 utf-8 */
    }
  }
  return utf8;
}

/** 规整提取结果：统一换行、压缩空行 */
function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let pdfLoader = null;
async function loadPdfParse() {
  if (!pdfLoader) {
    pdfLoader = import('pdf-parse/lib/pdf-parse.js')
      .catch(() => import('pdf-parse'))
      .then((m) => m.default || m);
  }
  return pdfLoader;
}

/* ------------------------- 扫描版 PDF：本地 OCR 兜底 ------------------------- */

/** OCR 脚本路径（macOS Vision，无文本层的页面渲染后识别） */
const OCR_SCRIPT = fileURLToPath(new URL('./ocr.swift', import.meta.url));
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 240000;

/** swift 是否可用（只探测一次） */
let swiftOk = null;
function hasSwift() {
  if (swiftOk !== null) return Promise.resolve(swiftOk);
  return new Promise((resolve) => {
    const child = spawn('swift', ['--version'], { stdio: 'ignore' });
    child.on('error', () => {
      swiftOk = false;
      resolve(false);
    });
    child.on('exit', (code) => {
      swiftOk = code === 0;
      resolve(swiftOk);
    });
  });
}

/**
 * 用 macOS Vision 对 PDF 做本地 OCR（支持扫描件 / 图片型 PDF）。
 * 返回文本；失败抛错，由调用方决定是否降级提示。
 */
async function ocrPdf(buffer) {
  if (process.platform !== 'darwin') {
    throw new Error('扫描版 PDF 识别目前仅支持 macOS');
  }
  if (!(await hasSwift())) {
    throw new Error('未检测到 swift 命令（需安装 Xcode Command Line Tools）');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'exam-ocr-'));
  const file = path.join(dir, 'input.pdf');
  await writeFile(file, buffer);

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('swift', [OCR_SCRIPT, file]);
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`OCR 超时（${Math.round(OCR_TIMEOUT_MS / 1000)}s）`));
      }, OCR_TIMEOUT_MS);

      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 OCR：${e.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const text = tidy(out);
        if (code === 0 && text.length > 20) resolve(text);
        else reject(new Error(`OCR 未得到有效文本（exit=${code}）${err ? `：${err.slice(-200)}` : ''}`));
      });
    });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 从上传文件（内存 Buffer）中提取纯文本 */
export async function extractText({ originalname, buffer }) {
  const ext = extOf(originalname);

  if (ext === 'pdf') {
    const pdfParse = await loadPdfParse();
    const data = await pdfParse(buffer);
    const text = tidy(data?.text);
    // 文本层几乎为空 → 大概率是扫描件 / 图片型 PDF，尝试本地 OCR
    if (text.length < 30) {
      console.log(`[parse] PDF 无文本层（${text.length} 字），尝试本地 OCR…`);
      try {
        const ocrText = await ocrPdf(buffer);
        console.log(`[parse] OCR 完成 · ${ocrText.length} 字`);
        return ocrText;
      } catch (e) {
        throw new Error(
          `该 PDF 是扫描件 / 图片型，无法直接提取文字，本地 OCR 也失败了（${e.message}）。` +
            `可改用文字版 PDF / Word / TXT，或把大纲文字直接粘贴到输入框。`
        );
      }
    }
    return text;
  }

  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return tidy(value);
  }

  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc，请用 Word 另存为 .docx 后上传');
  }

  if (ACCEPT_EXT.includes(ext)) {
    return tidy(decodeText(buffer));
  }

  throw new Error(`不支持的文件类型「${ext || '未知'}」，请上传 PDF / Word(.docx) / TXT`);
}
