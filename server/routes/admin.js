const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { combineName } = require('../nameUtil');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const TYPE_LABELS = {
  clock_in: '出勤',
  clock_out: '退勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
};

// ---- マスタ管理 ----

// 権限マスタ(固定): システムの動作に直結するため、追加・削除はできません
const ROLE_MASTER = [
  { value: 'employee', label: '一般社員' },
  { value: 'admin', label: '管理者' },
];

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
    const roleValue = role === 'admin' ? 'admin' : 'employee';
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
    const nextRole = role === 'admin' || role === 'employee' ? role : employee.role;
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
    res.json({ logs: logs.map((l) => ({ ...l, label: TYPE_LABELS[l.type] })) });
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

    const header = '社員番号,氏名,種別,事業部,現場名,備考,日時(JST)\n';
    const rows = logs.map((l) => {
      const jst = new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      return [l.employee_code, l.employee_name, TYPE_LABELS[l.type], l.site_division || '', l.note || '', l.remarks || '', jst]
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

module.exports = router;
