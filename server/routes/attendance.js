const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { jstTodayRangeUtcIso } = require('../dateUtil');
const sheetsSync = require('../sheetsSync');

const router = express.Router();

const TYPE_LABELS = {
  clock_in: '出勤',
  clock_out: '退勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
};

const VALID_TYPES = Object.keys(TYPE_LABELS);

// 直近の打刻種別から、現在「勤務中」か「休憩中」かを判定する
// (出勤〜退勤、休憩開始〜休憩終了が必ず対になっている前提。対応関係はサーバー側でも検証する)
function deriveStatus(lastType) {
  switch (lastType) {
    case 'clock_in':
      return { onDuty: true, onBreak: false };
    case 'break_start':
      return { onDuty: true, onBreak: true };
    case 'break_end':
      return { onDuty: true, onBreak: false };
    case 'clock_out':
    default:
      return { onDuty: false, onBreak: false };
  }
}

async function getLastLogType(employeeId) {
  const row = await db.get(
    'SELECT type FROM attendance_logs WHERE employee_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
    [employeeId]
  );
  return row ? row.type : null;
}

// この打刻種別が、現在の状態から見て押せる操作かどうかを判定する
function isAllowed(type, status) {
  switch (type) {
    case 'clock_in':
      return !status.onDuty;
    case 'clock_out':
      return status.onDuty;
    case 'break_start':
      return status.onDuty && !status.onBreak;
    case 'break_end':
      return status.onBreak;
    default:
      return false;
  }
}

const STATUS_ERROR_MESSAGES = {
  clock_in: 'すでに出勤中です。先に退勤を打刻してください。',
  clock_out: 'まだ出勤していません。先に出勤を打刻してください。',
  break_start: '休憩を開始できません。出勤中かつ休憩中でない場合のみ打刻できます。',
  break_end: '休憩中ではないため、休憩終了を打刻できません。',
};

// 打刻登録(出勤/退勤/休憩開始/休憩終了)
router.post('/clock', requireAuth, async (req, res, next) => {
  try {
    const { type, note, remarks, site_division } = req.body || {};
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: '打刻種別が正しくありません。' });
    }

    // 現場の該当事業部は必須項目。事業部マスタに登録済みの値のみ許可する。
    const siteDivisionValue = site_division && String(site_division).trim() ? String(site_division).trim() : null;
    if (!siteDivisionValue) {
      return res.status(400).json({ error: '現場の該当事業部を選択してください。' });
    }
    const divisionExists = await db.get('SELECT id FROM divisions WHERE name = ?', [siteDivisionValue]);
    if (!divisionExists) {
      return res.status(400).json({ error: '指定された事業部はマスタに登録されていません。' });
    }

    const status = deriveStatus(await getLastLogType(req.user.id));
    if (!isAllowed(type, status)) {
      return res.status(409).json({ error: STATUS_ERROR_MESSAGES[type] });
    }

    // note列は現場名、remarks列は備考(任意メモ)として利用する
    const siteName = note && String(note).trim() ? String(note).trim() : null;
    const remarksText = remarks && String(remarks).trim() ? String(remarks).trim() : null;

    const timestamp = new Date().toISOString();
    const log = await db.get(
      'INSERT INTO attendance_logs (employee_id, type, timestamp, note, remarks, site_division) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
      [req.user.id, type, timestamp, siteName, remarksText, siteDivisionValue]
    );

    // バックアップ用: 設定されていればリアルタイムでスプレッドシートにも同期する
    // (失敗・タイムアウトしても打刻そのものは成功させる)
    if (sheetsSync.isConfigured()) {
      await sheetsSync.appendLogToSheet({
        employee_code: req.user.employee_code,
        employee_name: req.user.name,
        type,
        type_label: TYPE_LABELS[type],
        site_division: siteDivisionValue,
        site_name: siteName,
        remarks: remarksText,
        timestamp: log.timestamp,
        timestamp_jst: new Date(log.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      });
    }

    const newStatus = deriveStatus(type);
    res.json({ ok: true, log: { ...log, label: TYPE_LABELS[log.type] }, status: newStatus });
  } catch (err) {
    next(err);
  }
});

// 時間の直接入力(1日分をまとめて登録): 打刻し忘れなどの後追い入力用
// 出勤・退勤は必須、休憩開始・休憩終了は両方入力するか両方空欄にする。
// 同じ日に既に打刻がある場合は二重登録を防ぐため登録できない(修正は管理者が行う)。
router.post('/manual', requireAuth, async (req, res, next) => {
  try {
    const { date, clock_in, clock_out, break_start, break_end, note, remarks, site_division } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: '日付を入力してください。' });
    }
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRe.test(clock_in || '') || !timeRe.test(clock_out || '')) {
      return res.status(400).json({ error: '出勤時刻と退勤時刻を入力してください。' });
    }
    const hasBreakStart = !!break_start;
    const hasBreakEnd = !!break_end;
    if (hasBreakStart !== hasBreakEnd) {
      return res.status(400).json({ error: '休憩は開始・終了の両方を入力するか、両方とも空欄にしてください。' });
    }
    if (hasBreakStart && (!timeRe.test(break_start) || !timeRe.test(break_end))) {
      return res.status(400).json({ error: '休憩時刻の形式が正しくありません。' });
    }

    const toDate = (t) => new Date(`${date}T${t}:00+09:00`);
    const entries = [{ type: 'clock_in', at: toDate(clock_in) }];
    if (hasBreakStart) {
      entries.push({ type: 'break_start', at: toDate(break_start) }, { type: 'break_end', at: toDate(break_end) });
    }
    entries.push({ type: 'clock_out', at: toDate(clock_out) });

    if (entries.some((e) => Number.isNaN(e.at.getTime()))) {
      return res.status(400).json({ error: '日付または時刻の形式が正しくありません。' });
    }
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i].at.getTime() <= entries[i - 1].at.getTime()) {
        return res.status(400).json({ error: '時刻は「出勤 → 休憩開始 → 休憩終了 → 退勤」の順に、後の時刻になるよう入力してください。' });
      }
    }
    if (entries[entries.length - 1].at.getTime() > Date.now()) {
      return res.status(400).json({ error: '未来の時刻は入力できません。' });
    }

    const siteDivisionValue = site_division && String(site_division).trim() ? String(site_division).trim() : null;
    if (!siteDivisionValue) {
      return res.status(400).json({ error: '現場の該当事業部を選択してください。' });
    }
    if (!(await db.get('SELECT id FROM divisions WHERE name = ?', [siteDivisionValue]))) {
      return res.status(400).json({ error: '指定された事業部はマスタに登録されていません。' });
    }

    const dayStart = new Date(`${date}T00:00:00+09:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const existing = await db.get(
      'SELECT id FROM attendance_logs WHERE employee_id = ? AND timestamp >= ? AND timestamp < ? LIMIT 1',
      [req.user.id, dayStart.toISOString(), dayEnd.toISOString()]
    );
    if (existing) {
      return res.status(409).json({ error: 'その日には既に打刻があります。修正が必要な場合は管理者に連絡してください。' });
    }

    const siteName = note && String(note).trim() ? String(note).trim() : null;
    const remarksText = remarks && String(remarks).trim() ? String(remarks).trim() : null;

    const created = [];
    await db.withTransaction(async (tx) => {
      for (const e of entries) {
        const log = await tx.get(
          'INSERT INTO attendance_logs (employee_id, type, timestamp, note, remarks, site_division) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
          [req.user.id, e.type, e.at.toISOString(), siteName, remarksText, siteDivisionValue]
        );
        created.push(log);
      }
    });

    if (sheetsSync.isConfigured()) {
      for (const log of created) {
        await sheetsSync.appendLogToSheet({
          employee_code: req.user.employee_code,
          employee_name: req.user.name,
          type: log.type,
          type_label: TYPE_LABELS[log.type],
          site_division: siteDivisionValue,
          site_name: siteName,
          remarks: remarksText,
          timestamp: log.timestamp,
          timestamp_jst: new Date(log.timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
        });
      }
    }

    res.json({ ok: true, logs: created.map((l) => ({ ...l, label: TYPE_LABELS[l.type] })) });
  } catch (err) {
    next(err);
  }
});

// 本日の打刻状況(打刻一覧 + 現在の状態)
router.get('/today-status', requireAuth, async (req, res, next) => {
  try {
    const { startIso, endIso, todayStr } = jstTodayRangeUtcIso();
    const logs = await db.all(
      `SELECT * FROM attendance_logs
       WHERE employee_id = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC`,
      [req.user.id, startIso, endIso]
    );

    const status = deriveStatus(await getLastLogType(req.user.id));

    res.json({
      date: todayStr,
      logs: logs.map((l) => ({ ...l, label: TYPE_LABELS[l.type] })),
      status,
    });
  } catch (err) {
    next(err);
  }
});

// 自分の打刻履歴(期間指定)
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let query = 'SELECT * FROM attendance_logs WHERE employee_id = ?';
    const params = [req.user.id];

    if (from) {
      query += ' AND timestamp >= ?';
      params.push(new Date(`${from}T00:00:00+09:00`).toISOString());
    }
    if (to) {
      const toExclusive = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000);
      query += ' AND timestamp < ?';
      params.push(toExclusive.toISOString());
    }
    query += ' ORDER BY timestamp DESC LIMIT 500';

    const logs = await db.all(query, params);
    res.json({ logs: logs.map((l) => ({ ...l, label: TYPE_LABELS[l.type] })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
