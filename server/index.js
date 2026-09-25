// ローカル/Docker実行用のエントリポイント(静的ファイル配信 + サーバー起動)
// Vercelへのデプロイでは代わりに /api/index.js が使われ、静的ファイルはVercelが直接配信する
const path = require('path');
const express = require('express');
const app = require('./app');

const PORT = process.env.PORT || 3000;

// フロントエンド(静的ファイル)を配信
app.use(express.static(path.join(__dirname, '..', 'public')));

// 存在しないパスはindex.htmlへ(APIパスは除く)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`三桜 勤怠管理システム起動: http://localhost:${PORT}`);
});
