(() => {
  'use strict';

  const IDENTITY_KEY = 'quiz_site_teaching_closure_v1318_identity';
  const GUEST_DEVICE_KEY = 'quiz_site_teaching_closure_v1318_guest_device';
  let activeClassId = '';
  let activeClassTab = 'courses';
  let activeCourseSpaceId = '';
  let activeCourseSpaceTab = 'banks';
  let activeStatisticsTab = 'semester';
  let selectedAnonymousLearnerId = '';
  let studentAuthMode = 'login';

  const $ = id => document.getElementById(id);
  const app = () => window.QUIZ_APP_V1;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const nowIso = () => new Date().toISOString();
  const uid = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  function getIdentity() {
    try {
      return JSON.parse(localStorage.getItem(IDENTITY_KEY)) || null;
    } catch {
      return null;
    }
  }

  function setIdentity(identity) {
    if (identity) localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    else localStorage.removeItem(IDENTITY_KEY);
  }

  function ensureTeachingState(state = app()?.getState?.()) {
    if (!state) return null;
    const teaching = state.teaching && typeof state.teaching === 'object' ? state.teaching : {};
    teaching.version = 1.1;
    teaching.teacher = teaching.teacher && typeof teaching.teacher === 'object' ? teaching.teacher : null;
    teaching.classes = Array.isArray(teaching.classes) ? teaching.classes : [];
    teaching.students = Array.isArray(teaching.students) ? teaching.students : [];
    teaching.publications = Array.isArray(teaching.publications) ? teaching.publications : [];
    teaching.student_learning = teaching.student_learning && typeof teaching.student_learning === 'object'
      ? teaching.student_learning
      : {};
    teaching.course_spaces = Array.isArray(teaching.course_spaces) ? teaching.course_spaces : [];
    teaching.course_statistics = teaching.course_statistics && typeof teaching.course_statistics === 'object'
      ? teaching.course_statistics
      : {};
    for (const space of teaching.course_spaces) {
      if (space.course_code) continue;
      let code;
      do { code = `K${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
      while (teaching.course_spaces.some(item => item !== space && item.course_code === code));
      space.course_code = code;
    }
    teaching.students.forEach(student => { student.course_space_ids = Array.isArray(student.course_space_ids) ? student.course_space_ids : []; });
    for (const bank of state.courses || []) {
      if (!bank.parent_course_id) {
        let space = teaching.course_spaces.find(item => item.course_name === bank.course_name);
        if (!space) {
          space = { course_space_id: uid('course_space'), course_name: bank.course_name || '未命名课程', created_at: bank.created_at || nowIso() };
          teaching.course_spaces.push(space);
        }
        bank.parent_course_id = space.course_space_id;
      }
      bank.bank_name = bank.bank_name || bank.course_name || '未命名题库';
    }
    state.teaching = teaching;
    return teaching;
  }

  function currentStudent() {
    const identity = getIdentity();
    if (!['student', 'guest'].includes(identity?.role)) return null;
    const teaching = ensureTeachingState();
    const learnerId = identity.role === 'guest' ? identity.guestId : identity.studentId;
    return teaching?.students.find(student => student.student_id === learnerId) || null;
  }

  function currentTeacher() {
    const identity = getIdentity();
    const teaching = ensureTeachingState();
    return identity?.role === 'teacher' && teaching?.teacher?.teacher_id === identity.teacherId ? teaching.teacher : null;
  }

  function learningFor(studentId) {
    const teaching = ensureTeachingState();
    if (!teaching.student_learning[studentId]) {
      teaching.student_learning[studentId] = {
        current_session: null,
        wrong_book: {},
        attempts: [],
        updated_at: nowIso()
      };
    }
    const learning = teaching.student_learning[studentId];
    learning.wrong_book = learning.wrong_book && typeof learning.wrong_book === 'object' ? learning.wrong_book : {};
    learning.attempts = Array.isArray(learning.attempts) ? learning.attempts : [];
    return learning;
  }

  function collectCompletedAttempts(state, learning) {
    const session = state.current_session;
    if (!session?.round_history?.length) return;
    session.round_history.forEach(round => {
      const completedAt = round.completed_at || '';
      const key = `${session.course_id || ''}::${session.chapter || ''}::${completedAt}::${round.set_number || ''}`;
      if (!completedAt || learning.attempts.some(item => item.key === key)) return;
      learning.attempts.push({
        key,
        course_id: session.course_id || '',
        chapter: session.chapter || '',
        difficulty_band: round.difficulty_band || '',
        set_number: Number(round.set_number || 1),
        score: Number(round.score || 0),
        diagnosis_score: Number(session.diagnosis_score || 0),
        answers: clone(round.answers || []),
        completed_at: completedAt
      });
    });
  }

  function beforeQuizStateSave(state) {
    const identity = getIdentity();
    if (!['student', 'guest'].includes(identity?.role)) return;
    const learnerId = identity.role === 'guest' ? identity.guestId : identity.studentId;
    if (!learnerId) return;
    const teaching = ensureTeachingState(state);
    const student = teaching.students.find(item => item.student_id === learnerId);
    if (!student) return;
    const learning = learningFor(student.student_id);
    learning.current_session = clone(state.current_session || null);
    learning.wrong_book = clone(state.wrong_book || {});
    collectCompletedAttempts(state, learning);
    learning.updated_at = nowIso();
    student.last_active_at = learning.updated_at;
  }

  function restoreStudentLearning(studentId) {
    const state = app().getState();
    const learning = learningFor(studentId);
    state.current_session = clone(learning.current_session || null);
    state.wrong_book = clone(learning.wrong_book || {});
  }

  async function hashPassword(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function generateClassCode() {
    const teaching = ensureTeachingState();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = 'C';
      for (let index = 0; index < 6; index += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    } while (teaching.classes.some(item => item.class_code === code));
    return code;
  }

  function approvedChapterTitles(course) {
    return (course.chapters || []).filter(chapter => {
      const papers = (course.paper_reviews || []).filter(paper => paper.chapter === chapter.title);
      return papers.length === 8 && papers.every(paper => paper.status === 'approved');
    }).map(chapter => chapter.title);
  }

  function resolveHomeScreen() {
    const identity = getIdentity();
    if (identity?.role === 'teacher' && currentTeacher()) return 'teacher-course-list';
    if (identity?.role === 'student' && currentStudent()) return 'student-home';
    if (identity?.role === 'guest' && currentStudent()) return 'student-home';
    return 'role';
  }

  function resolveCourseListScreen() {
    return ['student', 'guest'].includes(getIdentity()?.role) ? 'student-home' : 'teacher-course-list';
  }

  function routeAfterRestore() {
    const teaching = ensureTeachingState();
    const identity = Object.prototype.hasOwnProperty.call(window, 'QUIZ_SERVER_IDENTITY')
      ? window.QUIZ_SERVER_IDENTITY
      : getIdentity();
    if (identity) setIdentity(identity);
    if (identity?.role === 'teacher' && teaching.teacher) {
      app().saveState();
      renderTeacherDashboard();
      app().showRawScreen('teacher-dashboard');
      return;
    }
    if (['student', 'guest'].includes(identity?.role)) {
      const learnerId = identity.role === 'guest' ? identity.guestId : identity.studentId;
      const student = teaching.students.find(item => item.student_id === learnerId);
      if (student) {
        restoreStudentLearning(student.student_id);
        renderStudentHome();
        app().showRawScreen('student-home');
        return;
      }
    }
    setIdentity(null);
    app().showRawScreen('role');
  }

  async function openTeacherAuth() {
    $('teacher-auth-badge').textContent = '教师登录';
    $('teacher-auth-title').textContent = '进入教师工作台';
    $('teacher-auth-hint').textContent = '教师端使用固定测试账号，暂不开放注册。';
    $('teacher-name-input').value = '测试1';
    $('teacher-name-input').disabled = true;
    $('teacher-password-input').value = '';
    $('teacher-auth-submit').textContent = '登录';
    app().showRawScreen('teacher-auth');
  }

  async function submitTeacherAuth() {
    const name = $('teacher-name-input').value.trim();
    const password = $('teacher-password-input').value;
    if (!name) return alert('请输入教师姓名');
    if (!password) return alert('请输入密码');
    try {
      const response = await fetch('/api/auth/teacher/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
      const payload = await response.json();
      if (!response.ok) return alert(payload.message || '教师登录失败');
      setIdentity(payload.identity);
      location.reload();
    } catch (error) {
      alert(`无法连接登录服务：${error.message}`);
    }
  }

  function renderTeacherDashboard() {
    const teacher = ensureTeachingState().teacher;
    $('teacher-welcome').textContent = teacher ? `欢迎回来，${teacher.teacher_name}` : '教师工作台';
  }

  function setStudentAuthMode(mode) {
    studentAuthMode = mode === 'register' ? 'register' : 'login';
    const registering = studentAuthMode === 'register';
    $('student-auth-badge').textContent = registering ? '学生注册' : '学生登录';
    $('student-auth-title').textContent = registering ? '创建学生账号' : '进入我的课程';
    $('student-auth-hint').textContent = registering
      ? '注册只需学号和密码；登录后再用课程码加入课程。'
      : '登录后再使用课程码加入课程。';
    $('student-password-confirm-wrap').classList.toggle('hide', !registering);
    $('student-password-input').autocomplete = registering ? 'new-password' : 'current-password';
    $('student-auth-submit').textContent = registering ? '注册并进入' : '登录';
    $('student-forgot-password-btn').classList.toggle('hide', registering);
    $('student-login-mode-btn').className = `${registering ? 'bg-paper-white' : 'bg-primary'} border-brutal py-3 font-black btn-brutal`;
    $('student-register-mode-btn').className = `${registering ? 'bg-primary' : 'bg-paper-white'} border-brutal py-3 font-black btn-brutal`;
  }

  function openStudentAuth() {
    $('student-number-input').value = '';
    $('student-password-input').value = '';
    $('student-password-confirm-input').value = '';
    setStudentAuthMode('login');
    app().showRawScreen('student-auth');
  }

  async function submitStudentAuth() {
    const number = $('student-number-input').value.trim();
    const password = $('student-password-input').value;
    const confirmation = $('student-password-confirm-input').value;
    if (!number || !password) return alert('请填写学号和密码');
    if (studentAuthMode === 'register' && password.length < 4) return alert('密码至少需要4位');
    if (studentAuthMode === 'register' && password !== confirmation) return alert('两次输入的密码不一致');
    const endpoint = studentAuthMode === 'register' ? '/api/auth/student/register' : '/api/auth/student/login';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number, password, password_confirmation: confirmation }) });
      const payload = await response.json();
      if (!response.ok) return alert(payload.message || (studentAuthMode === 'register' ? '学生注册失败' : '学生登录失败'));
      setIdentity(payload.identity);
      location.reload();
    } catch (error) {
      alert(`无法连接登录服务：${error.message}`);
    }
  }

  async function enterGuestMode() {
    let guestId = localStorage.getItem(GUEST_DEVICE_KEY) || '';
    if (!/^guest_[a-zA-Z0-9_-]{16,100}$/.test(guestId)) {
      const randomPart = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
      guestId = `guest_${randomPart}`;
      localStorage.setItem(GUEST_DEVICE_KEY, guestId);
    }
    const button = $('role-guest-btn');
    button.disabled = true;
    try {
      const response = await fetch('/api/auth/guest/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_id: guestId })
      });
      const payload = await response.json();
      if (!response.ok) return alert(payload.message || '访客身份进入失败');
      setIdentity(payload.identity);
      location.reload();
    } catch (error) {
      alert(`无法进入访客模式：${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function renderStudentHome() {
    const identity = getIdentity();
    const isGuest = identity?.role === 'guest';
    const student = currentStudent();
    if (!student) return routeAfterRestore();
    const state = app().getState();
    const teaching = ensureTeachingState(state);
    $('student-welcome').textContent = isGuest ? '欢迎，访客' : '欢迎回来';
    $('student-class-label').textContent = isGuest ? '无需课程码，可使用全部已开放题库' : '输入课程码加入课程';
    $('student-course-heading').textContent = isGuest ? '可用课程' : '我的课程';
    $('student-switch-btn').textContent = isGuest ? '退出访客' : '切换账号';
    const joinedSpaceIds = new Set(student.course_space_ids || []);
    const cards = state.courses.filter(course => (isGuest || joinedSpaceIds.has(course.parent_course_id)) && (course.chapters || []).length).map((course, index) => {
      if (!course) return '';
      const courseSpace = teaching.course_spaces.find(item => item.course_space_id === course.parent_course_id);
      return `<div class="${index % 2 ? 'bg-cyan rotate-1' : 'bg-primary -rotate-1'} border-brutal shadow-brutal p-5">
        <span class="tiny-label bg-black text-white px-2 py-1">${isGuest ? '访客可用' : '已加入课程'}</span>
        <div class="text-2xl font-black mt-3">${escapeHtml(courseSpace?.course_name || course.course_name)}</div>
        <div class="mt-2 text-sm font-bold">题库：${escapeHtml(course.bank_name || course.course_name)} · 开放 ${(course.chapters || []).length} 个章节</div>
        <button class="student-open-course mt-4 w-full bg-lime border-brutal shadow-brutal-sm py-3 font-black btn-brutal" data-course-id="${escapeHtml(course.course_id)}">
          进入课程 <i class="fa-solid fa-arrow-right ml-1"></i>
        </button>
      </div>`;
    }).filter(Boolean).join('');
    const joinPanel = `<div class="bg-paper-white border-brutal shadow-brutal p-5"><h3 class="text-xl font-black">加入一门课程</h3><p class="mt-2 text-sm font-bold">向教师索取课程码；加入后只会显示你自己的课程。</p><div class="flex gap-2 mt-3"><input id="student-course-code-input" class="min-w-0 flex-1 bg-paper-white border-brutal p-3 font-black uppercase" placeholder="输入课程码" /><button id="student-join-course-btn" class="bg-lime border-brutal px-4 font-black btn-brutal">加入</button></div></div>`;
    const emptyMessage = isGuest ? '当前还没有已审核开放的课程。' : '尚未加入已开放课程。';
    $('student-course-list').innerHTML = `${isGuest ? '' : joinPanel}${cards || `<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">${emptyMessage}</div>`}`;
    $('student-join-course-btn')?.addEventListener('click', async () => {
      const code = $('student-course-code-input').value.trim().toUpperCase();
      if (!code) return alert('请输入教师提供的课程码');
      const button = $('student-join-course-btn');
      button.disabled = true;
      try {
        const response = await fetch('/api/auth/student/join-course', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course_code: code }) });
        const payload = await response.json();
        if (!response.ok) return alert(payload.message || '加入课程失败');
        alert(`已加入：${payload.course_space?.course_name || '课程'}`);
        location.reload();
      } catch (error) { alert(`无法加入课程：${error.message}`); }
      finally { button.disabled = false; }
    });
    document.querySelectorAll('.student-open-course').forEach(button => {
      button.addEventListener('click', () => app().openCourse(button.dataset.courseId));
    });
  }

  function allowedChapterTitles(courseId) {
    const identity = getIdentity();
    const student = currentStudent();
    if (!student) return null;
    const course = app().getState().courses.find(item => item.course_id === courseId);
    if (!course || (identity?.role !== 'guest' && !(student.course_space_ids || []).includes(course.parent_course_id))) return [];
    return clone((course.chapters || []).map(chapter => chapter.title));
  }

  function courseBanks(spaceId = activeCourseSpaceId) {
    return (app().getState().courses || []).filter(bank => bank.parent_course_id === spaceId);
  }

  function renderTeacherCourseList() {
    const teaching = ensureTeachingState();
    const list = $('teacher-course-space-list');
    list.innerHTML = teaching.course_spaces.length ? teaching.course_spaces.map((space, index) => {
      const banks = courseBanks(space.course_space_id);
      const questions = banks.reduce((sum, bank) => sum + (bank.question_bank?.length || 0), 0);
      const published = banks.filter(bank => approvedChapterTitles(bank).length).length;
      return `<div class="${index % 2 ? 'bg-cyan rotate-1' : 'bg-primary -rotate-1'} border-brutal shadow-brutal p-5">
        <span class="tiny-label bg-black text-white px-2 py-1">课程</span>
        <div class="text-2xl font-black mt-3">${escapeHtml(space.course_name)}</div>
        <div class="mt-2 text-sm font-bold">${banks.length} 个题库 · ${questions} 道题 · ${published} 个题库已有开放章节</div>
        <button class="open-course-space-btn mt-4 w-full bg-lime border-brutal shadow-brutal-sm py-3 font-black btn-brutal" data-course-space-id="${escapeHtml(space.course_space_id)}">进入课程</button>
      </div>`;
    }).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">还没有课程，点击“创建课程”开始。</div>';
    list.querySelectorAll('.open-course-space-btn').forEach(button => button.addEventListener('click', () => {
      activeCourseSpaceId = button.dataset.courseSpaceId;
      activeCourseSpaceTab = 'banks';
      renderTeacherCourseWorkspace();
      app().showRawScreen('teacher-course-workspace');
    }));
  }

  function createCourseSpace() {
    const name = $('course-space-name-input').value.trim();
    if (!name) return alert('请输入课程名称');
    const teaching = ensureTeachingState();
    if (teaching.course_spaces.some(item => item.course_name === name)) return alert('已经存在同名课程');
    teaching.course_spaces.push({ course_space_id: uid('course_space'), course_name: name, course_code: `K${Math.random().toString(36).slice(2, 8).toUpperCase()}`, created_at: nowIso(), learning_summary: '' });
    $('course-space-name-input').value = '';
    $('create-course-space-form').classList.add('hide');
    app().saveState();
    renderTeacherCourseList();
  }

  function bankStatus(bank) {
    if (bank.status === 'partial') {
      const pending = (bank.failed_generation_tasks || []).reduce((sum, task) => sum + (task.missing_slots?.length || 0), 0);
      return pending ? `生成未完成 · ${pending}题待补生成` : '生成未完成';
    }
    const approved = approvedChapterTitles(bank).length;
    if (!approved) return '已生成，待审核';
    return approved === (bank.chapters || []).length ? '已发布' : `已开放 ${approved} 章`;
  }

  function renderCourseBanks(space) {
    const banks = courseBanks(space.course_space_id);
    $('teacher-course-space-content').innerHTML = `
      <div class="grid grid-cols-2 gap-3">
        <button id="course-bank-create-tab" class="bg-lime border-brutal shadow-brutal-sm p-4 font-black btn-brutal">创建该课程题库</button>
        <button id="course-bank-manage-tab" class="bg-cyan border-brutal shadow-brutal-sm p-4 font-black btn-brutal">管理该课程题库</button>
      </div>
      <div id="course-bank-pane" class="space-y-4"></div>`;
    const pane = $('course-bank-pane');
    const showCreate = () => {
      pane.innerHTML = `<div class="bg-primary border-brutal shadow-brutal p-5"><h3 class="text-2xl font-black">创建该课程题库</h3><p class="mt-2 font-bold">先填写题库名称，再上传主资料和补充资料。</p><button id="start-create-bank-btn" class="mt-4 w-full bg-lime border-brutal py-3 font-black btn-brutal">开始创建题库</button></div>
      ${banks.filter(bank => bank.status === 'partial').map(bank => `<div class="bg-orange border-brutal p-4"><b>未完成：</b>${escapeHtml(bank.bank_name)} · ${bank.question_bank?.length || 0} 道题<button class="resume-bank-btn mt-3 w-full bg-paper-white border-brutal py-2 font-black" data-bank-id="${escapeHtml(bank.course_id)}">继续生成</button></div>`).join('')}`;
      $('start-create-bank-btn').addEventListener('click', () => app().showScreen('create'));
      pane.querySelectorAll('.resume-bank-btn').forEach(button => button.addEventListener('click', () => app().resumeCourseGeneration(button.dataset.bankId)));
    };
    const showManage = () => {
      pane.innerHTML = banks.length ? banks.map((bank, index) => `<div class="${index % 2 ? 'bg-paper-white' : 'bg-primary'} border-brutal shadow-brutal p-5">
        <div class="flex justify-between gap-3"><span class="tiny-label bg-black text-white px-2 py-1">${escapeHtml(bankStatus(bank))}</span><span class="text-sm font-black">${bank.question_bank?.length || 0} 道题</span></div>
        <h3 class="text-2xl font-black mt-3">${escapeHtml(bank.bank_name)}</h3>
        <p class="mt-2 text-sm font-bold">${bank.chapters?.length || 0} 个章节</p>
        <div class="grid grid-cols-2 gap-3 mt-4">
          <button class="review-bank-btn bg-lime border-brutal py-2 font-black btn-brutal" data-bank-id="${escapeHtml(bank.course_id)}">${bank.status === 'partial' ? '继续生成' : '详情与审核'}</button>
          <button class="delete-bank-btn bg-paper-white border-brutal py-2 font-black btn-brutal" data-bank-id="${escapeHtml(bank.course_id)}">删除题库</button>
        </div>
      </div>`).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">该课程还没有题库。</div>';
      pane.querySelectorAll('.review-bank-btn').forEach(button => button.addEventListener('click', () => {
        const bank = app().getState().courses.find(item => item.course_id === button.dataset.bankId);
        if (bank?.status === 'partial') app().resumeCourseGeneration(button.dataset.bankId);
        else app().openReview(button.dataset.bankId);
      }));
      pane.querySelectorAll('.delete-bank-btn').forEach(button => button.addEventListener('click', () => app().deleteCourse(button.dataset.bankId)));
    };
    $('course-bank-create-tab').addEventListener('click', showCreate);
    $('course-bank-manage-tab').addEventListener('click', showManage);
    showManage();
  }

  function renderCourseBlueprint(space) {
    const banks = courseBanks(space.course_space_id);
    const chapters = new Map();
    banks.forEach(bank => (bank.chapters || []).forEach(chapter => {
      const points = new Set(chapters.get(chapter.title) || []);
      (chapter.knowledge_points || []).forEach(point => points.add(typeof point === 'string' ? point : point.name || point.title));
      (bank.question_bank || []).filter(question => question.chapter === chapter.title).forEach(question => {
        if (question.knowledge_point) points.add(question.knowledge_point);
      });
      chapters.set(chapter.title, [...points].filter(Boolean));
    }));
    $('teacher-course-space-content').innerHTML = chapters.size ? [...chapters.entries()].map(([title, points], index) => `<div class="${index % 2 ? 'bg-cyan' : 'bg-paper-white'} border-brutal shadow-brutal-sm p-5"><h3 class="text-xl font-black">${escapeHtml(title)}</h3><p class="mt-2 font-bold text-sm">${points.length ? points.map(escapeHtml).join(' · ') : '已建立章节，暂未提取知识点标签'}</p></div>`).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">生成题库后，系统会直接使用已有章节和知识点信息形成知识蓝图。</div>';
  }

  function renderCourseMaterials(space) {
    const banks = courseBanks(space.course_space_id);
    const renderFiles = (bank, key) => (bank[key] || []).map(file => escapeHtml(file.name || file)).join('、') || '暂无';
    $('teacher-course-space-content').innerHTML = `<div class="bg-cyan border-brutal shadow-brutal p-5"><h3 class="text-2xl font-black">课程资料</h3><p class="mt-2 font-bold">补充资料可包含：课程 PPT、教材、课程大纲、学情分析。</p></div>${banks.length ? banks.map(bank => `<div class="bg-paper-white border-brutal p-4"><h4 class="font-black">${escapeHtml(bank.bank_name)}</h4><p class="mt-2 text-sm"><b>主资料：</b>${renderFiles(bank, 'main_materials')}</p><p class="mt-2 text-sm"><b>补充资料：</b>${renderFiles(bank, 'supplement_materials')}</p></div>`).join('') : '<div class="bg-paper-white border-brutal p-4 font-black">该课程还没有题库资料。</div>'}`;
  }

  function courseStatistics(space) {
    const teaching = ensureTeachingState();
    const stats = teaching.course_statistics?.[space.course_space_id];
    return stats ? clone(stats) : {
      students: 0,
      active_students: 0,
      participation_rate: 0,
      rounds: 0,
      answers: 0,
      correct: 0,
      accuracy: 0,
      practiced_chapter_selections: 0,
      average_chapters: 0,
      average_rounds: 0,
      active_days: 0,
      coverage: {},
      difficulty_transitions: {},
      chapters: [],
      weak: [],
      ai_guidance: {},
      ai_knowledge_points: [],
      anonymous_learners: []
    };
  }

  function analyticsBandLabel(band) {
    return ({ '0-39': '基础', '40-59': '巩固', '60-79': '提高', '80-100': '挑战' })[band] || band || '未标注';
  }

  function guidanceKnowledgeStatus(item) {
    if (!item.follow_up_opportunities) return '待积累';
    if (item.follow_up_rate >= 60) return '较稳定';
    if (item.check_rate >= 70 && item.follow_up_rate < 50) return '后续仍易错';
    if (item.average_turns >= 4) return '建议教师讲解';
    return '继续观察';
  }

  function reportSummaryIsValid(value) {
    const text = String(value || '').trim();
    if (!text || text.length < 80 || text.length > 2200) return false;
    if (/([^\s])\1{9,}/u.test(text)) return false;
    const punctuation = (text.match(/[!！?？。．，,；;：:]/g) || []).length;
    return !(text.length > 200 && punctuation / text.length > 0.45);
  }

  function cleanReportText(value) {
    return String(value || '')
      .replace(/\\?\*\*/g, '')
      .replace(/([!！?？。．，,；;：:])\1{2,}/gu, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function reportSnapshot(stats) {
    return {
      students: stats.students || 0,
      active_students: stats.active_students || 0,
      participation_rate: stats.participation_rate || 0,
      rounds: stats.rounds || 0,
      answers: stats.answers || 0,
      accuracy: stats.accuracy || 0,
      average_chapters: stats.average_chapters || 0,
      average_rounds: stats.average_rounds || 0,
      chapters: stats.chapters || [],
      difficulty_transitions: stats.difficulty_transitions || {},
      ai_guidance: stats.ai_guidance || {}
    };
  }

  function generationGuidanceFromStats(stats) {
    const focus = [...(stats.chapters || [])]
      .filter(item => Number(item.answers || 0) >= 10)
      .sort((left, right) => Number(left.accuracy || 0) - Number(right.accuracy || 0) || Number(right.answers || 0) - Number(left.answers || 0))
      .slice(0, 4)
      .map(item => ({ chapter: item.chapter, accuracy: item.accuracy, answers: item.answers, weak_point: item.weak_point }));
    return {
      focus_chapters: focus,
      instruction: '在原课程资料、章节知识蓝图、固定题位和难度边界内，优先强化有充分作答数据的低正确率章节及其高频薄弱点；增加真实平行变式和常见误区干扰项，不把未练章节判定为薄弱，不改变每章题型与难度配额。'
    };
  }

  function programReportText(space, stats) {
    const transition = stats.difficulty_transitions || {};
    const ai = stats.ai_guidance || {};
    const focus = generationGuidanceFromStats(stats).focus_chapters;
    const focusText = focus.length
      ? focus.map(item => `${item.chapter}（实际作答正确率${item.accuracy}%，${item.answers}题；高频薄弱点：${item.weak_point}）`).join('；')
      : '当前章节数据不足，暂不判断薄弱章节';
    const aiText = ai.started
      ? `错误或不确定题${ai.eligible || 0}题，启动AI ${ai.started}次，完成${ai.completed || 0}次；有后续平行题机会${ai.follow_up_opportunities || 0}次，其中未使用AI独立答对${ai.follow_up_correct || 0}次。`
      : `错误或不确定题${ai.eligible || 0}题，但当前AI使用字段均为0，暂不能评价AI引导效果。`;
    return `一、课程现状\n${space.course_name}共有${stats.students || 0}名课程学生，${stats.active_students || 0}人完成正式练习，参与率${stats.participation_rate || 0}%；累计${stats.rounds || 0}轮、${stats.answers || 0}题，实际作答正确率${stats.accuracy || 0}%。人均练习${stats.average_chapters || 0}个不同章节、${stats.average_rounds || 0}轮。\n\n二、章节发现\n${focusText}。未练章节不计0分，也不作为薄弱依据。\n\n三、动态难度\n同一学生、同一章节的连续练习中，升档${transition.up || 0}次、保持${transition.same || 0}次、降档${transition.down || 0}次；发生难度调整${transition.adjusted || 0}次，调整后进入60—79分目标区间${transition.adaptation_rate || 0}%，达到60分以上${transition.acceptable_rate || 0}%。\n\n四、AI引导\n${aiText}\n\n五、下一轮出题建议\n${generationGuidanceFromStats(stats).instruction}`;
  }

  function renderReportSection(space, stats) {
    const stored = reportSummaryIsValid(space.learning_report?.text)
      ? space.learning_report.text
      : (reportSummaryIsValid(space.learning_summary) ? cleanReportText(space.learning_summary) : '');
    const hasReport = Boolean(stored);
    const basisActive = Boolean(space.active_generation_basis?.confirmed_at);
    return `<section class="analytics-panel"><div class="flex flex-wrap justify-between gap-3 items-start"><div><h3 class="analytics-panel-title">学情总结与下一轮出题建议</h3><p class="analytics-muted mt-1">统计数字由程序生成，AI只负责解释和补充建议。</p></div><div class="report-actions">${hasReport ? `<div class="report-menu"><button id="download-learning-report-btn" class="report-action-primary">下载报告 ▾</button><div id="download-learning-report-menu" class="report-menu-options hide"><button data-report-format="md">下载 .md</button><button data-report-format="txt">下载 .txt</button></div></div><button id="regenerate-learning-summary-btn" class="report-action-secondary">重新生成</button><button id="activate-generation-basis-btn" class="report-action-secondary">${basisActive ? '已设为出题依据' : '设为出题依据'}</button>` : '<button id="generate-learning-summary-btn" class="report-action-primary">生成AI总结</button>'}</div></div><div id="course-learning-summary" class="analytics-callout mt-4 whitespace-pre-wrap">${escapeHtml(hasReport ? stored : '尚未生成。生成后将形成课程现状、章节发现、动态难度、AI引导和下一轮出题建议。')}</div><details class="mt-4"><summary class="font-black cursor-pointer">查看详细统计依据</summary><div class="analytics-muted mt-3 leading-relaxed">课程学生${stats.students || 0}人；实际练习${stats.active_students || 0}人；章节统计仅包含实际练过该章的学生；动态难度只比较同一学生、同一章节的连续轮次；AI后续独立答对只统计存在后续平行题机会且后续未启动AI的记录。</div></details></section>`;
  }

  function renderSemesterOverview(space, stats) {
    const chapters = stats.chapters || [];
    const largestChapter = Math.max(1, ...chapters.map(item => Number(item.students || 0)));
    const transition = stats.difficulty_transitions || {};
    const transitionTotal = Math.max(1, Number(transition.up || 0) + Number(transition.same || 0) + Number(transition.down || 0));
    const transitionParts = [
      ['升档', transition.up || 0, '#ffd000'],
      ['保持', transition.same || 0, '#12cfe3'],
      ['降档', transition.down || 0, '#ff9f43']
    ];
    const ai = stats.ai_guidance || {};
    const funnel = [
      ['错误/不确定', ai.eligible || 0],
      ['启动AI', ai.started || 0],
      ['完成引导', ai.completed || 0],
      ['有后续平行题机会', ai.follow_up_opportunities || 0],
      ['未使用AI独立答对', ai.follow_up_correct || 0]
    ];
    const funnelMax = Math.max(1, ...funnel.map(item => Number(item[1] || 0)));
    return `<div class="analytics-kpi-grid">
        <div class="analytics-kpi" style="--kpi-color:#ffd000"><div class="analytics-kpi-value">${stats.active_students || 0}/${stats.students || 0}</div><div class="analytics-kpi-label">实际练习学生 · ${stats.participation_rate || 0}%</div></div>
        <div class="analytics-kpi" style="--kpi-color:#12cfe3"><div class="analytics-kpi-value">${stats.rounds || 0}</div><div class="analytics-kpi-label">累计正式练习轮次</div></div>
        <div class="analytics-kpi" style="--kpi-color:#111"><div class="analytics-kpi-value">${stats.answers || 0}</div><div class="analytics-kpi-label">累计作答题数</div></div>
        <div class="analytics-kpi" style="--kpi-color:#a8ff00"><div class="analytics-kpi-value">${ai.started || 0}</div><div class="analytics-kpi-label">AI引导次数${ai.started ? '' : ' · 暂无记录'}</div></div>
      </div>
      <div class="grid grid-cols-1 gap-4">
        <section class="analytics-panel"><div class="flex justify-between gap-2"><h3 class="analytics-panel-title">章节学习情况</h3><span class="analytics-muted">未练学生不计入</span></div><div class="mt-3">${chapters.map(item => `<div class="chapter-bar-row"><div class="text-sm font-black">${escapeHtml(item.chapter)}</div><div><div class="chapter-bar-track"><div class="chapter-bar-fill" style="width:${Number(item.students || 0) / largestChapter * 100}%"></div></div><div class="analytics-muted mt-1">${item.students}人｜正确率${item.accuracy}%｜${item.answers || 0}题</div></div></div>`).join('') || '<p class="font-bold">暂无章节数据。</p>'}</div></section>
        <section class="analytics-panel"><h3 class="analytics-panel-title">难度调整情况</h3><p class="analytics-muted mt-1">只比较同一学生、同一章节的连续练习</p><div class="difficulty-stack">${transitionParts.map(([label, count, color]) => `<span style="width:${Number(count) / transitionTotal * 100}%;background:${color}" title="${label}${count}次">${Number(count) / transitionTotal >= .16 ? `${label} ${Math.round(Number(count) / transitionTotal * 100)}%` : ''}</span>`).join('')}</div><div class="grid grid-cols-3 gap-2 mt-3">${transitionParts.map(([label, count]) => `<div class="text-center"><div class="text-xl font-black">${count}</div><div class="analytics-muted">${label}</div></div>`).join('')}</div><div class="analytics-callout mt-4"><div>进入60—79分目标区间：<b>${transition.adaptation_rate || 0}%</b></div><div>调整后达到60分以上：<b>${transition.acceptable_rate || 0}%</b></div><div class="analytics-muted">统计样本：${transition.adjusted || 0}次难度调整</div></div></section>
      </div>
      ${ai.started ? `<section class="analytics-panel"><div class="flex justify-between gap-2"><h3 class="analytics-panel-title">AI引导漏斗</h3><span class="analytics-muted">后续独立答对率 ${ai.follow_up_rate || 0}%</span></div><div class="ai-funnel">${funnel.map(([label, count]) => `<div class="ai-funnel-step" style="width:${Math.max(34, Number(count) / funnelMax * 100)}%">${escapeHtml(label)} · ${count}</div>`).join('')}</div></section>` : '<section class="analytics-panel"><h3 class="analytics-panel-title">AI引导漏斗</h3><p class="mt-2 font-bold">当前数据尚未记录AI使用行为，因此不绘制全为0的漏斗图。</p></section>'}
      ${renderReportSection(space, stats)}`;
  }

  function renderChapterStatistics(stats) {
    const chapters = stats.chapters || [];
    const transition = stats.difficulty_transitions || {};
    if (!chapters.length) return '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-bold">还没有章节练习数据。</div>';
    return `<div class="analytics-kpi-grid">
        <div class="analytics-kpi" style="--kpi-color:#ffd000"><div class="analytics-kpi-value">${transition.up || 0}</div><div class="analytics-kpi-label">后续升档</div></div>
        <div class="analytics-kpi" style="--kpi-color:#12cfe3"><div class="analytics-kpi-value">${transition.same || 0}</div><div class="analytics-kpi-label">保持难度</div></div>
        <div class="analytics-kpi" style="--kpi-color:#ff9f43"><div class="analytics-kpi-value">${transition.down || 0}</div><div class="analytics-kpi-label">后续降档</div></div>
        <div class="analytics-kpi" style="--kpi-color:#a8ff00"><div class="analytics-kpi-value">${transition.adaptation_rate || 0}%</div><div class="analytics-kpi-label">进入目标区间</div></div>
      </div>
      <div class="analytics-panel"><div class="flex flex-wrap justify-between gap-2"><h3 class="analytics-panel-title">章节与知识点</h3><span class="analytics-muted">只统计实际练过该章的学生</span></div><div class="overflow-x-auto mt-3"><table class="w-full text-sm"><thead><tr class="border-b-2 border-black text-left"><th class="p-2">章节</th><th class="p-2">练习人数</th><th class="p-2">轮次</th><th class="p-2">平均得分</th><th class="p-2">AI引导</th><th class="p-2">高频薄弱点</th></tr></thead><tbody>${chapters.map(item => `<tr class="border-b border-gray-300"><td class="p-2 font-black whitespace-nowrap">${escapeHtml(item.chapter)}</td><td class="p-2">${item.students}</td><td class="p-2">${item.rounds}</td><td class="p-2">${item.average_score}</td><td class="p-2">${item.ai_started}</td><td class="p-2 font-bold">${escapeHtml(item.weak_point)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="analytics-callout">难度调整共${transition.adjusted || 0}次，其中${transition.adapted || 0}次下一轮进入60—79分区间，${transition.acceptable || 0}次达到60分以上；该指标只比较同一学生、同一章节的连续练习。</div>`;
  }

  function renderAiGuidanceStatistics(space, stats) {
    const ai = stats.ai_guidance || {};
    const points = stats.ai_knowledge_points || [];
    if (!Number(ai.eligible || 0)) {
      return `<div class="analytics-panel"><h3 class="analytics-panel-title">AI引导成效</h3><p class="mt-2 font-bold">还没有可统计的正式练习数据。</p></div>`;
    }
    if (!Number(ai.started || 0)) {
      return `<div class="analytics-panel"><h3 class="analytics-panel-title">AI引导成效</h3><div class="text-4xl font-black mt-3">${ai.eligible || 0}题</div><p class="mt-2 font-bold">本学期共有这些错误或不确定题，但AI使用字段均为0，因此不绘制漏斗，也暂不能判断AI引导效果。</p></div>`;
    }
    const conclusion = ai.follow_up_opportunities
      ? `可引导错题中${ai.start_rate}%启动了AI；完成引导后，有后续同知识点作答机会的题中${ai.follow_up_rate}%独立答对。`
      : `可引导错题中${ai.start_rate}%启动了AI；目前还没有足够的后续同知识点作答记录。`;
    const funnel = [['错误/不确定', ai.eligible || 0], ['启动AI', ai.started || 0], ['完成引导', ai.completed || 0], ['有后续平行题机会', ai.follow_up_opportunities || 0], ['未使用AI独立答对', ai.follow_up_correct || 0]];
    const funnelMax = Math.max(1, ...funnel.map(item => item[1]));
    return `<div class="analytics-panel"><div class="flex justify-between gap-2"><h3 class="analytics-panel-title">AI引导漏斗</h3><span class="analytics-muted">后续独立答对率 ${ai.follow_up_rate || 0}%</span></div><div class="ai-funnel">${funnel.map(([label, count]) => `<div class="ai-funnel-step" style="width:${Math.max(34, count / funnelMax * 100)}%">${escapeHtml(label)} · ${count}</div>`).join('')}</div></div>
      <div class="analytics-callout">平均每次完成引导需要 <b>${ai.average_turns || 0}轮</b> AI对话，最后判断确认正确率 <b>${ai.check_rate || 0}%</b>。${escapeHtml(conclusion)}</div>
      <div class="analytics-panel">
        <h3 class="analytics-panel-title mb-3">重点知识点</h3>
        ${points.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="border-b-2 border-black text-left"><th class="p-2">知识点</th><th class="p-2">AI介入</th><th class="p-2">平均对话</th><th class="p-2">判断正确</th><th class="p-2">后续答对</th><th class="p-2">提示</th></tr></thead><tbody>${points.map(item => `<tr class="border-b border-gray-300"><td class="p-2 font-black">${escapeHtml(item.knowledge_point)}</td><td class="p-2">${item.started}题</td><td class="p-2">${item.average_turns}轮</td><td class="p-2">${item.check_rate}%</td><td class="p-2">${item.follow_up_opportunities ? `${item.follow_up_rate}%` : '待积累'}</td><td class="p-2 font-bold">${guidanceKnowledgeStatus(item)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="font-bold">目前还没有知识点级AI引导数据。</p>'}
      </div>`;
  }

  function learnerPathText(learner) {
    return (learner.rounds || []).slice(-3).map(round => `${String(round.chapter || '').replace(/^第.+?章\s*/, '') || '未标注'}·${analyticsBandLabel(round.difficulty_band)}${round.score}`).join(' → ') || '尚未开始';
  }

  function learnerAiTrendText(learner) {
    return (learner.rounds || []).slice(-3).map(round => round.ai_started || 0).join(' → ') || '暂无';
  }

  function renderAnonymousLearnerDetail(learner) {
    if (!learner) return '<div class="bg-paper-white border-brutal p-4 font-bold">点击匿名编号，查看该学习者的具体轨迹。</div>';
    return `<div class="bg-cyan border-brutal shadow-brutal p-5">
      <div class="flex flex-wrap justify-between gap-3"><h3 class="text-xl font-black">${escapeHtml(learner.anonymous_id)} 学习轨迹</h3><span class="font-black">${escapeHtml(learner.status)}</span></div>
      <div class="grid grid-cols-4 gap-2 mt-3"><div class="bg-paper-white border-brutal p-2 text-center"><b>${learner.chapters_practiced || 0}</b><br><span class="text-xs">练习章节</span></div><div class="bg-paper-white border-brutal p-2 text-center"><b>${(learner.rounds || []).length}</b><br><span class="text-xs">完成轮次</span></div><div class="bg-paper-white border-brutal p-2 text-center"><b>${learner.active_days || 0}</b><br><span class="text-xs">活跃天数</span></div><div class="bg-paper-white border-brutal p-2 text-center"><b>${learner.ai_started || 0}</b><br><span class="text-xs">AI使用</span></div></div><div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">${(learner.rounds || []).map((round, index) => `<div class="bg-paper-white border-brutal p-3"><div class="text-xs font-black">${escapeHtml(String(round.completed_at || '').slice(0, 10))} · ${escapeHtml(round.chapter)} · 第${index + 1}轮</div><div class="text-2xl font-black mt-1">${escapeHtml(analyticsBandLabel(round.difficulty_band))}第${round.set_number}套 · ${round.score}分</div><div class="text-sm font-bold mt-2">诊断${round.diagnosis_score || '—'} · 错题${round.wrong} · 不确定${round.uncertain} · AI介入${round.ai_started}</div><details class="mt-3"><summary class="font-black cursor-pointer">查看本轮10题</summary><div class="overflow-x-auto mt-2"><table class="w-full text-xs"><thead><tr class="border-b-2 border-black text-left"><th class="p-1">知识点/题目</th><th class="p-1">作答</th><th class="p-1">AI</th><th class="p-1">判断</th><th class="p-1">后续</th></tr></thead><tbody>${(round.questions || []).map(question => `<tr class="border-b border-gray-300"><td class="p-1"><b>${escapeHtml(question.knowledge_point)}</b><br>${escapeHtml(question.stem || '原始数据未提供题干')}</td><td class="p-1">${question.result === 'correct' ? '正确' : question.result === 'uncertain' ? '不确定' : '错误'}</td><td class="p-1">${question.ai_started ? `${question.ai_turns || 0}轮` : '未使用'}</td><td class="p-1">${question.check_correct === true ? '正确' : question.check_correct === false ? '错误' : '—'}</td><td class="p-1">${question.follow_up === 'correct' ? '独立答对' : question.follow_up === 'wrong' ? '再次错误' : '待验证'}</td></tr>`).join('')}</tbody></table></div></details></div>`).join('')}</div>
      <p class="mt-4 font-black">${escapeHtml(learner.analysis)}</p>
    </div>`;
  }

  function renderAnonymousLearningStatistics(stats) {
    const learners = stats.anonymous_learners || [];
    if (!learners.length) {
      return '<div class="bg-paper-white border-brutal shadow-brutal p-5"><h3 class="text-xl font-black">匿名学习轨迹</h3><p class="mt-2 font-bold">还没有完成正式练习的学生。产生轮次记录后，系统会自动生成稳定匿名编号和学习路径。</p></div>';
    }
    const selected = learners.find(item => item.anonymous_id === selectedAnonymousLearnerId);
    return `<div class="bg-paper-white border-brutal shadow-brutal p-5"><div class="flex flex-wrap justify-between gap-2"><h3 class="text-xl font-black">匿名学习轨迹</h3><span class="text-sm font-bold">不显示姓名和学号</span></div>
      <div class="overflow-x-auto mt-3"><table class="w-full text-sm"><thead><tr class="border-b-2 border-black text-left"><th class="p-2">匿名学习者</th><th class="p-2">最近三轮</th><th class="p-2">AI介入变化</th><th class="p-2">后续验证</th><th class="p-2">当前状态</th></tr></thead><tbody>${learners.map(learner => `<tr class="border-b border-gray-300"><td class="p-2"><button class="anonymous-learner-btn underline font-black" data-anonymous-id="${escapeHtml(learner.anonymous_id)}">${escapeHtml(learner.anonymous_id)}</button></td><td class="p-2 font-bold">${escapeHtml(learnerPathText(learner))}</td><td class="p-2">${escapeHtml(learnerAiTrendText(learner))}题</td><td class="p-2">${learner.follow_up_opportunities ? `${learner.follow_up_correct}/${learner.follow_up_opportunities}独立答对` : '待积累'}</td><td class="p-2 font-black">${escapeHtml(learner.status)}</td></tr>`).join('')}</tbody></table></div></div>
      <div id="anonymous-learner-detail">${renderAnonymousLearnerDetail(selected)}</div>`;
  }

  function renderCourseStatistics(space) {
    const stats = courseStatistics(space);
    const panels = {
      semester: () => renderSemesterOverview(space, stats),
      chapters: () => renderChapterStatistics(stats),
      'ai-guidance': () => renderAiGuidanceStatistics(space, stats),
      anonymous: () => renderAnonymousLearningStatistics(stats)
    };
    $('teacher-course-space-content').innerHTML = `<div class="statistics-subnav" aria-label="学情统计分类"><button id="statistics-semester-tab" class="statistics-subtab ${activeStatisticsTab === 'semester' ? 'is-active' : ''}">学期总览</button><button id="statistics-chapters-tab" class="statistics-subtab ${activeStatisticsTab === 'chapters' ? 'is-active' : ''}">章节统计</button><button id="statistics-ai-guidance-tab" class="statistics-subtab ${activeStatisticsTab === 'ai-guidance' ? 'is-active' : ''}">AI引导</button><button id="statistics-anonymous-tab" class="statistics-subtab ${activeStatisticsTab === 'anonymous' ? 'is-active' : ''}">匿名轨迹</button></div>
      ${(panels[activeStatisticsTab] || panels.semester)()}`;
    $('statistics-semester-tab').addEventListener('click', () => { activeStatisticsTab = 'semester'; renderCourseStatistics(space); });
    $('statistics-chapters-tab').addEventListener('click', () => { activeStatisticsTab = 'chapters'; renderCourseStatistics(space); });
    $('statistics-ai-guidance-tab').addEventListener('click', () => { activeStatisticsTab = 'ai-guidance'; renderCourseStatistics(space); });
    $('statistics-anonymous-tab').addEventListener('click', () => { activeStatisticsTab = 'anonymous'; renderCourseStatistics(space); });
    $('generate-learning-summary-btn')?.addEventListener('click', () => generateLearningSummary(space, stats));
    $('regenerate-learning-summary-btn')?.addEventListener('click', () => generateLearningSummary(space, stats));
    $('download-learning-report-btn')?.addEventListener('click', event => {
      event.stopPropagation();
      $('download-learning-report-menu')?.classList.toggle('hide');
    });
    document.querySelectorAll('[data-report-format]').forEach(button => button.addEventListener('click', () => downloadLearningReport(space, stats, button.dataset.reportFormat)));
    $('activate-generation-basis-btn')?.addEventListener('click', () => activateGenerationBasis(space, stats));
    document.querySelectorAll('.anonymous-learner-btn').forEach(button => button.addEventListener('click', () => {
      selectedAnonymousLearnerId = button.dataset.anonymousId;
      renderCourseStatistics(space);
    }));
  }

  function currentLearningReportText(space, stats) {
    if (reportSummaryIsValid(space.learning_report?.text)) return cleanReportText(space.learning_report.text);
    if (reportSummaryIsValid(space.learning_summary)) return cleanReportText(space.learning_summary);
    return programReportText(space, stats);
  }

  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reportAsMarkdown(space, stats, text) {
    const body = text.split('\n').map(line => /^[一二三四五六七八九十]+、/.test(line.trim()) ? `## ${line.trim()}` : line).join('\n');
    const generatedAt = space.learning_report?.generated_at || nowIso();
    return `# ${space.course_name}学情报告\n\n生成时间：${generatedAt.slice(0, 19).replace('T', ' ')}\n\n${body}\n\n---\n统计口径：未练章节不计0分；章节正确率只基于实际作答；难度变化只比较同一学生同一章节的连续轮次。\n`;
  }

  function downloadLearningReport(space, stats, format) {
    const text = currentLearningReportText(space, stats);
    const safeName = String(space.course_name || '课程').replace(/[\\/:*?"<>|]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'md') downloadTextFile(`${safeName}_学情报告_${date}.md`, reportAsMarkdown(space, stats, text), 'text/markdown');
    else downloadTextFile(`${safeName}_学情报告_${date}.txt`, `${space.course_name}学情报告\n\n${text}\n`, 'text/plain');
    $('download-learning-report-menu')?.classList.add('hide');
  }

  function activateGenerationBasis(space, stats) {
    const text = currentLearningReportText(space, stats);
    space.active_generation_basis = {
      confirmed_at: nowIso(),
      report_generated_at: space.learning_report?.generated_at || '',
      guidance: generationGuidanceFromStats(stats),
      report_excerpt: text.slice(0, 1200)
    };
    app().saveState();
    renderCourseStatistics(space);
  }

  async function generateLearningSummary(space, stats) {
    const button = $('generate-learning-summary-btn') || $('regenerate-learning-summary-btn');
    if (button) { button.disabled = true; button.textContent = '正在总结…'; }
    const verifiedReport = programReportText(space, stats);
    try {
      const summaryData = reportSnapshot(stats);
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'siliconflow',
          model: 'deepseek-ai/DeepSeek-V4-Flash',
          stream: false,
          temperature: 0.15,
          max_tokens: 600,
          messages: [
            { role: 'system', content: '你是教师学情分析助手。统计事实已经由程序写好，你只能补充教学解释和下一轮命题建议。不得改写或另算数字，不得把未练章节说成薄弱，不得声称因果关系，不得使用Markdown符号，不得重复标点。输出120至450个汉字，固定以“六、AI补充建议”开头，给出3至5条具体建议。建议必须服从课程资料、章节知识蓝图、固定题位、难度边界和答案解析一致性。' },
            { role: 'user', content: `以下是程序核验后的报告与统计数据。请只补充第六部分，不要复述数字。\n\n${verifiedReport}\n\n统计数据：${JSON.stringify(summaryData)}` }
          ]
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'AI总结失败');
      const addition = cleanReportText(payload.choices?.[0]?.message?.content || payload.content || payload.text || '');
      if (!reportSummaryIsValid(addition) || !addition.startsWith('六、AI补充建议')) throw new Error('AI返回了异常或不完整内容');
      const report = `${verifiedReport}\n\n${addition}`;
      space.learning_report = {
        text: report,
        generated_at: nowIso(),
        source: 'verified-statistics-plus-ai',
        snapshot: summaryData,
        generation_guidance: generationGuidanceFromStats(stats)
      };
      space.learning_summary = report;
      space.learning_summary_updated_at = space.learning_report.generated_at;
      space.active_generation_basis = null;
      await app().saveState();
      renderCourseStatistics(space);
    } catch (error) {
      space.learning_report = {
        text: verifiedReport,
        generated_at: nowIso(),
        source: 'verified-statistics-fallback',
        snapshot: reportSnapshot(stats),
        generation_guidance: generationGuidanceFromStats(stats),
        ai_error: String(error.message || error)
      };
      space.learning_summary = verifiedReport;
      space.learning_summary_updated_at = space.learning_report.generated_at;
      space.active_generation_basis = null;
      await app().saveState();
      alert(`AI异常内容已拦截，已保留程序生成的可靠报告。\n${error.message || error}`);
      renderCourseStatistics(space);
    }
  }

  function renderTeacherCourseWorkspace() {
    const teaching = ensureTeachingState();
    const space = teaching.course_spaces.find(item => item.course_space_id === activeCourseSpaceId);
    if (!space) return app().showRawScreen('teacher-course-list');
    $('teacher-course-space-header').innerHTML = `<span class="tiny-label bg-black text-white px-2 py-1">课程</span><h2 class="text-3xl font-black mt-3">${escapeHtml(space.course_name)}</h2><p class="mt-3 font-black">学生课程码：<span class="bg-paper-white border-brutal px-2 py-1">${escapeHtml(space.course_code || '保存后生成')}</span></p>`;
    document.querySelectorAll('.course-space-tab-btn').forEach(button => {
      const active = button.dataset.courseSpaceTab === activeCourseSpaceTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (activeCourseSpaceTab === 'blueprint') renderCourseBlueprint(space);
    else if (activeCourseSpaceTab === 'materials') renderCourseMaterials(space);
    else if (activeCourseSpaceTab === 'statistics') renderCourseStatistics(space);
    else renderCourseBanks(space);
  }

  function renderTeacherClasses() {
    const teaching = ensureTeachingState();
    const classes = teaching.classes;
    $('teacher-class-list').innerHTML = classes.length ? classes.map((item, index) => {
      const studentCount = teaching.students.filter(student => student.class_id === item.class_id).length;
      const courseCount = teaching.publications.filter(publication => publication.class_id === item.class_id && publication.chapter_titles?.length).length;
      return `<div class="${index % 2 ? 'bg-cyan rotate-1' : 'bg-primary -rotate-1'} border-brutal shadow-brutal p-5">
        <div class="flex justify-between gap-3 items-start">
          <div>
            <span class="tiny-label bg-black text-white px-2 py-1">班级码 ${escapeHtml(item.class_code)}</span>
            <div class="text-2xl font-black mt-3">${escapeHtml(item.class_name)}</div>
            <div class="mt-2 text-sm font-bold">${studentCount} 名学生 · 已发布 ${courseCount} 门课程${item.term ? ` · ${escapeHtml(item.term)}` : ''}</div>
          </div>
        </div>
        <button class="open-class-btn mt-4 w-full bg-lime border-brutal shadow-brutal-sm py-3 font-black btn-brutal" data-class-id="${escapeHtml(item.class_id)}">进入班级</button>
      </div>`;
    }).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">还没有班级，点击“创建班级”开始。</div>';
    document.querySelectorAll('.open-class-btn').forEach(button => button.addEventListener('click', () => {
      activeClassId = button.dataset.classId;
      activeClassTab = 'courses';
      renderTeacherClassDetail();
      app().showRawScreen('teacher-class-detail');
    }));
  }

  function createClass() {
    const name = $('class-name-input').value.trim();
    const term = $('class-term-input').value.trim();
    if (!name) return alert('请输入班级名称');
    const teaching = ensureTeachingState();
    if (teaching.classes.some(item => item.class_name === name)) return alert('已经存在同名班级');
    const record = {
      class_id: uid('class'),
      class_name: name,
      class_code: generateClassCode(),
      term,
      created_at: nowIso()
    };
    teaching.classes.push(record);
    app().saveState();
    $('class-name-input').value = '';
    $('class-term-input').value = '';
    $('create-class-form').classList.add('hide');
    renderTeacherClasses();
    alert(`班级创建成功，班级码：${record.class_code}`);
  }

  function renderTeacherClassDetail() {
    const teaching = ensureTeachingState();
    const classRecord = teaching.classes.find(item => item.class_id === activeClassId);
    if (!classRecord) {
      app().showRawScreen('teacher-classes');
      return;
    }
    const studentCount = teaching.students.filter(student => student.class_id === classRecord.class_id).length;
    $('teacher-class-header').innerHTML = `
      <span class="tiny-label bg-black text-white px-2 py-1">班级码 ${escapeHtml(classRecord.class_code)}</span>
      <h2 class="text-3xl font-black mt-3">${escapeHtml(classRecord.class_name)}</h2>
      <p class="mt-2 font-bold">${studentCount} 名学生${classRecord.term ? ` · ${escapeHtml(classRecord.term)}` : ''}</p>`;
    document.querySelectorAll('.class-tab-btn').forEach(button => {
      const selected = button.dataset.classTab === activeClassTab;
      button.classList.toggle('bg-lime', selected);
      button.classList.toggle('bg-paper-white', !selected);
    });
    if (activeClassTab === 'students') renderClassStudents(classRecord);
    else if (activeClassTab === 'learning') renderClassLearning(classRecord);
    else renderClassCourses(classRecord);
  }

  function renderClassCourses(classRecord) {
    const state = app().getState();
    const courses = state.courses.filter(course => course.question_bank?.length);
    $('teacher-class-content').innerHTML = courses.length ? courses.map(course => {
      const approved = approvedChapterTitles(course);
      const publication = publicationFor(classRecord.class_id, course.course_id);
      const selected = new Set(publication?.chapter_titles || []);
      const courseSpace = state.teaching.course_spaces.find(item => item.course_space_id === course.parent_course_id);
      return `<div class="bg-paper-white border-brutal shadow-brutal p-5">
        <div class="text-xl font-black">${escapeHtml(courseSpace?.course_name || course.course_name)}</div>
        <p class="mt-1 text-sm font-bold">题库：${escapeHtml(course.bank_name || course.course_name)}</p>
        <p class="mt-1 text-sm font-bold">已审核开放 ${approved.length} 个章节</p>
        <div class="mt-4 space-y-2">
          ${approved.length ? approved.map(title => `<label class="flex items-center gap-3 bg-pastel-grey border-2 border-black p-2 font-bold">
            <input type="checkbox" class="publication-chapter-checkbox w-5 h-5" data-course-id="${escapeHtml(course.course_id)}" value="${escapeHtml(title)}" ${selected.has(title) ? 'checked' : ''} />
            <span>${escapeHtml(title)}</span>
          </label>`).join('') : '<div class="bg-orange border-2 border-black p-2 font-bold">暂无审核完成的章节</div>'}
        </div>
        <button class="save-publication-btn mt-4 w-full bg-lime border-brutal py-2 font-black btn-brutal" data-course-id="${escapeHtml(course.course_id)}" ${approved.length ? '' : 'disabled'}>保存发布范围</button>
      </div>`;
    }).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">请先在“我的课程”中创建并审核课程。</div>';
    document.querySelectorAll('.save-publication-btn').forEach(button => button.addEventListener('click', () => {
      savePublication(classRecord.class_id, button.dataset.courseId);
    }));
  }

  function savePublication(classId, courseId) {
    const chapterTitles = [...document.querySelectorAll(`.publication-chapter-checkbox[data-course-id="${CSS.escape(courseId)}"]:checked`)]
      .map(input => input.value);
    setPublication(classId, courseId, chapterTitles);
    alert(chapterTitles.length ? `已发布 ${chapterTitles.length} 个章节` : '已取消向该班发布这门课程');
    renderTeacherClassDetail();
  }

  function setPublication(classId, courseId, chapterTitles) {
    const teaching = ensureTeachingState();
    let publication = publicationFor(classId, courseId);
    if (!publication) {
      publication = { publication_id: uid('publication'), class_id: classId, course_id: courseId, chapter_titles: [], published_at: nowIso() };
      teaching.publications.push(publication);
    }
    publication.chapter_titles = [...new Set(chapterTitles || [])];
    publication.updated_at = nowIso();
    app().saveState();
    return publication;
  }

  function renderClassStudents(classRecord) {
    const teaching = ensureTeachingState();
    const students = teaching.students.filter(item => item.class_id === classRecord.class_id);
    $('teacher-class-content').innerHTML = students.length ? students.map((student, index) => {
      const learning = learningFor(student.student_id);
      return `<div class="${index % 2 ? 'bg-cyan' : 'bg-paper-white'} border-brutal shadow-brutal-sm p-4">
        <div class="flex justify-between gap-3">
          <div><span class="font-black text-xl">${escapeHtml(student.student_name)}</span><span class="ml-2 text-sm font-bold">${escapeHtml(student.student_number)}</span></div>
          <span class="tiny-label bg-black text-white px-2 py-1">${learning.attempts.length}轮</span>
        </div>
        <p class="mt-2 text-xs font-bold">加入：${new Date(student.joined_at).toLocaleString()}</p>
      </div>`;
    }).join('') : '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">暂无学生。请把班级码发给学生加入。</div>';
  }

  function studentStats(student) {
    const learning = learningFor(student.student_id);
    const attempts = learning.attempts || [];
    const answers = attempts.flatMap(item => item.answers || []);
    const correct = answers.filter(item => item.correct).length;
    const wrong = answers.length - correct;
    const average = attempts.length
      ? Math.round(attempts.reduce((sum, item) => sum + Number(item.score || 0), 0) / attempts.length)
      : 0;
    return { attempts, answers, correct, wrong, average, wrongBookCount: Object.keys(learning.wrong_book || {}).length };
  }

  function renderClassLearning(classRecord) {
    const teaching = ensureTeachingState();
    const students = teaching.students.filter(item => item.class_id === classRecord.class_id);
    if (!students.length) {
      $('teacher-class-content').innerHTML = '<div class="bg-paper-white border-brutal shadow-brutal p-5 font-black">暂无学生学习数据。</div>';
      return;
    }
    const rows = students.map(student => ({ student, stats: studentStats(student) }));
    const totalRounds = rows.reduce((sum, row) => sum + row.stats.attempts.length, 0);
    const totalAnswers = rows.reduce((sum, row) => sum + row.stats.answers.length, 0);
    const totalCorrect = rows.reduce((sum, row) => sum + row.stats.correct, 0);
    const accuracy = totalAnswers ? Math.round(totalCorrect / totalAnswers * 100) : 0;
    const weakMap = {};
    rows.forEach(row => row.stats.answers.filter(answer => !answer.correct).forEach(answer => {
      const name = answer.knowledge_point || '未标注知识点';
      weakMap[name] = (weakMap[name] || 0) + 1;
    }));
    const weakPoints = Object.entries(weakMap).sort((left, right) => right[1] - left[1]).slice(0, 5);
    $('teacher-class-content').innerHTML = `
      <div class="grid grid-cols-3 gap-2">
        <div class="bg-primary border-brutal p-3 text-center"><div class="text-2xl font-black">${students.length}</div><div class="text-xs font-bold">学生</div></div>
        <div class="bg-cyan border-brutal p-3 text-center"><div class="text-2xl font-black">${totalRounds}</div><div class="text-xs font-bold">完成轮次</div></div>
        <div class="bg-lime border-brutal p-3 text-center"><div class="text-2xl font-black">${accuracy}%</div><div class="text-xs font-bold">班级正确率</div></div>
      </div>
      <div class="bg-paper-white border-brutal shadow-brutal p-5">
        <h3 class="text-xl font-black mb-3">学生学习情况</h3>
        <div class="space-y-3">${rows.map(({ student, stats }) => `<div class="border-2 border-black p-3">
          <div class="font-black">${escapeHtml(student.student_name)} · ${escapeHtml(student.student_number)}</div>
          <div class="mt-1 text-sm font-bold">完成 ${stats.attempts.length} 轮 · 平均 ${stats.average} 分 · 答对 ${stats.correct} 题 · 错题 ${stats.wrong} 题 · 错题本 ${stats.wrongBookCount} 道</div>
        </div>`).join('')}</div>
      </div>
      <div class="bg-orange border-brutal shadow-brutal p-5">
        <h3 class="text-xl font-black mb-3">班级薄弱知识点</h3>
        ${weakPoints.length ? weakPoints.map(([name, count]) => `<div class="flex justify-between border-b-2 border-black py-2 font-bold"><span>${escapeHtml(name)}</span><span>${count}次错误</span></div>`).join('') : '<p class="font-bold">目前没有错题数据。</p>'}
      </div>`;
  }

  async function leaveCurrentIdentity() {
    const identity = getIdentity();
    if (['student', 'guest'].includes(identity?.role)) app().saveState();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 清除本地身份仍继续 */ }
    setIdentity(null);
    app().resetActiveStudentState();
    app().showRawScreen('role');
  }

  function guardScreen(id) {
    const identity = getIdentity();
    const common = new Set(['role', 'teacher-auth', 'student-auth']);
    if (common.has(id)) return id;
    if (identity?.role === 'teacher') {
      if (id === 'home' || id === 'join') return 'teacher-course-list';
      const allowed = new Set(['teacher-dashboard', 'teacher-course-list', 'teacher-course-workspace', 'create', 'upload', 'loading', 'generation-complete', 'review']);
      return allowed.has(id) ? id : 'teacher-course-list';
    }
    if (identity?.role === 'student') {
      const allowed = new Set(['student-home', 'chapter', 'diagnosis-intro', 'diagnosis-result', 'quiz', 'report', 'wrongbook']);
      return allowed.has(id) ? id : 'student-home';
    }
    if (identity?.role === 'guest') {
      const allowed = new Set(['student-home', 'chapter', 'diagnosis-intro', 'diagnosis-result', 'quiz', 'report', 'wrongbook']);
      return allowed.has(id) ? id : 'student-home';
    }
    return 'role';
  }

  function bindEvents() {
    $('role-teacher-btn').addEventListener('click', openTeacherAuth);
    $('role-student-btn').addEventListener('click', openStudentAuth);
    $('role-guest-btn').addEventListener('click', enterGuestMode);
    $('teacher-auth-submit').addEventListener('click', submitTeacherAuth);
    $('student-auth-submit').addEventListener('click', submitStudentAuth);
    $('student-login-mode-btn').addEventListener('click', () => setStudentAuthMode('login'));
    $('student-register-mode-btn').addEventListener('click', () => setStudentAuthMode('register'));
    $('student-forgot-password-btn').addEventListener('click', () => alert('请联系课程老师。'));
    $('teacher-courses-btn').addEventListener('click', () => { renderTeacherCourseList(); app().showRawScreen('teacher-course-list'); });
    $('teacher-logout-btn').addEventListener('click', leaveCurrentIdentity);
    $('student-switch-btn').addEventListener('click', leaveCurrentIdentity);
    $('student-wrongbook-btn').addEventListener('click', () => app().openWrongBook('student-home'));
    $('create-class-open-btn').addEventListener('click', () => $('create-class-form').classList.remove('hide'));
    $('create-class-cancel-btn').addEventListener('click', () => $('create-class-form').classList.add('hide'));
    $('create-class-submit-btn').addEventListener('click', createClass);
    $('create-course-space-open-btn').addEventListener('click', () => $('create-course-space-form').classList.remove('hide'));
    $('create-course-space-cancel-btn').addEventListener('click', () => $('create-course-space-form').classList.add('hide'));
    $('create-course-space-submit-btn').addEventListener('click', createCourseSpace);
    document.querySelectorAll('.course-space-tab-btn').forEach(button => button.addEventListener('click', () => {
      activeCourseSpaceTab = button.dataset.courseSpaceTab;
      renderTeacherCourseWorkspace();
    }));
    document.addEventListener('click', event => {
      const nav = event.target.closest('[data-teaching-nav]');
      if (!nav) return;
      const target = nav.dataset.teachingNav;
      if (target === 'role') app().showRawScreen('role');
      else if (target === 'teacher-courses' || target === 'teacher-course-list') {
        renderTeacherCourseList();
        app().showRawScreen('teacher-course-list');
      }
      else if (target === 'teacher-dashboard') {
        renderTeacherDashboard();
        app().showRawScreen('teacher-dashboard');
      } else if (target === 'teacher-classes') {
        renderTeacherClasses();
        app().showRawScreen('teacher-classes');
      }
    });
    document.querySelectorAll('.class-tab-btn').forEach(button => button.addEventListener('click', () => {
      activeClassTab = button.dataset.classTab;
      renderTeacherClassDetail();
    }));
  }

  window.TEACHING_V1 = {
    ensureTeachingState,
    beforeQuizStateSave,
    resolveHomeScreen,
    resolveCourseListScreen,
    routeAfterRestore,
    renderStudentHome,
    renderTeacherClasses,
    renderTeacherClassDetail,
    renderTeacherCourseList,
    renderTeacherCourseWorkspace,
    allowedChapterTitles,
    guardScreen,
    get activeCourseSpaceId() { return activeCourseSpaceId; },
    __test: {
      submitTeacherAuth,
      submitStudentAuth,
      enterGuestMode,
      createClass,
      setPublication,
      studentStats,
      getIdentity,
      setIdentity,
      restoreStudentLearning
    }
  };

  bindEvents();
})();
