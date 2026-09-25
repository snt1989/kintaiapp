// 氏名(姓・名)関連のユーティリティ
// 姓・名を受け取り、表示・検索用に結合した氏名を返す
function combineName(lastName, firstName) {
  return [lastName, firstName]
    .map((v) => (v ? String(v).trim() : ''))
    .filter(Boolean)
    .join(' ');
}

module.exports = { combineName };
