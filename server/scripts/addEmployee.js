// 一般社員アカウントを作成するスクリプト(管理画面からも登録可能です)
// 使い方: node server/scripts/addEmployee.js <社員番号> <氏名> <パスワード> [事業部]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

const [, , employeeCode, name, password, division] = process.argv;

async function main() {
  if (!employeeCode || !name || !password) {
    console.log('使い方: node server/scripts/addEmployee.js <社員番号> <氏名> <パスワード> [事業部]');
    process.exitCode = 1;
    return;
  }

  if (password.length < 3) {
    console.error('エラー: パスワードは3文字以上にしてください。');
    process.exitCode = 1;
    return;
  }

  await db.ensureSchema();

  const existing = await db.get('SELECT id FROM employees WHERE employee_code = ?', [employeeCode]);
  if (existing) {
    console.error(`エラー: 社員番号 ${employeeCode} は既に登録されています。`);
    process.exitCode = 1;
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await db.run('INSERT INTO employees (employee_code, name, password_hash, role, division) VALUES (?, ?, ?, ?, ?)', [
    employeeCode,
    name,
    hash,
    'employee',
    division || null,
  ]);

  console.log(`社員アカウントを作成しました: 社員番号=${employeeCode}, 氏名=${name}` + (division ? `, 事業部=${division}` : ''));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
