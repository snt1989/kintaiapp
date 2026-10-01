# 株式会社三桜 勤怠管理システム

スマートフォンなどのブラウザから出退勤を打刻し、記録をサーバー(データベース)に保管する勤怠管理アプリです。

## 主な機能

- 社員: 社員番号+パスワードでログイン → 出勤/退勤/休憩開始/休憩終了の打刻、自分の打刻履歴の閲覧(スマホ対応)
- 管理者: 全社員の勤怠ログ閲覧・CSV出力、社員アカウントの追加・編集(パスワードリセット、権限変更、無効化)
- データはクラウド型データベース(PostgreSQL)に保存され、どの端末からアクセスしても同じデータを参照

## 技術構成

- バックエンド: Node.js + Express(Vercelではサーバーレス関数として動作)
- データベース: PostgreSQL(Vercel Postgres / Neon 等。`pg` パッケージで接続)
- 認証: JWT(トークン) + bcryptによるパスワードハッシュ化
- フロントエンド: 素のHTML/CSS/JavaScript(ビルド不要、スマホ表示対応。Vercelが静的ファイルとして直接配信)

---

## 1. ローカルで動かす(動作確認用)

事前にPostgreSQLデータベースを1つ用意してください(下記のいずれか)。

- [Neon](https://neon.tech)や[Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)などの無料クラウドPostgresを使う(接続文字列をそのまま使えるので簡単)
- `docker compose up -d db` でローカルにPostgresコンテナだけ起動する

```bash
# 依存パッケージのインストール
npm install

# .env ファイルを作成(JWT_SECRETとPOSTGRES_URLは必ず設定してください)
cp .env.example .env

# データベースのテーブルを作成
npm run migrate

# サーバー起動
npm start
```

ブラウザで `http://localhost:3000` を開くとログイン画面が表示されます。

### 初期管理者アカウントの作成

まだ社員が1人も登録されていない状態では誰もログインできないため、最初に管理者アカウントを作成します。

```bash
node server/scripts/createAdmin.js A0001 "管理者 太郎" "初期パスワード123"
```

- 第1引数: 社員番号
- 第2引数: 氏名(スペースを含む場合は引用符で囲む)
- 第3引数: パスワード(3文字以上)

作成後、この社員番号とパスワードでログインし、管理者ダッシュボードから他の社員を追加できます。

### 事業部の登録

社員登録画面の「事業部」欄は自由入力ではなく、事前にマスタ登録された事業部から選択する仕組みです。ログイン後、管理者ダッシュボードの「マスタ管理」タブから事業部(例: 製造事業部、営業事業部、管理本部など)を登録してください。事業部名を変更すると、その事業部に所属する社員のデータも自動的に更新されます。社員が所属している事業部は削除できません(先に該当社員の事業部を変更してください)。

---

## 2. Vercelへのデプロイ(推奨)

### 2-1. GitHubリポジトリを用意する

このフォルダの中身をGitHubリポジトリにpushしてください。

### 2-2. Vercelプロジェクトを作成する

1. [vercel.com](https://vercel.com) にログインし、「Add New → Project」から先ほどのリポジトリを選択してインポート
2. Framework Preset は「Other」のままでOK(ビルド設定は不要です。`vercel.json` が自動的に使われます)

### 2-3. データベース(Vercel Postgres)を接続する

1. Vercelプロジェクトの「Storage」タブ → 「Create Database」→「Postgres」(Neon)を選択して作成
2. 作成したデータベースをこのプロジェクトに接続(Connect Project)すると、`POSTGRES_URL` などの環境変数が自動的にプロジェクトへ追加されます

### 2-4. 環境変数を設定する

Vercelプロジェクトの「Settings → Environment Variables」で、以下を追加してください。

| 変数名 | 値 |
| --- | --- |
| `JWT_SECRET` | ランダムな長い文字列(例: `openssl rand -hex 32` で生成) |

`POSTGRES_URL` は 2-3 の手順で自動的に設定されるため、手動で設定する必要はありません。

### 2-5. デプロイする

環境変数を保存すると自動的に(または「Deploy」ボタンで)ビルド・デプロイが始まります。初回アクセス時にアプリがデータベースのテーブルを自動作成するため、追加の作業は不要です。

### 2-6. 初期管理者アカウントを作成する

デプロイ後、まだ社員が1人もいない状態では誰もログインできません。自分のPCから、Vercelに設定したものと同じ`POSTGRES_URL`を使って初期管理者を作成します。

```bash
# .envのPOSTGRES_URLをVercel上のものと同じ値にしてから実行
node server/scripts/createAdmin.js A0001 "管理者 太郎" "初期パスワード123"
```

作成後、デプロイされたURL(例: `https://your-app.vercel.app`)にアクセスし、この社員番号とパスワードでログインしてください。

### 補足: Vercelの無料枠について

Vercel Postgres(Neon)は無料枠があり、小〜中規模の勤怠データであれば問題なく収まります。データ量が増えてきた場合は、Vercelのダッシュボードから有料プランへのアップグレードをご検討ください。

---

## 3. その他のデプロイ方法(Docker)

Vercel以外の環境(自社サーバーや他のクラウド)にデプロイしたい場合は、Dockerでも動かせます。

```bash
docker compose up -d --build
```

- `docker-compose.yml` は、アプリ用コンテナと、データ永続化用のPostgresコンテナ(`attendance_pgdata`ボリューム)をまとめて起動します。
- 起動後、コンテナ内で下記コマンドを実行して初期管理者を作成してください。

```bash
docker compose exec attendance node server/scripts/createAdmin.js A0001 "管理者 太郎" "初期パスワード123"
```

- 環境変数 `JWT_SECRET` は必ず長いランダム文字列に変更してください(`docker-compose.yml` の環境変数、または `.env` で上書き可能)。
- このDockerイメージ(+外部のPostgres)を Render / Railway / Fly.io / AWS (ECS, App Runner) / GCP Cloud Run / さくらのクラウド などにデプロイすることも可能です。`POSTGRES_URL` を各サービスが提供するPostgresの接続文字列に差し替えてください。

### HTTPS化について

スマートフォンのブラウザから安心して使うために、必ずHTTPS(https://)でアクセスできるようにしてください。Vercel / Render / Railway / Fly.ioなどは標準でHTTPSが有効になります。自社サーバーに構築する場合は、Nginx等をリバースプロキシに置き、Let's Encryptなどで証明書を取得することをおすすめします。

---

## 4. 使い方

### 社員側

1. `https://(デプロイ先のURL)/` にスマートフォンやPCのブラウザでアクセス
2. 社員番号・パスワードでログイン
3. 「打刻」画面で出勤・休憩開始・休憩終了・退勤ボタンを押す
4. 「履歴」画面で自分の過去の打刻記録を確認

ホーム画面に追加(ブックマーク)しておくと、アプリのように起動できます。

### 管理者側

1. 管理者権限のアカウントでログイン(自動的に管理者ダッシュボードへ)
2. 「勤怠ログ」で社員・期間を絞り込んで確認、CSV出力で給与計算ソフト等へ連携可能
3. 「社員一覧」から社員の追加、氏名変更、権限変更(一般社員⇔管理者)、パスワードリセット、アカウント無効化が可能

### 給与計算(管理者)

管理者ダッシュボードの「給与計算」タブで、対象月ごとに社員の勤務時間と支給額の目安を確認できます。

- 社員ごとの時給(円)を画面上で入力して保存します。時給が未設定の社員の支給額は表示されません。
- 計算ルール: 基本給 = 時給 × 勤務時間(休憩を除く)。1日8時間を超えた分は時間外(+25%)、22時〜翌5時は深夜(+25%)、日曜の勤務は休日(+35%)として加算します。割増率は画面から変更できます。
- 勤務時間は日本時間で日ごとに集計し、日をまたぐ勤務は日付ごとに分けます。出勤のみで退勤がない勤務は集計に含めず、「退勤漏れ」と表示します。
- 「CSV出力」で、社員ごとの内訳(基本給・時間外・深夜・休日・支給額)を出力できます。
- 一覧の「明細書」から、個人別・月別の給与明細書(勤怠の集計、支給の内訳、日別の出勤・退勤・休憩)を開けます。「印刷する」で印刷できます。
- 一覧の「編集」(または明細書の「編集する」)で、勤怠・支給・控除を明細書ごとに修正できます。修正値を空欄にした項目は自動計算の値を使い、勤務時間を修正すると支給額は修正後の時間から再計算されます(支給額そのものを修正した場合はその金額を優先)。通勤手当・その他手当も入力できます。修正した項目は明細書に「*」、一覧に「修正あり」と表示されます。
- 控除欄には、健康保険料・厚生年金保険料・雇用保険料・住民税・その他を社員・月ごとに入力して保存します。控除合計と差引支給額が明細書と給与計算の一覧に表示されます。
- 所得税は自動で計算します。国税庁の源泉徴収税額表(月額表)・甲欄の「電算機計算の特例」の算式(令和8年分)を使い、支給額から社会保険料(健康保険料・厚生年金保険料・雇用保険料)と非課税の通勤手当(月額150,000円まで)を除いた金額と、社員ごとの扶養親族等の数(控除対象配偶者を含む)から求めます。令和9年分以降の月は、給与所得控除・基礎控除の最低額が変わった表で計算しますが、税率の表は令和8年分と同じものを使っています。年が変わったら国税庁の最新の表で確認してください。
  - 明細の編集ページで所得税の「自動計算」を外すと、金額を手入力できます(空欄にして自動計算に戻すこともできます)。この機能を追加する前に入力していた所得税は、手入力として残ります。
  - 乙欄の社員は自動計算の対象外で、手入力になります。税区分と扶養親族等の数は、給与計算の一覧で変更して「変更した内容を保存」します。
  - 年末調整・月の途中の入退社の扱い・障害者控除などは含みません。
- 給与計算画面の「社員情報を登録」から、社員番号・氏名・権限・事業部・時給・税区分・扶養親族等の数・初期パスワードを登録できます(社員管理の「社員を追加」でも登録できますが、時給と所得税の項目は給与計算側の画面で入力します)。
- 支給額は社会保険料・税・各種手当を含まない目安の計算です。実際の給与支給は就業規則や法令に沿って確認してください。

---

## 4.5 スプレッドシートへのリアルタイムバックアップ(任意)

打刻のたびにGoogleスプレッドシートへ自動でバックアップできます。Google Cloudのサービスアカウントなどは不要で、Googleスプレッドシートの「Apps Script」機能だけで設定できます。

### 手順

1. バックアップ先にしたいGoogleスプレッドシートを新規作成(または既存のものを用意)する。
2. スプレッドシートのメニューから「拡張機能」→「Apps Script」を開く。
3. デフォルトで入っているコードを全て削除し、以下のコードを貼り付ける。

   ```javascript
   // Googleスプレッドシート「拡張機能 > Apps Script」に貼り付けて使用します。
   const SECRET = 'ここに好きな合言葉を設定してください(Vercel側のSHEETS_WEBHOOK_SECRETと必ず同じ値にする)';
   const SHEET_NAME = '勤怠ログ';
   const HEADER = ['社員番号', '氏名', '種別', '事業部', '現場名', '備考', '日時(JST)', '入力方法'];

   function doPost(e) {
     const body = JSON.parse(e.postData.contents);
     if (body.secret !== SECRET) {
       return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
         .setMimeType(ContentService.MimeType.JSON);
     }

     const sheet = getSheet_();

     if (body.action === 'append') {
       appendRow_(sheet, body.log);
     } else if (body.action === 'replace_all') {
       sheet.clearContents();
       sheet.appendRow(HEADER);
       (body.logs || []).forEach((log) => appendRow_(sheet, log));
     }

     return ContentService.createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }

   function getSheet_() {
     const ss = SpreadsheetApp.getActiveSpreadsheet();
     let sheet = ss.getSheetByName(SHEET_NAME);
     if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
     if (sheet.getLastRow() === 0) sheet.appendRow(HEADER);
     return sheet;
   }

   function appendRow_(sheet, log) {
     sheet.appendRow([
       log.employee_code || '',
       log.employee_name || '',
       log.type_label || log.type || '',
       log.site_division || '',
       log.site_name || log.note || '',
       log.remarks || '',
       log.timestamp_jst || log.timestamp || '',
       log.input_method_label || '',
     ]);
   }
   ```

4. 1行目の `SECRET` を、他人に推測されにくい好きな文字列に書き換える(後でVercel側にも同じ値を設定します)。
5. 画面上部の「保存」(フロッピーアイコン)を押す。
6. 右上の「デプロイ」→「新しいデプロイ」を押す。
7. 歯車アイコンから種類を選ぶ画面で「ウェブアプリ」を選択する。
8. 「次のユーザーとして実行」は **自分**、「アクセスできるユーザー」は **全員** を選び、「デプロイ」を押す。
9. 初回はGoogleアカウントの承認画面が出るので、自分のアカウントで許可する。
10. 表示された「ウェブアプリ」のURL(`https://script.google.com/macros/s/.../exec` の形式)をコピーする。
11. Vercelのプロジェクト設定(Settings → Environment Variables)に、以下の2つを追加する。
    - `SHEETS_WEBHOOK_URL` … 手順10でコピーしたURL
    - `SHEETS_WEBHOOK_SECRET` … 手順4で決めた合言葉(Apps Script側の `SECRET` と完全に同じ文字列)
12. 追加後、Vercelで再デプロイ(Deployments → 最新のデプロイの「…」→ Redeploy)する。

### 使い方

- 設定が完了すると、社員が打刻するたびに自動でスプレッドシートに1行ずつ追記されます(管理者ダッシュボードの「スプレッドシート連携」カードで設定状況を確認できます)。
- スプレッドシート側を手動で編集してしまった場合や、管理画面で打刻データを編集・削除した後にズレを直したい場合は、管理者ダッシュボードの「スプレッドシートに全件同期」ボタンを押すと、データベースの内容でシートを丸ごと置き換えられます。
- 設定しない場合は何も影響がなく、通常通りアプリ内のデータベースのみで動作します。

---

## 5. セキュリティ上の注意

- `.env` の `JWT_SECRET` は必ずランダムな長い文字列に変更してください(デフォルト値のまま公開しないこと)。
- 社員のパスワードは平文では保存されず、bcryptでハッシュ化されます。
- 退職者のアカウントは削除ではなく「無効化」を推奨します(打刻履歴を残すため)。
- 本番運用前に、社内のセキュリティポリシーに沿って脆弱性診断・アクセス制限(社内IPのみ許可 等)の要否をご検討ください。

---

## 6. ディレクトリ構成

```
sanoh-attendance/
├── api/
│   └── index.js           Vercelサーバーレス関数のエントリポイント(server/app.jsをそのまま使用)
├── server/                バックエンド(Express)
│   ├── app.js              Expressアプリ本体(ルーティング定義。ローカル/Vercel共通)
│   ├── index.js            ローカル/Docker実行用エントリポイント(静的ファイル配信+起動)
│   ├── db.js                PostgreSQL接続・スキーマ管理
│   ├── auth.js              JWT認証ミドルウェア
│   ├── dateUtil.js          日本時間(JST)関連ユーティリティ
│   ├── routes/
│   │   ├── auth.js          ログイン・パスワード変更
│   │   ├── attendance.js    打刻・自分の履歴
│   │   └── admin.js         管理者用API(社員管理・全社ログ)
│   └── scripts/
│       ├── migrate.js       データベースのテーブル作成/更新
│       ├── createAdmin.js   初期管理者作成
│       └── addEmployee.js   社員追加(コマンドライン)
├── public/                 フロントエンド(静的ファイル。Vercelが直接配信)
│   ├── index.html           ログイン画面
│   ├── clock.html            打刻画面
│   ├── history.html          自分の履歴画面
│   ├── admin.html            管理者ダッシュボード
│   ├── css/style.css
│   └── js/api.js
├── vercel.json              Vercelのルーティング設定(/api/* をサーバーレス関数へ)
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

---

## 7. 今後拡張したい場合

このシステムはシンプルな「打刻+管理」構成です。将来的に以下のような拡張も可能です(追加開発が必要です)。

- 有給休暇・残業申請と承認フロー
- 勤務時間の自動集計(月次レポート、残業時間アラート)
- QRコード/位置情報による打刻場所の制限
- 給与計算システムとの自動連携
