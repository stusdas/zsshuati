const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createBackgroundGenerationJobs } = require('./background-generation-jobs');

const HOST = process.env.QUIZ_SITE_HOST || '0.0.0.0';
const PORT = Number(process.env.QUIZ_SITE_PORT || 8792);
const ROOT = __dirname;
const SERVER_CONFIG_FILE = process.env.QUIZ_SERVER_CONFIG_FILE || path.join(ROOT, 'server-config.local.json');
const UPSTREAM_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DATA_DIRECTORY = process.env.QUIZ_DATA_DIRECTORY || path.join(ROOT, '题库数据备份');
const STATE_FILE = path.join(DATA_DIRECTORY, '当前题库与学习记录.json');
const PUBLIC_SEED_FILE = path.join(ROOT, 'initial-public-state.json');
const BACKUP_DIRECTORY = path.join(DATA_DIRECTORY, '自动备份');
const RUNTIME_LOG_DIRECTORY = process.env.QUIZ_RUNTIME_LOG_DIRECTORY || path.join(ROOT, '运行日志');
const GENERATION_TIMING_FILE = path.join(RUNTIME_LOG_DIRECTORY, '题目生成步骤耗时记录_跨策略对比.jsonl');
const GENERATION_JOB_DIRECTORY = process.env.QUIZ_GENERATION_JOB_DIRECTORY || path.join(DATA_DIRECTORY, '生成任务');
const AUTH_SECRET_FILE = process.env.QUIZ_AUTH_SECRET_FILE || path.join(ROOT, 'auth-secret.local.json');
const SESSION_COOKIE = 'quiz_site_v1318_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const JSON_MODE_UNSUPPORTED_MODELS = new Set([
  'stepfun-ai/Step-3.5-Flash',
  'zai-org/GLM-4.5-Air'
]);
let lastArchiveBackupAt = 0;
let stateWriteQueue = Promise.resolve();

function readLocalJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`${label}读取失败：${error.message}`);
    return {};
  }
}

const LOCAL_SERVER_CONFIG = readLocalJson(SERVER_CONFIG_FILE, '本机服务配置');

function loadOrCreateAuthSecret() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_SECRET_FILE, 'utf8'));
    if (typeof parsed.secret === 'string' && parsed.secret.length >= 32) return parsed.secret;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`身份签名密钥读取失败：${error.message}`);
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(AUTH_SECRET_FILE, `${JSON.stringify({ secret }, null, 2)}\n`, 'utf8');
  return secret;
}

const AUTH_SECRET = loadOrCreateAuthSecret();

function queueStateWrite(task) {
  const queued = stateWriteQueue.then(task, task);
  stateWriteQueue = queued.catch(() => {});
  return queued;
}

function parseCookies(request) {
  return String(request.headers.cookie || '').split(';').reduce((result, item) => {
    const separator = item.indexOf('=');
    if (separator < 0) return result;
    result[item.slice(0, separator).trim()] = decodeURIComponent(item.slice(separator + 1).trim());
    return result;
  }, {});
}

function signSession(identity) {
  const payload = Buffer.from(JSON.stringify({ ...identity, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(identity.exp || 0) > Date.now() ? identity : null;
  } catch {
    return null;
  }
}

function requestUsesHttps(request) {
  const forwardedProtocol = String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(request?.socket?.encrypted) || forwardedProtocol === 'https' || process.env.QUIZ_COOKIE_SECURE === '1';
}

function sessionCookie(identity, request) {
  const secure = requestUsesHttps(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(identity))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function clearSessionCookie(request) {
  const secure = requestUsesHttps(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { password_salt: salt, password_scrypt: hash };
}

function verifyTeacherPassword(teacher, password) {
  if (!teacher) return false;
  if (teacher.password_salt && teacher.password_scrypt) {
    const actual = crypto.scryptSync(String(password), teacher.password_salt, 64);
    const expected = Buffer.from(teacher.password_scrypt, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  if (teacher.password_hash) {
    return crypto.createHash('sha256').update(String(password)).digest('hex') === teacher.password_hash;
  }
  return false;
}

const TEACHER_NAME = String(process.env.QUIZ_TEACHER_NAME || LOCAL_SERVER_CONFIG.teacherName || '').trim();
const TEACHER_PASSWORD = String(process.env.QUIZ_TEACHER_PASSWORD || LOCAL_SERVER_CONFIG.teacherPassword || '');
const TEACHER_CONFIGURED = Boolean(TEACHER_NAME && TEACHER_PASSWORD.length >= 8);
const FIXED_TEACHER = Object.freeze({
  teacher_id: String(process.env.QUIZ_TEACHER_ID || LOCAL_SERVER_CONFIG.teacherId || 'teacher_owner'),
  teacher_name: TEACHER_NAME || '未配置教师',
  ...(TEACHER_CONFIGURED ? passwordRecord(TEACHER_PASSWORD) : {})
});

// ===== V9 原版 AI 引导服务端配置（逐字移植自 ai-guide-server.js，模型名称与标签一字未改）=====
const UPSTREAM_TIMEOUT_MS = 30000; // 上游最长等待30秒，绝不让用户等更久
const LOCAL_SECRETS_PATH = path.join(ROOT, 'ai-guide-secrets.local.json');
const ZHIPU_KEY_FILE = path.join(ROOT, '智谱Key_只在本机填写.local.txt');
const STUDY_DATA_DIR = process.env.QUIZ_STUDY_DATA_DIRECTORY || path.join(ROOT, '错题本数据');
const STUDY_STORE_PATH = path.join(STUDY_DATA_DIR, '当前错题本与练习记录.json');
let LOCAL_SECRETS = {};
try {
  LOCAL_SECRETS = JSON.parse(fs.readFileSync(LOCAL_SECRETS_PATH, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') console.warn(`本机密钥文件读取失败：${error.message}`);
}
const SILICONFLOW_API_KEY = String(process.env.SILICONFLOW_API_KEY || LOCAL_SECRETS.siliconflowApiKey || '').trim();

function readLocalZhipuKey() {
  try {
    return fs.readFileSync(ZHIPU_KEY_FILE, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#')) || '';
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`智谱 Key 文件读取失败：${error.message}`);
    return '';
  }
}

const ZHIPU_API_KEY = String(
  process.env.ZHIPU_API_KEY
  || LOCAL_SECRETS.zhipuApiKey
  || readLocalZhipuKey()
  || ''
).trim();

// 各平台的密钥配置。硅基流动已预填现有 Key；智谱需要到 https://open.bigmodel.cn 注册后
// 在「API Keys」页面创建并粘贴（GLM-4-Flash 免费模型无限调用）。
const PROVIDERS = {
  siliconflow: {
    name: '硅基流动',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    apiKey: SILICONFLOW_API_KEY, // 环境变量优先，否则读取被 Git 忽略的本机密钥文件
    models: [
      { id: 'inclusionAI/Ling-flash-2.0', label: 'Ling-flash-2.0（压测最快0.3秒首字）', disableThinking: true },
      { id: 'zai-org/GLM-5.2', label: 'GLM-5.2（最聪明）', disableThinking: true },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek-V4-Flash（均衡）', disableThinking: true },
      { id: 'Qwen/Qwen3-8B', label: 'Qwen3-8B（免费 · 晚高峰易断流）', disableThinking: true }
    ]
  },
  zhipu: {
    name: '智谱',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: ZHIPU_API_KEY,
    models: [
      { id: 'glm-4-flash-250414', label: 'GLM-4-Flash-250414（免费 · 晚高峰易断流）' }
    ]
  }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

function ensureRuntimeLogDirectory() {
  fs.mkdirSync(RUNTIME_LOG_DIRECTORY, { recursive: true });
}

function normalizeGenerationTimingRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.strategy_version || !payload.task || !payload.model
    || !Number.isFinite(Number(payload.duration_ms))) return null;
  return {
    schema_version: 2,
    strategy_version: String(payload.strategy_version).slice(0, 160),
    run_id: String(payload.run_id || '').slice(0, 100),
    course_name: String(payload.course_name || '').slice(0, 200),
    task: String(payload.task).slice(0, 500),
    model: String(payload.model).slice(0, 200),
    attempt: Number(payload.attempt || 1),
    max_attempts: Number(payload.max_attempts || 1),
    status: String(payload.status || 'unknown').slice(0, 80),
    started_at: String(payload.started_at || ''),
    ended_at: String(payload.ended_at || new Date().toISOString()),
    duration_ms: Math.max(0, Math.round(Number(payload.duration_ms))),
    usage_reported: Boolean(payload.usage_reported),
    prompt_tokens: Math.max(0, Math.round(Number(payload.prompt_tokens || 0))),
    completion_tokens: Math.max(0, Math.round(Number(payload.completion_tokens || 0))),
    total_tokens: Math.max(0, Math.round(Number(payload.total_tokens || 0))),
    cached_prompt_tokens: Math.max(0, Math.round(Number(payload.cached_prompt_tokens || 0))),
    reasoning_tokens: Math.max(0, Math.round(Number(payload.reasoning_tokens || 0))),
    error_type: String(payload.error_type || '').slice(0, 100),
    error_code: String(payload.error_code || '').slice(0, 160),
    error_message: String(payload.error_message || '').slice(0, 500)
  };
}

function appendGenerationTimingRecord(payload) {
  const record = normalizeGenerationTimingRecord(payload);
  if (!record) throw new Error('INVALID_TIMING_PAYLOAD');
  ensureRuntimeLogDirectory();
  fs.appendFileSync(GENERATION_TIMING_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function handleGenerationTiming(request, response) {
  if (request.method === 'OPTIONS') {
    sendState(response, 204, {});
    return;
  }
  if (request.method !== 'POST') {
    sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  try {
    const payload = JSON.parse((await readRequestBody(request)).toString('utf8'));
    const record = normalizeGenerationTimingRecord(payload);
    if (!record) {
      sendState(response, 400, { code: 'INVALID_TIMING_PAYLOAD' });
      return;
    }
    // 只接受计时与状态字段，避免把课程资料、题目正文或密钥写进运行日志。
    appendGenerationTimingRecord(record);
    sendState(response, 200, { ok: true, file: path.basename(GENERATION_TIMING_FILE) });
  } catch (error) {
    sendState(response, 500, { code: 'TIMING_LOG_WRITE_FAILED', message: error.message });
  }
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyChatCompletion(request, response) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '600'
    });
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { message: 'Method not allowed' });
    return;
  }
  try {
    const identity = publicIdentity(readSession(request), readStatePayload().state);
    if (!identity) return sendJson(response, 401, { code: 'AUTH_REQUIRED', message: '请先登录' });
    if (!SILICONFLOW_API_KEY) return sendJson(response, 503, { code: 'PROVIDER_KEY_MISSING', message: '服务器尚未配置 AI 服务密钥' });
    const body = await readRequestBody(request);
    const controller = new AbortController();
    const proxyTimeoutMs = 150000;
    const proxyStartedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), proxyTimeoutMs);
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    let upstream;
    let responseBody;
    try {
      upstream = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
          'Accept': 'application/json'
        },
        body,
        signal: controller.signal
      });
      responseBody = Buffer.from(await upstream.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() - proxyStartedAt >= proxyTimeoutMs) {
      const timeoutError = new Error('UPSTREAM_WALL_CLOCK_TIMEOUT');
      timeoutError.name = 'AbortError';
      throw timeoutError;
    }
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'X-SiliconCloud-Trace-Id': upstream.headers.get('x-siliconcloud-trace-id') || ''
    });
    response.end(responseBody);
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    sendJson(response, timeout ? 504 : 502, {
      code: timeout ? 'LOCAL_PROXY_UPSTREAM_TIMEOUT' : 'LOCAL_PROXY_ERROR',
      message: timeout ? '本地代理等待硅基流动响应超时' : `本地代理请求失败：${error.message}`
    });
  }
}

async function callBackgroundGenerationModel(model, messages, generationOptions = {}, externalSignal) {
  if (!SILICONFLOW_API_KEY) {
    throw Object.assign(new Error('服务器尚未配置硅基流动 API Key'), { code: 'AUTH_ERROR', canFallback: false });
  }
  const controller = new AbortController();
  let stoppedByUser = false;
  const forwardAbort = () => { stoppedByUser = true; controller.abort(); };
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutMs = 90000;
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = {
    model,
    messages,
    stream: false,
    temperature: generationOptions.temperature ?? 0.3,
    max_tokens: generationOptions.maxTokens || 8192
  };
  // 这两个模型会把 response_format=json_object 直接判为非法参数。
  // 后台任务必须与浏览器端使用同一兼容规则，否则重生链路会固定浪费两个题位阶段。
  if (generationOptions.json && !generationOptions.multimodal && !JSON_MODE_UNSUPPORTED_MODELS.has(model)) {
    body.response_format = { type: 'json_object' };
  }
  if (/thinking/i.test(model) && !generationOptions.multimodal) body.thinking_budget = generationOptions.thinkingBudget || 1024;
  else body.enable_thinking = false;
  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseText = await upstream.text();
    if (Date.now() - startedAt >= timeoutMs) {
      throw Object.assign(new Error('模型响应超过90秒硬截止时间'), { code: 'REQUEST_TIMEOUT', canFallback: true });
    }
    if (!upstream.ok) {
      let providerMessage = responseText.slice(0, 500);
      try {
        const parsed = JSON.parse(responseText);
        providerMessage = parsed.message || parsed.error?.message || providerMessage;
      } catch {}
      const code = upstream.status === 402
        ? 'QUOTA_EXCEEDED'
        : upstream.status === 429
          ? 'MODEL_RATE_LIMITED'
        : upstream.status === 401 || upstream.status === 403
          ? 'AUTH_ERROR'
          : upstream.status >= 500
            ? 'MODEL_SERVICE_UNAVAILABLE'
            : 'MODEL_NOT_AVAILABLE';
      throw Object.assign(new Error(`HTTP ${upstream.status}：${providerMessage}`), {
        code,
        status: upstream.status,
        canFallback: !['AUTH_ERROR', 'QUOTA_EXCEEDED'].includes(code),
        disableForGeneration: ['AUTH_ERROR', 'QUOTA_EXCEEDED', 'MODEL_NOT_AVAILABLE'].includes(code)
      });
    }
    let parsed;
    try { parsed = JSON.parse(responseText); }
    catch { throw Object.assign(new Error('模型接口没有返回合法JSON响应'), { code: 'INVALID_API_RESPONSE', canFallback: true }); }
    if (parsed.choices?.[0]?.finish_reason === 'length') {
      throw Object.assign(new Error('模型返回内容被截断'), { code: 'OUTPUT_TRUNCATED', canFallback: true });
    }
    const content = String(parsed.choices?.[0]?.message?.content || '').trim();
    if (!content) throw Object.assign(new Error('模型没有返回最终内容'), { code: 'EMPTY_MODEL_CONTENT', canFallback: true });
    const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : null;
    const promptTokens = Math.max(0, Math.round(Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0)));
    const completionTokens = Math.max(0, Math.round(Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0)));
    return {
      content,
      usage: {
        usage_reported: Boolean(usage),
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Math.max(0, Math.round(Number(usage?.total_tokens ?? (promptTokens + completionTokens)))),
        cached_prompt_tokens: Math.max(0, Math.round(Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0))),
        reasoning_tokens: Math.max(0, Math.round(Number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0)))
      }
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (stoppedByUser) throw Object.assign(new Error('用户手动停止生成'), { code: 'USER_STOPPED', canFallback: false });
      throw Object.assign(new Error('模型响应超过90秒硬截止时间'), { code: 'REQUEST_TIMEOUT', canFallback: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', forwardAbort);
  }
}

// ===== V9 原版 AI 引导接口（逐字移植自 ai-guide-server.js）=====
function handleConfig(request, response) {
  if (request.method === 'OPTIONS') { response.writeHead(204, CORS_HEADERS); response.end(); return; }
  if (request.method !== 'GET') return sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED' });
  sendJson(response, 200, {
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, name: p.name, hasKey: Boolean(p.apiKey), models: p.models
    }))
  });
}

async function handleStudyStore(request, response) {
  if (request.method === 'OPTIONS') { response.writeHead(204, CORS_HEADERS); response.end(); return; }
  let identity;
  try { identity = publicIdentity(readSession(request), readStatePayload().state); }
  catch (error) { return sendJson(response, 500, { code: 'STATE_READ_FAILED', message: error.message }); }
  if (!identity) return sendJson(response, 401, { code: 'AUTH_REQUIRED', message: '请先登录' });
  const identityKey = identity.role === 'student'
    ? `学生_${identity.studentId}`
    : identity.role === 'guest'
      ? `访客_${identity.guestId}`
      : `教师_${identity.teacherId}`;
  const scopedStorePath = path.join(STUDY_DATA_DIR, `${identityKey.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}.json`);
  if (request.method === 'GET') {
    try {
      const text = await fs.promises.readFile(scopedStorePath, 'utf8');
      const store = JSON.parse(text);
      return sendJson(response, 200, { store });
    } catch (error) {
      if (error.code === 'ENOENT') return sendJson(response, 200, { store: null });
      console.error(`读取错题本失败：${error.message}`);
      return sendJson(response, 500, { code: 'STUDY_STORE_READ_FAILED', message: '读取错题本文件失败' });
    }
  }
  if (request.method !== 'POST') return sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED' });

  let body;
  try { body = JSON.parse((await readRequestBody(request)).toString('utf8')); }
  catch { return sendJson(response, 400, { code: 'BAD_JSON', message: '请求体不是合法 JSON' }); }
  if (!body || !body.store || typeof body.store !== 'object' || Array.isArray(body.store)) {
    return sendJson(response, 400, { code: 'BAD_STUDY_STORE', message: 'store 必须是对象' });
  }
  const wrongBook = body.store.wrongBook;
  if (wrongBook != null && (typeof wrongBook !== 'object' || Array.isArray(wrongBook))) {
    return sendJson(response, 400, { code: 'BAD_WRONG_BOOK', message: 'wrongBook 必须是对象' });
  }
  if (wrongBook && Object.keys(wrongBook).length > 2000) {
    return sendJson(response, 400, { code: 'WRONG_BOOK_TOO_LARGE', message: '错题记录超过2000条上限' });
  }
  try {
    await fs.promises.mkdir(STUDY_DATA_DIR, { recursive: true });
    const payload = JSON.stringify(body.store, null, 2);
    await fs.promises.writeFile(scopedStorePath, payload, 'utf8');
    return sendJson(response, 200, { ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`保存错题本失败：${error.message}`);
    return sendJson(response, 500, { code: 'STUDY_STORE_WRITE_FAILED', message: '保存错题本文件失败' });
  }
}

async function handleAi(request, response) {
  if (request.method === 'OPTIONS') { response.writeHead(204, CORS_HEADERS); response.end(); return; }
  if (request.method !== 'POST') return sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED' });
  try {
    if (!publicIdentity(readSession(request), readStatePayload().state)) {
      return sendJson(response, 401, { code: 'AUTH_REQUIRED', message: '请先登录' });
    }
  } catch (error) {
    return sendJson(response, 500, { code: 'STATE_READ_FAILED', message: error.message });
  }
  let body;
  try { body = JSON.parse((await readRequestBody(request)).toString('utf8')); }
  catch { return sendJson(response, 400, { code: 'BAD_JSON', message: '请求体不是合法 JSON' }); }

  const provider = PROVIDERS[body.provider];
  if (!provider) return sendJson(response, 400, { code: 'UNKNOWN_PROVIDER', message: `未知平台：${body.provider}` });
  if (!provider.apiKey) {
    return sendJson(response, 401, {
      code: 'PROVIDER_KEY_MISSING',
      message: `${provider.name} 的 API Key 尚未配置：请通过本机 .local 配置文件或环境变量填写后重启服务。`
    });
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendJson(response, 400, { code: 'BAD_MESSAGES', message: 'messages 不能为空' });
  }

  const modelId = body.model || provider.models[0].id;
  const wantsStream = body.stream === true;
  const upstreamBody = {
    model: modelId,
    messages: body.messages,
    stream: wantsStream
  };
  const modelConf = provider.models.find(m => m.id === modelId);
  if (modelConf && modelConf.disableThinking) upstreamBody.enable_thinking = false;
  if (typeof body.temperature === 'number') upstreamBody.temperature = body.temperature;
  if (Number.isInteger(body.max_tokens)) upstreamBody.max_tokens = body.max_tokens;

  const startedAt = Date.now();
  const logDone = (status) => console.log(`[${new Date().toLocaleTimeString()}] ${provider.name} ${modelId} → HTTP ${status}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s${wantsStream ? '（流式）' : ''}`);

  if (wantsStream) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const rearm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS); };
    try {
      const upstream = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}`, 'Accept': 'text/event-stream' },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal
      });
      if (!upstream.ok || !upstream.body) {
        clearTimeout(timer);
        const errBuf = Buffer.from(await upstream.arrayBuffer());
        logDone(upstream.status);
        let errPayload = null;
        try { errPayload = JSON.parse(errBuf.toString('utf8')); } catch (e) {}
        return sendJson(response, upstream.status, errPayload || { code: 'UPSTREAM_ERROR', message: errBuf.toString('utf8').slice(0, 300) });
      }
      response.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store'
      }, CORS_HEADERS));
      // 前端按首字/停流预算主动放弃连接时，同步中止上游请求，避免重试期间请求堆积
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      for await (const chunk of upstream.body) {
        rearm();
        response.write(chunk);
      }
      response.end();
      logDone(200);
    } catch (error) {
      const timeout = error?.name === 'AbortError';
      const msg = timeout
        ? `等待 ${provider.name} ${modelId} 响应超时（${UPSTREAM_TIMEOUT_MS / 1000}秒无数据，已中断）`
        : `本地代理流式转发失败：${error.message}`;
      logDone('STREAM_ABORT');
      if (!response.headersSent) {
        sendJson(response, timeout ? 504 : 502, { code: timeout ? 'PROXY_UPSTREAM_TIMEOUT' : 'PROXY_ERROR', message: msg });
      } else {
        try { response.write(`data: ${JSON.stringify({ __proxy_error: msg })}\n\n`); } catch (e) {}
        response.end();
      }
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}`, 'Accept': 'application/json' },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    logDone(upstream.status);
    response.writeHead(upstream.status, Object.assign({
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, CORS_HEADERS));
    response.end(responseBody);
  } catch (error) {
    const timeout = error?.name === 'AbortError';
    sendJson(response, timeout ? 504 : 502, {
      code: timeout ? 'PROXY_UPSTREAM_TIMEOUT' : 'PROXY_ERROR',
      message: timeout
        ? `等待 ${provider.name} ${modelId} 响应超时（${UPSTREAM_TIMEOUT_MS / 1000}秒，已中断）`
        : `本地代理请求失败：${error.message}`
    });
  } finally {
    clearTimeout(timer);
  }
}

function ensureDataDirectories() {
  fs.mkdirSync(BACKUP_DIRECTORY, { recursive: true });
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isValidStatePayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    && payload.state && typeof payload.state === 'object' && Array.isArray(payload.state.courses);
}

function listStateBackupFiles() {
  ensureDataDirectories();
  const candidates = [];
  if (fs.existsSync(STATE_FILE)) candidates.push({ id: 'current', filePath: STATE_FILE, label: '当前自动保存（最新）' });
  for (const entry of fs.readdirSync(BACKUP_DIRECTORY, { withFileTypes: true })) {
    if (entry.isFile() && /^题库自动备份_.*\.json$/u.test(entry.name)) {
      candidates.push({ id: entry.name, filePath: path.join(BACKUP_DIRECTORY, entry.name), label: `历史自动备份：${entry.name.replace(/^题库自动备份_|\.json$/gu, '')}` });
    }
  }
  return candidates.map(item => {
    const stat = fs.statSync(item.filePath);
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(item.filePath, 'utf8')); } catch { /* 仍列出损坏文件，供用户知晓 */ }
    const courses = payload?.state?.courses || [];
    const questionCount = courses.reduce((total, course) => total + (course.question_bank?.length || 0), 0);
    return {
      id: item.id,
      label: item.label,
      saved_at: payload?.saved_at || stat.mtime.toISOString(),
      course_count: courses.length,
      question_count: questionCount,
      valid: isValidStatePayload(payload)
    };
  }).sort((left, right) => String(right.saved_at).localeCompare(String(left.saved_at)));
}

function sendState(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function ensureServerTeachingState(state) {
  const teaching = state.teaching && typeof state.teaching === 'object' ? state.teaching : {};
  teaching.version = 1.1;
  teaching.teacher = {
    ...FIXED_TEACHER,
    created_at: teaching.teacher?.created_at || new Date().toISOString()
  };
  teaching.classes = Array.isArray(teaching.classes) ? teaching.classes : [];
  teaching.students = Array.isArray(teaching.students) ? teaching.students : [];
  teaching.publications = Array.isArray(teaching.publications) ? teaching.publications : [];
  teaching.student_learning = teaching.student_learning && typeof teaching.student_learning === 'object'
    ? teaching.student_learning
    : {};
  teaching.analytics_roster = teaching.analytics_roster && typeof teaching.analytics_roster === 'object'
    ? teaching.analytics_roster
    : {};
  teaching.analytics_learning = teaching.analytics_learning && typeof teaching.analytics_learning === 'object'
    ? teaching.analytics_learning
    : {};
  teaching.guest_learning = teaching.guest_learning && typeof teaching.guest_learning === 'object'
    ? teaching.guest_learning
    : {};
  teaching.course_spaces = Array.isArray(teaching.course_spaces) ? teaching.course_spaces : [];
  for (const space of teaching.course_spaces) {
    if (space.course_code) continue;
    let code;
    do { code = `K${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
    while (teaching.course_spaces.some(item => item !== space && item.course_code === code));
    space.course_code = code;
  }
  for (const student of teaching.students) {
    student.course_space_ids = Array.isArray(student.course_space_ids) ? student.course_space_ids : [];
  }
  state.teaching = teaching;
  return teaching;
}

function readStatePayload() {
  if (!fs.existsSync(STATE_FILE)) {
    if (fs.existsSync(PUBLIC_SEED_FILE)) {
      const seeded = JSON.parse(fs.readFileSync(PUBLIC_SEED_FILE, 'utf8'));
      if (!isValidStatePayload(seeded)) throw new Error('PUBLIC_SEED_FILE_INVALID');
      seeded.state.current_session = null;
      seeded.state.wrong_book = seeded.state.wrong_book && typeof seeded.state.wrong_book === 'object'
        ? seeded.state.wrong_book
        : {};
      ensureServerTeachingState(seeded.state);
      return seeded;
    }
    const state = { courses: [], current_session: null, wrong_book: {}, teaching: {} };
    ensureServerTeachingState(state);
    return { format: 'quiz-site-quality-v2', saved_at: '', state };
  }
  const payload = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!isValidStatePayload(payload)) throw new Error('STATE_FILE_INVALID');
  payload.state.current_session = payload.state.current_session || null;
  payload.state.wrong_book = payload.state.wrong_book && typeof payload.state.wrong_book === 'object'
    ? payload.state.wrong_book
    : {};
  ensureServerTeachingState(payload.state);
  return payload;
}

function persistState(state) {
  ensureDataDirectories();
  ensureServerTeachingState(state);
  const serialized = JSON.stringify({
    format: 'quiz-site-quality-v2',
    saved_at: new Date().toISOString(),
    state
  }, null, 2);
  if (fs.existsSync(STATE_FILE) && Date.now() - lastArchiveBackupAt >= 5 * 60 * 1000) {
    fs.copyFileSync(STATE_FILE, path.join(BACKUP_DIRECTORY, `题库自动备份_${timestampForFile()}.json`));
    lastArchiveBackupAt = Date.now();
  }
  const temporaryFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, serialized, 'utf8');
  fs.renameSync(temporaryFile, STATE_FILE);
  return JSON.parse(serialized);
}

function publicIdentity(session, state) {
  if (!session) return null;
  const teaching = ensureServerTeachingState(state);
  if (session.role === 'teacher') {
    if (!teaching.teacher || teaching.teacher.teacher_id !== session.teacherId) return null;
    return { role: 'teacher', teacherId: session.teacherId, teacherName: teaching.teacher.teacher_name };
  }
  if (session.role === 'student') {
    const student = teaching.students.find(item => item.student_id === session.studentId);
    if (!student) return null;
    return { role: 'student', studentId: student.student_id };
  }
  if (session.role === 'guest' && /^guest_[a-zA-Z0-9_-]{16,100}$/.test(String(session.guestId || ''))) {
    return { role: 'guest', guestId: session.guestId, guestName: '访客' };
  }
  return null;
}

function analyticsPercent(value, total) {
  return total ? Math.round(Number(value || 0) / total * 100) : 0;
}

function anonymousLearnerCode(courseSpaceId, studentId) {
  const digest = crypto.createHmac('sha256', AUTH_SECRET)
    .update(`learning-analytics:${courseSpaceId}:${studentId}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `A${digest}`;
}

function courseStatisticsBySpace(state) {
  const teaching = ensureServerTeachingState(state);
  const summaries = {};
  for (const space of teaching.course_spaces) {
    const spaceBanks = (state.courses || []).filter(course => course.parent_course_id === space.course_space_id);
    const bankIds = new Set(spaceBanks.map(course => course.course_id));
    const questionLookup = new Map();
    for (const course of spaceBanks) {
      for (const question of course.question_bank || []) {
        questionLookup.set(`${course.course_id}::${question.question_id}`, question);
      }
    }
    const participantIds = new Set();
    const attempts = [];
    const learnerTimelines = [];
    const knowledgeAnalytics = {};
    const aiTotals = {
      eligible: 0,
      started: 0,
      completed: 0,
      checkKnown: 0,
      checkCorrect: 0,
      turns: 0,
      turnSessions: 0,
      followUpOpportunities: 0,
      followUpCorrect: 0
    };
    for (const [studentId, learning] of Object.entries(teaching.student_learning)) {
      const matching = (learning?.attempts || [])
        .filter(attempt => bankIds.has(attempt.course_id))
        .sort((left, right) => String(left.completed_at || '').localeCompare(String(right.completed_at || '')));
      if (!matching.length) continue;
      participantIds.add(studentId);
      attempts.push(...matching);

      const flattened = [];
      matching.forEach((attempt, roundIndex) => {
        (attempt.answers || []).forEach((answer, answerIndex) => {
          const question = questionLookup.get(`${attempt.course_id}::${answer.question_id}`) || {};
          const knowledgePoint = answer.knowledge_point || question.knowledge_point || '未标注知识点';
          const knowledgePointId = answer.knowledge_point_id || question.knowledge_point_id || '';
          const templateGroupId = answer.template_group_id || question.template_group_id || '';
          const matchKey = templateGroupId
            ? `template:${templateGroupId}`
            : `knowledge:${knowledgePointId || knowledgePoint}`;
          const started = answer.ai_started === true || ['started', 'guided_completed'].includes(answer.guidance_status);
          const completed = answer.guidance_status === 'guided_completed';
          const checkValue = typeof answer.checkCorrect === 'boolean'
            ? answer.checkCorrect
            : (typeof answer.check_correct === 'boolean' ? answer.check_correct : null);
          flattened.push({
            answer,
            attempt,
            question,
            roundIndex,
            answerIndex,
            knowledgePoint,
            knowledgePointId,
            templateGroupId,
            matchKey,
            started,
            completed,
            checkValue,
            turnCount: Math.max(0, Number(answer.guidance_turn_count || 0)),
            followUp: 'none'
          });
        });
      });

      flattened.forEach((item, index) => {
        if (!item.completed) return;
        const later = flattened.slice(index + 1).find(candidate =>
          candidate.matchKey === item.matchKey && candidate.answer.question_id !== item.answer.question_id
        );
        if (!later) return;
        item.followUp = later.answer.correct ? 'correct' : 'wrong';
      });

      for (const item of flattened) {
        const eligible = item.answer.correct !== true;
        const bucket = knowledgeAnalytics[item.knowledgePoint] || {
          knowledge_point: item.knowledgePoint,
          eligible: 0,
          started: 0,
          completed: 0,
          turns: 0,
          turn_sessions: 0,
          check_known: 0,
          check_correct: 0,
          follow_up_opportunities: 0,
          follow_up_correct: 0
        };
        if (eligible) {
          aiTotals.eligible += 1;
          bucket.eligible += 1;
        }
        if (item.started) {
          aiTotals.started += 1;
          bucket.started += 1;
        }
        if (item.completed) {
          aiTotals.completed += 1;
          bucket.completed += 1;
        }
        if (item.turnCount > 0) {
          aiTotals.turns += item.turnCount;
          aiTotals.turnSessions += 1;
          bucket.turns += item.turnCount;
          bucket.turn_sessions += 1;
        }
        if (item.checkValue !== null) {
          aiTotals.checkKnown += 1;
          bucket.check_known += 1;
          if (item.checkValue) {
            aiTotals.checkCorrect += 1;
            bucket.check_correct += 1;
          }
        }
        if (item.followUp !== 'none') {
          aiTotals.followUpOpportunities += 1;
          bucket.follow_up_opportunities += 1;
          if (item.followUp === 'correct') {
            aiTotals.followUpCorrect += 1;
            bucket.follow_up_correct += 1;
          }
        }
        knowledgeAnalytics[item.knowledgePoint] = bucket;
      }

      const rounds = matching.map((attempt, roundIndex) => {
        const roundItems = flattened.filter(item => item.roundIndex === roundIndex);
        const aiStarted = roundItems.filter(item => item.started).length;
        const aiCompleted = roundItems.filter(item => item.completed).length;
        return {
          chapter: attempt.chapter || '',
          difficulty_band: attempt.difficulty_band || '',
          set_number: Number(attempt.set_number || 1),
          score: Number(attempt.score || 0),
          ai_started: aiStarted,
          ai_completed: aiCompleted,
          ai_turns: roundItems.reduce((sum, item) => sum + item.turnCount, 0),
          wrong: roundItems.filter(item => item.answer.correct !== true && !item.answer.fuzzy).length,
          uncertain: roundItems.filter(item => item.answer.fuzzy === true).length,
          completed_at: attempt.completed_at || '',
          questions: roundItems.map(item => ({
            question_id: item.answer.question_id || '',
            stem: String(item.question.stem || '').slice(0, 70),
            knowledge_point: item.knowledgePoint,
            result: item.answer.correct ? 'correct' : (item.answer.fuzzy ? 'uncertain' : 'wrong'),
            ai_started: item.started,
            ai_completed: item.completed,
            ai_turns: item.turnCount,
            check_correct: item.checkValue,
            follow_up: item.followUp,
            repeated_error: item.answer.learning_state === 'repeated_error'
          }))
        };
      });
      const last = rounds[rounds.length - 1];
      const previous = rounds[rounds.length - 2];
      const bandRank = value => ['0-39', '40-59', '60-79', '80-100'].indexOf(value);
      let status = '持续练习';
      let analysis = last ? `已完成${rounds.length}轮，最近一轮${last.score}分。` : '尚无完成轮次。';
      if (previous && last) {
        const scoreDelta = last.score - previous.score;
        const aiDelta = last.ai_started - previous.ai_started;
        if (previous.score < 60 && last.score < 60) {
          status = '建议关注';
          analysis = `连续两轮低于60分，最近一轮AI介入${last.ai_started}题。`;
        } else if (bandRank(last.difficulty_band) > bandRank(previous.difficulty_band) && last.score >= 60) {
          status = '已进入更高难度';
          analysis = `已进入更高难度并取得${last.score}分，最近一轮AI介入${last.ai_started}题。`;
        } else if (scoreDelta > 0 && aiDelta < 0) {
          status = '稳步提升';
          analysis = `分数提高${scoreDelta}分，AI介入减少${Math.abs(aiDelta)}题。`;
        } else if (last.questions.some(question => question.repeated_error)) {
          status = '仍有重复错误';
          analysis = `最近一轮${last.score}分，仍有同知识点后续答错。`;
        }
      }
      const learnerFollowUp = flattened.filter(item => item.followUp !== 'none');
      learnerTimelines.push({
        anonymous_id: anonymousLearnerCode(space.course_space_id, studentId),
        diagnosis_score: Number(matching[0]?.diagnosis_score || 0),
        rounds,
        follow_up_opportunities: learnerFollowUp.length,
        follow_up_correct: learnerFollowUp.filter(item => item.followUp === 'correct').length,
        status,
        analysis
      });
    }
    const answers = attempts.flatMap(attempt => attempt.answers || []);
    const correctCount = answers.filter(answer => answer.correct).length;
    const weak = {};
    for (const answer of answers) {
      if (answer.correct) continue;
      const key = answer.knowledge_point || '未标注知识点';
      weak[key] = (weak[key] || 0) + 1;
    }
    const aiKnowledgePoints = Object.values(knowledgeAnalytics)
      .filter(item => item.eligible > 0 || item.started > 0)
      .sort((left, right) => right.started - left.started || right.eligible - left.eligible)
      .slice(0, 5)
      .map(item => ({
        knowledge_point: item.knowledge_point,
        eligible: item.eligible,
        started: item.started,
        average_turns: item.turn_sessions ? Number((item.turns / item.turn_sessions).toFixed(1)) : 0,
        check_rate: analyticsPercent(item.check_correct, item.check_known),
        follow_up_rate: analyticsPercent(item.follow_up_correct, item.follow_up_opportunities),
        follow_up_opportunities: item.follow_up_opportunities
      }));
    summaries[space.course_space_id] = {
      students: participantIds.size,
      rounds: attempts.length,
      answers: answers.length,
      correct: correctCount,
      accuracy: answers.length ? Math.round(correctCount / answers.length * 100) : 0,
      weak: Object.entries(weak).sort((left, right) => right[1] - left[1]).slice(0, 5),
      ai_guidance: {
        eligible: aiTotals.eligible,
        started: aiTotals.started,
        completed: aiTotals.completed,
        start_rate: analyticsPercent(aiTotals.started, aiTotals.eligible),
        completion_rate: analyticsPercent(aiTotals.completed, aiTotals.started),
        check_rate: analyticsPercent(aiTotals.checkCorrect, aiTotals.checkKnown),
        follow_up_rate: analyticsPercent(aiTotals.followUpCorrect, aiTotals.followUpOpportunities),
        follow_up_opportunities: aiTotals.followUpOpportunities,
        follow_up_correct: aiTotals.followUpCorrect,
        average_turns: aiTotals.turnSessions ? Number((aiTotals.turns / aiTotals.turnSessions).toFixed(1)) : 0
      },
      ai_knowledge_points: aiKnowledgePoints,
      anonymous_learners: learnerTimelines.sort((left, right) => {
        const leftTime = left.rounds[left.rounds.length - 1]?.completed_at || '';
        const rightTime = right.rounds[right.rounds.length - 1]?.completed_at || '';
        return rightTime.localeCompare(leftTime);
      })
    };
  }
  return summaries;
}

function courseSemesterStatisticsBySpace(state) {
  const teaching = ensureServerTeachingState(state);
  const summaries = {};
  const bandRank = value => ['0-39', '40-59', '60-79', '80-100'].indexOf(value);
  for (const space of teaching.course_spaces) {
    const spaceBanks = (state.courses || []).filter(course => course.parent_course_id === space.course_space_id);
    const bankIds = new Set(spaceBanks.map(course => course.course_id));
    const questionLookup = new Map();
    spaceBanks.forEach(course => (course.question_bank || []).forEach(question => {
      questionLookup.set(`${course.course_id}::${question.question_id}`, question);
    }));

    const learners = new Map();
    const importedRoster = Array.isArray(teaching.analytics_roster[space.course_space_id])
      ? teaching.analytics_roster[space.course_space_id]
      : [];
    if (!importedRoster.length) {
      teaching.students
        .filter(student => (student.course_space_ids || []).includes(space.course_space_id))
        .forEach(student => learners.set(`live:${student.student_id}`, {
          learnerId: student.student_id,
          learning: teaching.student_learning[student.student_id] || { attempts: [] }
        }));
    }
    if (!importedRoster.length) {
      for (const [studentId, learning] of Object.entries(teaching.student_learning)) {
        if ((learning?.attempts || []).some(attempt => bankIds.has(attempt.course_id))) {
          learners.set(`live:${studentId}`, { learnerId: studentId, learning });
        }
      }
    }
    const importedLearning = teaching.analytics_learning[space.course_space_id] || {};
    importedRoster.forEach(item => {
      const learnerId = String(item.learner_id || '');
      if (learnerId) learners.set(`import:${learnerId}`, {
        learnerId: `import:${learnerId}`,
        learning: importedLearning[learnerId] || { attempts: [] }
      });
    });
    for (const [learnerId, learning] of Object.entries(importedLearning)) {
      learners.set(`import:${learnerId}`, { learnerId: `import:${learnerId}`, learning });
    }

    const attempts = [];
    const participantIds = new Set();
    const activeDates = new Set();
    const practicedChapterSelections = new Set();
    const learnerTimelines = [];
    const knowledgeAnalytics = {};
    const chapterAnalytics = {};
    const coverage = { zero: 0, one_two: 0, three_four: 0, five_seven: 0, eight_plus: 0 };
    const difficultyTransitions = { up: 0, same: 0, down: 0, adjusted: 0, adapted: 0, acceptable: 0 };
    const aiTotals = {
      eligible: 0, started: 0, completed: 0, checkKnown: 0, checkCorrect: 0,
      turns: 0, turnSessions: 0, followUpOpportunities: 0, followUpCorrect: 0
    };

    for (const [sourceKey, source] of learners.entries()) {
      const matching = (source.learning?.attempts || [])
        .filter(attempt => bankIds.has(attempt.course_id))
        .sort((left, right) => String(left.completed_at || '').localeCompare(String(right.completed_at || '')));
      const learnerChapters = new Set(matching.map(attempt => attempt.chapter).filter(Boolean));
      const learnerDates = new Set(matching.map(attempt => String(attempt.completed_at || '').slice(0, 10)).filter(Boolean));
      const coverageCount = learnerChapters.size;
      if (!coverageCount) coverage.zero += 1;
      else if (coverageCount <= 2) coverage.one_two += 1;
      else if (coverageCount <= 4) coverage.three_four += 1;
      else if (coverageCount <= 7) coverage.five_seven += 1;
      else coverage.eight_plus += 1;

      if (!matching.length) {
        learnerTimelines.push({
          anonymous_id: anonymousLearnerCode(space.course_space_id, source.learnerId),
          diagnosis_score: 0,
          chapters_practiced: 0,
          active_days: 0,
          answers: 0,
          ai_started: 0,
          rounds: [],
          follow_up_opportunities: 0,
          follow_up_correct: 0,
          status: '尚未开始',
          analysis: '已加入课程，尚未完成正式练习。'
        });
        continue;
      }

      participantIds.add(sourceKey);
      attempts.push(...matching);
      learnerDates.forEach(date => activeDates.add(date));
      learnerChapters.forEach(chapter => practicedChapterSelections.add(`${sourceKey}::${chapter}`));

      const flattened = [];
      matching.forEach((attempt, roundIndex) => {
        (attempt.answers || []).forEach((answer, answerIndex) => {
          const question = questionLookup.get(`${attempt.course_id}::${answer.question_id}`) || {};
          const knowledgePoint = answer.knowledge_point || question.knowledge_point || '未标注知识点';
          const knowledgePointId = answer.knowledge_point_id || question.knowledge_point_id || '';
          const templateGroupId = answer.template_group_id || question.template_group_id || '';
          const started = answer.ai_started === true || ['started', 'guided_completed'].includes(answer.guidance_status);
          const completed = answer.guidance_status === 'guided_completed' || answer.ai_completed === true;
          const checkValue = typeof answer.checkCorrect === 'boolean'
            ? answer.checkCorrect
            : (typeof answer.check_correct === 'boolean' ? answer.check_correct : null);
          flattened.push({
            answer, attempt, question, roundIndex, answerIndex, knowledgePoint, knowledgePointId,
            matchKey: templateGroupId ? `template:${templateGroupId}` : `knowledge:${knowledgePointId || knowledgePoint}`,
            started, completed, checkValue,
            turnCount: Math.max(0, Number(answer.guidance_turn_count || answer.ai_turn_count || 0)),
            followUp: 'none'
          });
        });
      });
      flattened.forEach((item, index) => {
        if (!item.completed) return;
        const later = flattened.slice(index + 1).find(candidate =>
          candidate.matchKey === item.matchKey && candidate.answer.question_id !== item.answer.question_id
        );
        if (!later) return;
        item.followUp = later.answer.correct && !later.started ? 'correct' : 'wrong';
      });

      for (const item of flattened) {
        const eligible = item.answer.correct !== true;
        const bucket = knowledgeAnalytics[item.knowledgePoint] || {
          knowledge_point: item.knowledgePoint, eligible: 0, started: 0, completed: 0,
          turns: 0, turn_sessions: 0, check_known: 0, check_correct: 0,
          follow_up_opportunities: 0, follow_up_correct: 0
        };
        if (eligible) { aiTotals.eligible += 1; bucket.eligible += 1; }
        if (item.started) { aiTotals.started += 1; bucket.started += 1; }
        if (item.completed) { aiTotals.completed += 1; bucket.completed += 1; }
        if (item.turnCount > 0) {
          aiTotals.turns += item.turnCount; aiTotals.turnSessions += 1;
          bucket.turns += item.turnCount; bucket.turn_sessions += 1;
        }
        if (item.checkValue !== null) {
          aiTotals.checkKnown += 1; bucket.check_known += 1;
          if (item.checkValue) { aiTotals.checkCorrect += 1; bucket.check_correct += 1; }
        }
        if (item.followUp !== 'none') {
          aiTotals.followUpOpportunities += 1; bucket.follow_up_opportunities += 1;
          if (item.followUp === 'correct') { aiTotals.followUpCorrect += 1; bucket.follow_up_correct += 1; }
        }
        knowledgeAnalytics[item.knowledgePoint] = bucket;
      }

      const previousByChapter = new Map();
      for (const attempt of matching) {
        const previous = previousByChapter.get(attempt.chapter);
        if (previous) {
          const change = bandRank(attempt.difficulty_band) - bandRank(previous.difficulty_band);
          if (change > 0) difficultyTransitions.up += 1;
          else if (change < 0) difficultyTransitions.down += 1;
          else difficultyTransitions.same += 1;
          if (change !== 0) {
            difficultyTransitions.adjusted += 1;
            if (Number(attempt.score) >= 60 && Number(attempt.score) <= 79) difficultyTransitions.adapted += 1;
            if (Number(attempt.score) >= 60) difficultyTransitions.acceptable += 1;
          }
        }
        previousByChapter.set(attempt.chapter, attempt);
      }

      const rounds = matching.map((attempt, roundIndex) => {
        const roundItems = flattened.filter(item => item.roundIndex === roundIndex);
        const chapter = attempt.chapter || '未标注章节';
        const chapterBucket = chapterAnalytics[chapter] || {
          chapter, chapter_id: attempt.chapter_id || '', learners: new Set(), rounds: 0, scores: 0, answers: 0, correct: 0, ai_started: 0, weak: {}
        };
        chapterBucket.learners.add(sourceKey);
        chapterBucket.rounds += 1;
        chapterBucket.scores += Number(attempt.score || 0);
        chapterBucket.answers += roundItems.length;
        chapterBucket.correct += roundItems.filter(item => item.answer.correct === true).length;
        chapterBucket.ai_started += roundItems.filter(item => item.started).length;
        roundItems.filter(item => item.answer.correct !== true).forEach(item => {
          chapterBucket.weak[item.knowledgePoint] = (chapterBucket.weak[item.knowledgePoint] || 0) + 1;
        });
        chapterAnalytics[chapter] = chapterBucket;
        return {
          chapter,
          diagnosis_score: Number(attempt.diagnosis_score || 0),
          difficulty_band: attempt.difficulty_band || '',
          set_number: Number(attempt.set_number || 1),
          score: Number(attempt.score || 0),
          ai_started: roundItems.filter(item => item.started).length,
          ai_completed: roundItems.filter(item => item.completed).length,
          ai_turns: roundItems.reduce((sum, item) => sum + item.turnCount, 0),
          wrong: roundItems.filter(item => item.answer.correct !== true && !item.answer.fuzzy).length,
          uncertain: roundItems.filter(item => item.answer.fuzzy === true).length,
          completed_at: attempt.completed_at || '',
          questions: roundItems.map(item => ({
            question_id: item.answer.question_id || '',
            stem: String(item.answer.source_question_label || item.question.stem || '').slice(0, 70),
            knowledge_point: item.knowledgePoint,
            result: item.answer.correct ? 'correct' : (item.answer.fuzzy ? 'uncertain' : 'wrong'),
            ai_started: item.started, ai_completed: item.completed, ai_turns: item.turnCount,
            check_correct: item.checkValue, follow_up: item.followUp,
            repeated_error: item.answer.learning_state === 'repeated_error'
          }))
        };
      });

      const last = rounds[rounds.length - 1];
      const previous = rounds[rounds.length - 2];
      let status = '持续练习';
      let analysis = `已自主练习${learnerChapters.size}章、完成${rounds.length}轮，最近一轮${last.score}分。`;
      if (previous && last && previous.score < 60 && last.score < 60) status = '建议关注';
      else if (previous && last && last.score > previous.score && last.ai_started < previous.ai_started) status = '稳步提升';
      else if (last.questions.some(question => question.repeated_error)) status = '仍有重复错误';
      const learnerFollowUp = flattened.filter(item => item.followUp !== 'none');
      learnerTimelines.push({
        anonymous_id: anonymousLearnerCode(space.course_space_id, source.learnerId),
        diagnosis_score: Number(matching[0]?.diagnosis_score || 0),
        chapters_practiced: learnerChapters.size,
        active_days: learnerDates.size,
        answers: flattened.length,
        ai_started: flattened.filter(item => item.started).length,
        rounds,
        follow_up_opportunities: learnerFollowUp.length,
        follow_up_correct: learnerFollowUp.filter(item => item.followUp === 'correct').length,
        status,
        analysis
      });
    }

    const answers = attempts.flatMap(attempt => attempt.answers || []);
    const correctCount = answers.filter(answer => answer.correct).length;
    const weak = {};
    answers.filter(answer => !answer.correct).forEach(answer => {
      const key = answer.knowledge_point || '未标注知识点';
      weak[key] = (weak[key] || 0) + 1;
    });
    const aiKnowledgePoints = Object.values(knowledgeAnalytics)
      .filter(item => item.eligible > 0 || item.started > 0)
      .sort((left, right) => right.started - left.started || right.eligible - left.eligible)
      .slice(0, 5)
      .map(item => ({
        knowledge_point: item.knowledge_point, eligible: item.eligible, started: item.started,
        average_turns: item.turn_sessions ? Number((item.turns / item.turn_sessions).toFixed(1)) : 0,
        check_rate: analyticsPercent(item.check_correct, item.check_known),
        follow_up_rate: analyticsPercent(item.follow_up_correct, item.follow_up_opportunities),
        follow_up_opportunities: item.follow_up_opportunities
      }));
    const chapters = Object.values(chapterAnalytics).map(item => ({
      chapter: item.chapter,
      chapter_id: item.chapter_id,
      students: item.learners.size,
      rounds: item.rounds,
      average_score: item.rounds ? Number((item.scores / item.rounds).toFixed(1)) : 0,
      accuracy: analyticsPercent(item.correct, item.answers),
      answers: item.answers,
      ai_started: item.ai_started,
      weak_point: Object.entries(item.weak).sort((left, right) => right[1] - left[1])[0]?.[0] || '暂无'
    })).sort((left, right) => {
      const leftNumber = Number(String(left.chapter_id || '').match(/\d+/)?.[0] || 999);
      const rightNumber = Number(String(right.chapter_id || '').match(/\d+/)?.[0] || 999);
      return leftNumber - rightNumber || left.chapter.localeCompare(right.chapter, 'zh-CN');
    });

    summaries[space.course_space_id] = {
      students: learners.size,
      active_students: participantIds.size,
      participation_rate: learners.size ? Number((participantIds.size / learners.size * 100).toFixed(1)) : 0,
      rounds: attempts.length,
      answers: answers.length,
      correct: correctCount,
      accuracy: analyticsPercent(correctCount, answers.length),
      practiced_chapter_selections: practicedChapterSelections.size,
      average_chapters: learners.size ? Number((practicedChapterSelections.size / learners.size).toFixed(1)) : 0,
      average_rounds: learners.size ? Number((attempts.length / learners.size).toFixed(1)) : 0,
      active_days: activeDates.size,
      coverage,
      difficulty_transitions: {
        ...difficultyTransitions,
        adaptation_rate: difficultyTransitions.adjusted
          ? Number((difficultyTransitions.adapted / difficultyTransitions.adjusted * 100).toFixed(1))
          : 0,
        acceptable_rate: difficultyTransitions.adjusted
          ? Number((difficultyTransitions.acceptable / difficultyTransitions.adjusted * 100).toFixed(1))
          : 0
      },
      chapters,
      weak: Object.entries(weak).sort((left, right) => right[1] - left[1]).slice(0, 5),
      ai_guidance: {
        eligible: aiTotals.eligible, started: aiTotals.started, completed: aiTotals.completed,
        start_rate: analyticsPercent(aiTotals.started, aiTotals.eligible),
        completion_rate: analyticsPercent(aiTotals.completed, aiTotals.started),
        check_rate: analyticsPercent(aiTotals.checkCorrect, aiTotals.checkKnown),
        follow_up_rate: analyticsPercent(aiTotals.followUpCorrect, aiTotals.followUpOpportunities),
        follow_up_opportunities: aiTotals.followUpOpportunities,
        follow_up_correct: aiTotals.followUpCorrect,
        average_turns: aiTotals.turnSessions ? Number((aiTotals.turns / aiTotals.turnSessions).toFixed(1)) : 0
      },
      ai_knowledge_points: aiKnowledgePoints,
      anonymous_learners: learnerTimelines.sort((left, right) => {
        const leftTime = left.rounds[left.rounds.length - 1]?.completed_at || '';
        const rightTime = right.rounds[right.rounds.length - 1]?.completed_at || '';
        return rightTime.localeCompare(leftTime);
      })
    };
  }
  return summaries;
}

function teacherStateView(state) {
  const teaching = ensureServerTeachingState(state);
  return {
    ...state,
    current_session: null,
    wrong_book: {},
    teaching: {
      version: teaching.version,
      teacher: {
        teacher_id: teaching.teacher.teacher_id,
        teacher_name: teaching.teacher.teacher_name,
        created_at: teaching.teacher.created_at
      },
      classes: [],
      students: [],
      publications: [],
      student_learning: {},
      guest_learning: {},
      course_spaces: teaching.course_spaces,
      course_statistics: courseSemesterStatisticsBySpace(state)
    }
  };
}

function studentStateView(state, studentId) {
  const teaching = ensureServerTeachingState(state);
  const student = teaching.students.find(item => item.student_id === studentId);
  if (!student) return null;
  const joinedSpaceIds = new Set(student.course_space_ids || []);
  const publishedChapters = course => (course.chapters || []).filter(chapter => {
    const papers = (course.paper_reviews || []).filter(paper => paper.chapter === chapter.title);
    return papers.length === 8 && papers.every(paper => paper.status === 'approved');
  }).map(chapter => chapter.title);
  const courses = state.courses.filter(course => joinedSpaceIds.has(course.parent_course_id)).map(course => {
    const allowed = new Set(publishedChapters(course));
    return {
      ...course,
      chapters: (course.chapters || []).filter(chapter => allowed.has(chapter.title)),
      question_bank: (course.question_bank || []).filter(question => allowed.has(question.chapter)),
      paper_reviews: (course.paper_reviews || []).filter(paper => allowed.has(paper.chapter))
    };
  });
  const learning = teaching.student_learning[studentId] || {
    current_session: null,
    wrong_book: {},
    attempts: [],
    updated_at: new Date().toISOString()
  };
  const publicStudent = {
    student_id: student.student_id,
    student_number: student.student_number,
    course_space_ids: [...(student.course_space_ids || [])],
    joined_at: student.joined_at || '',
    last_active_at: student.last_active_at || ''
  };
  return {
    courses,
    current_session: learning.current_session || null,
    wrong_book: learning.wrong_book || {},
    teaching: {
      version: teaching.version,
      teacher: null,
      classes: [],
      students: [publicStudent],
      publications: [],
      student_learning: { [studentId]: learning },
      course_spaces: teaching.course_spaces.filter(space => courses.some(course => course.parent_course_id === space.course_space_id))
    }
  };
}

function guestStateView(state, guestId) {
  const teaching = ensureServerTeachingState(state);
  const publishedChapters = course => (course.chapters || []).filter(chapter => {
    const papers = (course.paper_reviews || []).filter(paper => paper.chapter === chapter.title);
    return papers.length === 8 && papers.every(paper => paper.status === 'approved');
  }).map(chapter => chapter.title);
  const courses = state.courses.map(course => {
    const allowed = new Set(publishedChapters(course));
    return {
      ...course,
      chapters: (course.chapters || []).filter(chapter => allowed.has(chapter.title)),
      question_bank: (course.question_bank || []).filter(question => allowed.has(question.chapter)),
      paper_reviews: (course.paper_reviews || []).filter(paper => allowed.has(paper.chapter))
    };
  }).filter(course => course.chapters.length > 0);
  const availableSpaceIds = [...new Set(courses.map(course => course.parent_course_id).filter(Boolean))];
  const guest = {
    student_id: guestId,
    student_name: '访客',
    student_number: '访客',
    course_space_ids: availableSpaceIds,
    is_guest: true
  };
  const learning = teaching.guest_learning[guestId] || {
    current_session: null,
    wrong_book: {},
    attempts: [],
    updated_at: new Date().toISOString()
  };
  return {
    courses,
    current_session: learning.current_session || null,
    wrong_book: learning.wrong_book || {},
    teaching: {
      version: teaching.version,
      teacher: null,
      classes: [],
      students: [guest],
      publications: [],
      student_learning: { [guestId]: learning },
      course_spaces: teaching.course_spaces.filter(space => availableSpaceIds.includes(space.course_space_id)).map(space => ({
        course_space_id: space.course_space_id,
        course_name: space.course_name
      }))
    }
  };
}

async function handleAuth(request, response, pathname) {
  if (request.method === 'OPTIONS') return sendState(response, 204, {});
  let payload = {};
  if (request.method === 'POST') {
    try { payload = JSON.parse((await readRequestBody(request)).toString('utf8') || '{}'); }
    catch { return sendState(response, 400, { code: 'INVALID_JSON' }); }
  }
  if (pathname === '/api/auth/teacher/status' && request.method === 'GET') {
    return sendState(response, 200, {
      exists: TEACHER_CONFIGURED,
      teacher_name: TEACHER_CONFIGURED ? FIXED_TEACHER.teacher_name : ''
    });
  }
  if (pathname === '/api/auth/session' && request.method === 'GET') {
    const state = readStatePayload().state;
    const identity = publicIdentity(readSession(request), state);
    return identity
      ? sendState(response, 200, { authenticated: true, identity })
      : sendState(response, 401, { authenticated: false, code: 'AUTH_REQUIRED' });
  }
  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    return sendState(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(request) });
  }
  if (pathname === '/api/auth/guest/login' && request.method === 'POST') {
    const requestedGuestId = String(payload.guest_id || '').trim();
    const guestId = /^guest_[a-zA-Z0-9_-]{16,100}$/.test(requestedGuestId)
      ? requestedGuestId
      : `guest_${crypto.randomBytes(16).toString('hex')}`;
    const identity = { role: 'guest', guestId };
    return sendState(response, 200, { ok: true, identity }, { 'Set-Cookie': sessionCookie(identity, request) });
  }
  if (pathname === '/api/auth/teacher/setup' && request.method === 'POST') {
    return sendState(response, 403, { code: 'TEACHER_REGISTRATION_DISABLED', message: '教师端暂不开放注册' });
  }
  if (pathname === '/api/auth/teacher/login' && request.method === 'POST') {
    if (!TEACHER_CONFIGURED) {
      return sendState(response, 503, {
        code: 'TEACHER_NOT_CONFIGURED',
        message: '教师账号尚未在服务器本机配置，请先创建 server-config.local.json。'
      });
    }
    const name = String(payload.name || '').trim();
    const password = String(payload.password || '');
    if (name !== FIXED_TEACHER.teacher_name || !verifyTeacherPassword(FIXED_TEACHER, password)) {
      return sendState(response, 401, { code: 'TEACHER_LOGIN_FAILED', message: '教师账号或密码不正确' });
    }
    try {
      const result = await queueStateWrite(() => {
        const state = readStatePayload().state;
        const teacher = ensureServerTeachingState(state).teacher;
        persistState(state);
        return teacher;
      });
      const identity = { role: 'teacher', teacherId: result.teacher_id };
      return sendState(response, 200, { ok: true, identity }, { 'Set-Cookie': sessionCookie(identity, request) });
    } catch (error) {
      return sendState(response, 500, { code: 'TEACHER_LOGIN_ERROR', message: error.message });
    }
  }
  if (pathname === '/api/auth/student/register' && request.method === 'POST') {
    const number = String(payload.number || '').trim();
    const password = String(payload.password || '');
    const confirmation = String(payload.password_confirmation || '');
    if (!number || password.length < 4 || password !== confirmation) {
      return sendState(response, 400, { code: 'INVALID_STUDENT_REGISTRATION', message: '请填写学号和至少4位密码，并确认两次密码一致' });
    }
    try {
      const result = await queueStateWrite(() => {
        const state = readStatePayload().state;
        const teaching = ensureServerTeachingState(state);
        let student = teaching.students.find(item => item.student_number === number);
        if (student?.password_scrypt || student?.password_hash) return { error: 'STUDENT_ALREADY_REGISTERED' };
        if (!student) {
          student = {
            student_id: `student_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            student_number: number,
            course_space_ids: [],
            joined_at: new Date().toISOString()
          };
          teaching.students.push(student);
        }
        delete student.student_name;
        Object.assign(student, passwordRecord(password), {
          registered_at: student.registered_at || new Date().toISOString(),
          last_active_at: new Date().toISOString()
        });
        delete student.password_hash;
        if (!teaching.student_learning[student.student_id]) {
          teaching.student_learning[student.student_id] = { current_session: null, wrong_book: {}, attempts: [], updated_at: new Date().toISOString() };
        }
        persistState(state);
        return { student };
      });
      if (result.error) return sendState(response, 409, { code: result.error, message: '该学号已注册，请直接登录' });
      const identity = { role: 'student', studentId: result.student.student_id };
      return sendState(response, 200, { ok: true, identity }, { 'Set-Cookie': sessionCookie(identity, request) });
    } catch (error) {
      return sendState(response, 500, { code: 'STUDENT_REGISTER_ERROR', message: error.message });
    }
  }
  if (pathname === '/api/auth/student/login' && request.method === 'POST') {
    const number = String(payload.number || '').trim();
    const password = String(payload.password || '');
    if (!number || !password) return sendState(response, 400, { code: 'INVALID_STUDENT_INPUT', message: '请填写学号和密码' });
    try {
      const result = await queueStateWrite(() => {
        const state = readStatePayload().state;
        const teaching = ensureServerTeachingState(state);
        const student = teaching.students.find(item => item.student_number === number);
        if (!student || !verifyTeacherPassword(student, password)) return null;
        student.last_active_at = new Date().toISOString();
        persistState(state);
        return { student };
      });
      if (!result) return sendState(response, 401, { code: 'STUDENT_LOGIN_FAILED', message: '学号或密码不正确；旧账号请先完成注册' });
      const identity = { role: 'student', studentId: result.student.student_id };
      return sendState(response, 200, { ok: true, identity }, { 'Set-Cookie': sessionCookie(identity, request) });
    } catch (error) {
      return sendState(response, 500, { code: 'STUDENT_LOGIN_ERROR', message: error.message });
    }
  }
  if (pathname === '/api/auth/student/join-course' && request.method === 'POST') {
    const courseCode = String(payload.course_code || '').trim().toUpperCase();
    const session = readSession(request);
    if (!courseCode || session?.role !== 'student' || !session.studentId) return sendState(response, 400, { code: 'INVALID_COURSE_JOIN' });
    try {
      const result = await queueStateWrite(() => {
        const state = readStatePayload().state;
        const teaching = ensureServerTeachingState(state);
        const student = teaching.students.find(item => item.student_id === session.studentId);
        const space = teaching.course_spaces.find(item => item.course_code === courseCode);
        if (!student) return { error: 'STUDENT_NOT_FOUND' };
        if (!space) return { error: 'COURSE_NOT_FOUND' };
        student.course_space_ids = Array.isArray(student.course_space_ids) ? student.course_space_ids : [];
        if (!student.course_space_ids.includes(space.course_space_id)) student.course_space_ids.push(space.course_space_id);
        student.last_active_at = new Date().toISOString();
        persistState(state);
        return { space };
      });
      if (result.error) return sendState(response, 404, { code: result.error, message: '没有找到这个课程码' });
      return sendState(response, 200, { ok: true, course_space: { course_space_id: result.space.course_space_id, course_name: result.space.course_name } });
    } catch (error) {
      return sendState(response, 500, { code: 'COURSE_JOIN_ERROR', message: error.message });
    }
  }
  return sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
}

async function handleStatePersistence(request, response) {
  if (request.method === 'OPTIONS') {
    sendState(response, 204, {});
    return;
  }
  const session = readSession(request);
  if (request.method === 'GET') {
    try {
      const stored = readStatePayload();
      const identity = publicIdentity(session, stored.state);
      if (!identity) return sendState(response, 401, { code: 'AUTH_REQUIRED' });
      const visibleState = identity.role === 'teacher'
        ? teacherStateView(stored.state)
        : identity.role === 'guest'
          ? guestStateView(stored.state, identity.guestId)
          : studentStateView(stored.state, identity.studentId);
      if (!visibleState) return sendState(response, 401, { code: 'AUTH_REQUIRED' });
      sendState(response, 200, { format: stored.format, saved_at: stored.saved_at, state: visibleState, identity });
    } catch (error) {
      sendState(response, 500, { code: 'STATE_READ_FAILED', message: error.message });
    }
    return;
  }
  if (request.method !== 'POST') {
    sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  try {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw.toString('utf8'));
    if (!isValidStatePayload(payload)) {
      sendState(response, 400, { code: 'INVALID_STATE_PAYLOAD', message: '备份内容不是有效的题库状态。' });
      return;
    }
    const result = await queueStateWrite(() => {
      const latestPayload = readStatePayload();
      const latest = latestPayload.state;
      const identity = publicIdentity(session, latest);
      if (!identity) return { error: 'AUTH_REQUIRED' };
      const latestTeaching = ensureServerTeachingState(latest);
      const incomingTeaching = ensureServerTeachingState(payload.state);
      if (identity.role === 'teacher') {
        if (!payload.base_saved_at || (latestPayload.saved_at && payload.base_saved_at !== latestPayload.saved_at)) {
          return { error: 'STATE_CONFLICT', saved_at: latestPayload.saved_at };
        }
        latest.courses = Array.isArray(payload.state.courses) ? payload.state.courses : latest.courses;
        latestTeaching.course_spaces = incomingTeaching.course_spaces;
      } else if (identity.role === 'student') {
        const studentId = identity.studentId;
        const incomingLearning = incomingTeaching.student_learning[studentId] || {
          current_session: payload.state.current_session || null,
          wrong_book: payload.state.wrong_book || {},
          attempts: []
        };
        latestTeaching.student_learning[studentId] = {
          current_session: incomingLearning.current_session || payload.state.current_session || null,
          wrong_book: incomingLearning.wrong_book || payload.state.wrong_book || {},
          attempts: Array.isArray(incomingLearning.attempts) ? incomingLearning.attempts : [],
          updated_at: new Date().toISOString()
        };
        const student = latestTeaching.students.find(item => item.student_id === studentId);
        if (student) student.last_active_at = new Date().toISOString();
      } else if (identity.role === 'guest') {
        const guestId = identity.guestId;
        const incomingLearning = incomingTeaching.student_learning[guestId] || {
          current_session: payload.state.current_session || null,
          wrong_book: payload.state.wrong_book || {},
          attempts: []
        };
        latestTeaching.guest_learning[guestId] = {
          current_session: incomingLearning.current_session || payload.state.current_session || null,
          wrong_book: incomingLearning.wrong_book || payload.state.wrong_book || {},
          attempts: Array.isArray(incomingLearning.attempts) ? incomingLearning.attempts : [],
          updated_at: new Date().toISOString()
        };
      } else {
        return { error: 'AUTH_REQUIRED' };
      }
      return { stored: persistState(latest) };
    });
    if (result.error === 'STATE_CONFLICT') {
      return sendState(response, 409, { code: result.error, saved_at: result.saved_at, message: '服务器已有更新，已拒绝旧页面覆盖' });
    }
    if (result.error) return sendState(response, 401, { code: result.error });
    sendState(response, 200, { ok: true, saved_at: result.stored.saved_at });
  } catch (error) {
    sendState(response, 500, { code: 'STATE_SAVE_FAILED', message: error.message });
  }
}

async function handleStateRestore(request, response) {
  if (request.method !== 'POST') {
    sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
    return;
  }
  try {
    const requestedId = JSON.parse((await readRequestBody(request)).toString('utf8')).id;
    const matching = listStateBackupFiles().find(item => item.id === requestedId);
    if (!matching) {
      sendState(response, 404, { code: 'BACKUP_NOT_FOUND', message: '指定备份不存在。' });
      return;
    }
    const source = requestedId === 'current'
      ? STATE_FILE
      : path.join(BACKUP_DIRECTORY, requestedId);
    const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!isValidStatePayload(payload)) {
      sendState(response, 400, { code: 'INVALID_BACKUP', message: '该备份文件不完整，无法恢复。' });
      return;
    }
    if (requestedId !== 'current' && fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, path.join(BACKUP_DIRECTORY, `题库自动备份_恢复前_${timestampForFile()}.json`));
    }
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    sendState(response, 200, { ok: true, state: payload.state });
  } catch (error) {
    sendState(response, 500, { code: 'STATE_RESTORE_FAILED', message: error.message });
  }
}

const backgroundGenerationJobs = createBackgroundGenerationJobs({
  directory: GENERATION_JOB_DIRECTORY,
  htmlPath: path.join(ROOT, '趣味刷题小站第一版.html'),
  getCourse(courseId) {
    const stored = readStatePayload();
    const course = stored.state.courses.find(item => item.course_id === courseId);
    return course ? { state: JSON.parse(JSON.stringify(stored.state)), course: JSON.parse(JSON.stringify(course)) } : null;
  },
  saveCourse(course) {
    const stored = readStatePayload();
    const index = stored.state.courses.findIndex(item => item.course_id === course.course_id);
    if (index >= 0) stored.state.courses[index] = course;
    else stored.state.courses.push(course);
    return persistState(stored.state);
  },
  callModel: callBackgroundGenerationModel,
  async appendTiming(entry) {
    appendGenerationTimingRecord(entry);
  }
});

async function handleBackgroundGenerationJobs(request, response, requestUrl) {
  if (request.method === 'OPTIONS') return sendState(response, 204, {});
  let identity;
  try { identity = publicIdentity(readSession(request), readStatePayload().state); }
  catch (error) { return sendState(response, 500, { code: 'STATE_READ_FAILED', message: error.message }); }
  if (identity?.role !== 'teacher') return sendState(response, 403, { code: 'TEACHER_REQUIRED' });
  const relative = requestUrl.pathname.slice('/api/generation-jobs'.length).replace(/^\/+|\/+$/g, '');
  const parts = relative ? relative.split('/') : [];
  try {
    if (!parts.length && request.method === 'GET') {
      const courseId = String(requestUrl.searchParams.get('course_id') || '');
      const jobs = backgroundGenerationJobs.list().filter(job => !courseId || job.course_id === courseId);
      return sendState(response, 200, { jobs });
    }
    if (!parts.length && request.method === 'POST') {
      const payload = JSON.parse((await readRequestBody(request)).toString('utf8') || '{}');
      if (!payload.course_id) return sendState(response, 400, { code: 'COURSE_ID_REQUIRED' });
      if (payload.repair_chapter) {
        return sendState(response, 202, {
          job: backgroundGenerationJobs.createManualReviewRepair(String(payload.course_id), String(payload.repair_chapter))
        });
      }
      if (payload.repair_all_manual) {
        return sendState(response, 202, {
          job: backgroundGenerationJobs.createManualReviewRepair(String(payload.course_id), '')
        });
      }
      return sendState(response, 202, { job: backgroundGenerationJobs.createOrResume(String(payload.course_id)) });
    }
    const jobId = decodeURIComponent(parts[0] || '');
    if (parts.length === 1 && request.method === 'GET') {
      const job = backgroundGenerationJobs.get(jobId);
      return job
        ? sendState(response, 200, { job })
        : sendState(response, 404, { code: 'JOB_NOT_FOUND' });
    }
    if (parts.length === 2 && request.method === 'POST' && parts[1] === 'stop') {
      return sendState(response, 200, { job: backgroundGenerationJobs.stop(jobId) });
    }
    if (parts.length === 2 && request.method === 'POST' && parts[1] === 'resume') {
      return sendState(response, 202, { job: backgroundGenerationJobs.resume(jobId) });
    }
    return sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    const status = error?.code === 'JOB_NOT_FOUND' || error?.code === 'COURSE_NOT_FOUND' ? 404 : 500;
    return sendState(response, status, { code: error?.code || 'BACKGROUND_JOB_ERROR', message: error.message });
  }
}

function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? '趣味刷题小站第一版.html' : decoded.replace(/^\/+/, '');
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  const publicFiles = new Set([
    '趣味刷题小站第一版.html',
    'jszip.min.js',
    'deepseek-config.js',
    'teaching-closure-v11.js',
    'tailwindcss-cdn.js',
    'fontawesome/css/all.min.css',
    'fontawesome/webfonts/fa-solid-900.woff2',
    'fontawesome/webfonts/fa-regular-400.woff2',
    'fontawesome/webfonts/fa-brands-400.woff2'
  ]);
  if (!publicFiles.has(normalized)) return null;
  const resolved = path.resolve(ROOT, relative);
  const rootWithSeparator = `${path.resolve(ROOT)}${path.sep}`;
  if (resolved !== path.resolve(ROOT) && !resolved.startsWith(rootWithSeparator)) return null;
  return resolved;
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const filePath = resolveStaticPath(requestUrl.pathname);
  if (!filePath) {
    sendJson(response, 403, { message: 'Forbidden' });
    return;
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      sendJson(response, 404, { message: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': /\.(?:html|js)$/i.test(filePath) ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (requestUrl.pathname.startsWith('/api/auth/')) {
    handleAuth(request, response, requestUrl.pathname);
    return;
  }
  if (requestUrl.pathname === '/api/chat/completions') {
    proxyChatCompletion(request, response);
    return;
  }
  if (requestUrl.pathname === '/api/state') {
    handleStatePersistence(request, response);
    return;
  }
  if (requestUrl.pathname === '/api/state/backups') {
    let identity;
    try { identity = publicIdentity(readSession(request), readStatePayload().state); }
    catch (error) { return sendState(response, 500, { code: 'STATE_READ_FAILED', message: error.message }); }
    if (identity?.role !== 'teacher') return sendState(response, 403, { code: 'TEACHER_REQUIRED' });
    if (request.method !== 'GET') return sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
    try { return sendState(response, 200, { backups: listStateBackupFiles() }); }
    catch (error) { return sendState(response, 500, { code: 'BACKUP_LIST_FAILED', message: error.message }); }
  }
  if (requestUrl.pathname === '/api/state/restore') {
    let identity;
    try { identity = publicIdentity(readSession(request), readStatePayload().state); }
    catch (error) { return sendState(response, 500, { code: 'STATE_READ_FAILED', message: error.message }); }
    if (identity?.role !== 'teacher') return sendState(response, 403, { code: 'TEACHER_REQUIRED' });
    handleStateRestore(request, response);
    return;
  }
  if (requestUrl.pathname === '/api/health') {
    if (request.method !== 'GET') return sendState(response, 405, { code: 'METHOD_NOT_ALLOWED' });
    return sendState(response, 200, {
      ok: true,
      version: 'V1.3.18_PUBLIC_LAUNCH_READY',
      port: PORT,
      server_time: new Date().toISOString()
    });
  }
  if (requestUrl.pathname === '/api/config') return handleConfig(request, response);
  if (requestUrl.pathname === '/api/study-store') return handleStudyStore(request, response);
  if (requestUrl.pathname === '/api/ai') return handleAi(request, response);
  if (requestUrl.pathname === '/api/generation-timing') {
    let identity;
    try { identity = publicIdentity(readSession(request), readStatePayload().state); }
    catch (error) { return sendState(response, 500, { code: 'STATE_READ_FAILED', message: error.message }); }
    if (identity?.role !== 'teacher') return sendState(response, 403, { code: 'TEACHER_REQUIRED' });
    handleGenerationTiming(request, response);
    return;
  }
  if (requestUrl.pathname === '/api/generation-jobs' || requestUrl.pathname.startsWith('/api/generation-jobs/')) {
    handleBackgroundGenerationJobs(request, response, requestUrl);
    return;
  }
  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  const page = '/趣味刷题小站第一版.html';
  console.log(`本机访问：http://127.0.0.1:${PORT}${page}`);
  const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal);
  for (const item of addresses) console.log(`同一局域网设备访问：http://${item.address}:${PORT}${page}`);
});
