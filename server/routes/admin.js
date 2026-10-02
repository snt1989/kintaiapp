const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { combineName } = require('../nameUtil');
const sheetsSync = require('../sheetsSync');
const payroll = require('../payroll');
const {
  generateEmployeeCode,
  getMaxEmployeeCodeNumber,
  NEXT_EMPLOYEE_CODE_SETTING_KEY,
} = require('./auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const TYPE_LABELS = {
  clock_in: '出勤',
  clock_out: '退勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
};

const INPUT_METHOD_LABELS = { clock: '打刻入力', manual: '直接入力' };

// ---- マスタ管理 ----

// 区別マスタ(固定): システムの動作に直結するため、追加・削除はできません
// (管理者のみが管理機能を利用可能。一般社員・委託職員・協力会社はいずれも打刻・自分の履歴閲覧のみ)
const ROLE_MASTER = [
  { value: 'employee', label: '一般社員' },
  { value: 'contractor', label: '委託職員' },
  { value: 'partner', label: '協力会社' },
  { value: 'admin', label: '管理者' },
];
const ROLE_VALUES = ROLE_MASTER.map((r) => r.value);
const ROLE_LABELS = Object.fromEntries(ROLE_MASTER.map((r) => [r.value, r.label]));

// 状態マスタ(固定): ログイン可否に直結するため、追加・削除はできません
const STATUS_MASTER = [
  { value: 1, label: '有効' },
  { value: 0, label: '無効' },
];

router.get('/roles', (req, res) => {
  res.json({ roles: ROLE_MASTER });
});

router.get('/statuses', (req, res) => {
  res.json({ statuses: STATUS_MASTER });
});

const DIVISIONS_WITH_COUNT_SQL = `
  SELECT divisions.id, divisions.name, divisions.sort_order, divisions.created_at,
         (SELECT COUNT(*)::int FROM employees WHERE employees.division = divisions.name) AS employee_count
  FROM divisions ORDER BY divisions.sort_order, divisions.name
`;

router.get('/divisions', async (req, res, next) => {
  try {
    const divisions = await db.all(DIVISIONS_WITH_COUNT_SQL);
    res.json({ divisions });
  } catch (err) {
    next(err);
  }
});

router.post('/divisions', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    const trimmed = (name || '').trim();
    if (!trimmed) {
      return res.status(400).json({ error: '事業部名を入力してください。' });
    }
    const exists = await db.get('SELECT id FROM divisions WHERE name = ?', [trimmed]);
    if (exists) {
      return res.status(409).json({ error: 'この事業部は既に登録されています。' });
    }
    const { m: maxOrder } = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM divisions');
    const division = await db.get(
      'INSERT INTO divisions (name, sort_order) VALUES (?, ?) RETURNING id, name, sort_order, created_at',
      [trimmed, Number(maxOrder) + 1]
    );
    res.json({ division: { ...division, employee_count: 0 } });
  } catch (err) {
    next(err);
  }
});

// 事業部マスタの並び替え: 新しい並び順のid配列を受け取り、1から振り直す
router.put('/divisions/reorder', async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '並び順の情報が正しくありません。' });
    }

    const existingRows = await db.all('SELECT id FROM divisions');
    const existingIds = existingRows.map((r) => r.id);
    const normalizedIds = ids.map((id) => Number(id));
    const idSet = new Set(normalizedIds);
    const isValid =
      idSet.size === normalizedIds.length &&
      idSet.size === existingIds.length &&
      existingIds.every((id) => idSet.has(id));

    if (!isValid) {
      return res.status(400).json({ error: '並び順の情報が事業部一覧と一致しません。' });
    }

    await db.withTransaction(async (tx) => {
      for (let i = 0; i < normalizedIds.length; i += 1) {
        await tx.run('UPDATE divisions SET sort_order = ? WHERE id = ?', [i + 1, normalizedIds[i]]);
      }
    });

    const divisions = await db.all(DIVISIONS_WITH_COUNT_SQL);
    res.json({ divisions });
  } catch (err) {
    next(err);
  }
});

router.put('/divisions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};
    const trimmed = (name || '').trim();
    if (!trimmed) {
      return res.status(400).json({ error: '事業部名を入力してください。' });
    }

    const division = await db.get('SELECT * FROM divisions WHERE id = ?', [id]);
    if (!division) {
      return res.status(404).json({ error: '事業部が見つかりません。' });
    }

    const duplicate = await db.get('SELECT id FROM divisions WHERE name = ? AND id <> ?', [trimmed, id]);
    if (duplicate) {
      return res.status(409).json({ error: 'この事業部名は既に使用されています。' });
    }

    await db.withTransaction(async (tx) => {
      await tx.run('UPDATE divisions SET name = ? WHERE id = ?', [trimmed, id]);
      // この事業部に所属する社員データも合わせて更新する
      await tx.run('UPDATE employees SET division = ? WHERE division = ?', [trimmed, division.name]);
    });

    const updated = await db.get(
      `SELECT divisions.id, divisions.name, divisions.sort_order, divisions.created_at,
              (SELECT COUNT(*)::int FROM employees WHERE employees.division = divisions.name) AS employee_count
       FROM divisions WHERE divisions.id = ?`,
      [id]
    );
    res.json({ division: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/divisions/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const division = await db.get('SELECT * FROM divisions WHERE id = ?', [id]);
    if (!division) {
      return res.status(404).json({ error: '事業部が見つかりません。' });
    }

    const { cnt } = await db.get('SELECT COUNT(*) AS cnt FROM employees WHERE division = ?', [division.name]);
    if (Number(cnt) > 0) {
      return res.status(409).json({
        error: `この事業部は${cnt}名の社員に設定されているため削除できません。先に該当社員の事業部を変更してください。`,
      });
    }

    await db.run('DELETE FROM divisions WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- データベース使用容量 ----

const DB_STORAGE_LIMIT_SETTING_KEY = 'db_storage_limit_mb';

// PostgreSQL(Vercel Postgres/Neon)は自前サーバーのディスクを持たないため、
// 「サーバーの容量」としてデータベースの使用容量を表示する
router.get('/storage', async (req, res, next) => {
  try {
    const dbSize = await db.get(
      `SELECT pg_database_size(current_database()) AS bytes,
              pg_size_pretty(pg_database_size(current_database())) AS pretty`
    );

    const tables = await db.all(`
      SELECT
        relname AS name,
        pg_total_relation_size(relid) AS bytes,
        pg_size_pretty(pg_total_relation_size(relid)) AS pretty,
        n_live_tup AS row_estimate
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `);

    const limitConfigured = await db.getSetting(DB_STORAGE_LIMIT_SETTING_KEY);
    const limitMb = limitConfigured && /^\d+(\.\d+)?$/.test(limitConfigured) ? parseFloat(limitConfigured) : null;
    const usedMb = Number(dbSize.bytes) / (1024 * 1024);
    const percent = limitMb ? Math.min(999, Math.round((usedMb / limitMb) * 1000) / 10) : null;

    res.json({
      database: { bytes: Number(dbSize.bytes), pretty: dbSize.pretty },
      tables: tables.map((t) => ({
        name: t.name,
        bytes: Number(t.bytes),
        pretty: t.pretty,
        row_estimate: Number(t.row_estimate),
      })),
      limit_mb: limitMb,
      used_percent: percent,
    });
  } catch (err) {
    next(err);
  }
});

// 容量の上限(MB)を管理画面から設定する(使用率の目安表示用。DB側の実際の上限を変更するものではない)
router.put('/settings/db-storage-limit', async (req, res, next) => {
  try {
    const { value } = req.body || {};
    const trimmed = value === null || value === undefined ? '' : String(value).trim();

    if (!trimmed) {
      await db.setSetting(DB_STORAGE_LIMIT_SETTING_KEY, null);
      return res.json({ limit_mb: null });
    }

    if (!/^\d+(\.\d+)?$/.test(trimmed) || Number(trimmed) <= 0) {
      return res.status(400).json({ error: '半角数字(MB単位)で入力してください(例: 500)。' });
    }

    await db.setSetting(DB_STORAGE_LIMIT_SETTING_KEY, trimmed);
    res.json({ limit_mb: parseFloat(trimmed) });
  } catch (err) {
    next(err);
  }
});

// ---- 社員番号の自動採番設定 ----

// 現在の設定値(未設定ならnull)と、実際に次回割り当てられる番号(計算結果)を返す
router.get('/settings/next-employee-code', async (req, res, next) => {
  try {
    const configured = await db.getSetting(NEXT_EMPLOYEE_CODE_SETTING_KEY);
    const computedNext = await generateEmployeeCode();
    res.json({ configured, computed_next: computedNext });
  } catch (err) {
    next(err);
  }
});

// 次回自動採番される社員番号を管理画面から設定する(従業員のセルフ登録・管理画面からの新規追加の両方に適用)
router.put('/settings/next-employee-code', async (req, res, next) => {
  try {
    const { value } = req.body || {};
    const trimmed = value === null || value === undefined ? '' : String(value).trim();

    if (!trimmed) {
      // 空欄の場合は設定を解除し、既存の最大値+1にリセットする
      await db.setSetting(NEXT_EMPLOYEE_CODE_SETTING_KEY, null);
      const computedNext = await generateEmployeeCode();
      return res.json({ configured: null, computed_next: computedNext });
    }

    if (!/^\d+$/.test(trimmed) || trimmed.length > 10) {
      return res.status(400).json({ error: '半角数字で10桁以内で入力してください(例: 0100)。' });
    }

    const maxNum = await getMaxEmployeeCodeNumber();
    if (parseInt(trimmed, 10) <= maxNum) {
      return res.status(400).json({
        error: `既に社員番号${String(maxNum).padStart(4, '0')}まで使用されているため、それより大きい番号を指定してください。`,
      });
    }

    await db.setSetting(NEXT_EMPLOYEE_CODE_SETTING_KEY, trimmed);
    const computedNext = await generateEmployeeCode();
    res.json({ configured: trimmed, computed_next: computedNext });
  } catch (err) {
    next(err);
  }
});

// ---- 社員管理 ----

const EMPLOYEE_COLUMNS = 'id, employee_code, name, last_name, first_name, role, active, division, hourly_wage, tax_table, dependents, social_insurance, labor_insurance, created_at';

// 税区分・扶養親族等の数・時給の入力チェック。指定がない項目は含めない
function parsePayFields(body, { requireAll = false } = {}) {
  const out = {};
  const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
  if (body.tax_table !== undefined || requireAll) {
    const v = isBlank(body.tax_table) ? 'kou' : String(body.tax_table);
    if (v !== 'kou' && v !== 'otsu') return { error: '税区分は甲欄・乙欄のどちらかを選んでください。' };
    out.tax_table = v;
  }
  if (body.dependents !== undefined || requireAll) {
    const v = isBlank(body.dependents) ? '0' : String(body.dependents).trim();
    if (!/^\d{1,2}$/.test(v) || Number(v) > payroll.MAX_DEPENDENTS) {
      return { error: `扶養親族等の数は0〜${payroll.MAX_DEPENDENTS}の半角数字で入力してください。` };
    }
    out.dependents = Number(v);
  }
  for (const [key, label] of [['social_insurance', '社会保険'], ['labor_insurance', '労働保険']]) {
    if (body[key] === undefined && !requireAll) continue;
    const v = body[key] === undefined || isBlank(body[key]) ? '0' : String(body[key]).trim().toLowerCase();
    if (!['0', '1', 'true', 'false'].includes(v)) return { error: `${label}の加入状況は「加入」「未加入」のどちらかを選んでください。` };
    out[key] = v === '1' || v === 'true' ? 1 : 0;
  }
  if (body.hourly_wage !== undefined) {
    if (isBlank(body.hourly_wage)) out.hourly_wage = null;
    else if (!/^\d{1,6}$/.test(String(body.hourly_wage).trim())) return { error: '時給は半角数字(円)で入力してください(例: 1500)。' };
    else out.hourly_wage = Number(String(body.hourly_wage).trim());
  }
  return { value: out };
}

router.get('/employees', async (req, res, next) => {
  try {
    const employees = await db.all(`SELECT ${EMPLOYEE_COLUMNS} FROM employees ORDER BY employee_code`);
    res.json({ employees });
  } catch (err) {
    next(err);
  }
});

router.post('/employees', async (req, res, next) => {
  try {
    const { employee_code, last_name, first_name, password, role, division } = req.body || {};
    if (!employee_code || !last_name || !String(last_name).trim() || !first_name || !String(first_name).trim() || !password) {
      return res.status(400).json({ error: '社員番号・姓・名・パスワードを入力してください。' });
    }
    if (String(password).length < 3) {
      return res.status(400).json({ error: 'パスワードは3文字以上にしてください。' });
    }
    const roleValue = ROLE_VALUES.includes(role) ? role : 'employee';
    const divisionValue = division ? String(division).trim() : null;

    if (divisionValue && !(await db.get('SELECT id FROM divisions WHERE name = ?', [divisionValue]))) {
      return res.status(400).json({ error: '指定された事業部はマスタに登録されていません。' });
    }

    const exists = await db.get('SELECT id FROM employees WHERE employee_code = ?', [
      String(employee_code).trim(),
    ]);
    if (exists) {
      return res.status(409).json({ error: 'この社員番号は既に登録されています。' });
    }

    const pay = parsePayFields(req.body || {}, { requireAll: true });
    if (pay.error) return res.status(400).json({ error: pay.error });

    const lastNameValue = String(last_name).trim();
    const firstNameValue = String(first_name).trim();
    const nameValue = combineName(lastNameValue, firstNameValue);
    const hash = bcrypt.hashSync(password, 10);
    const inserted = await db.get(
      'INSERT INTO employees (employee_code, name, last_name, first_name, password_hash, role, division, hourly_wage, tax_table, dependents, social_insurance, labor_insurance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [String(employee_code).trim(), nameValue, lastNameValue, firstNameValue, hash, roleValue, divisionValue,
        pay.value.hourly_wage === undefined ? null : pay.value.hourly_wage, pay.value.tax_table, pay.value.dependents,
        pay.value.social_insurance, pay.value.labor_insurance]
    );

    const employee = await db.get(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`, [inserted.id]);
    res.json({ employee });
  } catch (err) {
    next(err);
  }
});

// 社員の一括操作: 状態変更・事業部変更・削除

function loadIdsBody(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: '対象の社員を選択してください。' });
    return null;
  }
  return ids.map((id) => Number(id)).filter((id) => Number.isInteger(id));
}

router.put('/employees/bulk-status', async (req, res, next) => {
  try {
    const ids = loadIdsBody(req, res);
    if (ids === null) return;

    const { active } = req.body || {};
    if (active !== 0 && active !== 1) {
      return res.status(400).json({ error: '状態(有効/無効)の指定が正しくありません。' });
    }

    // 自分自身を一括操作で無効化してログイン不能になるのを防ぐため、自分は対象から除外する
    const targetIds = active === 0 ? ids.filter((id) => id !== req.user.id) : ids;
    const skippedSelf = active === 0 && targetIds.length !== ids.length;

    await db.withTransaction(async (tx) => {
      for (const id of targetIds) {
        await tx.run('UPDATE employees SET active = ? WHERE id = ?', [active, id]);
      }
    });

    res.json({ updated: targetIds.length, skippedSelf });
  } catch (err) {
    next(err);
  }
});

router.put('/employees/bulk-division', async (req, res, next) => {
  try {
    const ids = loadIdsBody(req, res);
    if (ids === null) return;

    const { division } = req.body || {};
    const divisionValue = division ? String(division).trim() : null;
    if (divisionValue && !(await db.get('SELECT id FROM divisions WHERE name = ?', [divisionValue]))) {
      return res.status(400).json({ error: '指定された事業部はマスタに登録されていません。' });
    }

    await db.withTransaction(async (tx) => {
      for (const id of ids) {
        await tx.run('UPDATE employees SET division = ? WHERE id = ?', [divisionValue, id]);
      }
    });

    res.json({ updated: ids.length });
  } catch (err) {
    next(err);
  }
});

router.delete('/employees', async (req, res, next) => {
  try {
    const ids = loadIdsBody(req, res);
    if (ids === null) return;

    const skipped = [];
    const deletableIds = [];

    for (const id of ids) {
      const employee = await db.get('SELECT id, employee_code, name FROM employees WHERE id = ?', [id]);
      if (!employee) {
        skipped.push({ id, reason: '社員が見つかりません。' });
        continue;
      }
      if (id === req.user.id) {
        skipped.push({ id, employee_code: employee.employee_code, name: employee.name, reason: '自分自身は削除できません。' });
        continue;
      }
      const { cnt: logCount } = await db.get('SELECT COUNT(*) AS cnt FROM attendance_logs WHERE employee_id = ?', [id]);
      if (Number(logCount) > 0) {
        skipped.push({
          id,
          employee_code: employee.employee_code,
          name: employee.name,
          reason: `打刻ログが${logCount}件あるため削除できません。`,
        });
        continue;
      }
      deletableIds.push(id);
    }

    await db.withTransaction(async (tx) => {
      for (const id of deletableIds) {
        await tx.run('DELETE FROM payroll_deductions WHERE employee_id = ?', [id]);
        await tx.run('DELETE FROM payroll_adjustments WHERE employee_id = ?', [id]);
        await tx.run('DELETE FROM employees WHERE id = ?', [id]);
      }
    });

    res.json({ deleted: deletableIds.length, skipped });
  } catch (err) {
    next(err);
  }
});

router.put('/employees/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { employee_code, last_name, first_name, role, active, division, new_password } = req.body || {};

    const employee = await db.get('SELECT * FROM employees WHERE id = ?', [id]);
    if (!employee) {
      return res.status(404).json({ error: '社員が見つかりません。' });
    }

    let nextLastName = employee.last_name;
    let nextFirstName = employee.first_name;
    if (last_name !== undefined) {
      if (!String(last_name).trim()) {
        return res.status(400).json({ error: '姓を入力してください。' });
      }
      nextLastName = String(last_name).trim();
    }
    if (first_name !== undefined) {
      if (!String(first_name).trim()) {
        return res.status(400).json({ error: '名を入力してください。' });
      }
      nextFirstName = String(first_name).trim();
    }
    const nextName = combineName(nextLastName, nextFirstName) || employee.name;
    const nextRole = ROLE_VALUES.includes(role) ? role : employee.role;
    const nextActive = active !== undefined ? (active ? 1 : 0) : employee.active;
    const nextDivision = division !== undefined ? (String(division).trim() || null) : employee.division;

    let nextCode = employee.employee_code;
    if (employee_code !== undefined) {
      const trimmedCode = String(employee_code).trim();
      if (!trimmedCode) {
        return res.status(400).json({ error: '社員番号を入力してください。' });
      }
      if (trimmedCode !== employee.employee_code) {
        const duplicate = await db.get('SELECT id FROM employees WHERE employee_code = ? AND id <> ?', [
          trimmedCode,
          id,
        ]);
        if (duplicate) {
          return res.status(409).json({ error: 'この社員番号は既に使用されています。' });
        }
        nextCode = trimmedCode;
      }
    }

    if (nextDivision && !(await db.get('SELECT id FROM divisions WHERE name = ?', [nextDivision]))) {
      return res.status(400).json({ error: '指定された事業部はマスタに登録されていません。' });
    }

    const pay = parsePayFields(req.body || {});
    if (pay.error) return res.status(400).json({ error: pay.error });
    const nextTaxTable = pay.value.tax_table !== undefined ? pay.value.tax_table : employee.tax_table;
    const nextDependents = pay.value.dependents !== undefined ? pay.value.dependents : employee.dependents;
    const nextWage = pay.value.hourly_wage !== undefined ? pay.value.hourly_wage : employee.hourly_wage;
    const nextSocial = pay.value.social_insurance !== undefined ? pay.value.social_insurance : employee.social_insurance;
    const nextLabor = pay.value.labor_insurance !== undefined ? pay.value.labor_insurance : employee.labor_insurance;

    await db.run(
      'UPDATE employees SET employee_code = ?, name = ?, last_name = ?, first_name = ?, role = ?, active = ?, division = ?, hourly_wage = ?, tax_table = ?, dependents = ?, social_insurance = ?, labor_insurance = ? WHERE id = ?',
      [nextCode, nextName, nextLastName, nextFirstName, nextRole, nextActive, nextDivision, nextWage, nextTaxTable, nextDependents, nextSocial, nextLabor, id]
    );

    if (new_password) {
      if (String(new_password).length < 3) {
        return res.status(400).json({ error: 'パスワードは3文字以上にしてください。' });
      }
      const hash = bcrypt.hashSync(new_password, 10);
      await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [hash, id]);
    }

    const updated = await db.get(`SELECT ${EMPLOYEE_COLUMNS} FROM employees WHERE id = ?`, [id]);
    res.json({ employee: updated });
  } catch (err) {
    next(err);
  }
});


// 事業部別の勤怠一覧。日ごとの事業部・現場名は、その日の打刻(出勤を優先)から取る。
function buildDivisionAttendance(emps, logsOf, month, division, role, group) {
  var ROLE_NAMES = { employee: '一般社員', contractor: '委託職員', partner: '協力会社', admin: '管理者' };
  var jstDay = function (ts) { return new Date(new Date(ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); };
  var rows = [];
  var incomplete = 0;
  emps.forEach(function (emp) {
    var around = logsOf(emp.id);
    if (!around.length) return;
      if (role && emp.role !== role) return;
    var byDay = {};
    around.forEach(function (l) {
      var k = jstDay(l.timestamp);
      (byDay[k] = byDay[k] || []).push(l);
    });
    var summary = payroll.calculateEmployee(around, 0, undefined, month);
    incomplete += summary.incomplete ? 1 : 0;
    payroll.dailyBreakdown(around, month).forEach(function (d) {
      var dayLogs = (byDay[d.date] || []).slice().sort(function (a, b) { return (a.type === 'clock_in' ? 0 : 1) - (b.type === 'clock_in' ? 0 : 1); });
      var withDiv = dayLogs.filter(function (l) { return l.site_division; })[0];
      var withSite = dayLogs.filter(function (l) { return l.note; })[0];
      var remarks = dayLogs.map(function (l) { return l.remarks; }).filter(function (r, i, a) { return r && a.indexOf(r) === i; }).join('、');
      var div = withDiv ? withDiv.site_division : (emp.division || '');
      if (division && div !== division) return;
      rows.push({
        date: d.date, weekday: d.weekday, employee_id: emp.id, employee_code: emp.employee_code, name: emp.name, role: emp.role, role_label: ROLE_NAMES[emp.role] || emp.role,
        division: div, site: withSite ? withSite.note : '', remarks: remarks,
        clock_in: d.clock_in, clock_out: d.clock_out, break_minutes: d.break_minutes, worked_minutes: d.worked_minutes,
        overtime_minutes: d.overtime_minutes, night_minutes: d.night_minutes, holiday_minutes: d.holiday_minutes,
      });
    });
  });
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.employee_code < b.employee_code ? -1 : a.employee_code > b.employee_code ? 1 : 0); });
  var groups = {};
  rows.forEach(function (r) {
    var key = group === 'role' ? r.role : r.division;
      var g = groups[key] || (groups[key] = { division: key, label: group === 'role' ? r.role_label : r.division, people: {}, days: 0, total_minutes: 0, overtime_minutes: 0, night_minutes: 0, holiday_minutes: 0 });
    g.people[r.employee_id] = true;
    g.days += 1;
    g.total_minutes += r.worked_minutes; g.overtime_minutes += r.overtime_minutes; g.night_minutes += r.night_minutes; g.holiday_minutes += r.holiday_minutes;
  });
  var totals = Object.keys(groups).map(function (k) { var g = groups[k]; g.people = Object.keys(g.people).length; return g; })
    .sort(function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
  return { rows: rows, totals_by_division: totals };
}

// ---- 事業部別の勤怠一覧(全社員・1か月分) ----
// division を指定するとその事業部の日だけに絞る。給与の金額は含まない。
router.get('/attendance/by-division', async (req, res, next) => {
  try {
    const month = req.query.month || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const range = payroll.monthRangeIso(month);
    if (!range) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });
    const division = String(req.query.division || '');
    const emps = await db.all('SELECT id, employee_code, name, role, division FROM employees ORDER BY employee_code');
    const from = new Date(new Date(range.startIso).getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(new Date(range.endIso).getTime() + 24 * 3600 * 1000).toISOString();
    const all = await db.all(
      'SELECT id, employee_id, type, timestamp, note, remarks, site_division FROM attendance_logs WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, id',
      [from, to]
    );
    const byEmp = new Map();
    for (const l of all) {
      if (!byEmp.has(l.employee_id)) byEmp.set(l.employee_id, []);
      byEmp.get(l.employee_id).push(l);
    }
    const role = String(req.query.role || '');
    const group = req.query.group === 'role' ? 'role' : 'division';
    const result = buildDivisionAttendance(emps, (id) => byEmp.get(id) || [], month, division, role, group);
    res.json({ month, division, role, group, ...result });
  } catch (err) {
    next(err);
  }
});

// ---- 個別の勤怠データ(社員1人・1か月分) ----
// 日別の内訳(出勤・退勤・休憩・勤務時間)、月の集計、打刻明細を返す。給与の金額は含まない。
router.get('/employees/:id/attendance', async (req, res, next) => {
  try {
    const month = req.query.month || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const range = payroll.monthRangeIso(month);
    if (!range) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });
    const emp = await db.get(
      'SELECT id, employee_code, name, role, active, division FROM employees WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!emp) return res.status(404).json({ error: '社員が見つかりません。' });

    // 日をまたぐ勤務を正しく集計するため、前後1日ぶん多めに取得する
    const from = new Date(new Date(range.startIso).getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(new Date(range.endIso).getTime() + 24 * 3600 * 1000).toISOString();
    const around = await db.all(
      'SELECT id, type, timestamp, note, remarks, site_division, input_method FROM attendance_logs WHERE employee_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, id',
      [emp.id, from, to]
    );
    const summary = payroll.calculateEmployee(around, 0, undefined, month);
    const logs = around
      .filter((l) => l.timestamp >= range.startIso && l.timestamp < range.endIso)
      .map((l) => ({
        ...l,
        label: TYPE_LABELS[l.type],
        input_method_label: INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock,
      }));
    res.json({
      month,
      employee: emp,
      summary: {
        work_days: summary.work_days,
        total_minutes: summary.total_minutes,
        overtime_minutes: summary.overtime_minutes,
        night_minutes: summary.night_minutes,
        holiday_minutes: summary.holiday_minutes,
        incomplete: summary.incomplete,
      },
      days: payroll.dailyBreakdown(around, month),
      logs,
    });
  } catch (err) {
    next(err);
  }
});

// ---- 勤怠ログ閲覧 ----

function buildLogsQuery({ employee_id, from, to }) {
  let query = `
    SELECT attendance_logs.*, employees.name AS employee_name, employees.employee_code
    FROM attendance_logs
    JOIN employees ON employees.id = attendance_logs.employee_id
    WHERE 1=1
  `;
  const params = [];

  if (employee_id) {
    query += ' AND attendance_logs.employee_id = ?';
    params.push(employee_id);
  }
  if (from) {
    query += ' AND attendance_logs.timestamp >= ?';
    params.push(new Date(`${from}T00:00:00+09:00`).toISOString());
  }
  if (to) {
    const toExclusive = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000);
    query += ' AND attendance_logs.timestamp < ?';
    params.push(toExclusive.toISOString());
  }
  query += ' ORDER BY attendance_logs.timestamp DESC LIMIT 5000';
  return { query, params };
}

router.get('/logs', async (req, res, next) => {
  try {
    const { query, params } = buildLogsQuery(req.query);
    const logs = await db.all(query, params);
    res.json({
      logs: logs.map((l) => ({
        ...l,
        label: TYPE_LABELS[l.type],
        input_method_label: INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// 打刻ログの一括編集(日時の一括修正)
router.put('/logs/bulk', async (req, res, next) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: '更新する打刻データがありません。' });
    }
    if (updates.length > 500) {
      return res.status(400).json({ error: '一度に更新できるのは500件までです。' });
    }

    const result = { updated: 0, errors: [] };

    await db.withTransaction(async (tx) => {
      for (const item of updates) {
        const { id, timestamp } = item || {};
        if (!id || !timestamp) {
          result.errors.push({ id: id || null, error: 'IDまたは日時が指定されていません。' });
          continue;
        }
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
          result.errors.push({ id, error: '日時の形式が正しくありません。' });
          continue;
        }
        const existing = await tx.get('SELECT id FROM attendance_logs WHERE id = ?', [id]);
        if (!existing) {
          result.errors.push({ id, error: '打刻データが見つかりません。' });
          continue;
        }
        await tx.run('UPDATE attendance_logs SET timestamp = ? WHERE id = ?', [date.toISOString(), id]);
        result.updated += 1;
      }
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 打刻ログの削除(1件)
router.delete('/logs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const log = await db.get('SELECT id FROM attendance_logs WHERE id = ?', [id]);
    if (!log) {
      return res.status(404).json({ error: '打刻データが見つかりません。' });
    }
    await db.run('DELETE FROM attendance_logs WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 打刻ログの一括削除
router.delete('/logs', async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '削除する打刻データがありません。' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: '一度に削除できるのは500件までです。' });
    }

    let deleted = 0;
    await db.withTransaction(async (tx) => {
      for (const id of ids) {
        const r = await tx.run('DELETE FROM attendance_logs WHERE id = ?', [id]);
        deleted += r.changes;
      }
    });

    res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

router.get('/logs/csv', async (req, res, next) => {
  try {
    const { query, params } = buildLogsQuery(req.query);
    const logs = await db.all(query, params);

    const header = '社員番号,氏名,種別,事業部,現場名,備考,日時(JST),入力方法\n';
    const rows = logs.map((l) => {
      const jst = new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return [l.employee_code, l.employee_name, TYPE_LABELS[l.type], l.site_division || '', l.note || '', l.remarks || '', jst, INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',');
    });
    const csv = '﻿' + header + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_logs.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ---- 給与計算 ----

const RATE_KEYS = { overtime: 'payroll_rate_overtime', night: 'payroll_rate_night', holiday: 'payroll_rate_holiday' };

async function loadRates() {
  const rates = { ...payroll.DEFAULT_RATES };
  for (const [name, key] of Object.entries(RATE_KEYS)) {
    const v = await db.getSetting(key);
    if (v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v))) rates[name] = Number(v);
  }
  return rates;
}

function parseAdjustments(row) {
  try {
    const d = row && row.data ? JSON.parse(row.data) : {};
    return { overrides: d.overrides || {}, allowances: d.allowances || {} };
  } catch (e) {
    return { overrides: {}, allowances: {} };
  }
}

// 月ごとの給与集計(対象月は "YYYY-MM"。省略時は今月)
router.get('/payroll', async (req, res, next) => {
  try {
    const month = req.query.month || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const range = payroll.monthRangeIso(month);
    if (!range) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });

    const rates = await loadRates();
    const employees = await db.all(
      'SELECT id, employee_code, name, role, active, division, hourly_wage, tax_table, dependents, social_insurance, labor_insurance FROM employees ORDER BY employee_code'
    );
    // 日をまたぐ勤務を正しく集計するため、前後1日ぶん多めに取得する
    const from = new Date(new Date(range.startIso).getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(new Date(range.endIso).getTime() + 24 * 3600 * 1000).toISOString();
    const logs = await db.all(
      'SELECT employee_id, type, timestamp FROM attendance_logs WHERE timestamp >= ? AND timestamp < ?',
      [from, to]
    );
    const byEmployee = new Map();
    for (const l of logs) {
      if (!byEmployee.has(l.employee_id)) byEmployee.set(l.employee_id, []);
      byEmployee.get(l.employee_id).push(l);
    }

    const adjRows = await db.all('SELECT * FROM payroll_adjustments WHERE month = ?', [month]);
    const adjByEmployee = new Map(adjRows.map((a) => [a.employee_id, parseAdjustments(a)]));
    const dedRows = await db.all('SELECT * FROM payroll_deductions WHERE month = ?', [month]);
    const dedByEmployee = new Map(dedRows.map((d) => [d.employee_id, d]));

    const rows = employees
      .map((e) => ({
        id: e.id,
        employee_code: e.employee_code,
        name: e.name,
        division: e.division,
        active: e.active,
        hourly_wage: e.hourly_wage,
        tax_table: e.tax_table,
        dependents: e.dependents,
        social_insurance: e.social_insurance,
        labor_insurance: e.labor_insurance,
        ...payroll.finalizeEmployee(
          payroll.calculateEmployee(byEmployee.get(e.id) || [], e.hourly_wage, rates, month),
          adjByEmployee.get(e.id),
          e.hourly_wage,
          rates
        ),
      }))
      .map((r) => {
        const dedRow = dedByEmployee.get(r.id);
        const tax = payroll.applyIncomeTax(dedRow, r, r, month, dedRow && dedRow.income_tax_manual);
        const deductionsTotal = payroll.sumDeductions(tax.deductions);
        return {
          ...r,
          income_tax: tax.deductions.income_tax,
          income_tax_auto: tax.income_tax_auto,
          deductions_total: deductionsTotal,
          net_pay: r.total_pay - deductionsTotal,
        };
      })
      // 無効な社員は、その月に勤務がある場合だけ表示する
      .filter((r) => r.active || r.total_minutes > 0);

    res.json({ month, rates, rows });
  } catch (err) {
    next(err);
  }
});

// 個人の給与明細書(対象月の集計と日別の内訳)
router.get('/payroll/:id/slip', async (req, res, next) => {
  try {
    const month = req.query.month;
    const range = payroll.monthRangeIso(month);
    if (!range) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });

    const emp = await db.get(
      'SELECT id, employee_code, name, role, division, hourly_wage, tax_table, dependents, social_insurance, labor_insurance FROM employees WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!emp) return res.status(404).json({ error: '社員が見つかりません。' });

    const rates = await loadRates();
    const from = new Date(new Date(range.startIso).getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(new Date(range.endIso).getTime() + 24 * 3600 * 1000).toISOString();
    const logs = await db.all(
      'SELECT type, timestamp FROM attendance_logs WHERE employee_id = ? AND timestamp >= ? AND timestamp < ?',
      [emp.id, from, to]
    );

    const dedRow = await db.get('SELECT * FROM payroll_deductions WHERE employee_id = ? AND month = ?', [emp.id, month]);
    const deductions = { ...payroll.emptyDeductions(), ...Object.fromEntries(payroll.DEDUCTION_ITEMS.map((i) => [i.key, dedRow ? Number(dedRow[i.key]) || 0 : 0])) };
    const computed = payroll.calculateEmployee(logs, emp.hourly_wage, rates, month);
    const adjRow = await db.get('SELECT * FROM payroll_adjustments WHERE employee_id = ? AND month = ?', [emp.id, month]);
    const adjustments = parseAdjustments(adjRow);
    const summary = payroll.finalizeEmployee(computed, adjustments, emp.hourly_wage, rates);
    const tax = payroll.applyIncomeTax(deductions, summary, emp, month, dedRow && dedRow.income_tax_manual);
    const deductionsTotal = payroll.sumDeductions(tax.deductions);

    res.json({
      month,
      issued_on: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      employee: {
        id: emp.id, employee_code: emp.employee_code, name: emp.name, division: emp.division, hourly_wage: emp.hourly_wage,
        tax_table: emp.tax_table, dependents: emp.dependents,
        social_insurance: emp.social_insurance, labor_insurance: emp.labor_insurance,
      },
      rates,
      summary,
      computed,
      overrides: adjustments.overrides,
      allowance_items: payroll.ALLOWANCE_ITEMS,
      deduction_items: payroll.DEDUCTION_ITEMS,
      deductions: tax.deductions,
      income_tax_auto: tax.income_tax_auto,
      income_tax_base: tax.income_tax_base,
      income_tax_year: payroll.taxTableFor(month).year,
      deductions_total: deductionsTotal,
      net_pay: summary.total_pay - deductionsTotal,
      days: payroll.dailyBreakdown(logs, month),
    });
  } catch (err) {
    next(err);
  }
});

// 給与明細の編集(勤怠・支給・控除をまとめて保存)
//   overrides  … 勤怠・支給の修正値。空欄(null)は自動計算の値を使う
//   allowances … 手当(空欄は0円)
//   deductions … 控除(空欄は0円)
router.put('/payroll/:id/slip', async (req, res, next) => {
  try {
    const { month, overrides = {}, allowances = {}, deductions = {} } = req.body || {};
    if (!payroll.monthRangeIso(month)) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });
    const emp = await db.get('SELECT id, tax_table FROM employees WHERE id = ?', [Number(req.params.id)]);
    if (!emp) return res.status(404).json({ error: '社員が見つかりません。' });

    const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
    const parseInt0 = (v, max, label) => {
      const text = String(v).trim();
      if (!/^\d{1,9}$/.test(text) || Number(text) > max) return { error: `${label}は0〜${max.toLocaleString('ja-JP')}の半角数字で入力してください。` };
      return { value: Number(text) };
    };

    const LABELS = {
      work_days: '出勤日数', total_minutes: '総勤務時間', overtime_minutes: '時間外', night_minutes: '深夜', holiday_minutes: '休日',
      base_pay: '基本給', overtime_pay: '時間外手当', night_pay: '深夜手当', holiday_pay: '休日手当',
    };
    const cleanOverrides = {};
    for (const key of [...payroll.ATTENDANCE_KEYS, ...payroll.PAY_KEYS]) {
      if (isBlank(overrides[key])) continue;
      const max = key === 'work_days' ? 31 : key.endsWith('_minutes') ? 44640 : 99999999;
      const r = parseInt0(overrides[key], max, LABELS[key]);
      if (r.error) return res.status(400).json({ error: r.error });
      cleanOverrides[key] = r.value;
    }
    const cleanAllowances = {};
    for (const item of payroll.ALLOWANCE_ITEMS) {
      const r = isBlank(allowances[item.key]) ? { value: 0 } : parseInt0(allowances[item.key], 9999999, item.label);
      if (r.error) return res.status(400).json({ error: r.error });
      cleanAllowances[item.key] = r.value;
    }
    const cleanDeductions = {};
    for (const item of payroll.DEDUCTION_ITEMS) {
      const r = isBlank(deductions[item.key]) ? { value: 0 } : parseInt0(deductions[item.key], 9999999, item.label);
      if (r.error) return res.status(400).json({ error: r.error });
      cleanDeductions[item.key] = r.value;
    }

    // 所得税が空欄なら自動計算に切り替える。乙欄の社員は自動計算できないので、入力値(空欄は0円)を使う
    const incomeTaxManual = emp.tax_table === 'otsu' || !isBlank(deductions.income_tax) ? 1 : 0;
    if (!incomeTaxManual) cleanDeductions.income_tax = 0;

    await db.withTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO payroll_adjustments (employee_id, month, data) VALUES (?, ?, ?)
         ON CONFLICT (employee_id, month) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [emp.id, month, JSON.stringify({ overrides: cleanOverrides, allowances: cleanAllowances })]
      );
      const d = cleanDeductions;
      await tx.run(
        `INSERT INTO payroll_deductions (employee_id, month, health_insurance, pension, employment_insurance, income_tax, income_tax_manual, resident_tax, other)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (employee_id, month) DO UPDATE SET
           health_insurance = EXCLUDED.health_insurance, pension = EXCLUDED.pension,
           employment_insurance = EXCLUDED.employment_insurance, income_tax = EXCLUDED.income_tax,
           income_tax_manual = EXCLUDED.income_tax_manual,
           resident_tax = EXCLUDED.resident_tax, other = EXCLUDED.other, updated_at = now()`,
        [emp.id, month, d.health_insurance, d.pension, d.employment_insurance, d.income_tax, incomeTaxManual, d.resident_tax, d.other]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// 時給の保存(複数人まとめて)。空欄・null は未設定に戻す
router.put('/payroll/wages', async (req, res, next) => {
  try {
    const { wages } = req.body || {};
    if (!Array.isArray(wages) || wages.length === 0) {
      return res.status(400).json({ error: '保存する時給がありません。' });
    }
    // 各行は時給・税区分・扶養親族等の数のうち、変更した項目だけを持つ
    const parsed = [];
    for (const w of wages) {
      const r = parsePayFields(w);
      if (r.error) return res.status(400).json({ error: r.error });
      parsed.push({ id: Number(w.id), fields: r.value });
    }
    await db.withTransaction(async (tx) => {
      for (const { id, fields } of parsed) {
        for (const [column, value] of Object.entries(fields)) {
          await tx.run(`UPDATE employees SET ${column} = ? WHERE id = ?`, [value, id]);
        }
      }
    });
    res.json({ updated: wages.length });
  } catch (err) {
    next(err);
  }
});

// 割増率(%)の保存
router.put('/payroll/rates', async (req, res, next) => {
  try {
    const rates = {};
    for (const name of Object.keys(RATE_KEYS)) {
      const v = Number((req.body || {})[name]);
      if (!Number.isFinite(v) || v < 0 || v > 200) {
        return res.status(400).json({ error: '割増率は0〜200の数字(%)で入力してください。' });
      }
      rates[name] = v;
    }
    for (const [name, key] of Object.entries(RATE_KEYS)) await db.setSetting(key, String(rates[name]));
    res.json({ rates });
  } catch (err) {
    next(err);
  }
});

// ---- スプレッドシート連携(リアルタイムバックアップ) ----

router.get('/sheets/status', (req, res) => {
  res.json({ configured: sheetsSync.isConfigured() });
});

// データベースの現在の打刻データ全件でスプレッドシートの内容を丸ごと置き換える
// (初回バックアップ、または編集・削除でシートとズレが生じた場合の手動再同期用)
router.post('/sheets/sync-all', async (req, res, next) => {
  try {
    if (!sheetsSync.isConfigured()) {
      return res.status(400).json({ error: 'スプレッドシート連携が設定されていません。SHEETS_WEBHOOK_URLを設定してください。' });
    }

    const logs = await db.all(`
      SELECT attendance_logs.*, employees.name AS employee_name, employees.employee_code
      FROM attendance_logs
      JOIN employees ON employees.id = attendance_logs.employee_id
      ORDER BY attendance_logs.timestamp ASC
    `);

    const payload = logs.map((l) => ({
      employee_code: l.employee_code,
      employee_name: l.employee_name,
      type: l.type,
      type_label: TYPE_LABELS[l.type],
      site_division: l.site_division || '',
      site_name: l.note || '',
      remarks: l.remarks || '',
      input_method_label: INPUT_METHOD_LABELS[l.input_method] || INPUT_METHOD_LABELS.clock,
      timestamp: l.timestamp,
      timestamp_jst: new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
    }));

    const result = await sheetsSync.replaceAllLogsInSheet(payload);
    if (!result.ok) {
      return res.status(502).json({ error: 'スプレッドシートへの同期に失敗しました。', detail: result.error || `HTTP ${result.status}` });
    }

    res.json({ ok: true, synced: payload.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
