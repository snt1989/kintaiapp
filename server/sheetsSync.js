// Googleスプレッドシートへのリアルタイムバックアップ連携
// Google Apps Script の Web App(doPost)をWebhookとして利用する。
// (サービスアカウントやGoogle Cloud APIの有効化が不要で、Googleスプレッドシートの画面だけで設定できるため)
//
// Vercelの環境変数:
//   SHEETS_WEBHOOK_URL    … Apps ScriptのWebアプリURL(未設定なら連携自体を行わない)
//   SHEETS_WEBHOOK_SECRET … Apps Script側に設定した合言葉と同じ文字列
//
// 詳しい設定手順はREADME.mdを参照してください。

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_WEBHOOK_SECRET = process.env.SHEETS_WEBHOOK_SECRET || '';

function isConfigured() {
  return !!SHEETS_WEBHOOK_URL;
}

async function postToSheet(body, timeoutMs = 8000) {
  if (!SHEETS_WEBHOOK_URL) {
    return { ok: false, skipped: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SHEETS_WEBHOOK_SECRET, ...body }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`スプレッドシート同期エラー(HTTP ${res.status}):`, text);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    // 打刻・管理操作そのものは失敗させたくないため、ここでは例外を投げずログのみ出す
    console.error('スプレッドシート同期に失敗しました:', err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// 1件の打刻をリアルタイムでシートに追加する
async function appendLogToSheet(log) {
  return postToSheet({ action: 'append', log });
}

// データベースの現在の内容でシートを丸ごと置き換える(初回バックアップ・ズレの解消用)
async function replaceAllLogsInSheet(logs) {
  return postToSheet({ action: 'replace_all', logs });
}

module.exports = { isConfigured, appendLogToSheet, replaceAllLogsInSheet };
