const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createBackgroundGenerationEngine } = require('./background-generation-engine');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBackgroundGenerationJobs(options) {
  const directory = options.directory;
  const engineFactory = options.engineFactory || createBackgroundGenerationEngine;
  const jobs = new Map();
  const runtimes = new Map();
  let activeJobId = '';

  fs.mkdirSync(directory, { recursive: true });

  function jobPath(id) {
    return path.join(directory, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  function saveJob(job) {
    job.updated_at = new Date().toISOString();
    const file = jobPath(job.job_id);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
    jobs.set(job.job_id, job);
  }

  function publicJob(job) {
    if (!job) return null;
    return clone({
      job_id: job.job_id,
      course_id: job.course_id,
      course_name: job.course_name,
      status: job.status,
      progress_percent: job.progress_percent || 0,
      current_task: job.current_task || '',
      current_model: job.current_model || '',
      saved_questions: job.saved_questions || 0,
      total_questions: job.total_questions || 0,
      job_type: job.job_type || 'course_generation',
      chapter_title: job.chapter_title || '',
      repair_scope: job.repair_scope || (job.chapter_title ? 'chapter' : 'course'),
      repair_total: job.repair_total || 0,
      repair_processed: job.repair_processed || 0,
      repair_completed: job.repair_completed || 0,
      repair_remaining: job.repair_remaining || 0,
      failed_task_count: job.failed_task_count || 0,
      created_at: job.created_at,
      started_at: job.started_at || '',
      updated_at: job.updated_at,
      completed_at: job.completed_at || '',
      error: job.error || null,
      progress_log: (job.progress_log || []).slice(-80)
    });
  }

  function appendProgress(job, message, tone = 'normal') {
    job.progress_log = Array.isArray(job.progress_log) ? job.progress_log : [];
    job.progress_log.push({ at: new Date().toISOString(), message: String(message), tone: String(tone || 'normal') });
    if (job.progress_log.length > 200) job.progress_log.splice(0, job.progress_log.length - 200);
    if (job.job_type === 'manual_review_repair') {
      const match = String(message).match(/已处理\s+(\d+)\/(\d+)\s+道，成功\s+(\d+)\s+道/);
      if (match) {
        job.repair_total = Number(match[2]);
        job.repair_processed = Number(match[1]);
        job.repair_completed = Number(match[3]);
        job.saved_questions = job.repair_processed;
        job.total_questions = job.repair_total;
        job.progress_percent = job.repair_total ? Math.min(99, Math.round(job.repair_processed / job.repair_total * 100)) : 0;
      }
    }
    saveJob(job);
  }

  function repairQuestionInScope(job, question) {
    return Boolean(question?.manual_edit_required) && (!job.chapter_title || question.chapter === job.chapter_title);
  }

  function repairScopeLabel(job) {
    return job.chapter_title || '当前题库全部章节';
  }

  function loadJobs() {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
        if (!job?.job_id || !job?.course_id) continue;
        if (job.status === 'running' || job.status === 'stopping') {
          job.status = 'queued';
          job.current_task = '服务重新启动，等待从已保存题位继续';
        }
        jobs.set(job.job_id, job);
        saveJob(job);
      } catch (error) {
        console.warn(`读取后台生成任务失败：${entry.name}：${error.message}`);
      }
    }
  }

  async function saveCourseProgress(job, course) {
    const stored = await options.saveCourse(clone(course));
    if (job.job_type === 'manual_review_repair') {
      job.repair_remaining = Array.isArray(course.question_bank)
        ? course.question_bank.filter(question => repairQuestionInScope(job, question)).length
        : 0;
      job.saved_questions = job.repair_processed || 0;
      job.total_questions = job.repair_total || job.saved_questions;
      job.progress_percent = job.total_questions
        ? Math.min(99, Math.round(job.saved_questions / job.total_questions * 100))
        : 0;
      saveJob(job);
      return stored;
    }
    job.saved_questions = Array.isArray(course.question_bank) ? course.question_bank.length : 0;
    job.total_questions = Math.max(job.total_questions || 0, (course.chapters || []).length * 80);
    job.failed_task_count = Array.isArray(course.failed_generation_tasks) ? course.failed_generation_tasks.length : 0;
    job.progress_percent = job.total_questions
      ? Math.min(99, Math.round(job.saved_questions / job.total_questions * 100))
      : 0;
    saveJob(job);
    return stored;
  }

  async function runJob(job) {
    if (activeJobId) return;
    activeJobId = job.job_id;
    job.status = 'running';
    job.started_at = job.started_at || new Date().toISOString();
    job.error = null;
    saveJob(job);
    const runtime = { controller: null, engine: null };
    runtimes.set(job.job_id, runtime);
    try {
      const snapshot = options.getCourse(job.course_id);
      if (!snapshot?.course) throw Object.assign(new Error('找不到要继续生成的题库'), { code: 'COURSE_NOT_FOUND' });
      job.course_name = snapshot.course.course_name || job.course_name;
      if (job.job_type === 'manual_review_repair') {
        const pending = (snapshot.course.question_bank || []).filter(question =>
          repairQuestionInScope(job, question)
        ).length;
        job.repair_total = pending;
        job.repair_processed = 0;
        job.repair_completed = 0;
        job.repair_remaining = pending;
        job.saved_questions = 0;
        job.total_questions = job.repair_total;
      } else {
        job.saved_questions = (snapshot.course.question_bank || []).length;
        job.total_questions = (snapshot.course.chapters || snapshot.course._pendingChapters || []).length * 80;
      }
      saveJob(job);
      runtime.engine = engineFactory({ htmlPath: options.htmlPath });
      appendProgress(job, job.job_type === 'manual_review_repair'
        ? `后台AI重生开始：${repairScopeLabel(job)} 共 ${job.repair_total} 道待补题`
        : `后台任务开始：从已保存的 ${job.saved_questions} 道题继续`, 'success');
      const completion = job.job_type === 'manual_review_repair'
        ? await runtime.engine.repairManual({ state: snapshot.state, course: snapshot.course, chapterTitle: job.chapter_title }, {
          progress(message, tone) {
            job.current_task = message;
            appendProgress(job, message, tone);
          },
          loading(message, width) {
            job.current_task = message;
            const numeric = Number.parseFloat(String(width || '').replace('%', ''));
            if (Number.isFinite(numeric)) job.progress_percent = Math.max(job.progress_percent || 0, Math.min(99, numeric));
            saveJob(job);
          },
          requestStarted(task, model) { job.current_task = task; job.current_model = model || ''; saveJob(job); },
          requestFinished(status) { job.current_task = status || job.current_task; saveJob(job); },
          async timing(entry) { await options.appendTiming({ strategy_version: 'V1.3.15_STUDENT_REGISTRATION_ANONYMOUS_STATS', run_id: job.job_id, course_name: job.course_name, ...entry }); },
          async callModel(model, messages, generationOptions) {
            const controller = new AbortController(); runtime.controller = controller;
            try { return await options.callModel(model, messages, generationOptions, controller.signal); }
            finally { if (runtime.controller === controller) runtime.controller = null; }
          },
          async saveCourse(course) { return saveCourseProgress(job, course); },
          abort() { runtime.controller?.abort(); }
        })
        : await runtime.engine.run({ state: snapshot.state, course: snapshot.course }, {
        progress(message, tone) {
          job.current_task = message;
          appendProgress(job, message, tone);
        },
        loading(message, width) {
          job.current_task = message;
          const numeric = Number.parseFloat(String(width || '').replace('%', ''));
          if (Number.isFinite(numeric)) job.progress_percent = Math.max(job.progress_percent || 0, Math.min(99, numeric));
          saveJob(job);
        },
        requestStarted(task, model) {
          job.current_task = task;
          job.current_model = model || '';
          saveJob(job);
        },
        requestFinished(status) {
          job.current_task = status || job.current_task;
          saveJob(job);
        },
        async timing(entry) {
          await options.appendTiming({
            strategy_version: 'V1.3.15_NORMAL_GENERATION_WITH_STUDENT_REGISTRATION',
            run_id: job.job_id,
            course_name: job.course_name,
            ...entry
          });
        },
        async callModel(model, messages, generationOptions) {
          const controller = new AbortController();
          runtime.controller = controller;
          try {
            return await options.callModel(model, messages, generationOptions, controller.signal);
          } finally {
            if (runtime.controller === controller) runtime.controller = null;
          }
        },
        async saveCourse(course) {
          return saveCourseProgress(job, course);
        },
        abort() {
          runtime.controller?.abort();
        }
      });
      const completedCourse = job.job_type === 'manual_review_repair' ? completion.course : completion;
      if (job.job_type === 'manual_review_repair') {
        job.repair_total = completion.result.total;
        job.repair_processed = completion.result.total;
        job.repair_completed = completion.result.repaired;
        job.repair_remaining = completion.result.remaining;
        job.saved_questions = completion.result.total;
        job.total_questions = completion.result.total;
      }
      if (job.job_type === 'manual_review_repair') {
        job.saved_questions = job.repair_processed;
        job.total_questions = job.repair_total || job.total_questions;
      } else {
        job.saved_questions = (completedCourse.question_bank || []).length;
        job.total_questions = job.saved_questions;
      }
      job.failed_task_count = 0;
      job.progress_percent = 100;
      job.status = 'completed';
      job.current_task = job.job_type === 'manual_review_repair'
        ? `${repairScopeLabel(job)} AI重生完成：已处理 ${job.repair_processed} 道，自动审核通过 ${job.repair_completed} 道，仍待补题 ${job.repair_remaining} 道`
        : '全部题目已生成并保存，等待教师审核';
      job.current_model = '';
      job.completed_at = new Date().toISOString();
      appendProgress(job, job.current_task, 'success');
    } catch (error) {
      const stopped = job.status === 'stopping' || error?.code === 'USER_STOPPED' || error?.name === 'GenerationStopped';
      const accessBlocked = ['QUOTA_EXCEEDED', 'AUTH_ERROR', 'FORBIDDEN'].includes(error?.code);
      job.status = stopped || accessBlocked ? 'paused' : (error?.name === 'GenerationIncomplete' ? 'partial' : 'failed');
      job.current_model = '';
      job.current_task = stopped
        ? '任务已暂停，可继续生成'
        : accessBlocked
          ? error.code === 'QUOTA_EXCEEDED'
            ? `模型账户余额不足，已保留 ${job.saved_questions} 道题；充值后点击继续生成`
            : `模型账户不可用，已保留 ${job.saved_questions} 道题；修复密钥后点击继续生成`
          : `任务未完成：${error.message}`;
      job.error = stopped ? null : {
        code: error?.code || error?.name || 'BACKGROUND_GENERATION_FAILED',
        message: error?.message || String(error),
        at: new Date().toISOString()
      };
      appendProgress(job, job.current_task, stopped || accessBlocked ? 'warning' : 'error');
    } finally {
      runtimes.delete(job.job_id);
      activeJobId = '';
      saveJob(job);
      queueMicrotask(runNextQueued);
    }
  }

  function runNextQueued() {
    if (activeJobId) return;
    const next = [...jobs.values()]
      .filter(job => job.status === 'queued')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (next) runJob(next).catch(error => console.error(`后台任务启动失败：${error.message}`));
  }

  function createOrResume(courseId) {
    const snapshot = options.getCourse(courseId);
    if (!snapshot?.course) throw Object.assign(new Error('题库不存在'), { code: 'COURSE_NOT_FOUND' });
    let job = [...jobs.values()].find(item => item.course_id === courseId && ['queued', 'running', 'paused', 'partial', 'failed'].includes(item.status));
    if (!job) {
      const now = new Date().toISOString();
      job = {
        job_id: `generation_${crypto.randomUUID()}`,
        course_id: courseId,
        course_name: snapshot.course.course_name || '',
        status: 'queued',
        progress_percent: 0,
        current_task: '等待后台生成',
        current_model: '',
        saved_questions: (snapshot.course.question_bank || []).length,
        total_questions: (snapshot.course.chapters || snapshot.course._pendingChapters || []).length * 80,
        failed_task_count: (snapshot.course.failed_generation_tasks || []).length,
        progress_log: [],
        created_at: now,
        updated_at: now
      };
    } else if (job.status !== 'running' && job.status !== 'queued') {
      job.status = 'queued';
      job.error = null;
      job.current_task = '等待从已保存题位继续';
    }
    saveJob(job);
    runNextQueued();
    return publicJob(job);
  }

  function createManualReviewRepair(courseId, chapterTitle) {
    const snapshot = options.getCourse(courseId);
    if (!snapshot?.course) throw Object.assign(new Error('题库不存在'), { code: 'COURSE_NOT_FOUND' });
    const title = String(chapterTitle || '');
    const pending = (snapshot.course.question_bank || []).filter(question =>
      question.manual_edit_required && (!title || question.chapter === title)
    ).length;
    if (!pending) throw Object.assign(new Error(title ? '该章节没有待补题，无需AI重新生成' : '当前题库没有待补题，无需AI重新生成'), { code: 'NO_MANUAL_QUESTIONS' });
    let job = [...jobs.values()].find(item => item.course_id === courseId && item.job_type === 'manual_review_repair' && item.chapter_title === title && ['queued', 'running', 'paused', 'partial', 'failed'].includes(item.status));
    if (!job) {
      const now = new Date().toISOString();
      job = {
        job_id: `review_repair_${crypto.randomUUID()}`,
        job_type: 'manual_review_repair',
        chapter_title: title,
        repair_scope: title ? 'chapter' : 'course',
        repair_total: pending,
        repair_processed: 0,
        repair_completed: 0,
        repair_remaining: pending,
        course_id: courseId,
        course_name: snapshot.course.course_name || '',
        status: 'queued', progress_percent: 0, current_task: '等待后台AI重新生成待补题', current_model: '',
        saved_questions: 0, total_questions: pending, failed_task_count: 0, progress_log: [], created_at: now, updated_at: now
      };
    } else if (job.status !== 'running' && job.status !== 'queued') {
      job.status = 'queued'; job.error = null; job.current_task = '等待继续AI重新生成待补题';
    }
    saveJob(job); runNextQueued(); return publicJob(job);
  }

  function stop(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw Object.assign(new Error('任务不存在'), { code: 'JOB_NOT_FOUND' });
    if (job.status === 'queued') {
      job.status = 'paused';
      job.current_task = '任务已暂停，可继续生成';
      saveJob(job);
      return publicJob(job);
    }
    if (job.status === 'running') {
      job.status = 'stopping';
      job.current_task = '正在停止当前请求并保存进度';
      saveJob(job);
      const runtime = runtimes.get(jobId);
      runtime?.engine?.stop();
      runtime?.controller?.abort();
    }
    return publicJob(job);
  }

  loadJobs();
  queueMicrotask(runNextQueued);

  return {
    list() { return [...jobs.values()].map(publicJob).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))); },
    get(jobId) { return publicJob(jobs.get(jobId)); },
    createOrResume,
    createManualReviewRepair,
    stop,
    resume(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw Object.assign(new Error('任务不存在'), { code: 'JOB_NOT_FOUND' });
      if (job.status !== 'completed') {
        job.status = 'queued';
        job.error = null;
        job.current_task = '等待从已保存题位继续';
        saveJob(job);
        runNextQueued();
      }
      return publicJob(job);
    }
  };
}

module.exports = { createBackgroundGenerationJobs };
