// データベースのスキーマを作成/更新するスクリプト
// 使い方: node server/scripts/migrate.js
require('dotenv').config();
const db = require('../db');

(async () => {
  try {
    await db.ensureSchema();
    console.log('データベースのスキーマ準備が完了しました。');
  } catch (err) {
    console.error('スキーマの初期化に失敗しました:', err);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
