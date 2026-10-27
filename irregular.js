/**
 * 変則日の検出と、カレンダー用ファイル（.ics）の書き出し
 *
 * 変則日 =
 *   ・祝日なのに授業がある日（例：授業実施（海の日））
 *   ・授業期間の平日なのに授業がない日（例：大学祭、創立記念日）
 *
 * 前半（検出・ICS生成）は画面に依存しない関数です。
 * 後半は index.html の #irregular の表示と操作をつなぎます。
 */
(function (root) {
  // 国民の祝日の名称（行事予定のラベルから祝日かどうかを判定するために使う）
  const HOLIDAY_NAMES = [
    '元日', '成人の日', '建国記念の日', '天皇誕生日', '春分の日', '昭和の日', '憲法記念日',
    'みどりの日', 'こどもの日', '海の日', '山の日', '敬老の日', '秋分の日', 'スポーツの日',
    '体育の日', '文化の日', '勤労感謝の日', '振替休日', '国民の休日'
  ];
  const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const TERM_GAP_DAYS = 21; // 授業日どうしがこれ以上空いたら、別の学期とみなす
  const BREAK_WEEKDAYS = 5; // 平日がこの日数以上続けて授業なしなら、長期休業とみなして除く

  const pad = n => String(n).padStart(2, '0');

  function toDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }

  function toYmd(date) {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function addDays(ymd, n) {
    const d = toDate(ymd);
    d.setUTCDate(d.getUTCDate() + n);
    return toYmd(d);
  }

  function diffDays(a, b) {
    return Math.round((toDate(b) - toDate(a)) / 86400000);
  }

  function findHolidayName(label) {
    if (!label) return null;
    return HOLIDAY_NAMES.find(name => label.includes(name)) || null;
  }

  /** 「授業実施（海の日）」→「海の日」。祝日名が見つからなければ括弧内、それもなければ全文 */
  function holidayClassName(label) {
    const holiday = findHolidayName(label);
    if (holiday) return holiday;
    const m = (label || '').match(/[（(](.+?)[）)]/);
    return m ? m[1] : (label || '');
  }

  /** 授業日を学期ごとの期間 [{start, end}] に分ける */
  function findTerms(days) {
    const dates = Object.keys(days).filter(d => days[d].type === 'lecture').sort();
    const terms = [];
    dates.forEach(date => {
      const last = terms[terms.length - 1];
      if (last && diffDays(last.end, date) <= TERM_GAP_DAYS) last.end = date;
      else terms.push({ start: date, end: date });
    });
    return terms;
  }

  /**
   * 変則日を探す。
   * @param cal {days}  行事予定JSON
   * @param options.timetable  {0..6: [コマ]}  自分の時間割（曜日ごと）
   * @param options.onlyMyDays  true なら、自分のコマがある曜日の変則日だけにする
   */
  function detectIrregularDays(cal, options = {}) {
    const timetable = options.timetable || {};
    const days = cal.days || {};
    const result = [];

    findTerms(days).forEach(term => {
      let run = []; // 授業のない平日が続いている間の候補
      const flushRun = () => {
        if (run.length < BREAK_WEEKDAYS) {
          run.filter(r => !r.holiday).forEach(r => result.push(r.item));
        }
        run = [];
      };

      for (let date = term.start; date <= term.end; date = addDays(date, 1)) {
        const dow = toDate(date).getUTCDay();
        if (dow === 0 || dow === 6) continue; // 土日は対象外（途切れとも数えない）
        const entry = days[date];
        const periods = timetable[String(dow)] || [];

        if (entry && entry.type === 'lecture') {
          flushRun();
          // 祝日なのに授業がある日（「授業実施（◯◯）」など）
          if (entry.label && (findHolidayName(entry.label) || /授業実施/.test(entry.label))) {
            result.push({
              date, dow, kind: 'holiday-class', periods,
              name: holidayClassName(entry.label),
              universityLabel: entry.label
            });
          }
        } else if (entry && entry.type === 'exam') {
          flushRun();
        } else {
          const holiday = entry && findHolidayName(entry.label);
          run.push({
            holiday: Boolean(holiday),
            item: {
              date, dow, kind: 'no-class', periods,
              name: (entry && entry.label) || '',
              universityLabel: (entry && entry.label) || ''
            }
          });
        }
      }
      flushRun();
    });

    result.sort((a, b) => a.date.localeCompare(b.date));
    return options.onlyMyDays ? result.filter(r => r.periods.length > 0) : result;
  }

  function periodText(periods) {
    return periods.length > 0 ? periods.map(p => `${p}限`).join('・') : '登録なし';
  }

  /** 書き出す予定の見出しと説明文 */
  function describeItem(item) {
    const summary = item.kind === 'holiday-class'
      ? `📚授業あり（${item.name}）`
      : `🏖授業なし${item.name ? `（${item.name}）` : ''}`;
    const lines = [
      `大学の行事予定：${item.universityLabel || '授業日ではありません'}`,
      `あなたの登録コマ：${periodText(item.periods)}`,
      '講義日チェックで作成'
    ];
    return { summary, description: lines.join('\n') };
  }

  // ---------- .ics の組み立て ----------
  function escapeIcsText(text) {
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /** 1行を75バイト以内に折り返す（2行目以降は先頭に空白1つ）。日本語の文字の途中では切らない */
  function foldLine(line) {
    const encoder = new TextEncoder();
    const out = [];
    let current = '';
    let bytes = 0;
    let limit = 75;
    for (const ch of Array.from(line)) {
      const size = encoder.encode(ch).length;
      if (bytes + size > limit) {
        out.push(current);
        current = ' ';
        bytes = 1;
        limit = 75;
      }
      current += ch;
      bytes += size;
    }
    out.push(current);
    return out;
  }

  function icsTimestamp(now) {
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
      + `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  }

  /**
   * ICS文字列を作る。UIDは日付と種類から決めるので、同じ予定をもう一度取り込んでも重複しにくい。
   * @param items  detectIrregularDays の結果
   * @param options.alarm  true なら前日の朝9時に通知（VALARM）
   */
  function buildIcs(items, options = {}) {
    const now = options.now || new Date();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//lecture-checker-app//irregular-days//JA',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeIcsText(options.calendarName || '講義日チェック（変則日）')}`
    ];
    items.forEach(item => {
      const { summary, description } = describeItem(item);
      const compact = item.date.replace(/-/g, '');
      lines.push(
        'BEGIN:VEVENT',
        `UID:lcc-${compact}-${item.kind}@lecture-checker`,
        `DTSTAMP:${icsTimestamp(now)}`,
        `DTSTART;VALUE=DATE:${compact}`,
        `DTEND;VALUE=DATE:${addDays(item.date, 1).replace(/-/g, '')}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        'TRANSP:TRANSPARENT'
      );
      if (options.alarm) {
        lines.push(
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeIcsText(summary)}`,
          'TRIGGER:-PT15H', // 終日予定の0時の15時間前＝前日の朝9時
          'END:VALARM'
        );
      }
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.flatMap(foldLine).join('\r\n') + '\r\n';
  }

  const api = { detectIrregularDays, buildIcs, describeItem, findTerms, HOLIDAY_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.IrregularDays = api;

  // ---------- 画面との連携 ----------
  if (typeof document === 'undefined' || !document.getElementById('irregular')) return;

  const $ = id => document.getElementById(id);
  const section = $('irregular');
  const listEl = $('irregular-list');
  const summaryEl = $('irregular-summary');
  const myOnlyEl = $('irregular-my-only');
  const alarmEl = $('irregular-alarm');
  const exportButton = $('irregular-export-button');
  const unchecked = new Set(); // 利用者が外した予定（日付＋種類）

  function currentTimetable() {
    return typeof readTimetableInputs === 'function' ? readTimetableInputs() : {};
  }

  function hasAnyPeriod(timetable) {
    return Object.values(timetable).some(periods => periods.length > 0);
  }

  function currentItems() {
    const cal = typeof getActiveCalendar === 'function' ? getActiveCalendar() : null;
    if (!cal) return null;
    const timetable = currentTimetable();
    return detectIrregularDays(cal, { timetable, onlyMyDays: myOnlyEl.checked && hasAnyPeriod(timetable) });
  }

  function keyOf(item) {
    return `${item.date}:${item.kind}`;
  }

  function selectedItems(items) {
    return items.filter(item => !unchecked.has(keyOf(item)));
  }

  function updateSummary(items) {
    const chosen = selectedItems(items);
    const classCount = chosen.filter(i => i.kind === 'holiday-class').length;
    summaryEl.textContent = `祝日の授業 ${classCount} 件／平日の休講 ${chosen.length - classCount} 件を書き出します`;
    exportButton.disabled = chosen.length === 0;
  }

  function render() {
    const items = currentItems();
    if (!items) {
      section.hidden = true; // 行事予定が未取り込みのときは出さない
      return;
    }
    section.hidden = false;
    const timetable = currentTimetable();
    const anyPeriod = hasAnyPeriod(timetable);
    myOnlyEl.disabled = !anyPeriod;
    $('irregular-my-only-note').hidden = anyPeriod;

    listEl.replaceChildren();
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'irregular-empty';
      li.textContent = '変則日は見つかりませんでした。';
      listEl.append(li);
      summaryEl.textContent = '';
      exportButton.disabled = true;
      return;
    }

    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'irregular-item';
      const label = document.createElement('label');

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !unchecked.has(keyOf(item));
      box.addEventListener('change', () => {
        if (box.checked) unchecked.delete(keyOf(item)); else unchecked.add(keyOf(item));
        updateSummary(items);
      });

      const date = document.createElement('span');
      date.className = 'irregular-date';
      date.textContent = `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8))}（${WEEKDAY_NAMES[item.dow]}）`;

      const badge = document.createElement('span');
      badge.className = `irregular-badge ${item.kind === 'holiday-class' ? 'is-class' : 'is-no-class'}`;
      badge.textContent = item.kind === 'holiday-class' ? '授業あり' : '授業なし';

      const text = document.createElement('span');
      text.className = 'irregular-text';
      text.textContent = item.name || '（行事の記載なし）';

      const mine = document.createElement('span');
      mine.className = 'irregular-mine';
      mine.textContent = item.periods.length > 0 ? `あなたのコマ：${periodText(item.periods)}` : '';

      label.append(box, date, badge, text, mine);
      li.append(label);
      listEl.append(li);
    });
    updateSummary(items);
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  exportButton.addEventListener('click', () => {
    const items = currentItems();
    if (!items) return;
    const chosen = selectedItems(items);
    if (chosen.length === 0) return;
    const year = (typeof CALENDAR_YEAR !== 'undefined' && CALENDAR_YEAR) || '';
    download(buildIcs(chosen, { alarm: alarmEl.checked }), `lecture-irregular-days-${year}.ics`);
  });

  myOnlyEl.addEventListener('change', render);

  // 時間割を変更・保存したら、自分のコマの表示を更新する
  const grid = $('timetable-grid');
  if (grid) grid.addEventListener('change', render);
  const saveButton = $('save-button');
  if (saveButton) saveButton.addEventListener('click', render);

  // 行事予定の取り込み・削除のあとに、calendar-import.js から呼ばれる
  root.refreshIrregular = render;
  render();
})(typeof window !== 'undefined' ? window : globalThis);
