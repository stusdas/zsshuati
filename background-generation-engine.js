const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeClassList() {
  return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

function makeElement() {
  const base = {
    classList: makeClassList(),
    style: new Proxy({}, { get: (target, key) => target[key] || '', set: (target, key, value) => { target[key] = value; return true; } }),
    dataset: {},
    children: [],
    value: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    querySelectorAll() { return []; },
    querySelector() { return makeElement(); },
    closest() { return null; },
    click() {},
    focus() {},
    setAttribute() {},
    getAttribute() { return null; },
    remove() {},
    get firstElementChild() { return this.children[0] || null; }
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return target[key];
      return '';
    },
    set(target, key, value) { target[key] = value; return true; }
  });
}

function extractMainScript(html) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  const main = scripts.find(code => code.includes('async function generateCourseWithChapters'));
  if (!main) throw new Error('BACKGROUND_ENGINE_MAIN_SCRIPT_NOT_FOUND');
  const bootStart = main.indexOf('      restoreStateFromDisk().then');
  const bridgeStart = main.indexOf('      // ===== V9 原版 AI 引导模块桥接', bootStart);
  const withoutBoot = bootStart >= 0 && bridgeStart > bootStart
    ? `${main.slice(0, bootStart)}${main.slice(bridgeStart)}`
    : main;
  const closeAt = withoutBoot.lastIndexOf('    })();');
  if (closeAt < 0) throw new Error('BACKGROUND_ENGINE_IIFE_END_NOT_FOUND');
  const injection = `
      let __backgroundHooks = null;
      const __cloneForWorker = value => JSON.parse(JSON.stringify(value));
      globalThis.__BACKGROUND_GENERATION_ENGINE__ = {
        async run(payload, hooks) {
          __backgroundHooks = hooks;
          window.__BACKGROUND_GENERATION_HOOKS__ = hooks;
          state = payload.state && typeof payload.state === 'object'
            ? payload.state
            : { courses: [payload.course], current_session: null, wrong_book: {}, teaching: {} };
          const courseId = payload.course.course_id;
          const existingIndex = (state.courses || []).findIndex(item => item.course_id === courseId);
          if (existingIndex >= 0) state.courses[existingIndex] = payload.course;
          else (state.courses || (state.courses = [])).push(payload.course);
          draftCourse = state.courses.find(item => item.course_id === courseId);
          stopGenerationRequested = false;
          window.BACKGROUND_GENERATION_STOP_REQUESTED = false;
          unavailableGenerationModels.clear();
          appendGenerationProgress = (message, tone = 'normal') => hooks.progress?.(String(message), tone);
          setLoading = (message, width) => hooks.loading?.(String(message), String(width || ''));
          startGenerationRequest = (task, model) => hooks.requestStarted?.(String(task || ''), model || '');
          finishGenerationRequest = status => hooks.requestFinished?.(String(status || ''));
          persistGenerationTiming = entry => hooks.timing?.(__cloneForWorker(entry));
          saveState = () => hooks.saveCourse(__cloneForWorker(draftCourse));
          requestAIModel = async (model, messages, options = {}) => {
            if (generationStopRequested()) {
              throw new AIInterfaceError('USER_STOPPED', '用户手动停止生成', { canFallback: false });
            }
            try {
              const result = await hooks.callModel(model, __cloneForWorker(messages), __cloneForWorker(options));
              return result && typeof result === 'object' && !Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, 'content')
                ? result
                : { content: String(result || ''), usage: null };
            } catch (error) {
              if (generationStopRequested()) {
                throw new AIInterfaceError('USER_STOPPED', '用户手动停止生成', { canFallback: false });
              }
              if (error && error.code === 'USER_STOPPED') {
                throw new AIInterfaceError('USER_STOPPED', error.message || '用户手动停止生成', { canFallback: false });
              }
              throw new AIInterfaceError(error?.code || 'MODEL_SERVICE_UNAVAILABLE', error?.message || String(error), {
                canFallback: error?.canFallback !== false,
                disableForGeneration: Boolean(error?.disableForGeneration),
                status: Number(error?.status || 0)
              });
            }
          };
          const chapters = (draftCourse.chapters && draftCourse.chapters.length)
            ? draftCourse.chapters
            : (draftCourse._pendingChapters || []);
          const generated = await generateCourseWithChapters(
            draftCourse.course_name,
            chapters,
            draftCourse._assessmentBlueprint || {},
            draftCourse._mainText || '',
            draftCourse._supplementText || ''
          );
          draftCourse.chapters = generated.chapters;
          draftCourse.question_bank = generated.question_bank;
          delete draftCourse._pendingChapters;
          delete draftCourse._assessmentBlueprint;
          delete draftCourse._mainText;
          delete draftCourse._supplementText;
          delete draftCourse.failed_generation_tasks;
          draftCourse.status = 'pending_review';
          draftCourse.paper_reviews = ensurePaperReviews(draftCourse, true);
          draftCourse.updated_at = new Date().toISOString();
          await hooks.saveCourse(__cloneForWorker(draftCourse));
          return __cloneForWorker(draftCourse);
        },
        async repairManual(payload, hooks) {
          __backgroundHooks = hooks;
          window.__BACKGROUND_GENERATION_HOOKS__ = hooks;
          state = payload.state && typeof payload.state === 'object'
            ? payload.state
            : { courses: [payload.course], current_session: null, wrong_book: {}, teaching: {} };
          const courseId = payload.course.course_id;
          const existingIndex = (state.courses || []).findIndex(item => item.course_id === courseId);
          if (existingIndex >= 0) state.courses[existingIndex] = payload.course;
          else (state.courses || (state.courses = [])).push(payload.course);
          draftCourse = state.courses.find(item => item.course_id === courseId);
          stopGenerationRequested = false;
          window.BACKGROUND_GENERATION_STOP_REQUESTED = false;
          unavailableGenerationModels.clear();
          appendGenerationProgress = (message, tone = 'normal') => hooks.progress?.(String(message), tone);
          setLoading = (message, width) => hooks.loading?.(String(message), String(width || ''));
          startGenerationRequest = (task, model) => hooks.requestStarted?.(String(task || ''), model || '');
          finishGenerationRequest = status => hooks.requestFinished?.(String(status || ''));
          persistGenerationTiming = entry => hooks.timing?.(__cloneForWorker(entry));
          saveState = () => hooks.saveCourse(__cloneForWorker(draftCourse));
          requestAIModel = async (model, messages, options = {}) => {
            if (generationStopRequested()) {
              throw new AIInterfaceError('USER_STOPPED', '用户手动停止生成', { canFallback: false });
            }
            try {
              const result = await hooks.callModel(model, __cloneForWorker(messages), __cloneForWorker(options));
              return result && typeof result === 'object' && !Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, 'content')
                ? result
                : { content: String(result || ''), usage: null };
            } catch (error) {
              if (generationStopRequested() || error?.code === 'USER_STOPPED') {
                throw new AIInterfaceError('USER_STOPPED', error?.message || '用户手动停止生成', { canFallback: false });
              }
              throw new AIInterfaceError(error?.code || 'MODEL_SERVICE_UNAVAILABLE', error?.message || String(error), {
                canFallback: error?.canFallback !== false,
                disableForGeneration: Boolean(error?.disableForGeneration),
                status: Number(error?.status || 0)
              });
            }
          };
          const result = await repairManualQuestionsInChapter(
            draftCourse.course_name,
            String(payload.chapterTitle || '')
          );
          draftCourse.status = 'pending_review';
          draftCourse.paper_reviews = ensurePaperReviews(draftCourse);
          draftCourse.updated_at = new Date().toISOString();
          await hooks.saveCourse(__cloneForWorker(draftCourse));
          return { course: __cloneForWorker(draftCourse), result: __cloneForWorker(result) };
        },
        stop() {
          stopGenerationRequested = true;
          window.BACKGROUND_GENERATION_STOP_REQUESTED = true;
          __backgroundHooks?.abort?.();
        },
        isStopRequested() {
          return generationStopRequested();
        }
      };
`;
  return `${withoutBoot.slice(0, closeAt)}${injection}${withoutBoot.slice(closeAt)}`;
}

function createBackgroundGenerationEngine(options = {}) {
  const htmlPath = options.htmlPath || path.join(__dirname, '趣味刷题小站第一版.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const mainScript = extractMainScript(html);
  const elementById = new Map();
  const document = {
    body: makeElement(),
    documentElement: makeElement(),
    getElementById(id) {
      if (!elementById.has(id)) elementById.set(id, makeElement());
      return elementById.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return makeElement(); },
    createElement() { return makeElement(); },
    addEventListener() {},
    removeEventListener() {}
  };
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
    clear() { storage.clear(); }
  };
  const window = {
    document,
    localStorage,
    location: { protocol: 'http:', origin: 'http://127.0.0.1', href: 'http://127.0.0.1/' },
    navigator: { userAgent: 'QuizBackgroundWorker/1.0' },
    DEEPSEEK_CONFIG: {
      apiKey: 'SERVER_SIDE',
      apiUrl: 'server://generation',
      models: [
        'inclusionAI/Ling-flash-2.0',
        'zai-org/GLM-5.2',
        'deepseek-ai/DeepSeek-V4-Flash'
      ],
      requestTimeoutMs: 90000
    },
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    innerHeight: 900,
    visualViewport: null,
    crypto: crypto.webcrypto
  };
  window.window = window;
  window.globalThis = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    location: window.location,
    navigator: window.navigator,
    globalThis: window,
    console,
    crypto: crypto.webcrypto,
    performance,
    fetch: async (_url, request = {}) => {
      const hooks = window.__BACKGROUND_GENERATION_HOOKS__;
      if (!hooks?.callModel) throw new Error('BACKGROUND_ENGINE_MODEL_HOOK_NOT_READY');
      const body = JSON.parse(String(request.body || '{}'));
      try {
        const modelResult = await hooks.callModel(body.model, body.messages || [], {
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          json: body.response_format?.type === 'json_object',
          thinkingBudget: body.thinking_budget
        });
        const content = modelResult && typeof modelResult === 'object' && !Array.isArray(modelResult)
          ? String(modelResult.content || '')
          : String(modelResult || '');
        const usage = modelResult && typeof modelResult === 'object' && !Array.isArray(modelResult)
          ? modelResult.usage
          : null;
        return {
          ok: true,
          status: 200,
          async json() { return { choices: [{ finish_reason: 'stop', message: { content } }], usage }; },
          async text() { return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage }); }
        };
      } catch (error) {
        if (window.BACKGROUND_GENERATION_STOP_REQUESTED === true || error?.code === 'USER_STOPPED') {
          const stopped = new Error(error?.message || '用户手动停止生成');
          stopped.name = 'AbortError';
          throw stopped;
        }
        if (error?.code === 'REQUEST_TIMEOUT') {
          const timeout = new Error(error.message || '模型响应超时');
          timeout.name = 'AbortError';
          throw timeout;
        }
        const status = Number(error?.status || (error?.code === 'MODEL_RATE_LIMITED' ? 429 : error?.code === 'AUTH_ERROR' ? 401 : 503));
        return {
          ok: false,
          status,
          async json() { return { error: { message: error?.message || String(error) } }; },
          async text() { return JSON.stringify({ error: { message: error?.message || String(error) } }); }
        };
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    Blob,
    URL,
    AbortController,
    structuredClone,
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    alert() {},
    confirm() { return false; },
    prompt() { return null; },
    FileReader: class FileReader {},
    DOMParser: class DOMParser {},
    JSZip: { loadAsync: async () => { throw new Error('BACKGROUND_ENGINE_FILE_PARSE_NOT_AVAILABLE'); } }
  });
  new vm.Script(mainScript, { filename: 'quiz-background-engine.vm.js' }).runInContext(context);
  const engine = window.__BACKGROUND_GENERATION_ENGINE__;
  if (!engine || typeof engine.run !== 'function') throw new Error('BACKGROUND_ENGINE_EXPORT_FAILED');
  return engine;
}

module.exports = { createBackgroundGenerationEngine };
