const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = String(process.env.QUIZ_SITE_PORT || '8792');
const SERVER_ENTRY = path.resolve(ROOT, process.env.QUIZ_SITE_SERVER_ENTRY || 'local-server.js');
const LOG_DIR = path.join(ROOT, '运行日志');
const LOG_FILE = path.join(LOG_DIR, '本地服务自动恢复日志.log');
const LOCK_FILE = path.join(ROOT, `.quiz-site-supervisor-${PORT}.json`);
const RESTART_DELAY_MS = Math.max(500, Number(process.env.QUIZ_SITE_RESTART_DELAY_MS || 2000));
const TEST_MAX_RESTARTS = Number(process.env.QUIZ_SITE_SUPERVISOR_TEST_MAX_RESTARTS || 0);

fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  console.log(line);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (isProcessAlive(existing.pid)) {
      appendLog(`检测到已有守护程序 PID ${existing.pid}，本次不重复启动`);
      return false;
    }
  } catch (_) {}
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, started_at: new Date().toISOString() }, null, 2), 'utf8');
  return true;
}

if (!acquireLock()) process.exit(0);

let child = null;
let stopping = false;
let restartCount = 0;
let restartTimer = null;

function removeLock() {
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (Number(current.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

function startServer() {
  if (stopping) return;
  appendLog(`启动本地服务：端口 ${PORT}${restartCount ? `（自动恢复第 ${restartCount} 次）` : ''}`);
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, QUIZ_SITE_PORT: PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', data => fs.appendFileSync(LOG_FILE, data));
  child.stderr.on('data', data => fs.appendFileSync(LOG_FILE, data));
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    restartCount += 1;
    appendLog(`本地服务意外退出（code=${code ?? ''}, signal=${signal ?? ''}），${RESTART_DELAY_MS / 1000} 秒后自动恢复`);
    if (TEST_MAX_RESTARTS > 0 && restartCount >= TEST_MAX_RESTARTS) return shutdown(0);
    restartTimer = setTimeout(startServer, RESTART_DELAY_MS);
  });
  child.once('error', error => appendLog(`本地服务启动失败：${error.message}`));
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) child.kill();
  removeLock();
  setTimeout(() => process.exit(exitCode), 50);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', removeLock);
process.on('uncaughtException', error => {
  appendLog(`守护程序异常：${error.stack || error.message}`);
  shutdown(1);
});

startServer();
