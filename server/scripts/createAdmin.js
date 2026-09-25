// 初期管理者アカウントを作成するスクリプト
// 使い方: node server/scripts/createAdmin.js <社員番号> <氏名> <パスワード>
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

const [, , employeeCode, name, password] = process.argv;

async function main() {
  if (!employeeCode || !name || !password) {
    console.log('使い方: node server/scripts/createAdmin.js <社員番号> <氏名> <パスワード>');
    console.log('例:     node server/scripts/createAdmin.js A0001 "山田太郎" "ChangeMe123"');
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
  const hash = bcrypt.hashSync(password, 10);

  if (existing) {
    await db.run('UPDATE employees SET name = ?, password_hash = ?, role = ?, active = 1 WHERE id = ?', [
      name,
      hash,
      'admin',
      existing.id,
    ]);
    console.log(`既存の社員番号 ${employeeCode} を管理者として更新しました。`);
  } else {
    await db.run('INSERT INTO employees (employee_code, name, password_hash, role) VALUES (?, ?, ?, ?)', [
      employeeCode,
      name,
      hash,
      'admin',
    ]);
    console.log(`管理者アカウントを作成しました: 社員番号=${employeeCode}, 氏名=${name}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
