// server/payroll.js を public/js/demo-mock.js の埋め込みコピーに同期する
//   使い方: node server/scripts/syncDemoPayroll.js          (同期する)
//           node server/scripts/syncDemoPayroll.js --check  (ずれていれば終了コード1)
// demo-mock.js の <payroll:begin> 〜 <payroll:end> の間は自動生成なので、直接編集しないこと。
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'payroll.js');
const TARGET = path.join(__dirname, '..', '..', 'public', 'js', 'demo-mock.js');
const BEGIN = '// <payroll:begin>';
const END = '// <payroll:end>';

const source = fs.readFileSync(SOURCE, 'utf8').replace(/\s+$/, '');
const body = source
  .split('\n')
  .map((line) => (line ? `  ${line}` : line))
  .join('\n');

const block = [
  `${BEGIN} (自動生成: node server/scripts/syncDemoPayroll.js / server/payroll.js のコピー。直接編集しない)`,
  'function loadPayroll() {',
  '  const module = { exports: {} };',
  body,
  '  return module.exports;',
  '}',
  END,
].join('\n');

const current = fs.readFileSync(TARGET, 'utf8');
const start = current.indexOf(BEGIN);
const stop = current.indexOf(END);
if (start === -1 || stop === -1 || stop < start) {
  console.error('demo-mock.js に <payroll:begin> / <payroll:end> の目印が見つかりません。');
  process.exit(2);
}
const next = current.slice(0, start) + block + current.slice(stop + END.length);

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('demo-mock.js の payroll コピーが server/payroll.js と一致していません。同期してください。');
    process.exit(1);
  }
  console.log('demo-mock.js の payroll コピーは最新です。');
} else if (next === current) {
  console.log('変更なし(すでに同期済み)。');
} else {
  fs.writeFileSync(TARGET, next);
  console.log('demo-mock.js に server/payroll.js を同期しました。');
}
