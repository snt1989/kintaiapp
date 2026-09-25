// 初期管理者アカウントを作成するスクリプト
// 使い方: node server/scripts/createAdmin.js <社員番号> <氏名> <パスワード>
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { combineName } = require('../nameUtil');

const [, , employeeCode, name, password] = process.argv;
// "山田 太郎" のように姓名をスペース区切りで受け取り、姓・名に分割して保存する
const [lastName, ...rest] = (name || '').trim().split(/\s+/);
const firstName = rest.join(' ');

async function main() {
  if (!employeeCode || !name || !password) {
    console.log('使い方: node server/scripts/createAdmin.js <社員番号> "<姓> <名>" <パスワード>');
    console.log('例:     node server/scripts/createAdmin.js A0001 "山田 太郎" "ChangeMe123"');
    process.exitCode = 1;
    return;
  }
  if (!firstName) {
    console.error('エラー: 氏名は "姓 名" のようにスペースで区切って指定してください(例: "山田 太郎")。');
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

  const fullName = combineName(lastName, firstName);

  if (existing) {
    await db.run(
      'UPDATE employees SET name = ?, last_name = ?, first_name = ?, password_hash = ?, role = ?, active = 1 WHERE id = ?',
      [fullName, lastName, firstName, hash, 'admin', existing.id]
    );
    console.log(`既存の社員番号 ${employeeCode} を管理者として更新しました。`);
  } else {
    await db.run(
      'INSERT INTO employees (employee_code, name, last_name, first_name, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [employeeCode, fullName, lastName, firstName, hash, 'admin']
    );
    console.log(`管理者アカウントを作成しました: 社員番号=${employeeCode}, 氏名=${fullName}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
