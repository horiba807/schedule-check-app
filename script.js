'use strict';

const STORAGE_KEY = 'lectureCheckerTimetable2026';
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAYS = [
  { day: 1, name: '月曜日', short: '月' },
  { day: 2, name: '火曜日', short: '火' },
  { day: 3, name: '水曜日', short: '水' },
  { day: 4, name: '木曜日', short: '木' },
  { day: 5, name: '金曜日', short: '金' },
  { day: 6, name: '土曜日', short: '土' },
];

const timetableGrid = document.getElementById('timetable-grid');
const dateInput = document.getElementById('check-date');
const resultCard = document.getElementById('result');
const resultIcon = document.getElementById('result-icon');
const resultKicker = document.getElementById('result-kicker');
const resultTitle = document.getElementById('result-title');
const resultDetail = document.getElementById('result-detail');
const dayInfo = document.getElementById('day-info');


// ===== 行事予定データ（アップロードして取り込んだJSONのみ） =====
const CALENDAR_STORAGE_KEY = 'lectureCheckerCalendar';
let LECTURE_DATES = new Set();
let EXAM_DATES = new Set();
let UNIVERSITY_EVENTS = {};
let SPECIAL_LECTURE_EVENTS = {};
let CALENDAR_RANGE = null; // { start, end }。未取り込みのときは null
let CALENDAR_SOURCE = 'none'; // 'none' | 'imported'
let CALENDAR_YEAR = null;

/** 行事予定を空の状態（未取り込み）に戻す */
function clearCalendar() {
  LECTURE_DATES = new Set();
  EXAM_DATES = new Set();
  UNIVERSITY_EVENTS = {};
  SPECIAL_LECTURE_EVENTS = {};
  CALENDAR_RANGE = null;
  CALENDAR_SOURCE = 'none';
  CALENDAR_YEAR = null;
  dateInput.removeAttribute('min');
  dateInput.removeAttribute('max');
}

/** カレンダーJSONをアプリの判定用データに反映する */
function applyCalendar(cal) {
  clearCalendar();
  Object.entries(cal.days).forEach(([date, d]) => {
    if (d.type === 'lecture') {
      LECTURE_DATES.add(date);
      if (d.label) SPECIAL_LECTURE_EVENTS[date] = d.label;
    } else if (d.type === 'exam') {
      EXAM_DATES.add(date);
      if (d.label) UNIVERSITY_EVENTS[date] = d.label;
    } else if (d.label) {
      UNIVERSITY_EVENTS[date] = d.label;
    }
  });
  const meta = cal.meta || {};
  const dates = Object.keys(cal.days).sort();
  CALENDAR_RANGE = {
    start: meta.startDate || dates[0],
    end: meta.endDate || dates[dates.length - 1]
  };
  CALENDAR_YEAR = meta.academicYear || Number(CALENDAR_RANGE.start.slice(0, 4));
  CALENDAR_SOURCE = 'imported';
  dateInput.min = CALENDAR_RANGE.start;
  dateInput.max = CALENDAR_RANGE.end;
}

/** 保存済みの行事予定を返す（なければ null） */
function getActiveCalendar() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_STORAGE_KEY));
    if (saved && saved.days && Object.keys(saved.days).length > 0) return saved;
  } catch (error) { /* 壊れた保存データは無いものとして扱う */ }
  return null;
}

function loadInitialCalendar() {
  const saved = getActiveCalendar();
  if (saved) applyCalendar(saved);
  else clearCalendar();
}

/** 日付入力の初期値：今日（取り込み済みで範囲外なら範囲の先頭） */
function defaultDateValue() {
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (!CALENDAR_RANGE) return today;
  return today >= CALENDAR_RANGE.start && today <= CALENDAR_RANGE.end ? today : CALENDAR_RANGE.start;
}

function makeEmptyTimetable() {
  return { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] };
}

function loadTimetable() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return makeEmptyTimetable();
    const parsed = JSON.parse(saved);
    const clean = makeEmptyTimetable();
    for (const day of Object.keys(clean)) {
      clean[day] = Array.isArray(parsed[day]) ? parsed[day].filter(p => Number.isInteger(p) && p >= 1 && p <= 6) : [];
    }
    return clean;
  } catch (error) {
    return makeEmptyTimetable();
  }
}

let timetable = loadTimetable();

function renderTimetable() {
  timetableGrid.innerHTML = '';
  WEEKDAYS.forEach(({ day, name, short }) => {
    const card = document.createElement('div');
    card.className = 'day-card';
    const heading = document.createElement('div');
    heading.className = 'day-card-heading';
    heading.innerHTML = `<p>${name}</p>`;
    const list = document.createElement('div');
    list.className = 'period-list';
    for (let period = 1; period <= 6; period += 1) {
      const label = document.createElement('label');
      label.className = 'period-label';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.day = String(day);
      input.dataset.period = String(period);
      input.checked = timetable[String(day)].includes(period);
      input.setAttribute('aria-label', `${name} ${period}限`);
      const span = document.createElement('span');
      span.textContent = `${period}限`;
      label.append(input, span);
      list.append(label);
    }
    card.append(heading, list);
    timetableGrid.append(card);
  });
}

function readTimetableInputs() {
  const next = makeEmptyTimetable();
  timetableGrid.querySelectorAll('input[type="checkbox"]').forEach(input => {
    if (input.checked) next[input.dataset.day].push(Number(input.dataset.period));
  });
  return next;
}

function saveTimetable(showMessage = true) {
  timetable = readTimetableInputs();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timetable));
    const indicator = document.getElementById('saved-indicator');
    indicator.innerHTML = '<span class="saved-dot"></span>保存済み';
    if (showMessage) {
      indicator.setAttribute('title', '時間割をこのブラウザーに保存しました');
      indicator.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 220 });
    }
  } catch (error) {
    document.getElementById('saved-indicator').textContent = '保存できません';
  }
}

function formatJapaneseDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${DAY_NAMES[date.getDay()]}）`;
}

/**
 * 判定結果を表示する。
 * lines の各行は縦に並ぶ（最後の1行がメッセージ）。見た目は style.css の .result-row / .result-message で調整する。
 */
function setResult(type, icon, title, lines = []) {
  resultCard.className = `result-card result-${type}`;
  resultIcon.textContent = icon;
  resultKicker.textContent = dateInput.value ? formatJapaneseDate(dateInput.value) : '判定結果';
  resultTitle.textContent = title;
  resultDetail.replaceChildren();
  lines.forEach((text, index) => {
    const row = document.createElement('p');
    // 最後の1行はメッセージとして、少し目立たせる（見た目は style.css の .result-message）
    row.className = index === lines.length - 1 ? 'result-row result-message' : 'result-row';
    row.textContent = text;
    resultDetail.append(row);
  });
  dayInfo.hidden = true;
  dayInfo.textContent = '';
}

function todayString() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 授業実施日の行事名（「授業実施（海の日）」など）から、祝日名だけを取り出して「大学：授業実施日（海の日）」にする */
function universityLectureLine(special) {
  if (!special) return '授業実施日';
  const m = special.match(/[（(](.+?)[）)]/);
  // 「授業実施（海の日）」「海の日（授業実施日）」→ 祝日名だけを取り出す
  const name = m ? (/^授業実施/.test(m[1]) ? special.replace(/[（(].*$/, '') : m[1]) : special;
  return `授業実施日（${name}）`;
}

function checkLecture() {
  saveTimetable(false);
  const dateString = dateInput.value;
  if (!dateString) {
    setResult('warn', '!', '日付を選んでください', ['確認したい日付を入力してください。']);
    return;
  }
  if (!CALENDAR_RANGE) {
    setResult('warn', '!', '行事予定が未取り込みです', ['行事予定の取り込み画面から、大学の年間行事予定（PDF・画像・JSON）を読み込んでください。']);
    return;
  }
  if (dateString < CALENDAR_RANGE.start || dateString > CALENDAR_RANGE.end) {
    setResult('warn', '!', '対象年度外です', [`現在の日程データは${CALENDAR_RANGE.start}〜${CALENDAR_RANGE.end}の範囲です。別の年度のPDFを取り込むと切り替えられます。`]);
    return;
  }

  const date = new Date(`${dateString}T12:00:00`);
  const weekday = date.getDay();
  const periods = timetable[String(weekday)] || [];
  const periodText = periods.length > 0 ? periods.map(p => `${p}限`).join('・') : '-';
  const event = UNIVERSITY_EVENTS[dateString];
  const subject = dateString === todayString() ? '今日' : 'この日';

  if (EXAM_DATES.has(dateString)) {
    setResult('exam', '📃', '期末試験期間', ['大学：期末試験', `${subject}は期末試験日です。`]);
    return;
  }

  if (LECTURE_DATES.has(dateString)) {
    const universityLine = universityLectureLine(SPECIAL_LECTURE_EVENTS[dateString]);
    if (periods.length > 0) {
      setResult('yes', '✓', '授業実施日', [universityLine, `${periodText}`, ` `]);
    } else {
      setResult('yes', '🎉', '全休', [universityLine, ` `, `${subject}は全休です。`]);
    }
    return;
  }

  if (event) {
    setResult('no', '–', '休日', [`${event}`, `${subject}はお休みです。`]);
    return;
  }

  setResult('no', '–', '休日', ['授業実施日ではありません', `${subject}はお休みです。`]);
}

function setToday() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  dateInput.value = `${yyyy}-${mm}-${dd}`;
  checkLecture();
}

renderTimetable();
loadInitialCalendar();
dateInput.value = defaultDateValue();
document.getElementById('check-button').addEventListener('click', checkLecture);
document.getElementById('today-button').addEventListener('click', setToday);
document.getElementById('save-button').addEventListener('click', () => saveTimetable(true));
dateInput.addEventListener('change', checkLecture);
timetableGrid.addEventListener('change', () => {
  document.getElementById('saved-indicator').innerHTML = '<span class="saved-dot" style="background:#c18b35"></span>未保存の変更';
});
checkLecture();
