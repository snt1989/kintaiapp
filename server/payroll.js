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
  const minutes = {
    total_minutes: Math.round(total),
    overtime_minutes: Math.round(overtime),
    night_minutes: Math.round(night),
    holiday_minutes: Math.round(holiday),
  };
  const pay = payFromMinutes(minutes, hourlyWage, rates);
  return {
    work_days: days.filter((d) => d.total > 0).length,
    ...minutes,
    incomplete,
    ...pay,
    total_pay: pay.base_pay + pay.overtime_pay + pay.night_pay + pay.holiday_pay,
  };
}

// 勤務時間(分)と時給・割増率から、各支給額(円・切り捨て)を求める
function payFromMinutes(m, hourlyWage, rates = DEFAULT_RATES) {
  const r = { ...DEFAULT_RATES, ...rates };
  const wage = Number(hourlyWage) > 0 ? Number(hourlyWage) : 0;
  const round = (n) => Math.floor(n + 1e-9);
  return {
    base_pay: round(wage * (m.total_minutes / 60)),
    overtime_pay: round(wage * (m.overtime_minutes / 60) * (r.overtime / 100)),
    night_pay: round(wage * (m.night_minutes / 60) * (r.night / 100)),
    holiday_pay: round(wage * (m.holiday_minutes / 60) * (r.holiday / 100)),
  };
}

// 手当(管理者が入力する支給項目)
const ALLOWANCE_ITEMS = [
  { key: 'commute_allowance', label: '通勤手当' },
  { key: 'other_allowance', label: 'その他手当' },
];
// 修正できる勤怠・支給の項目(空欄は自動計算の値を使う)
const ATTENDANCE_KEYS = ['work_days', 'total_minutes', 'overtime_minutes', 'night_minutes', 'holiday_minutes'];
const PAY_KEYS = ['base_pay', 'overtime_pay', 'night_pay', 'holiday_pay'];

// 自動計算の結果に、管理者の修正(adjustments)を反映した最終値を返す
//   adjustments = { overrides: { 項目: 数値 }, allowances: { 項目: 数値 } }
// 勤務時間を修正した場合は、修正後の時間で支給額を再計算する。支給額そのものを修正した場合はその金額を優先する。
function finalizeEmployee(calc, adjustments, hourlyWage, rates = DEFAULT_RATES) {
  const overrides = (adjustments && adjustments.overrides) || {};
  const allowances = { commute_allowance: 0, other_allowance: 0, ...((adjustments && adjustments.allowances) || {}) };
  const has = (k) => overrides[k] !== undefined && overrides[k] !== null;
  const eff = { ...calc };
  for (const k of ATTENDANCE_KEYS) if (has(k)) eff[k] = Number(overrides[k]);
  if (['total_minutes', 'overtime_minutes', 'night_minutes', 'holiday_minutes'].some(has)) {
    Object.assign(eff, payFromMinutes(eff, hourlyWage, rates));
  }
  for (const k of PAY_KEYS) if (has(k)) eff[k] = Number(overrides[k]);
  const allowancesTotal = ALLOWANCE_ITEMS.reduce((sum, i) => sum + (Number(allowances[i.key]) || 0), 0);
  eff.allowances = allowances;
  eff.allowances_total = allowancesTotal;
  eff.total_pay = eff.base_pay + eff.overtime_pay + eff.night_pay + eff.holiday_pay + allowancesTotal;
  eff.adjusted_keys = [...ATTENDANCE_KEYS, ...PAY_KEYS].filter(has);
  return eff;
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

// ---- 所得税(源泉徴収) ----
// 国税庁「給与所得の源泉徴収税額表(月額表)」甲欄の「電算機計算の特例」の算式を使う。
//   1. 課税対象の支給額 − 社会保険料 = A(社会保険料等控除後の給与等の金額)
//   2. 課税給与所得金額 B = A − 給与所得控除 − 基礎控除 − 31,667円 × 扶養親族等の数(控除対象配偶者を含む)
//   3. B に税率と控除額(復興特別所得税を含む)を適用し、10円未満を四捨五入する
// 令和8年分(2026年)の表を使う。令和9年分以降は給与所得控除・基礎控除の最低額が変わる。
// 乙欄(扶養控除等申告書を出していない従たる給与など)は自動計算の対象外とし、手入力にする。
const TAX_TABLES = {
  2026: { minSalaryDeduction: 54167, saMax: 158333, basicMax: 48334 },
  2027: { minSalaryDeduction: 57500, saMax: 169444, basicMax: 51667 },
};
const DEPENDENT_DEDUCTION = 31667;
const COMMUTE_TAX_FREE_LIMIT = 150000; // 通勤手当の非課税限度額(月額)
const MAX_DEPENDENTS = 20;
// [Bの上限, 税率(10万分の何か), 控除額]
const TAX_BRACKETS = [
  [162500, 5105, 0],
  [275000, 10210, 8296],
  [579166, 20420, 36374],
  [750000, 23483, 54113],
  [1500000, 33693, 130688],
  [3333333, 40840, 237893],
  [Infinity, 45945, 408061],
];

function taxTableFor(month) {
  const year = Number(String(month || '').slice(0, 4));
  return year >= 2027 ? { year: 2027, ...TAX_TABLES[2027] } : { year: 2026, ...TAX_TABLES[2026] };
}

// 甲欄の源泉所得税額(円)。a は社会保険料等控除後の給与等の金額
function incomeTaxKou(a, dependents, month) {
  const amount = Math.floor(Number(a) || 0);
  if (amount <= 0) return 0;
  const t = taxTableFor(month);
  let salaryDeduction;
  if (amount <= t.saMax) salaryDeduction = t.minSalaryDeduction;
  else if (amount < 300000) salaryDeduction = Math.ceil((amount * 30) / 100) + 6667;
  else if (amount < 550000) salaryDeduction = Math.ceil((amount * 20) / 100) + 36667;
  else if (amount < 708331) salaryDeduction = Math.ceil((amount * 10) / 100) + 91667;
  else salaryDeduction = 162500;
  let basic;
  if (amount <= 2120833) basic = t.basicMax;
  else if (amount <= 2162499) basic = 40000;
  else if (amount <= 2204166) basic = 26667;
  else if (amount <= 2245833) basic = 13334;
  else basic = 0;
  const n = Math.min(MAX_DEPENDENTS, Math.max(0, Math.floor(Number(dependents) || 0)));
  const b = amount - salaryDeduction - basic - DEPENDENT_DEDUCTION * n;
  if (b <= 0) return 0;
  const [, rate, minus] = TAX_BRACKETS.find(([limit]) => b <= limit);
  const tax = Math.floor((b * rate) / 100000) - minus;
  return Math.max(0, Math.round(tax / 10) * 10);
}

// 所得税の課税対象となる、社会保険料控除後の金額(通勤手当は非課税限度額まで除く)
function taxableBase(summary, deductions) {
  const commute = Math.min(Number(summary && summary.allowances && summary.allowances.commute_allowance) || 0, COMMUTE_TAX_FREE_LIMIT);
  const gross = Math.max(0, (Number(summary && summary.total_pay) || 0) - commute);
  const social = ['health_insurance', 'pension', 'employment_insurance'].reduce((sum, k) => sum + (Number(deductions && deductions[k]) || 0), 0);
  return Math.max(0, gross - social);
}

// 控除の金額に所得税の自動計算を反映する。
//   manualTax が true、または税区分が乙欄のときは、入力済みの所得税をそのまま使う
//   戻り値: { deductions, income_tax_auto(自動計算した場合 true), income_tax_base(計算の基準額) }
function applyIncomeTax(deductions, summary, emp, month, manualTax) {
  const base = { ...emptyDeductions(), ...(deductions || {}) };
  const useAuto = !manualTax && (!emp || emp.tax_table !== 'otsu');
  if (!useAuto) return { deductions: base, income_tax_auto: false, income_tax_base: null };
  const a = taxableBase(summary, base);
  return {
    deductions: { ...base, income_tax: incomeTaxKou(a, emp && emp.dependents, month) },
    income_tax_auto: true,
    income_tax_base: a,
  };
}

module.exports = { incomeTaxKou, taxableBase, applyIncomeTax, taxTableFor, MAX_DEPENDENTS, ALLOWANCE_ITEMS, ATTENDANCE_KEYS, PAY_KEYS, payFromMinutes, finalizeEmployee, DEDUCTION_ITEMS, emptyDeductions, sumDeductions, calculateEmployee, summarizeDays, dailyBreakdown, monthRangeIso, DEFAULT_RATES };
