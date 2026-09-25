// Express アプリケーション本体(ルーティング定義)
// ローカル実行(server/index.js)とVercelサーバーレス関数(api/index.js)の両方から読み込む
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const db = require('./db');
const authRoutes = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());

// APIリクエストごとにDBスキーマの準備ができていることを保証する
// (サーバーレス環境ではコールドスタート時に1度だけ初期化処理が走る)
app.use('/api', async (req, res, next) => {
  try {
    await db.ensureSchema();
    next();
  } catch (err) {
    console.error('DBスキーマの初期化に失敗しました:', err);
    res.status(500).json({ error: 'データベースに接続できませんでした。しばらくしてから再度お試しください。' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 共通エラーハンドラ
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'サーバーでエラーが発生しました。' });
});

module.exports = app;
