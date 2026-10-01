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

// 権限マスタ(固定): システムの動作に直結するため、追加・削除はできません
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

const EMPLOYEE_COLUMNS = 'id, employee_code, name, last_name, first_name, role, active, division, created_at';

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

    const lastNameValue = String(last_name).trim();
    const firstNameValue = String(first_name).trim();
    const nameValue = combineName(lastNameValue, firstNameValue);
    const hash = bcrypt.hashSync(password, 10);
    const inserted = await db.get(
      'INSERT INTO employees (employee_code, name, last_name, first_name, password_hash, role, division) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [String(employee_code).trim(), nameValue, lastNameValue, firstNameValue, hash, roleValue, divisionValue]
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

    await db.run(
      'UPDATE employees SET employee_code = ?, name = ?, last_name = ?, first_name = ?, role = ?, active = ?, division = ? WHERE id = ?',
      [nextCode, nextName, nextLastName, nextFirstName, nextRole, nextActive, nextDivision, id]
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

// 月ごとの給与集計(対象月は "YYYY-MM"。省略時は今月)
router.get('/payroll', async (req, res, next) => {
  try {
    const month = req.query.month || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const range = payroll.monthRangeIso(month);
    if (!range) return res.status(400).json({ error: '対象月の形式が正しくありません(例: 2026-09)。' });

    const rates = await loadRates();
    const employees = await db.all(
      'SELECT id, employee_code, name, role, active, division, hourly_wage FROM employees ORDER BY employee_code'
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

    const rows = employees
      .map((e) => ({
        id: e.id,
        employee_code: e.employee_code,
        name: e.name,
        division: e.division,
        active: e.active,
        hourly_wage: e.hourly_wage,
        ...payroll.calculateEmployee(byEmployee.get(e.id) || [], e.hourly_wage, rates, month),
      }))
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
      'SELECT id, employee_code, name, role, division, hourly_wage FROM employees WHERE id = ?',
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

    res.json({
      month,
      issued_on: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
      employee: { id: emp.id, employee_code: emp.employee_code, name: emp.name, division: emp.division, hourly_wage: emp.hourly_wage },
      rates,
      summary: payroll.calculateEmployee(logs, emp.hourly_wage, rates, month),
      days: payroll.dailyBreakdown(logs, month),
    });
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
    for (const w of wages) {
      const raw = w.hourly_wage;
      if (raw !== null && raw !== '' && raw !== undefined && (!/^\d{1,6}$/.test(String(raw)))) {
        return res.status(400).json({ error: '時給は半角数字(円)で入力してください(例: 1500)。' });
      }
    }
    await db.withTransaction(async (tx) => {
      for (const w of wages) {
        const value = w.hourly_wage === null || w.hourly_wage === '' || w.hourly_wage === undefined ? null : Number(w.hourly_wage);
        await tx.run('UPDATE employees SET hourly_wage = ? WHERE id = ?', [value, Number(w.id)]);
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
