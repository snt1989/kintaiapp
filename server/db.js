// PostgreSQL(Vercel Postgres / Neon 等)接続モジュール
// better-sqlite3(ローカルファイル)からの移行版。Vercelのサーバーレス環境では
// ファイルシステムが永続化されないため、クラウド型のPostgreSQLを使用する。
const { Pool } = require('pg');

const connectionString =
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  // 起動時に気づけるよう警告のみ出す(実際のクエリ実行時にエラーになる)
  console.warn(
    '警告: POSTGRES_URL (または DATABASE_URL) が設定されていません。.env または Vercel の環境変数を確認してください。'
  );
}

const pool = new Pool({
  connectionString,
  // Neon / Vercel Postgres は SSL 必須。ローカルの自己署名証明書でも接続できるようにする。
  ssl: connectionString && /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('PostgreSQL接続プールでエラーが発生しました:', err);
});

// 生SQL実行(?プレースホルダはPostgresの$1,$2,...形式に自動変換する)
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function query(sql, params = []) {
  return pool.query(toPgPlaceholders(sql), params);
}

// SELECT: 先頭1行だけ取得(該当なしはnull)
async function get(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

// SELECT: 全件取得
async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

// INSERT/UPDATE/DELETE: 影響件数(changes)を返す。IDが必要な場合はSQL側で `RETURNING id` を付けること
async function run(sql, params = []) {
  const result = await query(sql, params);
  return { changes: result.rowCount, rows: result.rows };
}

// 複数クエリをひとつのトランザクションでまとめて実行する
// fn には { query, get, all, run } と同じ形のクライアント専用ヘルパーを渡す
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txHelpers = {
      query: (sql, params = []) => client.query(toPgPlaceholders(sql), params),
      get: async (sql, params = []) => (await client.query(toPgPlaceholders(sql), params)).rows[0] || null,
      all: async (sql, params = []) => (await client.query(toPgPlaceholders(sql), params)).rows,
      run: async (sql, params = []) => {
        const r = await client.query(toPgPlaceholders(sql), params);
        return { changes: r.rowCount, rows: r.rows };
      },
    };
    const result = await fn(txHelpers);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// スキーマ初期化(初回接続時に1度だけ実行する。既存テーブルには影響しない)
let schemaReadyPromise = null;
function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS employees (
          id SERIAL PRIMARY KEY,
          employee_code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
          active INTEGER NOT NULL DEFAULT 1,
          division TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS attendance_logs (
          id SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id),
          type TEXT NOT NULL CHECK (type IN ('clock_in','clock_out','break_start','break_end')),
          timestamp TEXT NOT NULL,
          note TEXT,
          remarks TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_logs_employee_time ON attendance_logs(employee_id, timestamp);`);

      await query(`
        CREATE TABLE IF NOT EXISTS divisions (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      // 将来的なスキーマ変更にも耐えられるよう、念のため列の存在確認も行う
      await query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS division TEXT;`);
      await query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS remarks TEXT;`);
      await query(`ALTER TABLE divisions ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;`);

      // 既存社員が使用している事業部名を、事業部マスタに未登録なら自動的に取り込む
      const used = await all(
        "SELECT DISTINCT division FROM employees WHERE division IS NOT NULL AND division <> ''"
      );
      for (const row of used) {
        await query('INSERT INTO divisions (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [row.division]);
      }

      // 並び順の初期化: 全件が初期値(0)のままであれば、名前順で並び順を割り振る
      const { cnt: divisionCount } = await get('SELECT COUNT(*) AS cnt FROM divisions');
      const { cnt: nonZeroCount } = await get('SELECT COUNT(*) AS cnt FROM divisions WHERE sort_order <> 0');
      if (Number(divisionCount) > 0 && Number(nonZeroCount) === 0) {
        const rows = await all('SELECT id FROM divisions ORDER BY name');
        for (let i = 0; i < rows.length; i += 1) {
          await query('UPDATE divisions SET sort_order = ? WHERE id = ?', [i + 1, rows[i].id]);
        }
      } else if (Number(divisionCount) > 0) {
        const zeroRows = await all('SELECT id FROM divisions WHERE sort_order = 0 ORDER BY name');
        if (zeroRows.length > 0) {
          const { m: maxOrder } = await get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM divisions');
          for (let i = 0; i < zeroRows.length; i += 1) {
            await query('UPDATE divisions SET sort_order = ? WHERE id = ?', [Number(maxOrder) + i + 1, zeroRows[i].id]);
          }
        }
      }
    })().catch((err) => {
      schemaReadyPromise = null; // 失敗した場合は次回リクエストで再試行できるようにする
      throw err;
    });
  }
  return schemaReadyPromise;
}

module.exports = { pool, query, get, all, run, withTransaction, ensureSchema };
