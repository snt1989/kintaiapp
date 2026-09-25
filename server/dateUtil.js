// 日本標準時(JST, UTC+9, サマータイムなし)関連のユーティリティ
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDate(date) {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

// 指定した日時(Date)のJSTでの日付文字列 "YYYY-MM-DD" を返す
function jstDateString(date) {
  const jst = toJstDate(date);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 今日(JST)の開始・終了をUTCのISO文字列で返す
function jstTodayRangeUtcIso() {
  const now = new Date();
  const todayStr = jstDateString(now);
  const startJst = new Date(`${todayStr}T00:00:00+09:00`);
  const endJst = new Date(startJst.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: startJst.toISOString(), endIso: endJst.toISOString(), todayStr };
}

module.exports = { jstDateString, jstTodayRangeUtcIso };
