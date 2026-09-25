const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// 社員登録画面用: 事業部の選択肢一覧(未ログインでも取得可能)
router.get('/divisions', async (req, res, next) => {
  try {
    const divisions = await db.all('SELECT id, name FROM divisions ORDER BY sort_order, name');
    res.json({ divisions });
  } catch (err) {
    next(err);
  }
});

// 次に使う社員番号を自動採番する(E0001, E0002, ... の形式)
async function generateEmployeeCode() {
  const rows = await db.all("SELECT employee_code FROM employees WHERE employee_code LIKE 'E%'");
  let maxNum = 0;
  for (const row of rows) {
    const m = /^E(\d+)$/.exec(row.employee_code);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `E${String(maxNum + 1).padStart(4, '0')}`;
}

// 従業員による自己登録(社員番号は自動採番、権限は常に一般社員)
router.post('/register', async (req, res, next) => {
  try {
    const { name, password, division } = req.body || {};
    if (!name || !String(name).trim() || !password) {
      return res.status(400).json({ error: '氏名とパスワードを入力してください。' });
    }
    if (String(password).length < 3) {
      return res.status(400).json({ error: 'パスワードは3文字以上にしてください。' });
    }

    const divisionValue = division ? String(division).trim() : null;
    if (divisionValue && !(await db.get('SELECT id FROM divisions WHERE name = ?', [divisionValue]))) {
      return res.status(400).json({ error: '選択した事業部が見つかりません。' });
    }

    const hash = bcrypt.hashSync(password, 10);

    let employee = null;
    for (let attempt = 0; attempt < 5 && !employee; attempt += 1) {
      const code = await generateEmployeeCode();
      try {
        employee = await db.get(
          'INSERT INTO employees (employee_code, name, password_hash, role, active, division) VALUES (?, ?, ?, ?, 1, ?) RETURNING *',
          [code, String(name).trim(), hash, 'employee', divisionValue]
        );
      } catch (err) {
        // 採番の競合(同時登録などで社員番号が重複)の場合のみ再試行する
        if (err && err.code === '23505') continue;
        throw err;
      }
    }

    if (!employee) {
      return res.status(500).json({ error: '社員番号の採番に失敗しました。もう一度お試しください。' });
    }

    const token = signToken(employee);
    res.json({
      token,
      employee: {
        id: employee.id,
        employee_code: employee.employee_code,
        name: employee.name,
        role: employee.role,
        division: employee.division || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 初回セットアップが必要かどうか(社員が1人も登録されていないか)を確認する
router.get('/setup-status', async (req, res, next) => {
  try {
    const { cnt } = await db.get('SELECT COUNT(*) AS cnt FROM employees');
    res.json({ needsSetup: Number(cnt) === 0 });
  } catch (err) {
    next(err);
  }
});

// 初回セットアップ: 社員が1人も登録されていない場合のみ、管理者アカウントを作成できる
// (ターミナル操作なしでブラウザから初期管理者を作成するための専用エンドポイント)
router.post('/setup-admin', async (req, res, next) => {
  try {
    const { cnt } = await db.get('SELECT COUNT(*) AS cnt FROM employees');
    if (Number(cnt) > 0) {
      return res.status(403).json({ error: '初期セットアップは既に完了しています(社員が1人以上登録済みです)。' });
    }

    const { employee_code, name, password } = req.body || {};
    if (!employee_code || !String(employee_code).trim() || !name || !String(name).trim() || !password) {
      return res.status(400).json({ error: '社員番号・氏名・パスワードを入力してください。' });
    }
    if (String(password).length < 3) {
      return res.status(400).json({ error: 'パスワードは3文字以上にしてください。' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const employee = await db.get(
      'INSERT INTO employees (employee_code, name, password_hash, role, active) VALUES (?, ?, ?, ?, 1) RETURNING *',
      [String(employee_code).trim(), String(name).trim(), hash, 'admin']
    );

    const token = signToken(employee);
    res.json({
      token,
      employee: {
        id: employee.id,
        employee_code: employee.employee_code,
        name: employee.name,
        role: employee.role,
        division: employee.division || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ログイン: 社員番号 + パスワード
router.post('/login', async (req, res, next) => {
  try {
    const { employee_code, password } = req.body || {};
    if (!employee_code || !password) {
      return res.status(400).json({ error: '社員番号とパスワードを入力してください。' });
    }

    const employee = await db.get('SELECT * FROM employees WHERE employee_code = ?', [
      String(employee_code).trim(),
    ]);

    if (!employee || !employee.active) {
      return res.status(401).json({ error: '社員番号またはパスワードが正しくありません。' });
    }

    const ok = bcrypt.compareSync(password, employee.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '社員番号またはパスワードが正しくありません。' });
    }

    const token = signToken(employee);
    res.json({
      token,
      employee: {
        id: employee.id,
        employee_code: employee.employee_code,
        name: employee.name,
        role: employee.role,
        division: employee.division || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 現在ログイン中のユーザー情報
router.get('/me', requireAuth, (req, res) => {
  res.json({ employee: req.user });
});

// パスワード変更(本人)
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: '現在のパスワードと新しいパスワードを入力してください。' });
    }
    if (String(new_password).length < 3) {
      return res.status(400).json({ error: '新しいパスワードは3文字以上にしてください。' });
    }

    const employee = await db.get('SELECT * FROM employees WHERE id = ?', [req.user.id]);
    if (!employee || !bcrypt.compareSync(current_password, employee.password_hash)) {
      return res.status(401).json({ error: '現在のパスワードが正しくありません。' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [hash, employee.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
