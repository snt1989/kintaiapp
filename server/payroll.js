// 給与計算ロジック(DBに依存しない純粋関数。サーバーとデモ版の両方で同じコードを使う)
//
// 計算ルール(初期値。割増率は管理画面から変更できる):
//   基本給   = 時給 × 勤務時間(休憩を除く)
//   時間外   = 1日8時間を超えた分に +25%(日曜の勤務は休日扱いとし、時間外には含めない)
//   深夜     = 22:00〜翌5:00の勤務に +25%(時間外・休日と重なる場合は加算)
//   休日     = 日曜の勤務に +35%
// 日付はすべて日本時間(JST)で区切る。出勤のみで退勤がない勤務は集計せず「退勤漏れ」として数える。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DAILY_LEGAL_MINUTES = 8 * 60;

const DEFAULT_RATES = { overtime: 25, night: 25, holiday: 35 }; // 割増率(%)

function jstDayStart(ms) {
  return Math.floor((ms + JST_OFFSET_MS) / DAY) * DAY - JST_OFFSET_MS;
}

function jstDateKey(dayStartMs) {
  return new Date(dayStartMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// 区間 a から、区間リスト subs に重なる部分を取り除く
function subtractIntervals(a, subs) {
  let pieces = [a];
  for (const s of subs) {
    const next = [];
    for (const p of pieces) {
      if (s.end <= p.start || s.start >= p.end) { next.push(p); continue; }
      if (s.start > p.start) next.push({ start: p.start, end: s.start });
      if (s.end < p.end) next.push({ start: s.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

function overlapMs(s1, e1, s2, e2) {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
}

// 1人分の打刻ログ(type, timestamp)から、日別の勤務時間を求める
function summarizeDays(logs) {
  const sorted = logs.slice().sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp));
  const work = [];
  const breaks = [];
  let workStart = null;
  let breakStart = null;
  for (const l of sorted) {
    const t = new Date(l.timestamp).getTime();
    if (l.type === 'clock_in') { workStart = t; }
    else if (l.type === 'clock_out') { if (workStart !== null && t > workStart) work.push({ start: workStart, end: t }); workStart = null; }
    else if (l.type === 'break_start') { breakStart = t; }
    else if (l.type === 'break_end') { if (breakStart !== null && t > breakStart) breaks.push({ start: breakStart, end: t }); breakStart = null; }
  }
  // 退勤が打刻されていない出勤(あれば、その出勤日のJST日付キー)
  const incompleteDate = workStart !== null ? jstDateKey(jstDayStart(workStart)) : null;

  const days = new Map(); // dateKey -> { total, night, sunday }
  const dayOf = (key, dayStart) => days.get(key) || { date: key, total: 0, night: 0, gross: 0, first: null, last: null, sunday: new Date(dayStart + JST_OFFSET_MS).getUTCDay() === 0 };
  for (const w of work) {
    // 日ごとの出勤・退勤の時刻と、休憩を含む拘束時間(休憩時間の算出用)
    for (let c = w.start; c < w.end;) {
      const ds = jstDayStart(c); const ce = Math.min(w.end, ds + DAY); const k = jstDateKey(ds);
      const dd = dayOf(k, ds);
      dd.gross += (ce - c) / MIN;
      if (dd.first === null || c < dd.first) dd.first = c;
      if (dd.last === null || ce > dd.last) dd.last = ce;
      days.set(k, dd);
      c = ce;
    }
    for (const piece of subtractIntervals(w, breaks)) {
      let cursor = piece.start;
      while (cursor < piece.end) {
        const dayStart = jstDayStart(cursor);
        const dayEnd = dayStart + DAY;
        const segEnd = Math.min(piece.end, dayEnd);
        const key = jstDateKey(dayStart);
        const d = dayOf(key, dayStart);
        d.total += (segEnd - cursor) / MIN;
        // 深夜: 0:00-5:00 と 22:00-24:00
        d.night += (overlapMs(cursor, segEnd, dayStart, dayStart + 5 * 60 * MIN) + overlapMs(cursor, segEnd, dayStart + 22 * 60 * MIN, dayEnd)) / MIN;
        days.set(key, d);
        cursor = segEnd;
      }
    }
  }
  return { days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), incompleteDate };
}

// 1人分の月間集計と支給額
// monthPrefix(例: "2026-09")を渡すと、その月の日付の勤務だけを集計する(月をまたぐ勤務の前後の日を除外するため)
function calculateEmployee(logs, hourlyWage, rates = DEFAULT_RATES, monthPrefix = null) {
  const summary = summarizeDays(logs);
  const incomplete = summary.incompleteDate && (!monthPrefix || summary.incompleteDate.startsWith(monthPrefix)) ? 1 : 0;
  const days = monthPrefix ? summary.days.filter((d) => d.date.startsWith(monthPrefix)) : summary.days;
  let total = 0, overtime = 0, night = 0, holiday = 0;
  for (const d of days) {
    total += d.total;
    night += d.night;
    if (d.sunday) holiday += d.total;
    else overtime += Math.max(0, d.total - DAILY_LEGAL_MINUTES);
  }
  const r = { ...DEFAULT_RATES, ...rates };
  const wage = Number(hourlyWage) > 0 ? Number(hourlyWage) : 0;
  const basePay = wage * (total / 60);
  const overtimePay = wage * (overtime / 60) * (r.overtime / 100);
  const nightPay = wage * (night / 60) * (r.night / 100);
  const holidayPay = wage * (holiday / 60) * (r.holiday / 100);
  const round = (n) => Math.floor(n + 1e-9);
  return {
    work_days: days.filter((d) => d.total > 0).length,
    total_minutes: Math.round(total),
    overtime_minutes: Math.round(overtime),
    night_minutes: Math.round(night),
    holiday_minutes: Math.round(holiday),
    incomplete,
    base_pay: round(basePay),
    overtime_pay: round(overtimePay),
    night_pay: round(nightPay),
    holiday_pay: round(holidayPay),
    total_pay: round(basePay + overtimePay + nightPay + holidayPay),
  };
}

// 対象月("YYYY-MM")の開始・終了(UTCのISO文字列)
function monthRangeIso(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  const start = new Date(`${m[1]}-${m[2]}-01T00:00:00+09:00`);
  const ny = mo === 12 ? y + 1 : y; const nm = mo === 12 ? 1 : mo + 1;
  const end = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+09:00`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// 給与明細書用の日別内訳(対象月の勤務日のみ)
function dailyBreakdown(logs, monthPrefix = null) {
  const { days } = summarizeDays(logs);
  const hhmm = (ms) => new Date(ms + JST_OFFSET_MS).toISOString().slice(11, 16);
  return days
    .filter((d) => d.total > 0 && (!monthPrefix || d.date.startsWith(monthPrefix)))
    .map((d) => ({
      date: d.date,
      weekday: ['日', '月', '火', '水', '木', '金', '土'][new Date(`${d.date}T00:00:00Z`).getUTCDay()],
      clock_in: d.first === null ? '' : hhmm(d.first),
      clock_out: d.last === null ? '' : hhmm(d.last),
      break_minutes: Math.max(0, Math.round(d.gross - d.total)),
      worked_minutes: Math.round(d.total),
      overtime_minutes: d.sunday ? 0 : Math.round(Math.max(0, d.total - DAILY_LEGAL_MINUTES)),
      night_minutes: Math.round(d.night),
      holiday_minutes: d.sunday ? Math.round(d.total) : 0,
    }));
}

// 控除の項目(金額は管理者が社員・月ごとに入力する)
const DEDUCTION_ITEMS = [
  { key: 'health_insurance', label: '健康保険料' },
  { key: 'pension', label: '厚生年金保険料' },
  { key: 'employment_insurance', label: '雇用保険料' },
  { key: 'income_tax', label: '所得税' },
  { key: 'resident_tax', label: '住民税' },
  { key: 'other', label: 'その他控除' },
];

function emptyDeductions() {
  return Object.fromEntries(DEDUCTION_ITEMS.map((i) => [i.key, 0]));
}

function sumDeductions(d) {
  return DEDUCTION_ITEMS.reduce((sum, i) => sum + (Number(d && d[i.key]) || 0), 0);
}

module.exports = { DEDUCTION_ITEMS, emptyDeductions, sumDeductions, calculateEmployee, summarizeDays, dailyBreakdown, monthRangeIso, DEFAULT_RATES };
