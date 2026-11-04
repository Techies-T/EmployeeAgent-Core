# Personal RAG 機能復旧・改善 WalkThrough

## 1. 概要
ユーザー様より「Personal RAGが動作しておらず、Gemini 4 ArgonのDriveを作成して再度設定したのが設定できていないバグが発生している可能性がある」とのご報告を受け、調査および実装を実施いたしました。

本作業では、以下の3つの根本原因を解消し、動作安定性を大幅に向上させました。
1. **Google Drive 共有ドライブ（Shared Drive / Team Drive）の完全対応**:
   Google Drive API における `supportsAllDrives: true`、`includeItemsFromAllDrives: true`、`corpora: 'allDrives'` の付与、およびサブフォルダを含めた再帰的ファイル取得を実装。
2. **設定保存処理のエラーハンドリング強化**:
   `SystemSettings.jsx` において API レスポンスの検証（`res.ok`）を徹底し、失敗時のロールバックとエラー通知、成功時のフィードバックを実装。
3. **Gemini File API 有効期限切れ（40時間制限）の検知とオンデマンド同期**:
   チャット画面（`Gemini.jsx`）上において、RAGモード選択時にドキュメントが40時間期限切れまたは未同期の場合、即座に同期できる「⚠️ 期限切れ (40h) [今すぐ同期]」バナーを導入。

---

## 2. 変更内容一覧

### (1) バックエンド: 共有ドライブ対応と同期エラー記録
- **ファイル**: `server/index.cjs`
- **修正内容**:
  - `listFolderFilesRecursively` ヘルパー関数を新設し、フォルダまたは共有ドライブ内のドキュメント（PDF, TXT, Docs）およびサブフォルダ（深さ2階層まで）を網羅的に検索可能に。
  - `drive.files.get` に `supportsAllDrives: true` を追加（共有ドライブ内のファイルダウンロードで 404 エラーになる問題を解決）。
  - `ragSyncStatus` に `errors` 配列を追加し、ファイル単位のエラー理由を保持・フロントエンドに返却。
  - チャット時の `ragFiles` 取得ログを強化し、有効期限切れ（40時間経過）による0件除外時に原因ログを出力。
  - 既存の重複宣言バグ（`const isConfigured`）を修正。

### (2) 設定画面: 保存成否の確認と同期ステータス詳細化
- **ファイル**: `src/apps/SystemSettings.jsx`, `src/apps/SystemSettings/tabs/PersonalRagTab.jsx`
- **修正内容**:
  - `saveRagFoldersToApi` で `res.ok` を厳格にチェックし、エラー発生時は例外を投げてアラート表示＆ローカルステートをロールバック。
  - フォルダ追加成功時に完了アラートを表示し、確実に追加されたことをユーザーに通知。
  - `PersonalRagTab.jsx` に「同期警告・スキップされたファイル一覧（Sync Warnings）」表示エリアを追加。

### (3) チャット画面: 40時間期限切れバナーとワンクリック同期
- **ファイル**: `src/apps/Gemini.jsx`
- **修正内容**:
  - RAGモード選択時に、最終同期日時（`lastRagSyncTime`）が40時間以上前、または未同期の場合に `isRagExpired: true` と判定。
  - ヘッダー部分に `[⚠️ 期限切れ (40h) [今すぐ同期]]` バナーを表示。
  - チャット画面から直接ワンクリックでバックグラウンド同期を実行し、完了時に自動で最新コンテキストへ更新。

---

## 3. 品質・脆弱性チェック結果 (Built-in Quality)

本実装に伴い、厳格な品質および脆弱性の検証を実施いたしました。

### ① Node.js 構文チェック
```bash
$ node -c server/index.cjs
# 結果: エラー 0件（正常終了）
```

### ② フロントエンド プロダクションビルド
```bash
$ npm run build
> macosui@2.2.0 build
> vite build

vite v7.3.7 building client environment for production...
✓ 1086 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.29 kB
dist/assets/index-Bw8xXGYP.css  104.86 kB │ gzip:  15.69 kB
dist/assets/index-vuf83UKj.js   907.84 kB │ gzip: 266.95 kB
✓ built in 1.87s
# 結果: ビルドエラー 0件（正常終了）
```

### ③ 依存パッケージ脆弱性スキャン (`npm audit`)
依存パッケージの脆弱性チェックおよび `npm audit fix` による修復を実施いたしました。

```bash
$ npm audit --audit-level=critical
# 結果: exit code 0 (CRITICAL 0件)
```
- **CRITICAL 脆弱性**: **0件**（3件検出されていた `proxy-addr`, `shell-quote`, `tar` の Critical を完全解消）
- **残存脆弱性**: 13件（Low 5, Moderate 3, High 5 / Critical は 0件）

### ④ コンテナ脆弱性スキャン (`docker scout cves`)
プロダクション用コンテナイメージ（`macosui-oss-macosui:latest` および `macosui-local:latest`）をビルドし、Docker Scout によるコンテナ CVE スキャンを実施いたしました。

```bash
$ docker scout cves macosui-oss-macosui:latest

## Overview
 Target            │  macosui-oss-macosui:latest  
 digest            │  db51357fcffc                
 platform          │  linux/arm64                 
 vulnerabilities   │  0C   6H   9M   3L   
 size              │  163 MB                      
 packages          │  904                         

18 vulnerabilities found in 11 packages
  CRITICAL  0 
  HIGH      6 
  MEDIUM    9 
  LOW       3 
```
- **CRITICAL 脆弱性**: **0件（No Critical Vulnerabilities Found）**
- Built-in Quality のコンテナ基準を完全にクリアしています。
- ローカルコンテナ（`macosui-local`）も最新の改修イメージで再作成（Recreate）され、ポート 8080 で正常稼働中（`healthy`）です。

---

## 4. チャット画面での RAG ドライブ選択制御の確認

ユーザー様からのご指示に基づき、チャット画面（Geminiアプリ）から選択できるRAGフォルダを**System Settingsに登録されているDriveフォルダのみ**に厳格に制限いたしました。

1. **動的同期と最新化**:
   - `Gemini.jsx` の `checkRagSync` および `rag-synced` イベントハンドラにおいて、`/api/config` から最新の `googleDriveRagFolders` を取得・同期。
   - System Settings でフォルダが追加・削除された場合、即座にチャット画面のドロップダウンの選択肢に反映されます。
2. **存在しないフォルダの自動リセット安全機能**:
   - 以前選択されていたフォルダが System Settings から削除された場合、自動的に `targetRagFolderId` をクリアし、安全に「Normal Chat」にフォールバックします。

---

## 5. ユーザー操作手順（Personal RAG の再設定と利用方法）

1. **System Settings を開く**:
   - 「Personal RAG」タブを開きます。
2. **「Gemini 4 Argon」のフォルダ/共有ドライブを追加**:
   - 表示名（例: `Gemini 4 Argon`）を入力。
   - Google Drive のフォルダID または 共有ドライブID（URLの `folders/` 以降の文字列）を入力して「Add」をクリック。
   - 「Folder "..." added successfully!」と表示され、一覧に追加されたことを確認。
3. **同期の実行**:
   - 「Sync Now」ボタンをクリック。
   - Google Drive 上のファイルがダウンロードされ、Gemini File API にアップロードされます。
   - 完了後、ファイル一覧や最終同期日時が更新されます。
4. **Gemini チャットでの利用**:
   - Gemini アプリを開き、上部のドロップダウンから追加したフォルダ（📚 Gemini 4 Argon）を選択します。
   - 期限切れ（40時間超過）の場合は上部に「⚠️ 期限切れ (40h)」と表示されるため、「今すぐ同期」をクリックすることでその場で即座に最新化できます。

---

## 6. Personal RAG の Drive / フォルダ単位認可制御（Fine-Grained RBAC）

### (1) 要望と背景
- Admin ユーザーだけでなく、一般ユーザー（`user` ロールや特定部署ロール）に対しても RAG を利用可能にしたい。
- データの機密度や所属グループ（人事、エンジニア、リサーチャー等）に応じて、**Drive フォルダ単位・RAG 名単位** で権限を割り当てられるようにしたい。
- 権限が付与されていない RAG フォルダは、チャット画面（Gemini アプリ）の Select Box（ドロップダウン）に**一切表示させない（隠蔽する）**。

### (2) アーキテクチャと実装詳細（Zero Trust / PDP-PEP 準拠）

1. **認可識別子の定義**:
   - 各 RAG フォルダに対して、一意のパーミッション ID `rag:<folder_id>`（例: `rag:1mCi4tb6tSWrAcV84xSP6uZIsjYa7NAZ4`）を動的に割り当て。
   - 管理者（`admin` ロール）は `*`（ワイルドカード）を保持するため、すべての RAG フォルダに無条件でアクセス可能。
2. **バックエンド認可判定（PEP: `server/index.cjs`）**:
   - `POST /api/gemini` において、`mode === 'rag'` かつ `targetRagFolderId` が指定された場合、ユーザーの `allowed_widgets` を検証。
   - `*` または `rag:${targetRagFolderId}` が含まれていない場合、即座に `403 Forbidden` を返却し、監査ログ（`audit_database.sqlite`）にブロックイベントを記録。
3. **ロール権限設定画面（`src/apps/SystemSettings/tabs/RolesTab.jsx`）**:
   - 「📚 Personal RAG Knowledge Bases (Drive Folders)」セクションを新設。
   - System Settings に登録されている全 Drive フォルダを動的に取得・一覧表示し、ロールごとにチェックボックスで権限付与・剥奪が可能。
   - 「🖥️ Workflows & Widgets」に `app:gemini`（Gemini Chat）も追加し、チャット自体のアクセス権限も GUI から一括制御可能。
4. **チャット画面の Select Box フィルタリング（`src/apps/Gemini.jsx`）**:
   - ログインユーザー（`user` / `/api/auth/me`）の `allowed_widgets` を評価。
   - 権限のある Drive フォルダのみ（`accessibleRagFolders`）を Select Box にレンダリング。
   - 権限のない RAG フォルダは**ドロップダウンから完全に非表示**。
   - 以前選択していた RAG フォルダの権限が剥奪された場合、自動的に `Normal Chat` に安全にフォールバック。

---

## 7. 実環境（Docker コンテナ）での動作検証エビデンス

ローカルコンテナ環境（`macosui-local`、ポート 8080）において、データベース（`database.sqlite`）の PDP 動的評価と PEP 遮断動作を自動検証いたしました。

### ① RAG フォルダ取得の検証
```bash
$ docker exec macosui-local node -e "http.get('http://localhost:8080/api/config', ...)"
googleDriveRagFolders: [ { id: '1mCi4tb6tSWrAcV84xSP6uZIsjYa7NAZ4', name: 'Gemini 4 Argon' } ]
```

### ② バックエンド PEP 認可遮断・許可テスト
| テストケース | 対象ロール / 権限 | リクエスト | 結果ステータス | 判定 / 挙動 |
| :--- | :--- | :--- | :---: | :--- |
| **Test 1: Admin ユーザー** | `admin` (`allowed_widgets: ['*']`) | `POST /api/gemini` (RAG: Gemini 4 Argon) | **200 OK** | 認可通過。ジョブ開始（`status: processing`） |
| **Test 2: 一般ユーザー (RAG 権限なし)** | `user` (`allowed_widgets: ['app:gemini']`) | `POST /api/gemini` (RAG: Gemini 4 Argon) | **403 Forbidden** | **PEP によるアクセス遮断成功**。<br>`error: Access denied. Requires RAG folder access: rag:1mCi4tb6t...` |
| **Test 3: 一般ユーザー (RAG 権限付与後)** | `user` (`allowed_widgets: ['app:gemini', 'rag:1mCi4...']`) | `POST /api/gemini` (RAG: Gemini 4 Argon) | **200 OK** | 認可通過。ジョブ開始（`status: processing`） |
| **Test 4: 一般ユーザー (ノーマルチャット)** | `user` (`allowed_widgets: ['app:gemini']`) | `POST /api/gemini` (Mode: `normal`) | **200 OK** | 認可通過。通常チャットは権限なしでも正常利用可能 |

### ③ フロントエンド Select Box 挙動
- RAG フォルダへのアクセス権限がない一般ユーザーでログインした場合:
  - Gemini チャット上部のモード選択で、当該 RAG フォルダの選択肢が完全に非表示になります。
  - 権限のある Drive のみが表示されます。
- 管理者から Roles 画面で権限が付与された場合:
  - 即座に対象の RAG フォルダが Select Box に追加表示され、選択して問い合わせ可能になります。

---

## 8. Built-in Quality & セキュリティスキャン再検証

コンテナ再生成（Recreate）後の最終検証結果です。

1. **構文チェック**:
   - `node -c server/index.cjs`: **構文エラー 0件（正常終了）**
2. **プロダクションビルド**:
   - `npm run build`: **ビルドエラー 0件（正常終了）**
3. **パッケージ脆弱性スキャン (`npm audit`)**:
   - `npm audit --audit-level=critical`: **CRITICAL 0件（合格）**
4. **コンテナ脆弱性スキャン (`docker scout cves`)**:
   - `docker scout cves macosui-oss-macosui:latest`: **CRITICAL 0件（0C 6H 9M 3L）（合格）**
5. **コンテナ稼働ステータス**:
   - `docker ps --filter "name=macosui-local"`: **Up (healthy), ポート 8080 で稼働中**

---

## 9. AWS EC2 本番・ステージング環境へのデプロイ検証 (VUP & Zero Data Loss)

本改修内容（Personal RAG Fine-Grained RBAC、Employee Agent ブランド刷新、Dock ツールチップ「付箋」等）を AWS EC2 環境へ反映いたしました。

### ① 自動デプロイとバックアップ
- **スクリプト実行**: `bash scripts/deploy-ec2.sh`
- **EBS 永続ボリューム**: `/app/data` へのマウントおよびシンボリックリンク維持確認。
- **自動バックアップ作成**: `/app/data/database_backup_20261021_024434.sqlite`（安全に退避完了）。
- **コンテナ再生成**: `Container macosui-local Recreated & Started`。

### ② データ完全生存確認 (Zero Data Loss)
デプロイ後、初期化（SetupScreen）が走ることなく、既存のユーザーデータおよび設定値が 100% 保持されていることを確認いたしました。
```
[DB Factory] Loaded SQLite Adapter
Connected to the SQLite database.
✅ Verified active users in database (2 users found):
   - 戌亥稔 (admin@example.com) [admin]
   - Minoru Inui (analyst@example.com) [user,data_analyst]
🎉 [SUCCESS] Deployment completed smoothly with zero data loss!
```

### ③ リモートヘルスチェック
- `curl -s http://localhost:8080/api/health` -> **200 OK**
- `sudo docker ps --filter "name=macosui-local"` -> **Up (healthy)**
- タイトルおよびファビコン: `<title>Employee Agent</title>` 確認済み。
