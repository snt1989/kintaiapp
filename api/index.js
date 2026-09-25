// Vercel サーバーレス関数のエントリポイント
// /api/(.*) へのリクエストは vercel.json の rewrites によりこの関数へ渡される
// 静的ファイル(public/配下)はVercelが直接配信するため、ここではAPIルートのみを扱う
module.exports = require('../server/app');
