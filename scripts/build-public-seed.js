const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) {
  throw new Error('用法：node scripts/build-public-seed.js <源状态文件> <输出文件>');
}

const payload = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
if (!Array.isArray(state.courses) || state.courses.length === 0) {
  throw new Error('源状态中没有课程');
}

const teaching = state.teaching && typeof state.teaching === 'object' ? state.teaching : {};
const seed = {
  format: 'quiz-site-quality-v2',
  saved_at: new Date().toISOString(),
  state: {
    courses: state.courses,
    current_session: null,
    wrong_book: {},
    teaching: {
      version: teaching.version || 1.1,
      teacher: {},
      course_spaces: Array.isArray(teaching.course_spaces) ? teaching.course_spaces : [],
      students: [],
      guest_sessions: [],
      practice_records: [],
      ai_guidance_records: []
    }
  }
};

fs.writeFileSync(outputPath, JSON.stringify(seed), 'utf8');
console.log(`已生成访客初始数据：${seed.state.courses.length} 门课程`);
