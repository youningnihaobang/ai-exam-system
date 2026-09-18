import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { getSettings, initStore } from './store.js';
import { aiStatus, setActiveModel } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

await initStore();

// 恢复前端「模型设置」里选中的模型（为空则沿用 .env / CLI 默认）
setActiveModel(getSettings().model || '');

const app = express();
app.use(express.json({ limit: '2mb' }));

// 接口访问日志：便于在终端观察 AI 请求的进度与耗时
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api')) {
      console.log(`[http] ${req.method} ${req.originalUrl} → ${res.statusCode} · ${Date.now() - startedAt}ms`);
    }
  });
  next();
});

app.use('/api', routes);
app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || '服务器内部错误';

  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = '单个文件不能超过 10MB';
  } else if (err.code === 'LIMIT_FILE_COUNT') {
    status = 400;
    message = '上传文件数量过多';
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    status = 400;
    message = '上传字段不正确';
  }

  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  const { configured, model, auth, environment } = aiStatus();
  console.log(`\n  试卷模拟系统已启动: http://localhost:${PORT}`);
  console.log(`  AI 服务: ${configured ? '已就绪' : '不可用'} · 认证 ${auth} · 模型 ${model} · 环境 ${environment}\n`);
});
