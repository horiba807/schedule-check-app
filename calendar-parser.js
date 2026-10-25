/**
 * 年間行事予定（週ごとのカレンダー表）→ JSON 変換
 *
 * 入力: テキスト項目の配列 [{ str, x, y, w }]
 *   x: 左端の座標 / y: 上から下へ増える座標 / w: 文字列の幅
 *   （pdf.js・OCR のどちらの結果でも、この形に揃えれば同じ処理で解析できます）
 *
 * 出力: { meta, days, warnings, yearCandidates }
 */
(function (root) {
  const WEEKDAY_CHARS = ['月', '火', '水', '木', '金', '土', '日']; // 列の並び（月曜始まり）
  const BASE_PITCH = 103.6; // 基準にしたPDF（A3相当）での1列の幅
  const JS_DAY_OF_COLUMN = [1, 2, 3, 4, 5, 6, 0]; // 列番号 → Date#getDay()
  const CIRCLED_START = 0x2460; // ①
  const CIRCLED_END = 0x2473; // ⑳

  function circledToNumber(ch) {
    const code = ch.codePointAt(0);
    return code >= CIRCLED_START && code <= CIRCLED_END ? code - CIRCLED_START + 1 : null;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function dayOfWeek(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  }

  function isValidDate(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day, 12));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** 先頭の丸数字（授業回数）とラベルに分ける。 "①履修申告終了" → {session:1, label:"履修申告終了"} */
  function splitSession(text) {
    const first = text.charAt(0);
    const n = first ? circledToNumber(first) : null;
    if (n === null) return { session: null, label: text };
    return { session: n, label: text.slice(1).trim() };
  }

  function guessAcademicYear(items) {
    for (const item of items) {
      const m = item.str.match(/(\d{4})年度/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function parseCalendarItems(rawItems, options = {}) {
    const warnings = [];
    const items = rawItems
      .map(i => ({ str: String(i.str).trim(), x: i.x, y: i.y, w: i.w || 0 }))
      .filter(i => i.str.length > 0);

    // 1. 列の幅（pitch）と表の上端（headerY）を求める
    //    曜日ヘッダー（月〜日）が読めればそこから、読めなければ日付数字の並びから推定する（OCR画像向け）
    const rawNumbers = items.filter(i => /^\d{1,2}$/.test(i.str));
    if (rawNumbers.length < 28) {
      throw new Error('日付の数字がほとんど見つかりません。行事予定の表ではない可能性があります。');
    }
    const headers = WEEKDAY_CHARS.map(ch => items.filter(i => i.str === ch));
    const hasHeader = headers.every(h => h.length > 0);
    let pitch = null;
    let headerY = null;
    if (hasHeader) {
      // 同じ曜日が複数見つかる場合は最も上にあるものをヘッダーとする
      const headerItems = headers.map(h => h.reduce((a, b) => (a.y <= b.y ? a : b)));
      pitch = (headerItems[6].x - headerItems[0].x) / 6;
      headerY = median(headerItems.map(h => h.y));
    }

    // 数字をx位置でまとまりに分け、数の少ないまとまり（月名「10月」の数字の切れ端など）を除く
    const sortedByX = [...rawNumbers].sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));
    const spread = (sortedByX[sortedByX.length - 1].x + sortedByX[sortedByX.length - 1].w / 2) - (sortedByX[0].x + sortedByX[0].w / 2);
    const splitGap = pitch ? pitch * 0.12 : spread * 0.03;
    const clusters = [];
    sortedByX.forEach(t => {
      const c = t.x + t.w / 2;
      const last = clusters[clusters.length - 1];
      if (last && c - last.max <= splitGap) {
        last.tokens.push(t);
        last.max = c;
      } else {
        clusters.push({ tokens: [t], max: c });
      }
    });
    const medianSize = median(clusters.map(c => c.tokens.length));
    let kept = clusters.filter(c => c.tokens.length >= medianSize * 0.6);
    if (kept.length > 7) kept = [...kept].sort((a, b) => b.tokens.length - a.tokens.length).slice(0, 7);
    kept.sort((a, b) => a.max - b.max);
    const allNumbers = kept.flatMap(c => c.tokens);

    if (!hasHeader) {
      if (kept.length !== 7) {
        throw new Error(`曜日の列を特定できませんでした（${kept.length}列を検出）。画像を大きく、傾きなく撮り直してください。`);
      }
      const means = kept.map(c => c.tokens.reduce((x, t) => x + t.x + t.w / 2, 0) / c.tokens.length);
      pitch = (means[6] - means[0]) / 6;
      headerY = Math.min(...allNumbers.map(t => t.y)) - pitch * 0.2;
      warnings.push('曜日の見出しを読み取れなかったため、日付の並びから列を推定しました。曜日の照合結果をご確認ください。');
    }
    // 数字が7列にきれいに分かれたときは、見出しよりも数字の実際の位置を信頼して列幅を決める
    const colMeans = kept.map(c => median(c.tokens.map(t => t.x + t.w / 2)));
    if (kept.length === 7) pitch = (colMeans[6] - colMeans[0]) / 6;
    const c0 = colMeans[0]; // 月曜の列の数字の中心
    const s = pitch / BASE_PITCH; // 画像・PDFの大きさに合わせて許容量を拡縮する

    // 2. 日付の数字を抽出（見出しより下にある 1〜2桁の数字）
    const dayTokens = allNumbers.filter(i => i.y > headerY + 3 * s);
    if (dayTokens.length < 300) {
      warnings.push(`日付の数字が ${dayTokens.length} 個しか見つかりませんでした（通常は365前後）。読み取りが不完全な可能性があります。`);
    }

    // 3. 列の左端を推定（最も左にある日付数字から少し余白を引く）
    const left0 = c0 - 10 * s; // 月曜の列の左端（ラベルの列判定用）
    const colOf = x => Math.floor((x - left0) / pitch);
    const gridRight = left0 + pitch * 7;

    // 4. 行（週）に分ける
    const sortedByY = [...dayTokens].sort((a, b) => a.y - b.y);
    const rows = [];
    for (const t of sortedByY) {
      const last = rows[rows.length - 1];
      if (last && t.y - last.anchor <= 6 * s) {
        last.tokens.push(t);
      } else {
        rows.push({ anchor: t.y, tokens: [t] });
      }
    }
    rows.forEach(r => {
      r.y = median(r.tokens.map(t => t.y));
    });

    // 5. 日付を月・日・列に割り当て（数字が減ったら翌月）
    const cells = [];
    let month = options.startMonth || 4;
    let prevDay = 0;
    rows.forEach((row, rowIndex) => {
      row.tokens.sort((a, b) => a.x - b.x);
      for (const t of row.tokens) {
        // 数字は1桁・2桁で左端がずれるので、中心に最も近い列に割り当てる
        const col = Math.round(((t.x + t.w / 2) - c0) / pitch);
        if (col < 0 || col > 6) continue;
        const day = Number(t.str);
        if (day < prevDay) month = month === 12 ? 1 : month + 1;
        prevDay = day;
        cells.push({ day, month, col, rowIndex, y: row.y, labelItems: [] });
      }
    });

    // 6. 年度の決定と検証（4/1 の曜日が列と一致するか）
    const first = cells[0];
    const requestedYear = options.academicYear || guessAcademicYear(items);
    const yearCandidates = [];
    for (let y = 2000; y <= 2100; y += 1) {
      if (dayOfWeek(y, 4, 1) === JS_DAY_OF_COLUMN[first.col] && first.month === 4 && first.day === 1) {
        yearCandidates.push(y);
      }
    }
    let academicYear = options.academicYear || null;
    if (!academicYear && requestedYear && yearCandidates.includes(requestedYear)) {
      academicYear = requestedYear;
    }
    if (!academicYear) {
      return {
        meta: { academicYear: null },
        days: {},
        warnings: [
          requestedYear
            ? `PDFに書かれた年度（${requestedYear}年度）の4月1日の曜日と、表の配置が一致しません。`
            : '年度を特定できませんでした。',
          '年度を指定して、もう一度解析してください。'
        ],
        yearCandidates: yearCandidates.filter(y => y >= 2015 && y <= 2045),
        needsYear: true
      };
    }

    const yearOf = m => (m >= 4 ? academicYear : academicYear + 1);
    let weekdayMismatch = 0;
    const validCells = [];
    for (const c of cells) {
      const y = yearOf(c.month);
      if (!isValidDate(y, c.month, c.day)) {
        warnings.push(`存在しない日付を読み取りました：${c.month}/${c.day}`);
        continue;
      }
      if (dayOfWeek(y, c.month, c.day) !== JS_DAY_OF_COLUMN[c.col]) {
        weekdayMismatch += 1;
        if (weekdayMismatch <= 5) {
          warnings.push(`${y}-${pad(c.month)}-${pad(c.day)} の曜日が表の列と一致しません。`);
        }
      }
      c.date = `${y}-${pad(c.month)}-${pad(c.day)}`;
      validCells.push(c);
    }
    if (weekdayMismatch > cells.length * 0.1) {
      // 大半の曜日が合わない＝年度の指定違い（または表の読み取り失敗）
      return {
        meta: { academicYear: null },
        days: {},
        warnings: [
          `指定された ${academicYear} 年度のカレンダーと、PDFの曜日の並びが一致しません（${weekdayMismatch} / ${cells.length} 件が不一致）。`,
          '年度を確認するか、空欄にして自動判定してください。'
        ],
        yearCandidates: yearCandidates.filter(y => y >= 2015 && y <= 2045),
        needsYear: true
      };
    }
    if (weekdayMismatch > 0) {
      warnings.push(`曜日が一致しない日付が計 ${weekdayMismatch} 件あります。該当箇所を確認してください。`);
    }

    // 7. 日付以外の文字列（行事名・丸数字）を最も近いセルに割り当てる
    const dayTokenSet = new Set(dayTokens);
    const skipTexts = new Set(WEEKDAY_CHARS);
    for (const item of items) {
      if (dayTokenSet.has(item) || skipTexts.has(item.str)) continue;
      if (/^\d{1,2}月$/.test(item.str)) continue;
      const col = colOf(item.x);
      if (col < 0 || col > 6 || item.x > gridRight) continue;
      if (item.y <= headerY + 3 * s) continue;
      let best = null;
      let bestDist = Infinity;
      for (const c of validCells) {
        if (c.col !== col) continue;
        const dist = Math.abs(c.y - item.y);
        if (dist < bestDist) {
          best = c;
          bestDist = dist;
        }
      }
      // 近くにセルがない（注釈・脚注など）ものは捨てる
      if (best && bestDist <= 14 * s) best.labelItems.push(item);
    }

    // 8. セルごとに種類を判定してJSON化
    const days = {};
    for (const c of validCells) {
      if (c.labelItems.length === 0) continue;
      c.labelItems.sort((a, b) => a.y - b.y || a.x - b.x);
      const cellRight = left0 + pitch * (c.col + 1);
      let text = '';
      c.labelItems.forEach((it, idx) => {
        if (idx > 0) {
          const prev = c.labelItems[idx - 1];
          // 前の行が右端近くまで届いていれば折り返しとみなして連結、そうでなければ区切る
          const wrapped = prev.x + prev.w >= cellRight - 14 * s;
          text += wrapped ? '' : '・';
        }
        text += it.str;
      });
      // 先頭の丸数字だけを授業回数として扱う（"①履修申告終了" など）
      const { session, label } = splitSession(text.replace(/^・/, ''));
      const entry = {};
      if (label === '期末試験') {
        entry.type = 'exam';
      } else if (session !== null) {
        entry.type = 'lecture';
        entry.session = session;
        if (label) entry.label = label;
      } else {
        entry.type = 'event';
        entry.label = label;
      }
      days[c.date] = entry;
    }

    const startDate = `${academicYear}-04-01`;
    const endDate = `${academicYear + 1}-03-31`;
    const lectureCount = Object.values(days).filter(d => d.type === 'lecture').length;
    if (lectureCount === 0) {
      warnings.push('授業回数（①〜⑮）が1件も見つかりませんでした。');
    }

    return {
      meta: {
        academicYear,
        startDate,
        endDate,
        title: (items.find(i => /行事予定/.test(i.str)) || {}).str || '',
        parsedAt: new Date().toISOString()
      },
      days,
      warnings,
      yearCandidates
    };
  }


  /** 文字ごと・短い断片ごとにばらけた項目を、同じ行で近いもの同士ひとつにまとめる（PDF・OCR共通）。数字だけの項目は混ぜない */
  function mergeAdjacentWords(words) {
    const isNumber = w => /^\d{1,2}$/.test(w.str);
    const sorted = words.map(w => ({ ...w, h: w.h || 10 })).sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];
    for (const w of sorted) {
      const prev = merged[merged.length - 1];
      const canMerge = prev && !isNumber(prev) && !isNumber(w)
        && Math.abs(w.y - prev.y) <= prev.h * 0.5
        && w.x - (prev.x + prev.w) <= prev.h * 0.8
        && w.x >= prev.x;
      if (canMerge) {
        prev.str += w.str;
        prev.w = w.x + w.w - prev.x;
      } else {
        merged.push({ ...w });
      }
    }
    return merged;
  }

  /** 「10オリエンテーション」「7④」のように数字と文字が続いている項目を分ける */
  function splitDigitsFromLabel(words, normalize) {
    const out = [];
    for (const w of words) {
      const m = w.str.match(/^(\d{1,2})(\D.*)$/);
      if (m) {
        const ratio = m[1].length / w.str.length;
        out.push({ str: m[1], x: w.x, y: w.y, w: w.w * ratio, h: w.h });
        out.push({ str: normalize ? normalize(m[2]) : m[2], x: w.x + w.w * ratio, y: w.y, w: w.w * (1 - ratio), h: w.h });
      } else {
        out.push({ ...w, str: normalize && !/^\d{1,2}$/.test(w.str) ? normalize(w.str) : w.str });
      }
    }
    return out;
  }

  /** OCRが読み違えやすい丸数字（①など）を、先頭に限って補正する */
  function normalizeOcrSession(str) {
    const m = str.match(/^[(（\[［]?\s*(\d{1,2})\s*[)）\]］]/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1) + str.slice(m[0].length);
    }
    return str;
  }

  /** 保存用JSONの最低限の検証 */
  function validateCalendar(cal) {
    if (!cal || typeof cal !== 'object' || typeof cal.days !== 'object' || cal.days === null) return false;
    return Object.entries(cal.days).every(([date, d]) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) && d && ['lecture', 'exam', 'event'].includes(d.type)
    );
  }

  const api = { parseCalendarItems, validateCalendar, mergeAdjacentWords, splitDigitsFromLabel, normalizeOcrSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CalendarParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
