// V1.1 起由 local-server.js 在服务器端读取本机密钥，浏览器不再保存真实 Key。
window.DEEPSEEK_CONFIG = {
  apiKey: 'SERVER_MANAGED',
  apiUrl: window.location.protocol === 'file:'
    ? 'http://127.0.0.1:8792/api/chat/completions'
    : '/api/chat/completions',
  models: [
    'Qwen/Qwen3-VL-8B-Thinking'
  ],
  requestTimeoutMs: 90000
};
