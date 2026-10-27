/**
 * 行事予定の取り込みUI
 * PDF → (pdf.js) → テキスト項目 → CalendarParser → 確認・修正 → localStorage → アプリに反映
 * JSON の書き出し／読み込みにも対応
 * script.js（applyCalendar など）と calendar-parser.js が先に読み込まれている前提です。
 */
(function () {
  const PDFJS_VERSION = '3.11.174';
  // pdf.js 本体・ワーカー・CMap は npm パッケージ pdfjs-dist の同じバージョンから読み込む
  const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
  const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
  // CMap（日本語フォントの文字コード表）の置き場所。1つ目で読めなければ次を試す
  const PDFJS_CMAP_URLS = [
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/cmaps/`
  ];
  const TESSERACT_VERSION = '5.1.1';
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const IMPORT_VERSION = 'v5（CMap自動切替・原因表示つき）';
  const TYPE_LABELS = { lecture: '授業日', exam: '試験', event: '行事・休日' };

  const $ = id => document.getElementById(id);
  const fileInput = $('calendar-file');
  const yearInput = $('calendar-year');
  const parseButton = $('calendar-parse-button');
  const exportButton = $('calendar-export-button');
  const resetButton = $('calendar-reset-button');
  const statusBox = $('calendar-status');
  const sourceChip = $('calendar-source-chip');
  const reviewBox = $('calendar-review');
  const reviewSummary = $('calendar-review-summary');
  const monthFilter = $('calendar-month-filter');
  const showAll = $('calendar-show-all');
  const tableBody = $('calendar-table-body');
  const addDateInput = $('calendar-add-date');
  const addButton = $('calendar-add-button');
  const applyButton = $('calendar-apply-button');
  const cancelButton = $('calendar-cancel-button');

  let draft = null; // 確認中のカレンダー { meta, days }

  function setStatus(kind, lines) {
    statusBox.hidden = !lines || lines.length === 0;
    statusBox.className = `calendar-status calendar-status-${kind}`;
    statusBox.replaceChildren();
    (lines || []).forEach(text => {
      const p = document.createElement('p');
      p.textContent = text;
      statusBox.append(p);
    });
  }

  function updateSourceChip() {
    const imported = CALENDAR_SOURCE === 'imported';
    sourceChip.textContent = imported ? `取り込み済み：${CALENDAR_YEAR}年度` : '未取り込み';
    resetButton.hidden = !imported;
    exportButton.disabled = !imported;
    // 変則日の一覧も、取り込み・削除に合わせて更新する（irregular.js）
    if (window.refreshIrregular) window.refreshIrregular();
  }

  // ---------- PDF の読み取り ----------
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_URL;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error('PDF読み取りライブラリ（pdf.js）を読み込めませんでした。ネットワーク接続を確認してください。'));
      document.head.append(script);
    });
  }

  // ---------- 画像（スクリーンショット）の読み取り（OCR） ----------
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => reject(new Error('OCRライブラリ（Tesseract.js）を読み込めませんでした。ネットワーク接続を確認してください。'));
      document.head.append(script);
    });
  }

  async function extractImageItems(file, onProgress) {
    const Tesseract = await loadTesseract();
    const result = await Tesseract.recognize(file, 'jpn', {
      logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); }
    });
    const words = (result.data.words || [])
      .map(w => ({ str: w.text.replace(/\s+/g, ''), x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }))
      .filter(w => w.str.length > 0);
    const items = CalendarParser.splitDigitsFromLabel(CalendarParser.mergeAdjacentWords(words), CalendarParser.normalizeOcrSession);
    return items;
  }

  async function readPdfWords(pdfjsLib, data, cMapUrl) {
    const pdf = await pdfjsLib.getDocument({ data: data.slice(0), cMapUrl, cMapPacked: true }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const words = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      words.push({ str: it.str.trim(), x: it.transform[4], y: -it.transform[5], w: it.width, h: it.height || 10 });
    }
    return { words, pageCount: pdf.numPages, rawCount: content.items.length };
  }

  async function checkReachable(url) {
    try {
      const res = await fetch(`${url}90ms-RKSJ-H.bcmap`, { method: 'GET' });
      return res.ok ? '取得できました' : `取得できませんでした（HTTP ${res.status}）`;
    } catch (error) {
      return '取得できませんでした（接続エラー）';
    }
  }

  async function extractPdfItems(file) {
    const pdfjsLib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    // 日本語PDFのフォントを読むには CMap が必要（無いと文字が1つも取り出せない）。置き場所を順に試す
    let rawCount = 0;
    for (const cMapUrl of PDFJS_CMAP_URLS) {
      const { words, pageCount, rawCount: n } = await readPdfWords(pdfjsLib, data, cMapUrl);
      rawCount = n;
      if (words.length > 0) {
        // 文字ごとにばらけて出力されるPDFがあるため、同じ行で近いものをまとめてから、数字とラベルを分ける
        const items = CalendarParser.splitDigitsFromLabel(CalendarParser.mergeAdjacentWords(words));
        return { items, pageCount };
      }
    }
    // どこでも読めなかった場合は、原因の手がかりを画面に出す
    const reach = [];
    for (const url of PDFJS_CMAP_URLS) reach.push(`${new URL(url).host}：${await checkReachable(url)}`);
    const error = new Error('PDFから文字を取り出せませんでした。日本語フォント用データ（CMap）を読み込めていない可能性があります。');
    error.details = [`pdf.js ${PDFJS_VERSION} が返したテキスト項目：${rawCount}件`, 'CMapの取得テスト', ...reach, 'ブラウザーの広告ブロッカーや、学校・会社のネットワーク制限を確認してください。このアプリが最新版か（取り込みパネルの「版」表示）も確認してください。'];
    throw error;
  }

  // ---------- 確認・修正テーブル ----------
  function weekdayName(dateString) {
    return DAY_NAMES[new Date(`${dateString}T12:00:00`).getDay()];
  }

  function countByType(days) {
    const counts = { lecture: 0, exam: 0, event: 0 };
    Object.values(days).forEach(d => { counts[d.type] += 1; });
    return counts;
  }

  function renderSummary() {
    const c = countByType(draft.days);
    const year = draft.meta.academicYear;
    reviewSummary.textContent = `${year}年度：授業日 ${c.lecture} 日／試験 ${c.exam} 日／行事・休日 ${c.event} 日`;
  }

  function renderMonthOptions() {
    const months = [...new Set(listDates().map(d => d.slice(0, 7)))].sort();
    monthFilter.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'すべての月';
    monthFilter.append(all);
    months.forEach(ym => {
      const o = document.createElement('option');
      o.value = ym;
      o.textContent = `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;
      monthFilter.append(o);
    });
  }

  /** 一覧に出す日付：予定のある日 ＋ 年度内のすべての土日（「すべて表示」ならすべての日） */
  function listDates() {
    const set = new Set(Object.keys(draft.days));
    const start = draft.meta.startDate || Object.keys(draft.days).sort()[0];
    const end = draft.meta.endDate || Object.keys(draft.days).sort().slice(-1)[0];
    if (start && end) {
      const d = new Date(`${start}T12:00:00`);
      const last = new Date(`${end}T12:00:00`);
      while (d <= last) {
        const wd = d.getDay();
        if (showAll.checked || wd === 0 || wd === 6) {
          set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
        d.setDate(d.getDate() + 1);
      }
    }
    return [...set].sort();
  }

  function renderTable() {
    tableBody.replaceChildren();
    const filter = monthFilter.value;
    listDates().forEach(date => {
      if (filter && !date.startsWith(filter)) return;
      const tr = document.createElement('tr');
      const wd = new Date(`${date}T12:00:00`).getDay();
      if (wd === 0 || wd === 6) tr.className = 'calendar-weekend';

      const tdDate = document.createElement('td');
      tdDate.textContent = `${Number(date.slice(5, 7))}/${Number(date.slice(8))}（${weekdayName(date)}）`;

      const tdType = document.createElement('td');
      const select = document.createElement('select');
      [['none', '予定なし'], ...Object.entries(TYPE_LABELS)].forEach(([value, text]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        select.append(o);
      });
      select.value = draft.days[date] ? draft.days[date].type : 'none';
      select.setAttribute('aria-label', `${date} の種類`);

      const tdSession = document.createElement('td');
      const sessionInput = document.createElement('input');
      sessionInput.type = 'number';
      sessionInput.min = '1';
      sessionInput.max = '20';
      sessionInput.setAttribute('aria-label', `${date} の授業回数`);
      sessionInput.addEventListener('input', () => {
        const d = draft.days[date];
        if (!d) return;
        const n = parseInt(sessionInput.value, 10);
        if (Number.isInteger(n)) d.session = n; else delete d.session;
      });
      tdSession.append(sessionInput);

      const tdLabel = document.createElement('td');
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.setAttribute('aria-label', `${date} の行事名`);
      labelInput.addEventListener('input', () => {
        if (!draft.days[date]) {
          // 予定なしの日に行事名を入力したら、行事として登録する
          if (!labelInput.value) return;
          draft.days[date] = { type: 'event' };
          select.value = 'event';
          renderSummary();
        }
        if (labelInput.value) draft.days[date].label = labelInput.value; else delete draft.days[date].label;
      });
      tdLabel.append(labelInput);

      const refreshFields = () => {
        const d = draft.days[date];
        sessionInput.value = d && d.session ? d.session : '';
        sessionInput.disabled = !d || d.type !== 'lecture';
        labelInput.value = d && d.label ? d.label : '';
      };
      refreshFields();

      select.addEventListener('change', () => {
        const value = select.value;
        if (value === 'none') {
          delete draft.days[date];
        } else {
          if (!draft.days[date]) draft.days[date] = { type: value };
          draft.days[date].type = value;
          if (value !== 'lecture') delete draft.days[date].session;
        }
        refreshFields();
        renderSummary();
      });
      tdType.append(select);

      const tdDelete = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-button';
      del.textContent = '×';
      del.setAttribute('aria-label', `${date} の予定を消す`);
      del.addEventListener('click', () => {
        delete draft.days[date];
        select.value = 'none';
        refreshFields();
        renderSummary();
      });
      tdDelete.append(del);

      tr.append(tdDate, tdType, tdSession, tdLabel, tdDelete);
      tableBody.append(tr);
    });
  }

  function openReview(cal, warnings = []) {
    draft = cal;
    reviewBox.hidden = false;
    renderSummary();
    renderMonthOptions();
    renderTable();
    if (warnings.length > 0) setStatus('warn', warnings);
    reviewBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeReview() {
    draft = null;
    reviewBox.hidden = true;
  }

  // ---------- 解析の実行 ----------
  async function handleParse() {
    const file = fileInput.files[0];
    if (!file) {
      setStatus('warn', ['PDF・画像・JSONのいずれかを選んでください。']);
      return;
    }
    const name = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
    const isJson = file.type === 'application/json' || name.endsWith('.json');
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isJson && !isImage) {
      setStatus('warn', ['対応しているのはPDF・画像（PNG/JPEG）・JSONです。']);
      return;
    }

    parseButton.disabled = true;
    setStatus('info', ['読み取り中です…']);
    try {
      if (isJson) {
        const cal = JSON.parse(await file.text());
        if (!CalendarParser.validateCalendar(cal)) throw new Error('JSONの形式が正しくありません（days に lecture / exam / event の日付が必要です）。');
        cal.meta = cal.meta || {};
        if (!cal.meta.academicYear) cal.meta.academicYear = Number(Object.keys(cal.days).sort()[0].slice(0, 4));
        setStatus('ok', ['JSONを読み込みました。内容を確認して「このカレンダーを使う」を押してください。']);
        openReview(cal);
        return;
      }

      let items;
      let pageCount = 1;
      if (isImage) {
        setStatus('info', ['画像を読み取っています…（初回は日本語データのダウンロードで時間がかかります）']);
        items = await extractImageItems(file, p => setStatus('info', [`画像を読み取っています… ${Math.round(p * 100)}%`]));
        if (items.length === 0) throw new Error('画像から文字を読み取れませんでした。文字がはっきり写った、大きめの画像をお試しください。');
      } else {
        ({ items, pageCount } = await extractPdfItems(file));
        if (items.length === 0) {
          throw new Error('PDFから文字を取り出せませんでした。スキャンしただけのPDFの可能性があります。画像として保存して取り込んでください。');
        }
      }
      const year = parseInt(yearInput.value, 10);
      const result = CalendarParser.parseCalendarItems(items, Number.isInteger(year) ? { academicYear: year } : {});
      if (result.needsYear) {
        const hint = result.yearCandidates.length ? `候補：${result.yearCandidates.join('、')}年度` : '';
        setStatus('warn', [...result.warnings, hint].filter(Boolean));
        return;
      }
      const notes = [...result.warnings];
      if (pageCount > 1) notes.push(`PDFは${pageCount}ページありますが、1ページ目だけを読み取りました。`);
      if (isImage) {
        const c = countByType(result.days);
        notes.unshift('画像から読み取った結果です。授業回数（①〜⑮）や行事名は読み違えやすいので、一覧をよく確認してください。');
        if (c.lecture < 100) notes.push(`授業日が ${c.lecture} 日しか見つかっていません。丸数字の読み取りに失敗している可能性があります。`);
      }
      if (notes.length === 0) {
        setStatus('ok', ['読み取りました。表の内容を確認し、必要なら修正してください。']);
      }
      openReview({ meta: result.meta, days: result.days }, notes);
    } catch (error) {
      setStatus('error', [error.message || String(error), ...(error.details || [])]);
    } finally {
      parseButton.disabled = false;
    }
  }

  // ---------- 保存・書き出し ----------
  function handleApply() {
    if (!draft) return;
    const cleaned = {};
    Object.entries(draft.days).forEach(([date, d]) => {
      const entry = { type: d.type };
      if (d.type === 'lecture' && d.session) entry.session = d.session;
      if (d.label) entry.label = d.label;
      cleaned[date] = entry;
    });
    const cal = { meta: { ...draft.meta }, days: cleaned };
    if (!CalendarParser.validateCalendar(cal)) {
      setStatus('error', ['カレンダーの内容が正しくありません。']);
      return;
    }
    try {
      localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(cal));
    } catch (error) {
      setStatus('error', ['このブラウザーに保存できませんでした（容量不足またはプライベートモードの可能性があります）。']);
      return;
    }
    applyCalendar(cal);
    dateInput.value = defaultDateValue();
    updateSourceChip();
    closeReview();
    setStatus('ok', [`${CALENDAR_YEAR}年度の行事予定に切り替えました。`]);
    checkLecture();
  }

  function handleExport() {
    const cal = getActiveCalendar();
    if (!cal) return;
    const blob = new Blob([JSON.stringify(cal, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lecture-calendar-${(cal.meta && cal.meta.academicYear) || 'data'}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleReset() {
    if (!window.confirm('取り込んだ行事予定を削除しますか？（登録した時間割は消えません）')) return;
    try { localStorage.removeItem(CALENDAR_STORAGE_KEY); } catch (error) { /* 無視 */ }
    clearCalendar();
    dateInput.value = defaultDateValue();
    updateSourceChip();
    closeReview();
    setStatus('ok', ['取り込んだ行事予定を削除しました。']);
    checkLecture();
  }

  function handleAdd() {
    if (!draft) return;
    const date = addDateInput.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (!draft.days[date]) draft.days[date] = { type: 'event', label: '' };
    monthFilter.value = '';
    renderSummary();
    renderMonthOptions();
    renderTable();
  }

  parseButton.addEventListener('click', handleParse);
  exportButton.addEventListener('click', handleExport);
  resetButton.addEventListener('click', handleReset);
  applyButton.addEventListener('click', handleApply);
  cancelButton.addEventListener('click', () => { closeReview(); setStatus('info', ['取り込みをキャンセルしました。']); });
  monthFilter.addEventListener('change', renderTable);
  showAll.addEventListener('change', () => { renderMonthOptions(); renderTable(); });
  addButton.addEventListener('click', handleAdd);

  updateSourceChip();
  const versionEl = $('calendar-version');
  //if (versionEl) versionEl.textContent = `取り込み機能の版：${IMPORT_VERSION}`;
})();
