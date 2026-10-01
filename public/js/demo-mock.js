// デモ版: サーバーなしで画面を触れるようにするためのモック
//
// fetch('/api/...') を差し替え、ブラウザ内(localStorage)の状態でバックエンドの動作を再現する。
//   - 有効化: 画面のURLに ?demo=1 を付けて開く(例: /index.html?demo=1)。以後はフラグが残る。
//   - 無効化: ?demo=0 を付けて開く、または画面下部の「デモを終了」を押す。
//   - データの保存先: localStorage のキー kintai_demo_state_v5(画面下部の「データを初期化」で作り直せる)
//   - ログイン: 管理者 0001 / 一般社員 0002 など、パスワードはすべて demo
// 給与計算は server/payroll.js のコピーを使う。server/payroll.js を変えたら
//   node server/scripts/syncDemoPayroll.js
// で下の <payroll:begin> 〜 <payroll:end> を同期すること。
(function () {
  'use strict';

  var FLAG_KEY = 'kintai_demo_mode';
  var STATE_KEY = 'kintai_demo_state_v5';
  var TOKEN_KEY = 'sanoh_attendance_token';
  var EMPLOYEE_KEY = 'sanoh_attendance_employee';
  var DEMO_PASSWORD = 'demo';

  try {
    var qs = new URLSearchParams(location.search).get('demo');
    if (qs === '1') localStorage.setItem(FLAG_KEY, '1');
    if (qs === '0') localStorage.removeItem(FLAG_KEY);
    if (localStorage.getItem(FLAG_KEY) !== '1') return;
  } catch (e) {
    return;
  }

  // <payroll:begin> (自動生成: node server/scripts/syncDemoPayroll.js / server/payroll.js のコピー。直接編集しない)
function loadPayroll() {
  const module = { exports: {} };
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

  module.exports = { ALLOWANCE_ITEMS, ATTENDANCE_KEYS, PAY_KEYS, payFromMinutes, finalizeEmployee, DEDUCTION_ITEMS, emptyDeductions, sumDeductions, calculateEmployee, summarizeDays, dailyBreakdown, monthRangeIso, DEFAULT_RATES };
  return module.exports;
}
// <payroll:end>

  var payroll = loadPayroll();
  var realFetch = window.fetch.bind(window);

  // ---- 共通ユーティリティ ----

  var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var TYPE_LABELS = { clock_in: '出勤', clock_out: '退勤', break_start: '休憩開始', break_end: '休憩終了' };
  var VALID_TYPES = Object.keys(TYPE_LABELS);
  var INPUT_METHOD_LABELS = { clock: '打刻入力', manual: '直接入力' };
  var ROLE_MASTER = [
    { value: 'employee', label: '一般社員' },
    { value: 'contractor', label: '委託職員' },
    { value: 'partner', label: '協力会社' },
    { value: 'admin', label: '管理者' },
  ];
  var ROLE_VALUES = ROLE_MASTER.map(function (r) { return r.value; });
  var STATUS_MASTER = [{ value: 1, label: '有効' }, { value: 0, label: '無効' }];
  var NEXT_CODE_KEY = 'next_employee_code';
  var DB_LIMIT_KEY = 'db_storage_limit_mb';
  var RATE_KEYS = { overtime: 'payroll_rate_overtime', night: 'payroll_rate_night', holiday: 'payroll_rate_holiday' };

  function jstDateStr(d) { return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10); }
  function jstTodayRange() {
    var todayStr = jstDateStr(new Date());
    var start = new Date(todayStr + 'T00:00:00+09:00');
    return { startIso: start.toISOString(), endIso: new Date(start.getTime() + DAY_MS).toISOString(), todayStr: todayStr };
  }
  function dateAdd(dateStr, n) { return new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * DAY_MS).toISOString().slice(0, 10); }
  function jstIso(dateStr, hhmm) { return new Date(dateStr + 'T' + hhmm + ':00+09:00').toISOString(); }
  function combineName(last, first) {
    return [last, first].map(function (v) { return v ? String(v).trim() : ''; }).filter(Boolean).join(' ');
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function trimmed(v) { return v && String(v).trim() ? String(v).trim() : null; }

  // ---- 状態(localStorage)と初期データ ----

  var state = null;

  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* 容量超過などは無視 */ }
  }

  function addDivision(s, name) {
    var d = { id: s.seq.division++, name: name, sort_order: s.divisions.length + 1, created_at: new Date().toISOString() };
    s.divisions.push(d);
    return d;
  }

  function addEmployee(s, o) {
    var e = {
      id: s.seq.employee++,
      employee_code: o.code,
      name: combineName(o.last, o.first),
      last_name: o.last,
      first_name: o.first,
      password: o.password || DEMO_PASSWORD,
      role: o.role || 'employee',
      active: o.active === 0 ? 0 : 1,
      division: o.division || null,
      hourly_wage: o.wage === undefined ? null : o.wage,
      created_at: new Date().toISOString(),
    };
    s.employees.push(e);
    return e;
  }

  function addLog(s, empId, type, ts, o) {
    var log = {
      id: s.seq.log++,
      employee_id: empId,
      type: type,
      timestamp: ts,
      note: o.note || null,
      remarks: o.remarks || null,
      site_division: o.division || null,
      input_method: o.method || 'clock',
      created_at: new Date().toISOString(),
    };
    s.logs.push(log);
    return log;
  }

  // 1日分(出勤・休憩・退勤)を登録する。outDate を渡すと日またぎの勤務になる
  function addDay(s, empId, date, spec) {
    var o = { note: spec.note, division: spec.division, method: spec.method, remarks: spec.remarks };
    addLog(s, empId, 'clock_in', jstIso(date, spec.in), o);
    if (spec.bs) {
      addLog(s, empId, 'break_start', jstIso(date, spec.bs), o);
      addLog(s, empId, 'break_end', jstIso(date, spec.be), o);
    }
    if (spec.out) addLog(s, empId, 'clock_out', jstIso(spec.outDate || date, spec.out), o);
  }

  function prevMonthOf(dateStr) {
    var y = Number(dateStr.slice(0, 4));
    var m = Number(dateStr.slice(5, 7)) - 1;
    if (m === 0) { y -= 1; m = 12; }
    return y + '-' + String(m).padStart(2, '0');
  }

  function seedState() {
    var s = {
      version: 5,
      seq: { division: 1, employee: 1, log: 1 },
      divisions: [], employees: [], logs: [], settings: {}, adjustments: {}, deductions: {},
    };
    ['建設事業部', '設備事業部', '製造事業部', '管理部'].forEach(function (n) { addDivision(s, n); });

    addEmployee(s, { code: '0001', last: '佐藤', first: '管理', role: 'admin', division: '管理部' });
    var tanaka = addEmployee(s, { code: '0002', last: '田中', first: '一郎', division: '建設事業部', wage: 1500 });
    var suzuki = addEmployee(s, { code: '0003', last: '鈴木', first: '花子', division: '設備事業部', wage: 1400 });
    var takahashi = addEmployee(s, { code: '0004', last: '高橋', first: '健太', role: 'contractor', division: '建設事業部', wage: 1800 });
    var ito = addEmployee(s, { code: '0005', last: '伊藤', first: '美咲', role: 'partner', division: '設備事業部', wage: 1300 });
    addEmployee(s, { code: '0006', last: '渡辺', first: '直樹', division: '製造事業部', wage: 1450, active: 0 });

    var rndSeed = 20261001;
    var rnd = function () { rndSeed = (rndSeed * 1103515245 + 12345) & 0x7fffffff; return rndSeed / 0x7fffffff; };
    var now = new Date();
    var today = jstDateStr(now);
    var lastItoDay = null;

    for (var i = 45; i >= 1; i -= 1) {
      var date = dateAdd(today, -i);
      var dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0=日
      var weekday = dow >= 1 && dow <= 5;

      // 田中: 建設現場の日勤。4日に1回は残業。日曜出勤が少しある
      if (weekday && i % 13 !== 0) {
        addDay(s, tanaka.id, date, {
          in: rnd() < 0.3 ? '07:50' : '08:00', bs: '12:00', be: '13:00',
          out: i % 4 === 0 ? '19:30' : '17:00', note: '東京第一現場', division: '建設事業部',
        });
      } else if (dow === 0 && i % 14 === 0) {
        addDay(s, tanaka.id, date, { in: '08:00', bs: '12:00', be: '12:45', out: '16:00', note: '東京第一現場', division: '建設事業部' });
      }

      // 鈴木: 設備の日勤。3日に1回は直接入力
      if (weekday && i % 9 !== 0) {
        addDay(s, suzuki.id, date, {
          in: '09:00', bs: '12:00', be: '13:00', out: '18:00', note: '横浜設備現場', division: '設備事業部',
          method: i % 3 === 0 ? 'manual' : 'clock', remarks: i % 11 === 0 ? '資材搬入あり' : null,
        });
      }

      // 高橋: 夜勤(22:00〜翌5:00)を週に3回ほど。日またぎは管理者が修正する運用
      if (weekday && i % 5 < 3) {
        var outDate = dateAdd(date, 1);
        if (new Date(outDate + 'T05:00:00+09:00').getTime() < now.getTime()) {
          addDay(s, takahashi.id, date, { in: '22:00', bs: '01:00', be: '01:30', out: '05:00', outDate: outDate, note: '川崎工場', division: '製造事業部' });
        }
      }

      // 伊藤: 月・水・金の短時間勤務
      if (dow === 1 || dow === 3 || dow === 5) {
        addDay(s, ito.id, date, { in: '10:00', bs: '12:00', be: '12:30', out: '15:00', note: '横浜設備現場', division: '設備事業部' });
        lastItoDay = date;
      }
    }

    // 伊藤の直近の勤務は退勤を打刻し忘れた状態にして、「退勤漏れ」の表示を確認できるようにする
    if (lastItoDay) {
      var dayStart = new Date(lastItoDay + 'T00:00:00+09:00').getTime();
      var dayEnd = dayStart + DAY_MS;
      s.logs = s.logs.filter(function (l) {
        var t = new Date(l.timestamp).getTime();
        return !(l.employee_id === ito.id && l.type === 'clock_out' && t >= dayStart && t < dayEnd);
      });
    }
    s.logs.sort(function (a, b) { return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id; });

    // 先月の田中さんに手当・控除のサンプルを入れておく(明細書の見た目を確認しやすくするため)
    var lastMonth = prevMonthOf(today);
    s.adjustments[tanaka.id + '|' + lastMonth] = { overrides: {}, allowances: { commute_allowance: 6000, other_allowance: 0 } };
    s.deductions[tanaka.id + '|' + lastMonth] = {
      health_insurance: 7500, pension: 13500, employment_insurance: 450, income_tax: 2100, resident_tax: 5000, other: 0,
    };
    return s;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 5 && Array.isArray(parsed.employees)) return parsed;
      }
    } catch (e) { /* 壊れていれば作り直す */ }
    var fresh = seedState();
    state = fresh;
    save();
    return fresh;
  }

  state = loadState();

  // ---- ルーティング ----

  var routes = [];
  function route(method, pattern, opts, handler) {
    var keys = [];
    var source = pattern.replace(/:([a-z]+)/g, function (_, k) { keys.push(k); return '([^/]+)'; });
    routes.push({ method: method, re: new RegExp('^' + source + '$'), keys: keys, opts: opts, handler: handler });
  }
  var PUBLIC = { auth: false, admin: false };
  var USER = { auth: true, admin: false };
  var ADMIN = { auth: true, admin: true };

  function ok(body) { return { status: 200, body: body }; }
  function fail(status, error, extra) { return { status: status, body: Object.assign({ error: error }, extra || {}) }; }

  function publicEmployee(e) {
    return {
      id: e.id, employee_code: e.employee_code, name: e.name, last_name: e.last_name, first_name: e.first_name,
      role: e.role, division: e.division || null,
    };
  }
  function listedEmployee(e) {
    return {
      id: e.id, employee_code: e.employee_code, name: e.name, last_name: e.last_name, first_name: e.first_name,
      role: e.role, active: e.active, division: e.division, created_at: e.created_at,
    };
  }
  function divisionWithCount(d) {
    var count = state.employees.filter(function (e) { return e.division === d.name; }).length;
    return { id: d.id, name: d.name, sort_order: d.sort_order, created_at: d.created_at, employee_count: count };
  }
  function sortedDivisions() {
    return state.divisions.slice().sort(function (a, b) { return a.sort_order - b.sort_order || (a.name < b.name ? -1 : 1); });
  }
  function findDivisionByName(name) {
    return state.divisions.find(function (d) { return d.name === name; }) || null;
  }
  function logsOf(empId) {
    return state.logs.filter(function (l) { return l.employee_id === empId; });
  }
  function byTimeAsc(a, b) { return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id; }
  function byTimeDesc(a, b) { return byTimeAsc(b, a); }

  function deriveStatus(lastType) {
    switch (lastType) {
      case 'clock_in': return { onDuty: true, onBreak: false };
      case 'break_start': return { onDuty: true, onBreak: true };
      case 'break_end': return { onDuty: true, onBreak: false };
      default: return { onDuty: false, onBreak: false };
    }
  }
  function lastLogType(empId) {
    var logs = logsOf(empId).sort(byTimeDesc);
    return logs.length ? logs[0].type : null;
  }
  function isAllowed(type, st) {
    if (type === 'clock_in') return !st.onDuty;
    if (type === 'clock_out') return st.onDuty;
    if (type === 'break_start') return st.onDuty && !st.onBreak;
    if (type === 'break_end') return st.onBreak;
    return false;
  }
  var STATUS_ERRORS = {
    clock_in: 'すでに出勤中です。先に退勤を打刻してください。',
    clock_out: 'まだ出勤していません。先に出勤を打刻してください。',
    break_start: '休憩を開始できません。出勤中かつ休憩中でない場合のみ打刻できます。',
    break_end: '休憩中ではないため、休憩終了を打刻できません。',
  };
  function withLabel(l) { return Object.assign({}, l, { label: TYPE_LABELS[l.type] }); }

  // 社員番号の自動採番(0001, 0002, ... の形式)
  function maxEmployeeCodeNumber() {
    var max = 0;
    state.employees.forEach(function (e) {
      var m = /^(\d+)$/.exec(e.employee_code);
      if (m && parseInt(m[1], 10) > max) max = parseInt(m[1], 10);
    });
    return max;
  }
  function generateEmployeeCode() {
    var maxNum = maxEmployeeCodeNumber();
    var configured = state.settings[NEXT_CODE_KEY];
    var configuredNum = configured && /^\d+$/.test(configured) ? parseInt(configured, 10) : 0;
    var nextNum = Math.max(configuredNum, maxNum + 1);
    var digits = Math.max(4, String(configuredNum).length);
    return String(nextNum).padStart(digits, '0');
  }

  // ---- /api/auth ----

  route('GET', '/auth/divisions', PUBLIC, function () {
    return ok({ divisions: sortedDivisions().map(function (d) { return { id: d.id, name: d.name }; }) });
  });

  route('POST', '/auth/register', PUBLIC, function (ctx) {
    var b = ctx.body;
    if (!b.last_name || !String(b.last_name).trim() || !b.first_name || !String(b.first_name).trim() || !b.password) {
      return fail(400, '姓・名・パスワードを入力してください。');
    }
    if (String(b.password).length < 3) return fail(400, 'パスワードは3文字以上にしてください。');
    var division = b.division ? String(b.division).trim() : null;
    if (division && !findDivisionByName(division)) return fail(400, '選択した事業部が見つかりません。');
    var e = addEmployee(state, {
      code: generateEmployeeCode(), last: String(b.last_name).trim(), first: String(b.first_name).trim(),
      password: String(b.password), role: 'employee', division: division,
    });
    return ok({ token: 'demo.' + e.id, employee: publicEmployee(e) });
  });

  route('GET', '/auth/setup-status', PUBLIC, function () {
    var needsSetup = state.employees.length === 0;
    return ok({ needsSetup: needsSetup, keyRequired: !needsSetup, hasSetupKey: false });
  });

  route('POST', '/auth/setup-admin', PUBLIC, function () {
    return fail(403, 'デモ版では管理者アカウントの追加はできません。ログイン画面から 0001 / demo でログインしてください。');
  });

  route('POST', '/auth/login', PUBLIC, function (ctx) {
    var b = ctx.body;
    if (!b.employee_code || !b.password) return fail(400, '社員番号とパスワードを入力してください。');
    var code = String(b.employee_code).trim();
    var e = state.employees.find(function (x) { return x.employee_code === code; });
    if (!e || !e.active || e.password !== b.password) return fail(401, '社員番号またはパスワードが正しくありません。');
    return ok({ token: 'demo.' + e.id, employee: publicEmployee(e) });
  });

  route('GET', '/auth/me', USER, function (ctx) { return ok({ employee: publicEmployee(ctx.user) }); });

  route('POST', '/auth/change-password', USER, function (ctx) {
    var b = ctx.body;
    if (!b.current_password || !b.new_password) return fail(400, '現在のパスワードと新しいパスワードを入力してください。');
    if (String(b.new_password).length < 3) return fail(400, '新しいパスワードは3文字以上にしてください。');
    if (ctx.user.password !== b.current_password) return fail(401, '現在のパスワードが正しくありません。');
    ctx.user.password = String(b.new_password);
    return ok({ ok: true });
  });

  // ---- /api/attendance ----

  route('POST', '/attendance/clock', USER, function (ctx) {
    var b = ctx.body;
    if (VALID_TYPES.indexOf(b.type) === -1) return fail(400, '打刻種別が正しくありません。');
    var siteDivision = trimmed(b.site_division);
    if (!siteDivision) return fail(400, '現場の該当事業部を選択してください。');
    if (!findDivisionByName(siteDivision)) return fail(400, '指定された事業部はマスタに登録されていません。');
    var st = deriveStatus(lastLogType(ctx.user.id));
    if (!isAllowed(b.type, st)) return fail(409, STATUS_ERRORS[b.type]);
    var log = addLog(state, ctx.user.id, b.type, new Date().toISOString(), {
      note: trimmed(b.note), remarks: trimmed(b.remarks), division: siteDivision, method: 'clock',
    });
    return ok({ ok: true, log: withLabel(log), status: deriveStatus(b.type) });
  });

  route('POST', '/attendance/manual', USER, function (ctx) {
    var b = ctx.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return fail(400, '日付を入力してください。');
    var timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRe.test(b.clock_in || '') || !timeRe.test(b.clock_out || '')) return fail(400, '出勤時刻と退勤時刻を入力してください。');
    var hasBs = !!b.break_start;
    var hasBe = !!b.break_end;
    if (hasBs !== hasBe) return fail(400, '休憩は開始・終了の両方を入力するか、両方とも空欄にしてください。');
    if (hasBs && (!timeRe.test(b.break_start) || !timeRe.test(b.break_end))) return fail(400, '休憩時刻の形式が正しくありません。');

    var at = function (t) { return new Date(b.date + 'T' + t + ':00+09:00'); };
    var entries = [{ type: 'clock_in', at: at(b.clock_in) }];
    if (hasBs) entries.push({ type: 'break_start', at: at(b.break_start) }, { type: 'break_end', at: at(b.break_end) });
    entries.push({ type: 'clock_out', at: at(b.clock_out) });
    if (entries.some(function (e) { return Number.isNaN(e.at.getTime()); })) return fail(400, '日付または時刻の形式が正しくありません。');
    for (var i = 1; i < entries.length; i += 1) {
      if (entries[i].at.getTime() <= entries[i - 1].at.getTime()) {
        return fail(400, '時刻は「出勤 → 休憩開始 → 休憩終了 → 退勤」の順に、後の時刻になるよう入力してください。');
      }
    }
    if (entries[entries.length - 1].at.getTime() > Date.now()) return fail(400, '未来の時刻は入力できません。');

    var siteDivision = trimmed(b.site_division);
    if (!siteDivision) return fail(400, '現場の該当事業部を選択してください。');
    if (!findDivisionByName(siteDivision)) return fail(400, '指定された事業部はマスタに登録されていません。');

    var dayStart = new Date(b.date + 'T00:00:00+09:00');
    var dayStartIso = dayStart.toISOString();
    var dayEndIso = new Date(dayStart.getTime() + DAY_MS).toISOString();
    var existing = logsOf(ctx.user.id).some(function (l) { return l.timestamp >= dayStartIso && l.timestamp < dayEndIso; });
    if (existing) return fail(409, 'その日には既に打刻があります。修正が必要な場合は管理者に連絡してください。');

    var created = entries.map(function (e) {
      return addLog(state, ctx.user.id, e.type, e.at.toISOString(), {
        note: trimmed(b.note), remarks: trimmed(b.remarks), division: siteDivision, method: 'manual',
      });
    });
    return ok({ ok: true, logs: created.map(withLabel) });
  });

  route('GET', '/attendance/today-status', USER, function (ctx) {
    var range = jstTodayRange();
    var logs = logsOf(ctx.user.id)
      .filter(function (l) { return l.timestamp >= range.startIso && l.timestamp < range.endIso; })
      .sort(byTimeAsc);
    return ok({ date: range.todayStr, logs: logs.map(withLabel), status: deriveStatus(lastLogType(ctx.user.id)) });
  });

  route('GET', '/attendance/my', USER, function (ctx) {
    var logs = logsOf(ctx.user.id);
    if (ctx.query.from) {
      var fromIso = new Date(ctx.query.from + 'T00:00:00+09:00').toISOString();
      logs = logs.filter(function (l) { return l.timestamp >= fromIso; });
    }
    if (ctx.query.to) {
      var toIso = new Date(new Date(ctx.query.to + 'T00:00:00+09:00').getTime() + DAY_MS).toISOString();
      logs = logs.filter(function (l) { return l.timestamp < toIso; });
    }
    logs = logs.sort(byTimeDesc).slice(0, 500);
    return ok({ logs: logs.map(withLabel) });
  });

  // ---- /api/admin: マスタ ----

  route('GET', '/admin/roles', ADMIN, function () { return ok({ roles: ROLE_MASTER }); });
  route('GET', '/admin/statuses', ADMIN, function () { return ok({ statuses: STATUS_MASTER }); });

  route('GET', '/admin/divisions', ADMIN, function () { return ok({ divisions: sortedDivisions().map(divisionWithCount) }); });

  route('POST', '/admin/divisions', ADMIN, function (ctx) {
    var name = (ctx.body.name || '').trim();
    if (!name) return fail(400, '事業部名を入力してください。');
    if (findDivisionByName(name)) return fail(409, 'この事業部は既に登録されています。');
    var maxOrder = state.divisions.reduce(function (m, d) { return Math.max(m, d.sort_order); }, 0);
    var d = { id: state.seq.division++, name: name, sort_order: maxOrder + 1, created_at: new Date().toISOString() };
    state.divisions.push(d);
    return ok({ division: divisionWithCount(d) });
  });

  route('PUT', '/admin/divisions/reorder', ADMIN, function (ctx) {
    var ids = ctx.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return fail(400, '並び順の情報が正しくありません。');
    var normalized = ids.map(Number);
    var idSet = {};
    normalized.forEach(function (id) { idSet[id] = true; });
    var valid = Object.keys(idSet).length === normalized.length &&
      normalized.length === state.divisions.length &&
      state.divisions.every(function (d) { return idSet[d.id]; });
    if (!valid) return fail(400, '並び順の情報が事業部一覧と一致しません。');
    normalized.forEach(function (id, idx) { state.divisions.find(function (d) { return d.id === id; }).sort_order = idx + 1; });
    return ok({ divisions: sortedDivisions().map(divisionWithCount) });
  });

  route('PUT', '/admin/divisions/:id', ADMIN, function (ctx) {
    var name = (ctx.body.name || '').trim();
    if (!name) return fail(400, '事業部名を入力してください。');
    var division = state.divisions.find(function (d) { return d.id === Number(ctx.params.id); });
    if (!division) return fail(404, '事業部が見つかりません。');
    if (state.divisions.some(function (d) { return d.name === name && d.id !== division.id; })) return fail(409, 'この事業部名は既に使用されています。');
    var oldName = division.name;
    division.name = name;
    state.employees.forEach(function (e) { if (e.division === oldName) e.division = name; });
    return ok({ division: divisionWithCount(division) });
  });

  route('DELETE', '/admin/divisions/:id', ADMIN, function (ctx) {
    var division = state.divisions.find(function (d) { return d.id === Number(ctx.params.id); });
    if (!division) return fail(404, '事業部が見つかりません。');
    var cnt = state.employees.filter(function (e) { return e.division === division.name; }).length;
    if (cnt > 0) return fail(409, 'この事業部は' + cnt + '名の社員に設定されているため削除できません。先に該当社員の事業部を変更してください。');
    state.divisions = state.divisions.filter(function (d) { return d !== division; });
    return ok({ ok: true });
  });

  // ---- /api/admin: データベース容量・設定 ----

  function prettySize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' kB';
    return Math.round(bytes / 1024 / 1024) + ' MB';
  }

  route('GET', '/admin/storage', ADMIN, function () {
    var tableDefs = [
      ['attendance_logs', state.logs], ['employees', state.employees], ['payroll_adjustments', Object.keys(state.adjustments)],
      ['payroll_deductions', Object.keys(state.deductions)], ['divisions', state.divisions], ['app_settings', Object.keys(state.settings)],
    ];
    var baseBytes = 8192; // テーブルごとの管理領域の目安
    var tables = tableDefs.map(function (t) {
      var bytes = baseBytes + JSON.stringify(t[1]).length * 2;
      return { name: t[0], bytes: bytes, pretty: prettySize(bytes), row_estimate: t[1].length };
    }).sort(function (a, b) { return b.bytes - a.bytes; });
    var total = tables.reduce(function (sum, t) { return sum + t.bytes; }, 7 * 1024 * 1024);
    var configured = state.settings[DB_LIMIT_KEY];
    var limitMb = configured && /^\d+(\.\d+)?$/.test(configured) ? parseFloat(configured) : null;
    var percent = limitMb ? Math.min(999, Math.round((total / (1024 * 1024) / limitMb) * 1000) / 10) : null;
    return ok({ database: { bytes: total, pretty: prettySize(total) }, tables: tables, limit_mb: limitMb, used_percent: percent });
  });

  route('PUT', '/admin/settings/db-storage-limit', ADMIN, function (ctx) {
    var value = ctx.body.value;
    var text = value === null || value === undefined ? '' : String(value).trim();
    if (!text) { delete state.settings[DB_LIMIT_KEY]; return ok({ limit_mb: null }); }
    if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) return fail(400, '半角数字(MB単位)で入力してください(例: 500)。');
    state.settings[DB_LIMIT_KEY] = text;
    return ok({ limit_mb: parseFloat(text) });
  });

  route('GET', '/admin/settings/next-employee-code', ADMIN, function () {
    var configured = state.settings[NEXT_CODE_KEY];
    return ok({ configured: configured === undefined ? null : configured, computed_next: generateEmployeeCode() });
  });

  route('PUT', '/admin/settings/next-employee-code', ADMIN, function (ctx) {
    var value = ctx.body.value;
    var text = value === null || value === undefined ? '' : String(value).trim();
    if (!text) { delete state.settings[NEXT_CODE_KEY]; return ok({ configured: null, computed_next: generateEmployeeCode() }); }
    if (!/^\d+$/.test(text) || text.length > 10) return fail(400, '半角数字で10桁以内で入力してください(例: 0100)。');
    var maxNum = maxEmployeeCodeNumber();
    if (parseInt(text, 10) <= maxNum) {
      return fail(400, '既に社員番号' + String(maxNum).padStart(4, '0') + 'まで使用されているため、それより大きい番号を指定してください。');
    }
    state.settings[NEXT_CODE_KEY] = text;
    return ok({ configured: text, computed_next: generateEmployeeCode() });
  });

  // ---- /api/admin: 社員 ----

  function sortedEmployees() {
    return state.employees.slice().sort(function (a, b) { return a.employee_code < b.employee_code ? -1 : a.employee_code > b.employee_code ? 1 : 0; });
  }

  route('GET', '/admin/employees', ADMIN, function () { return ok({ employees: sortedEmployees().map(listedEmployee) }); });

  route('POST', '/admin/employees', ADMIN, function (ctx) {
    var b = ctx.body;
    if (!b.employee_code || !b.last_name || !String(b.last_name).trim() || !b.first_name || !String(b.first_name).trim() || !b.password) {
      return fail(400, '社員番号・姓・名・パスワードを入力してください。');
    }
    if (String(b.password).length < 3) return fail(400, 'パスワードは3文字以上にしてください。');
    var role = ROLE_VALUES.indexOf(b.role) !== -1 ? b.role : 'employee';
    var division = b.division ? String(b.division).trim() : null;
    if (division && !findDivisionByName(division)) return fail(400, '指定された事業部はマスタに登録されていません。');
    var code = String(b.employee_code).trim();
    if (state.employees.some(function (e) { return e.employee_code === code; })) return fail(409, 'この社員番号は既に登録されています。');
    var e = addEmployee(state, {
      code: code, last: String(b.last_name).trim(), first: String(b.first_name).trim(), password: String(b.password), role: role, division: division,
    });
    return ok({ employee: listedEmployee(e) });
  });

  function idsFrom(ctx) {
    var ids = ctx.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    return ids.map(Number).filter(function (id) { return Number.isInteger(id); });
  }
  function employeeById(id) { return state.employees.find(function (e) { return e.id === Number(id); }) || null; }

  route('PUT', '/admin/employees/bulk-status', ADMIN, function (ctx) {
    var ids = idsFrom(ctx);
    if (ids === null) return fail(400, '対象の社員を選択してください。');
    var active = ctx.body.active;
    if (active !== 0 && active !== 1) return fail(400, '状態(有効/無効)の指定が正しくありません。');
    var targets = active === 0 ? ids.filter(function (id) { return id !== ctx.user.id; }) : ids;
    var skippedSelf = active === 0 && targets.length !== ids.length;
    targets.forEach(function (id) { var e = employeeById(id); if (e) e.active = active; });
    return ok({ updated: targets.length, skippedSelf: skippedSelf });
  });

  route('PUT', '/admin/employees/bulk-division', ADMIN, function (ctx) {
    var ids = idsFrom(ctx);
    if (ids === null) return fail(400, '対象の社員を選択してください。');
    var division = ctx.body.division ? String(ctx.body.division).trim() : null;
    if (division && !findDivisionByName(division)) return fail(400, '指定された事業部はマスタに登録されていません。');
    ids.forEach(function (id) { var e = employeeById(id); if (e) e.division = division; });
    return ok({ updated: ids.length });
  });

  route('DELETE', '/admin/employees', ADMIN, function (ctx) {
    var ids = idsFrom(ctx);
    if (ids === null) return fail(400, '対象の社員を選択してください。');
    var skipped = [];
    var deletable = [];
    ids.forEach(function (id) {
      var e = employeeById(id);
      if (!e) { skipped.push({ id: id, reason: '社員が見つかりません。' }); return; }
      if (id === ctx.user.id) { skipped.push({ id: id, employee_code: e.employee_code, name: e.name, reason: '自分自身は削除できません。' }); return; }
      var logCount = logsOf(id).length;
      if (logCount > 0) {
        skipped.push({ id: id, employee_code: e.employee_code, name: e.name, reason: '打刻ログが' + logCount + '件あるため削除できません。' });
        return;
      }
      deletable.push(id);
    });
    deletable.forEach(function (id) {
      Object.keys(state.deductions).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete state.deductions[k]; });
      Object.keys(state.adjustments).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete state.adjustments[k]; });
      state.employees = state.employees.filter(function (e) { return e.id !== id; });
    });
    return ok({ deleted: deletable.length, skipped: skipped });
  });

  route('PUT', '/admin/employees/:id', ADMIN, function (ctx) {
    var b = ctx.body;
    var e = employeeById(ctx.params.id);
    if (!e) return fail(404, '社員が見つかりません。');
    var last = e.last_name;
    var first = e.first_name;
    if (b.last_name !== undefined) {
      if (!String(b.last_name).trim()) return fail(400, '姓を入力してください。');
      last = String(b.last_name).trim();
    }
    if (b.first_name !== undefined) {
      if (!String(b.first_name).trim()) return fail(400, '名を入力してください。');
      first = String(b.first_name).trim();
    }
    var name = combineName(last, first) || e.name;
    var role = ROLE_VALUES.indexOf(b.role) !== -1 ? b.role : e.role;
    var active = b.active !== undefined ? (b.active ? 1 : 0) : e.active;
    var division = b.division !== undefined ? (String(b.division).trim() || null) : e.division;
    var code = e.employee_code;
    if (b.employee_code !== undefined) {
      var t = String(b.employee_code).trim();
      if (!t) return fail(400, '社員番号を入力してください。');
      if (t !== e.employee_code) {
        if (state.employees.some(function (x) { return x.employee_code === t && x.id !== e.id; })) return fail(409, 'この社員番号は既に使用されています。');
        code = t;
      }
    }
    if (division && !findDivisionByName(division)) return fail(400, '指定された事業部はマスタに登録されていません。');
    if (b.new_password && String(b.new_password).length < 3) return fail(400, 'パスワードは3文字以上にしてください。');
    Object.assign(e, { employee_code: code, name: name, last_name: last, first_name: first, role: role, active: active, division: division });
    if (b.new_password) e.password = String(b.new_password);
    return ok({ employee: listedEmployee(e) });
  });

  // ---- /api/admin: 勤怠ログ ----

  function filteredAdminLogs(query) {
    var logs = state.logs.slice();
    if (query.employee_id) logs = logs.filter(function (l) { return l.employee_id === Number(query.employee_id); });
    if (query.from) {
      var fromIso = new Date(query.from + 'T00:00:00+09:00').toISOString();
      logs = logs.filter(function (l) { return l.timestamp >= fromIso; });
    }
    if (query.to) {
      var toIso = new Date(new Date(query.to + 'T00:00:00+09:00').getTime() + DAY_MS).toISOString();
      logs = logs.filter(function (l) { return l.timestamp < toIso; });
    }
    return logs.sort(byTimeDesc).slice(0, 5000).map(function (l) {
      var e = employeeById(l.employee_id) || {};
      return Object.assign({}, l, {
        employee_name: e.name, employee_code: e.employee_code,
        label: TYPE_LABELS[l.type], input_method_label: INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock,
      });
    });
  }

  route('GET', '/admin/logs', ADMIN, function (ctx) { return ok({ logs: filteredAdminLogs(ctx.query) }); });

  route('PUT', '/admin/logs/bulk', ADMIN, function (ctx) {
    var updates = ctx.body.updates;
    if (!Array.isArray(updates) || updates.length === 0) return fail(400, '更新する打刻データがありません。');
    if (updates.length > 500) return fail(400, '一度に更新できるのは500件までです。');
    var result = { updated: 0, errors: [] };
    updates.forEach(function (item) {
      var id = item && item.id;
      var timestamp = item && item.timestamp;
      if (!id || !timestamp) { result.errors.push({ id: id || null, error: 'IDまたは日時が指定されていません。' }); return; }
      var date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) { result.errors.push({ id: id, error: '日時の形式が正しくありません。' }); return; }
      var log = state.logs.find(function (l) { return l.id === Number(id); });
      if (!log) { result.errors.push({ id: id, error: '打刻データが見つかりません。' }); return; }
      log.timestamp = date.toISOString();
      result.updated += 1;
    });
    return ok(result);
  });

  route('GET', '/admin/logs/csv', ADMIN, function (ctx) {
    var header = '社員番号,氏名,種別,事業部,現場名,備考,日時(JST),入力方法\n';
    var rows = filteredAdminLogs(ctx.query).map(function (l) {
      var jst = new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return [l.employee_code, l.employee_name, TYPE_LABELS[l.type], l.site_division || '', l.note || '', l.remarks || '', jst,
        INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock]
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    });
    return { status: 200, raw: '﻿' + header + rows.join('\n'), contentType: 'text/csv; charset=utf-8' };
  });

  route('DELETE', '/admin/logs/:id', ADMIN, function (ctx) {
    var log = state.logs.find(function (l) { return l.id === Number(ctx.params.id); });
    if (!log) return fail(404, '打刻データが見つかりません。');
    state.logs = state.logs.filter(function (l) { return l !== log; });
    return ok({ ok: true });
  });

  route('DELETE', '/admin/logs', ADMIN, function (ctx) {
    var ids = ctx.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return fail(400, '削除する打刻データがありません。');
    if (ids.length > 500) return fail(400, '一度に削除できるのは500件までです。');
    var idSet = {};
    ids.forEach(function (id) { idSet[Number(id)] = true; });
    var before = state.logs.length;
    state.logs = state.logs.filter(function (l) { return !idSet[l.id]; });
    return ok({ deleted: before - state.logs.length });
  });

  // ---- /api/admin: 給与計算 ----

  function loadRates() {
    var rates = Object.assign({}, payroll.DEFAULT_RATES);
    Object.keys(RATE_KEYS).forEach(function (name) {
      var v = state.settings[RATE_KEYS[name]];
      if (v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v))) rates[name] = Number(v);
    });
    return rates;
  }
  function adjustmentsFor(empId, month) {
    var a = state.adjustments[empId + '|' + month];
    return { overrides: (a && a.overrides) || {}, allowances: (a && a.allowances) || {} };
  }
  function deductionsFor(empId, month) { return state.deductions[empId + '|' + month] || null; }
  // 日をまたぐ勤務を正しく集計するため、前後1日ぶん多めに取得する
  function logsAround(range, empId) {
    var from = new Date(new Date(range.startIso).getTime() - DAY_MS).toISOString();
    var to = new Date(new Date(range.endIso).getTime() + DAY_MS).toISOString();
    return state.logs.filter(function (l) {
      return l.timestamp >= from && l.timestamp < to && (empId === undefined || l.employee_id === empId);
    });
  }

  route('GET', '/admin/payroll', ADMIN, function (ctx) {
    var month = ctx.query.month || new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 7);
    var range = payroll.monthRangeIso(month);
    if (!range) return fail(400, '対象月の形式が正しくありません(例: 2026-09)。');
    var rates = loadRates();
    var logs = logsAround(range);
    var rows = sortedEmployees().map(function (e) {
      var mine = logs.filter(function (l) { return l.employee_id === e.id; });
      var calc = payroll.calculateEmployee(mine, e.hourly_wage, rates, month);
      var fin = payroll.finalizeEmployee(calc, adjustmentsFor(e.id, month), e.hourly_wage, rates);
      var ded = deductionsFor(e.id, month);
      var deductionsTotal = payroll.sumDeductions(ded);
      return Object.assign({
        id: e.id, employee_code: e.employee_code, name: e.name, division: e.division, active: e.active, hourly_wage: e.hourly_wage,
      }, fin, { deductions_total: deductionsTotal, net_pay: fin.total_pay - deductionsTotal });
    }).filter(function (r) { return r.active || r.total_minutes > 0; }); // 無効な社員は、その月に勤務がある場合だけ表示する
    return ok({ month: month, rates: rates, rows: rows });
  });

  route('GET', '/admin/payroll/:id/slip', ADMIN, function (ctx) {
    var month = ctx.query.month;
    var range = payroll.monthRangeIso(month);
    if (!range) return fail(400, '対象月の形式が正しくありません(例: 2026-09)。');
    var emp = employeeById(ctx.params.id);
    if (!emp) return fail(404, '社員が見つかりません。');
    var rates = loadRates();
    var logs = logsAround(range, emp.id);
    var ded = deductionsFor(emp.id, month);
    var deductions = Object.assign({}, payroll.emptyDeductions());
    payroll.DEDUCTION_ITEMS.forEach(function (i) { deductions[i.key] = ded ? Number(ded[i.key]) || 0 : 0; });
    var computed = payroll.calculateEmployee(logs, emp.hourly_wage, rates, month);
    var adjustments = adjustmentsFor(emp.id, month);
    var summary = payroll.finalizeEmployee(computed, adjustments, emp.hourly_wage, rates);
    var deductionsTotal = payroll.sumDeductions(deductions);
    return ok({
      month: month,
      issued_on: new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10),
      employee: { id: emp.id, employee_code: emp.employee_code, name: emp.name, division: emp.division, hourly_wage: emp.hourly_wage },
      rates: rates,
      summary: summary,
      computed: computed,
      overrides: adjustments.overrides,
      allowance_items: payroll.ALLOWANCE_ITEMS,
      deduction_items: payroll.DEDUCTION_ITEMS,
      deductions: deductions,
      deductions_total: deductionsTotal,
      net_pay: summary.total_pay - deductionsTotal,
      days: payroll.dailyBreakdown(logs, month),
    });
  });

  route('PUT', '/admin/payroll/wages', ADMIN, function (ctx) {
    var wages = ctx.body.wages;
    if (!Array.isArray(wages) || wages.length === 0) return fail(400, '保存する時給がありません。');
    for (var i = 0; i < wages.length; i += 1) {
      var raw = wages[i].hourly_wage;
      if (raw !== null && raw !== '' && raw !== undefined && !/^\d{1,6}$/.test(String(raw))) {
        return fail(400, '時給は半角数字(円)で入力してください(例: 1500)。');
      }
    }
    wages.forEach(function (w) {
      var e = employeeById(w.id);
      if (e) e.hourly_wage = w.hourly_wage === null || w.hourly_wage === '' || w.hourly_wage === undefined ? null : Number(w.hourly_wage);
    });
    return ok({ updated: wages.length });
  });

  route('PUT', '/admin/payroll/rates', ADMIN, function (ctx) {
    var rates = {};
    var names = Object.keys(RATE_KEYS);
    for (var i = 0; i < names.length; i += 1) {
      var v = Number(ctx.body[names[i]]);
      if (!Number.isFinite(v) || v < 0 || v > 200) return fail(400, '割増率は0〜200の数字(%)で入力してください。');
      rates[names[i]] = v;
    }
    names.forEach(function (n) { state.settings[RATE_KEYS[n]] = String(rates[n]); });
    return ok({ rates: rates });
  });

  route('PUT', '/admin/payroll/:id/slip', ADMIN, function (ctx) {
    var b = ctx.body;
    var month = b.month;
    var overrides = b.overrides || {};
    var allowances = b.allowances || {};
    var deductions = b.deductions || {};
    if (!payroll.monthRangeIso(month)) return fail(400, '対象月の形式が正しくありません(例: 2026-09)。');
    var emp = employeeById(ctx.params.id);
    if (!emp) return fail(404, '社員が見つかりません。');

    var isBlank = function (v) { return v === null || v === undefined || String(v).trim() === ''; };
    var parseInt0 = function (v, max, label) {
      var text = String(v).trim();
      if (!/^\d{1,9}$/.test(text) || Number(text) > max) return { error: label + 'は0〜' + max.toLocaleString('ja-JP') + 'の半角数字で入力してください。' };
      return { value: Number(text) };
    };
    var LABELS = {
      work_days: '出勤日数', total_minutes: '総勤務時間', overtime_minutes: '時間外', night_minutes: '深夜', holiday_minutes: '休日',
      base_pay: '基本給', overtime_pay: '時間外手当', night_pay: '深夜手当', holiday_pay: '休日手当',
    };
    var cleanOverrides = {};
    var keys = payroll.ATTENDANCE_KEYS.concat(payroll.PAY_KEYS);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (isBlank(overrides[key])) continue;
      var max = key === 'work_days' ? 31 : /_minutes$/.test(key) ? 44640 : 99999999;
      var r = parseInt0(overrides[key], max, LABELS[key]);
      if (r.error) return fail(400, r.error);
      cleanOverrides[key] = r.value;
    }
    var cleanAllowances = {};
    for (var a = 0; a < payroll.ALLOWANCE_ITEMS.length; a += 1) {
      var item = payroll.ALLOWANCE_ITEMS[a];
      var ra = isBlank(allowances[item.key]) ? { value: 0 } : parseInt0(allowances[item.key], 9999999, item.label);
      if (ra.error) return fail(400, ra.error);
      cleanAllowances[item.key] = ra.value;
    }
    var cleanDeductions = {};
    for (var d = 0; d < payroll.DEDUCTION_ITEMS.length; d += 1) {
      var di = payroll.DEDUCTION_ITEMS[d];
      var rd = isBlank(deductions[di.key]) ? { value: 0 } : parseInt0(deductions[di.key], 9999999, di.label);
      if (rd.error) return fail(400, rd.error);
      cleanDeductions[di.key] = rd.value;
    }
    state.adjustments[emp.id + '|' + month] = { overrides: cleanOverrides, allowances: cleanAllowances };
    state.deductions[emp.id + '|' + month] = cleanDeductions;
    return ok({ ok: true });
  });

  // ---- /api/admin: スプレッドシート連携(デモ版では未設定扱い) ----

  route('GET', '/admin/sheets/status', ADMIN, function () { return ok({ configured: false }); });
  route('POST', '/admin/sheets/sync-all', ADMIN, function () {
    return fail(400, 'スプレッドシート連携が設定されていません。SHEETS_WEBHOOK_URLを設定してください。');
  });

  route('GET', '/health', PUBLIC, function () { return ok({ ok: true, db: 'demo', time: new Date().toISOString() }); });

  // ---- リクエストの振り分け ----

  function authenticate(init) {
    var headers = new Headers((init && init.headers) || {});
    var header = headers.get('Authorization') || '';
    var token = header.indexOf('Bearer ') === 0 ? header.slice(7) : null;
    if (!token) return { error: fail(401, '認証が必要です。再度ログインしてください。') };
    var m = /^demo\.(\d+)$/.exec(token);
    var user = m ? employeeById(m[1]) : null;
    if (!user || !user.active) return { error: fail(401, 'セッションが無効です。再度ログインしてください。') };
    return { user: user };
  }

  function dispatch(urlString, init) {
    var url = new URL(urlString, location.origin);
    var path = url.pathname.replace(/^\/api/, '');
    var method = ((init && init.method) || 'GET').toUpperCase();
    var matched = null;
    var params = {};
    for (var i = 0; i < routes.length && !matched; i += 1) {
      var r = routes[i];
      if (r.method !== method) continue;
      var m = r.re.exec(path);
      if (!m) continue;
      matched = r;
      r.keys.forEach(function (k, idx) { params[k] = decodeURIComponent(m[idx + 1]); });
    }
    if (!matched) return fail(404, 'APIが見つかりません。(' + method + ' ' + path + ')');

    var user = null;
    if (matched.opts.auth) {
      var authResult = authenticate(init);
      if (authResult.error) return authResult.error;
      user = authResult.user;
      if (matched.opts.admin && user.role !== 'admin') return fail(403, '管理者権限が必要です。');
    }
    var body = {};
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = {}; }
    }
    var query = {};
    url.searchParams.forEach(function (v, k) { query[k] = v; });

    var result;
    try {
      result = matched.handler({ params: params, query: query, body: body || {}, user: user });
    } catch (err) {
      console.error('[デモ版] API処理でエラー:', err);
      return fail(500, 'サーバーでエラーが発生しました。');
    }
    if (method !== 'GET') save();
    return result;
  }

  window.fetch = function (input, init) {
    var urlString = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    var url;
    try { url = new URL(urlString, location.origin); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);

    var result = dispatch(urlString, init);
    var response = result.raw !== undefined
      ? new Response(result.raw, { status: result.status, headers: { 'Content-Type': result.contentType || 'text/plain' } })
      : new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
    return new Promise(function (resolve) { setTimeout(function () { resolve(response); }, 40); });
  };

  // ---- 画面下部のデモ用バー ----

  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(EMPLOYEE_KEY); } catch (e) { /* 無視 */ }
  }

  function mountBar() {
    var bar = document.createElement('div');
    bar.setAttribute('data-demo-bar', '1');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;' +
      'justify-content:center;padding:6px 12px;background:#1f2937;color:#f9fafb;font-size:12px;line-height:1.5;';
    var text = document.createElement('span');
    text.textContent = 'デモ版(データはこのブラウザ内だけに保存)/ ログイン: 管理者 0001・一般 0002〜0005 / パスワードは全員 demo';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'データを初期化';
    var exit = document.createElement('button');
    exit.type = 'button';
    exit.textContent = 'デモを終了';
    [reset, exit].forEach(function (b) {
      b.style.cssText = 'font-size:12px;padding:2px 10px;border:1px solid #9ca3af;border-radius:4px;background:transparent;color:inherit;cursor:pointer;';
    });
    reset.addEventListener('click', function () {
      if (!window.confirm('デモのデータをすべて初期状態に戻します。よろしいですか?')) return;
      try { localStorage.removeItem(STATE_KEY); } catch (e) { /* 無視 */ }
      clearSession();
      location.href = 'index.html';
    });
    exit.addEventListener('click', function () {
      try { localStorage.removeItem(FLAG_KEY); } catch (e) { /* 無視 */ }
      clearSession();
      location.href = 'index.html?demo=0';
    });
    bar.appendChild(text);
    bar.appendChild(reset);
    bar.appendChild(exit);
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '56px';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBar);
  else mountBar();
})();
