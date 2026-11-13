# Changelog

本プロジェクトのすべての主要な変更履歴は本ファイルに記録されます。
フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に準拠し、バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [EA-Core v1.0.2] - 2026-11-13

### 🧩 PQC 署名付き外部ウィジェット分離・Dock アイコン復元・MCP 監査ログ検知強化

#### 📦 耐量子暗号（PQC）署名検証・ウィジェットインストーラー改善 (`scripts/install-widget.cjs`, `server/services/pluginSignatureVerifier.cjs`, `server/index.cjs`)
- **PQC Gatekeeper & インストーラー互換性向上**:
  - `manifest.json` および `widget.manifest.json` の自動探索・`bundleDir` 検出ロジックを強化し、署名検証ハッシュ計算時にメタデータファイルを適切に除外するよう修正。
  - `development.env` の自動読み込みと、ライセンスキー付きの DB カタログ自動登録に対応。
  - ローカルプラグインの静的配信ルーティングと、Docker Compose プロファイル分離（`plugin-service`）をサポート。

#### 🎨 Virtual Office プラグイン連携・UI 改善 (`src/components/Dock.jsx`, `server/index.cjs`, `docker-compose.full.yml`)
- **Dock アイコン復元とプロキシルーティング修正**:
  - Virtual Office ウィジェットの Dock アイコンをマテリアルデザイン統一のベクター SVG アイコンに復元。
  - プラグインプロキシを `serviceUrl` 優先ルーティングに修正し、Docker 内部 DNS（`ea-widget-virtual-office` ⇄ `macosui`）でのコンテナ間通信を最適化。

#### 🛡️ MCP 接続・ツール取得異常の監査ログ即時記録 (`server/mcpClient.cjs`)
- **MCP ゼロツール返却・接続エラーの監査ログ出力**:
  - MCP サーバー（ZTA Gateway 経由含む）への接続失敗・再接続失敗時に `mcp_connection` (`failure`) を `audit_database.sqlite` へ記録。
  - 接続成功後に `listTools()` が `0 件` を返却した場合（上流サーバー不通時など）やツール一覧取得例外時も `mcp_tools_load` (`failure`) として監査ログへ即時出力するよう改善（5分間の重複抑止スロットリング付き）。

---

## [EA-Core v1.0.1] - 2026-11-11

### 🛡️ Passkey (WebAuthn) 永続化・Gemini 4 Argon / Carbon MCP 推論安定化・思考トークン課金可視化

#### 🧠 Gemini 4 Argon / Carbon MCP マルチターン制御 & 思考トークン（Thinking Tokens）完全集計 (`server/routes/mcpChat.cjs`, `src/apps/McpChat.jsx`, `src/apps/Gemini.jsx`, `src/components/SaveToKnowledgeModal.jsx`)
- **マルチターン SQL 照会の早期離脱防止と合成フェーズ専用ハーネス**:
  - `gemini-4-argon` / `gemini-4-carbon` において、プロンプトで要求された全テーブル（`batting_stats`, `pitching_stats`, `games`, `team_standings`）の照会が完了してからストリーミング合成へ移行するよう `hasAllRequiredTables` 判定を追加。
  - ストリーミング合成時のシステム指示（`synthesisSystemInstruction`）を分離し、ツール呼び出し完了後のテキスト・HTML 出力抑制を防止。
- **長時間ストリーミングの 180 秒強制切断防止と Auto-Resume 関数名ブリッジ**:
  - `getGeminiClient` の `httpOptions.timeout` を `600000`（10分）に拡張し、大規模 HTML ダッシュボード生成中の 180 秒強制 Abort を解消。
  - Auto-Resume（チェックポイント自動再開）発動時に既出の `<script>` 関数名および `<canvas>` ID を引き継ぎ、万一 `initDashboard()` / `initCharts()` の呼称不一致が生じた場合も自動でブリッジ関数を補完する修復ハーネスを実装。
- **入力・出力・思考トークン（`thoughtsTokenCount`）の100%正確な集計と UI 表示**:
  - SQL ツール実行の全ターンおよび全ストリーミングパス（`finally` ブロック）で消費トークンを漏れなく累積合算。
  - チャット画面・ナレッジ保存モーダル・ナレッジ記事ヘッダーに `入力 X / 出力 Y / 思考 Z (合計 W)` を明示し、API 課金実態（思考トークン＝出力トークン単価として課金）に合わせて DB の `output_tokens` カラムへ `出力 + 思考` を記録するよう改善。

#### 🔐 WebAuthn Passkey 管理・Signal API 対応 (`server/index.cjs`, `src/apps/SystemSettings/tabs/GeneralTab.jsx`, `src/components/SessionLockModal.jsx`)
- **Passkey 一覧取得の確実化とリトライ制御**:
  - `GET /api/auth/passkey/list` に `Cache-Control: no-store, no-cache, must-revalidate, private` を付与し、`POST /api/auth/passkey/register/verify` レスポンスに最新のパスキー一覧を直接返却して即時反映。
  - クライアント側（`GeneralTab.jsx`）に `cache: 'no-store'`・自動リトライ（最大3回）・手動再読み込みボタンを追加。
- **Discoverable Credential（Resident Key）必須化と名称変更機能**:
  - `POST /api/auth/passkey/register/options` に `residentKey: 'required'` を明示し、パスワードマネージャーへの保存を標準化。
  - `PUT /api/auth/passkey/:id` エンドポイントおよび System Settings → General でのインライン名称変更 UI を追加。
- **WebAuthn Signal API 連携**:
  - `PublicKeyCredential.signalAllAcceptedCredentials` および `PublicKeyCredential.signalUnknownCredential` に対応し、アプリ側でのパスキー削除・一覧同期をブラウザのパスワードマネージャー（Google Password Manager / iCloud Keychain）へ自動通知。

#### ⚡ API ペイロード軽量化と OOM クラッシュ防止 (`server/routes/knowledge.cjs`, `server/routes/geminiLive.cjs`, `server/index.cjs`, `docker-compose.staging.yml`)
- **Base64 アバター画像のバイナリ配信エンドポイント分離**:
  - `GET /api/knowledge`・`GET /api/dm/unread`・`GET /api/gemini-live/documents` 等で各レコードに重複結合されていた Base64 `avatar_url`（1件あたり約748KB）を専用エンドポイント `GET /api/users/:id/avatar`（`Cache-Control: private, max-age=300`）への参照に置換し、`GET /api/knowledge` のレスポンスサイズを約 23.3MB から約 3.3KB（99.98% 削減）に軽量化。
  - ログイン直後の並列フェッチ時における Node.js ヒープ急増・502 Bad Gateway を解消。

#### 🎙️ AI Live Concierge UI 改善 (`src/apps/GeminiLiveApp.jsx`, `server/routes/geminiLive.cjs`)
- **左右フルハイト分割レイアウトと公開レポート HTML 解決**:
  - Live Concierge 画面を左右分割レイアウトに刷新し、`published_reports` のインタラクティブ HTML/SVG ダッシュボード表示を統合。

---

## [EA-Core v1.0.0] - 2026-11-06

### 🚀 EmployeeAgent-Core 1.0.0 初回メジャーリリース (ZTA MCP Analytics & Knowledge Platform)

#### 🛡️ Zero Trust Architecture (ZTA) & 監査トレーサビリティ強化
- **ZTA-MCP-Gateway トランザクション監査への実行ユーザー（End-User）アイデンティティ伝播 (`server/mcpClient.cjs`, `server/routes/ztaAudit.cjs`, `src/apps/SystemSettings/tabs/ZtaGatewayAuditSubTab.jsx`)**:
  - A2A OAuth クライアントID（`macosui-analyst` 等）だけでなく、実際に操作を行った社員のユーザーID・メールアドレス・ロール（`_zta_context`）をゲートウェイ監査ログへ伝播・突合し、一覧および詳細モーダルで「どの社員がどの SQL を発行し、どのテーブル・カラムを参照したか」を完全追跡可能に改善。
- **ZTA 厳格データ分離（システムプロンプトからの実データ数値排除） (`server/routes/mcpChat.cjs`, `server/db_sqlite.cjs`)**:
  - システムプロンプトおよび定型プロンプトから実データのサマリ数値を排除し、スキーマ定義（テーブル名・カラム名）のみに限定。MCP ツール未接続時や権限外アクセス時にプロンプト知識から数値を補完することを禁止。
- **クリーン Activation & 初期 RBAC ポリシーの確実なハイドレート (`server/db_sqlite.cjs`, `server/index.cjs`)**:
  - 空データベースからの初回 Activation 時に `initDb()` の全テーブル生成完了後に `autoActivate()` を直列実行し、`requireAuth` 等での PDP 動的ハイドレートを統一。

#### 📊 MCP ワークフロー & ナレッジベース統合
- **MCP 生成ダッシュボードのメタデータ・公開共有 URL 付きナレッジ登録 (`src/components/McpChatWindow.jsx`, `server/routes/mcpChat.cjs`)**:
  - Deep Research と同等のメタデータヘッダー（プロンプト情報・モデル情報・消費トークン数・ツール実行回数・EA 内共有 URL `/shared/:uuid`）を付与してナレッジベースおよび経営会議ブリーフィングへ登録する機能を実装。
- **長時間推論・大規模 HTML/SVG ダッシュボード生成の耐障害性強化 (`server/routes/mcpChat.cjs`, `server/services/llmAdapter.cjs`, `server/nginx/nginx.conf`)**:
  - SSE ハートビート（15秒間隔）とタイムアウト延長、および Nginx の Docker 内部 DNS 動的リゾルバ設定を追加し、`socket hang up` やコンテナ再起動時の `502 Bad Gateway` を防止。

---

## [v3.0.2] - 2026-10-28

### 🛡️ ZTA セッションタイムアウト制御 & バーチャルオフィス Offline 自動遷移の厳格化

#### 🔒 Security & ZTA Session Lifecycle (ZTAセッション管理・再ログイン強制)
- **タイムアウト・ログアウト後のブラウザリフレッシュ（F5）による不正セッション復活の完全防止 (`server/index.cjs`)**:
  - `GET /api/auth/me`、`requireAuth`、および `requireAuthOrA2A` において、Cookie 内の JWT 署名が有効期間内（7日間）であっても、DB 上のユーザーステータスが `status_text === 'Offline'` または `last_active_at === NULL`、あるいは最終操作から30分（`SESSION_IDLE_TIMEOUT_MS`）を超過している場合は即座にセッション失効（`401 SESSION_EXPIRED`）として拒否し、サーバー側でセッション Cookie（`macos_ui_token`）を確実に破棄（`clearSessionCookie`）する仕組みを実装。
  - これにより、一度タイムアウトまたはログアウトした後にブラウザを F5 リフレッシュしてもデスクトップには復帰せず、必ず Passkey または Google OAuth による再認証を要求する ZTA（Zero Trust Architecture）基準を徹底。
- **ZTA セッションタイムアウト監査ログの自動記録とフィルタ追加 (`server/index.cjs`, `src/apps/SystemSettings/tabs/SecurityLogsTab.jsx`)**:
  - クライアント/サーバー双方でのアイドルタイムアウト検知時およびバーチャルオフィスのプレゼンスタイムアウト遷移時に、`security_logs` テーブルへ `event_type: 'session_timeout'` を自動記録。
  - System Settings の「セキュリティ監査ログ」タブに **「セッションタイムアウト (ZTA)」** フィルタと `⏱️ ZTA Timeout` バッジを追加。

#### 🏢 Virtual Office Presence & Idle Detection (バーチャルオフィス Offline 判定改修)
- **未ログイン・無操作放置ユーザーの確実な `⚫ Offline（半透明表示）` 遷移 (`server/index.cjs`, `src/apps/VirtualOffice.jsx`)**:
  - `isUserOffline()` において `last_active_at` が `NULL` の場合も確実に `Offline`（`true`）と判定するよう修正。
  - バーチャルオフィスの3秒ごとの受動ポーリング（`GET /api/virtual-office/users`）による `last_active_at` の無条件更新を廃止し、ユーザーの実際の入力操作を伴うハートビート（`GET /api/auth/me?active=1`）または本人による明示的なステータス変更時のみ `last_active_at` を更新するよう分離。
  - 他ユーザーからの DM 送信や AI アシスタントの自動応答（`POST /api/dm/messages`）では受信者本人の `last_active_at` を更新しない設計を維持し、本人が不在のまま他者からチャットが送られ続けても30分で確実に `Offline` へ遷移。
- **フロントエンド無操作タイマーのリセットループ修正 & 疑似 `mousemove` 排除 (`src/App.jsx`)**:
  - 60秒ごとの定期セッション確認（`checkSession`）で `user` オブジェクト参照が更新されるたびに `useEffect` が再実行され、無操作タイマー（`lastActivityRef`）が毎分リセットされてしまう問題を修正（依存配列をプリミティブ値 `user?.id` に変更し、`silent` チェック時は同一属性のオブジェクト参照を維持）。
  - バーチャルオフィスの3秒ポーリングや未読通知バッジ表示に伴う DOM 再描画時にブラウザが同一座標で発火させる疑似 `mousemove` イベントを無視するため、マウス座標が実際に 3px 以上移動した場合のみ実操作と判定するよう改善。
- **外部 OAuth トークン未連携エラーとセッション失効エラーの分離 (`server/index.cjs`, `src/App.jsx`)**:
  - Google Drive / Calendar API 連携において対象ユーザーの OAuth トークンが未登録の場合に `401` ではなく `403 ({ code: 'GOOGLE_TOKEN_MISSING' })` を返却し、他ユーザーのスケジュール参照時やサーバー再起動時の一時的な `502` エラー等で自身の MacOSUI セッションが誤って強制ログアウトされないよう改善。

---

## [v3.0.1] - 2026-10-27 (🧪 テスト版 / Pre-release Test Build)

> ⚠️ **【テスト版 (Beta / Pre-release)】**: 本バージョン（`v3.0.1` / 表記 `3.0.1-beta`）は、Anthropic Claude Deep Research 統合ワークフローおよび UI・通信安定化の検証を目的とした**テスト版リリース**です。

### 🧪 Claude Deep Research 専用ワークフロー & UI/ネットワーク安定化

#### ✨ New Features & UI Improvements (新機能・UI改善)
- **Claude 専用 Deep Research ワークフロー「Claude 統合リサーチ＆HTML/SVG生成」の標準搭載 (`server/db_sqlite.cjs`, `src/apps/SystemSettings/tabs/DeepResearchTab.jsx`)**:
  - 単一の Claude モデル（`claude-opus-5-5` / `claude-sonnet-4-5` 等）で Task 0（調査計画）➔ Task 1（Web Search 最大10回による深掘り調査）➔ Task 2（Tailwind CSS + インラインSVGによるインタラクティブHTMLダッシュボード生成）を一貫実行する専用ワークフローを自動シード。
  - Claude の強みを引き出す専用リサーチ・ハーネス（`CLAUDE_RESEARCH_HARNESS_PROMPT`）および HTML/SVG 生成ハーネス（`CLAUDE_HTML_HARNESS_PROMPT`）を実装し、ワークフロー編集画面にワンクリック適用ボタンを追加。
- **Deep Research 画面のコンパクト・ツールバー化と表示領域の大幅拡大 (`src/apps/DeepResearch.jsx`)**:
  - 「ワークフロー選択」「保存先Pod」「過去ナレッジ結合（RAG）」を 1 行のスリムなツールバーに統合し、「過去ナレッジ結合」を折りたたみ式（アコーディオン）に変更することで、実行ログ・結果のスクロール表示領域を従来の約 2.5 倍以上に拡大。
- **Deep Research チェックポイント保存・再開（Resume）の強化 (`src/apps/DeepResearch.jsx`, `server/routes/deepResearch.cjs`)**:
  - Task 1 完了時のトークン消費量（`usageMetadata`）を SQLite チェックポイント（`deep_research_workflows`）へ正確に引き継ぎ、エラー発生時の途中再開（Resume）および完了サマリーのモデル名表示を Claude / Gemini 両対応に強化。
- **Personal RAG の Gemini / Claude 個別同期ボタン分離と耐障害フォールバック (`src/apps/SystemSettings/tabs/PersonalRagTab.jsx`, `src/apps/SystemSettings.jsx`, `server/index.cjs`)**:
  - Personal RAG 設定画面の Google Drive 同期アクションを「Gemini のみ同期」「Claude のみ同期」「両方を一括同期 (Sync All)」に分離し、利用するモデルに応じた柔軟な同期操作に対応。
  - Gemini File Search API へのアップロードがクレジット枯渇（HTTP 402）等で失敗した場合でも、Claude 用のローカルドキュメントキャッシュ（`data/rag_cache`）への保存・同期は継続して完了するフォールバック処理を実装。

#### 🛡️ Network & API Stability Fixes (通信・API安定化)
- **VPN / Docker Bridge MTU 制限環境における Anthropic API 通信の安定化 (`server/services/llmAdapter.cjs`, `server/index.cjs`, `docker-compose.yml`)**:
  - Node.js 24 (OpenSSL 3.5) のポスト量子ハイブリッド鍵交換による TLS `ClientHello` 肥大化を防ぐため `tls.DEFAULT_ECDH_CURVE = 'X25519:P-256:P-384'` を設定。
  - VPN トンネル（MTU 1000〜1380）環境でも大容量プロンプト送信時に `ECONNRESET` / `UND_ERR_SOCKET` が発生しないよう、TLS ハンドシェイク完了後にリクエストボディを 800 バイト単位で分割フラッシュ送信する専用トランスポート（`anthropicHttpsRequest`）および `max_tokens` 自動ダウングレード機構を実装。

---

## [v3.0.0] - 2026-10-26

### 🟣 Multi-LLM Engine: Google Gemini & Anthropic Claude Dual-Support メジャーリリース

#### ✨ New Features (新機能・マルチLLM対応)
- **Anthropic Claude API 公式統合 & ランタイム切り替え**:
  - Google Gemini の全機能を 100% 維持したまま、Anthropic Claude API（`@anthropic-ai/sdk`）をフルサポート。
  - **System Settings（システム設定）** に「AI Engine Configuration (Multi-LLM Switcher)」を追加。Claude API Key の AES-256-GCM 暗号化保存および、動的な Claude モデル一覧取得（SELECT Box）に対応。
  - チャットアプリ（`Gemini.jsx`）の上部ヘッダーにモデル切り替え SELECT Box を配備し、Gemini モデルと Claude モデルを会話中にワンクリックでスイッチ可能に。
  - 判定優先順位：ユーザーがチャット画面等で個別に指定したモデルを最優先とし、未指定時は System Settings の「Default AI Provider」およびデフォルトモデルへ自動フォールバック。
- **Anthropic Prompt Caching 統合による Personal RAG の高速化 & 大幅コスト削減**:
  - Google Drive から同期された社内文書（PDF/テキスト/Markdown）をローカルキャッシュ領域（`data/rag_cache`）から Claude にネイティブ連携。
  - Anthropic Document API（PDF Base64 送信）と **Anthropic Prompt Caching (`cache_control: { type: 'ephemeral' }`)** を自動適用。2回目以降の同一文書への質問において、トークンコストを最大 90% 削減しレスポンスを劇的に高速化。
  - RAG 処理時および Claude 実行時のタイムアウト上限を 60 秒から **180 秒（3分）** に拡張し、ローディング表示に「社内ドキュメントを解析中 (Claude Prompt Caching)...」の状態インジケーターを導入。
- **自律型 Deep Research ワークフローの Claude スイッチ対応**:
  - Deep Research Task 1（情報調査・計画フェーズ）および Task 2（HTML/SVG レポート生成フェーズ）において、Gemini と Claude を個別に選択・組み合わせ可能に（例: 調査は Claude、レポート生成は Gemini など）。
- **MCP Client（McpChat）での Claude 自律ツール実行ループ**:
  - MCP サーバーから取得したツールスキーマを Anthropic 形式（`tools`）へ自動変換し、Claude によるマルチターンの自律ツール実行（Tool Use ループ）を実現。
  - チャット画面上部ヘッダーから直接 Gemini / Claude モデルを即座にスイッチ可能。

#### 🛡️ Stability & Security Enhancements (安定化 & 自動自己修復)
- **推論特化型モデル（Claude Opus 5系等）における `temperature` 非推奨エラーの自動自己修復（Auto-healing）**:
  - 最新の推論・思考特化型モデル（`claude-opus-5-5` や Extended Thinking モデル等）において、API 仕様で非推奨とされている `temperature` パラメータを自動判定・除外。
  - 万一 API から `temperature is deprecated` エラーが返された場合も、バックグラウンドで即座に `temperature` を除外して自動リトライするフォールバックリカバリーを実装。
- **MCP 設定導線の重複解消と一本化**:
  - `System` タブにあった重複する MCP Agent Model 設定を削除し、管理者向け設定を `MCP Connections`（Server Monitor ＞ MCP Chat Model サブタブ）に一元化。

---

## [v2.9.2] - 2026-10-23

### 🖥️ クロスプラットフォーム UI/レイアウト安定化 & ZTA セッションタイムアウト強制ログアウト強化（安定版）

#### 🎨 UI/UX & Cross-Platform Layout Fixes (UI・レイアウト修正)
- **Dock（ウィジェットアイコン）浮き上がり現象の解消とビューポート固定 (`src/index.css`, `src/components/Desktop.jsx`, `src/components/Dock.jsx`, `src/components/MenuBar.jsx`)**:
  - Windows 端末（DPIスケーリング 125%〜150% 等）や小画面環境において、チャット画面の自動スクロール（`scrollIntoView`）に伴ってデスクトップ全体が縦スクロールし、Dock が画面中央に浮き上がる・MenuBar が画面外へ押し出される現象を修正。
  - `100dvh` および `overflow: clip`（スクロール位置リセットガード付き）を導入し、MenuBar（`top: 0`）と Dock（`bottom: 10px`）を `position: fixed` で画面上下に常時固定。
  - チャット系アプリ（`Gemini.jsx`, `McpChat.jsx`, `DeepResearch.jsx`, `DmChat.jsx`, `LiveConcierge.jsx`）の `scrollIntoView` を `{ behavior: 'smooth', block: 'nearest' }` に統一し、親要素の意図しないスクロールを防止。
- **ウィンドウのビューポート自動クランプ処理 (`src/components/Desktop.jsx`, `src/components/Window.jsx`)**:
  - 初期表示・ウィンドウ起動・ブラウザリサイズ時に、常に MenuBar（`28px`）の下〜Dock の上の有効領域内にウィンドウの座標（`x`, `y`）およびサイズ（`width`, `height`）が収まるよう自動調整する `clampWindowToViewport` を実装。
  - `Gemini.jsx` ヘッダーのモード選択 `<select>` に `max-w-[210px] truncate` を適用し、400px 幅ウィンドウでも右端の `Grounding` ボタンが見切れないよう改善。
- **メニューバー左上アイコンの EA (Employee Agent) ベクターエンブレムへの刷新 (`src/components/MenuBar.jsx`)**:
  - Windows 環境で文字化け（豆腐化）していた Apple 固有文字（``, `U+F8FF`）を廃止し、OS・フォント非依存のヘキサゴン・AIスパークル SVG エンブレム + `EA` バッジに刷新。

#### 🛡️ Security & ZTA Session Management (セキュリティ・セッション管理強化)
- **セッションタイムアウト・ZTA コンテキスト失効時の自動強制ログアウト (`src/App.jsx`, `src/components/LoginScreen.jsx`)**:
  - グローバル `fetch` インターセプターを導入し、API が `401` またはセッション失効による `403`（`SESSION_EXPIRED` / `Session context mismatch` / `Invalid or expired token` 等）を返した瞬間に即座にセッションを破棄し、セキュリティ通知バナー付きでログイン画面へ強制遷移。
  - **30分間の無操作タイマー（アイドルタイムアウト）**、**60秒ごとの `/api/auth/me` ハートビート検証**、および **画面復帰時（`visibilitychange` / `focus`）の即時セッション検証** を実装。
- **権限設定変更時のロールバック保護 (`src/apps/SystemSettings.jsx`)**:
  - ロール権限（`handleSaveRbacPolicies`）・就業規則・モデル設定の保存時に `res.ok` を検証し、セッション切れや権限エラー時には即座に変更前の状態へロールバックして画面上の不整合を防止。
- **バックエンド ZTA / PEP 認可エンドポイントの厳格化 (`server/index.cjs`)**:
  - `GET /api/config`: 未認証・セッション期限切れのクライアントにはログイン画面の初期化に必要な最小限の公開項目のみを返却し、`rbacPolicies` や `companyWorkPolicy` 等の内部設定を隠蔽。
  - `GET /api/auth/me`, `requireAuth`, `requirePermission`, `requireWidgetAccess`: トークン失効・IP/UA ハッシュ不一致・DB ユーザー不在時に `token` Cookie を確実に削除して `401 (SESSION_EXPIRED)` を返却し、すべての権限チェックでリアルタイム DB & PDP 評価を強制。

## [v2.9.1] - 2026-10-21

### 📚 Personal RAG Fine-Grained RBAC & Employee Agent ブランド刷新

#### ✨ New Features (新機能)
- **Personal RAG フォルダ単位のアクセス認可制御（Fine-Grained RBAC）**:
  - 各 Google Drive / RAG フォルダごとに識別子 `rag:<folder_id>` を定義し、ロール毎に細粒度のアクセス権限制御を実現。
  - バックエンド（`/api/gemini`）での PEP（Policy Enforcement Point）検証を導入し、権限のない RAG フォルダへのアクセスを 403 遮断。
  - ロール管理画面（`RolesTab.jsx`）に「📚 Personal RAG Knowledge Bases (Drive Folders)」セクションを追加。
  - チャット画面（`Gemini.jsx`）の Select Box において、ユーザーに権限が付与されている RAG フォルダのみを表示（未許可フォルダの完全隠蔽）。
- **macOS スタイルの Dock アイコンツールチップ表示**:
  - 画面下の Dock アイコンにホバー・フォーカスした際、アプリ名称（「付箋」「MCPチャット」「DeepResearch」「Gemini チャット」等）を半透明ダークガラス調のピル型バッジで表示。

#### 🎨 Brand & Design Updates (ブランド更新)
- **プロジェクト名称を「Employee Agent (EA)」へ刷新**:
  - ブラウザタブタイトルを `Employee Agent` に更新。
  - 新デザインのベクターファビコン（`favicon.svg` / `vite.svg`）を導入。
  - System Settings（General タブ）およびメニューバーの About 表記、Live Concierge、セキュリティ監査ログタブ等の UI 表記を `Employee Agent v2.9.1`（`package.json` のバージョンと動的連動）へ統一。

#### 🛡️ MCP ZTA/RBAC 権限管理 & マルチドメイン動的ルーティング改修
- **Built-in Knowledge Base MCP と RBAC ロール権限の整合性強化 (`server/mcpClient.cjs`)**:
  - `app:knowledge-base` 権限を持つロールが外部 MCP サーバー（`mcp:X`）の個別認可によって Built-in Knowledge Base MCP からロックアウトされる事象を解消。
  - 各 MCP ツール定義に所属サーバー・ドメインメタデータ（`[MCP Server: ... | カテゴリ: ...]`）を自動付与。
- **マルチドメイン対応の動的パイプライン & ルーティングハーネス強化 (`server/routes/mcpChat.cjs`, `server/routes/knowledgeMcp.cjs`)**:
  - ツール名部分一致フィルタを廃止し、ドメイン属性（`knowledge_base`, `npb_baseball`, `digital_agency`, `google_workspace` 等）に基づく正確なツールバインディングへ刷新。
  - 月別・著者別の記事投稿数やインプット/アウトプットトークンのクロス集計クエリが確実に `Knowledge Base MCP`（`get_knowledge_token_crosstab` 等）へルーティングされるよう自動判定キーワードおよびシステムプロンプト規約を強化。

## [v2.9.0] - 2026-10-08

### 🌐 ZTA Gateway トランザクション監査ログ基盤 & MCP Chat 自律進捗インジケーター（タイムアウト最適化・自動リトライ）

#### ✨ New Features (新機能)
- **ZTA Gateway トランザクション監査ログ基盤（ゼロトラスト・ディープインスペクション）**:
  - **SQL ディープインスペクション & カタログ一貫性照合**:
    - AIエージェントが発行した全SQLクエリのAST構文解析、対象テーブル・カラムの完全抽出、READ/WRITE判定、機密リテラルのサニタイズを実装。
    - YAMLメタデータカタログと照合し、認可外テーブルへのアクセスを即時検知・遮断。
  - **改ざん防止ハッシュチェーン付き独立監査ストレージ**:
    - MacOSUI 内部監査ログとは物理的に分離された独立ログストレージを設計・構築。各ログ行に SHA-256 改ざん防止ハッシュチェーンを付与し、完全性を保証。
  - **System Settings への「ZTA Gateway 監査」サブタブ統合**:
    - `SecurityLogsTab.jsx` 内に「🌐 ZTA Gateway トランザクション監査」サブタブを新設。
    - SQLクエリ、実行テーブル、READ/WRITE種別、YAMLカタログ一貫性、所要時間（ms）、ハッシュチェーン検証状態をリアルタイムに検索・可視化。

- **📊 MCP Chat 自律進捗エスティメーター & リアルタイムUI刷新 (`McpChat.jsx`)**:
  - **パーセント進捗バー（%）のアニメーション表示**:
    - 0% から 96% へ向かって経過時間とともに滑らかに進捗バーが前進し、ユーザーがフリーズと誤認する問題を完全解消。
  - **自律的フェーズ推移 & 3ステップバッジ**:
    - `1. 分析計画立案` ➔ `2. MCPデータ照会` ➔ `3. ダッシュボード構築` を動的にチェックマーク（✓）化。
    - 経過時間に応じて具体的な処理フェーズ（SQL準備、実データ解析、Chart.js構成、HTMLコード検証等）をリアルタイムに自動更新。
    - 通信遅延・再試行検知時はアンバー色の警告バッジ（`🔄 通信自動再試行中`）を表示し、システムが能動的にリカバリ中であることを明示。

#### ⚡ Resiliency & Performance (耐障害性・パフォーマンス向上)
- **Gemini Interactions API 呼び出しのタイムアウト最適化 & 自動リトライ (`server/routes/mcpChat.cjs`)**:
  - **厳格な Promise.race タイムアウトガード**:
    - 従来の10分（600秒）待機を撤廃し、ターンごとに 120秒（初期推論・ツール計画）および 180秒（ダッシュボードHTML生成）に最適化。Google インフラ側での接続ハングを確実に検知・遮断。
  - **一時的障害の自動再試行 (Auto-Retry)**:
    - タイムアウト、HTTP 504（Gateway Timeout）、HTTP 503、ソケット切断を検知し、指数バックオフ付きで最大2回自動再試行。

## [v2.8.5] - 2026-10-07

### 🛡️ MCP Chat ハーネス設定画面（System Settings）新設 & スケール分離可視化ルール

#### ✨ New Features & Guardrails (新機能・ハーネス強化)
- **MCP Chat システム指示・ハーネス設定画面（Admin 専用）の新設**:
  - **System Settings の「MCP Connections」タブに『⚙️ Harness & Rules』サブタブを追加**:
    - コード修正や再デプロイを行わずに、ブラウザ管理画面からプロンプト制約・可視化ルールを直接編集・保存・即時反映可能に。
    - **管理者権限保護 (ZTA / PDP 準拠)**: Admin（`action:manage_system_settings`）のみ更新可能とし、一般ユーザーによる勝手なルール改変を防止。
    - **ビルトイン・デフォルトハーネスのプリセット & リセット機能**: ゼロから入力する負担を無くすため、実証済みの最新ルールがあらかじめ初期設定され、ワンクリックでいつでも復元可能。
    - **最大ツール実行ターン数（Max Turns）の動的調整**: 画面上のスライダー/数値入力から 3〜30 ターン（デフォルト15）を即座に変更可能。
- **データ可視化「スケール分離ルール (Multi-Scale Data Visualization Rule)」の導入**:
  - 1試合平均得点（一桁）とシーズン累計得失差（数百点）のように、桁数・単位が大きく異なる指標を単一Y軸に混在プロットしてバーが地面に潰れる問題を根絶。
  - ①隣接グラフ分離（Dedicated Side-by-Side Charts）、②2軸化（Dual Y-Axes）、③表示切替トグル（Metric Toggle）のいずれかを強制適用するハーネスを定義。

## [v2.8.4] - 2026-10-06

### 🚀 超大規模ダッシュボード生成対応 & GenUI 耐障害性強化 (Token Limit & Harness)

#### 🐛 Bug Fixes & Resiliency (不具合修正・耐障害性向上)
- **大規模分析ダッシュボードの出力途絶（スクリプト切断・チャート非表示）の完全解消**:
  - **最大出力トークン上限の拡張 (`max_output_tokens: 65536`)**:
    - パークファクター（球場補正）を考慮したタイガース vs ホークス頂上決戦分析など、野手16名・投手16名の全スタッツ、Chart.jsレーダーチャート、シミュレーションUIを含む超大作ダッシュボード生成において、Gemini 3.8 Flash の最大出力トークン（64K tokens）をフル活用。
    - 旧設定（24,576 tokens）に起因する `JavaScript` スクリプトの途中切断を根本から解消。
  - **コードブロック自動修復ハーネス (Server-side Auto-Repair Harness)**:
    - 万が一出力が途中切断された場合でも、未終了の `<script>`、`</body>`、`</html>` およびバッククォートをサーバー側で自動検知・補完し、マークダウンパーサーの破壊や未終了ブロックを防止。
  - **GenUI ウィジェット (`HtmlPreviewCodeBlock.jsx`) の耐障害レンダリング強化**:
    - `iframe` 注入コードの先頭に `window.onerror` グローバルエラーハンドラとタブ初期化フォールバックを実装。
    - スクリプト構文エラー時でも画面が真っ白にならず、デフォルトで最初のタブコンテンツやテーブルが表示される耐障害性を確保。

## [v2.8.3] - 2026-10-05

### 🚀 MCP Chat (AI Analytics) 高度分析ダッシュボード生成・表示の完全復旧と堅牢化

#### 🐛 Bug Fixes & Stability (不具合修正・安定性向上)
- **MCP Chat で「Operation completed.」とだけ表示されダッシュボードが出力されない不具合の完全解消**:
  - **最大ツール実行ターンの拡張 (`maxTurns: 15`)**: 阪神タイガース vs 福岡ソフトバンクホークスの戦力比較など、複数テーブル・複数球団にまたがる高度な分析において、ツール実行上限（旧 6 ターン）で処理が途切れてしまう問題を解消。
  - **モデル生成テキストの堅牢な抽出 (`extractTextFromInteraction`)**: `@google/genai` Interactions API のトップレベル出力 `output_text` および `steps[].content`（配列・文字列・オブジェクト）から完全な回答テキストを多層的に抽出するパーサーを実装。
  - **独立したフォールバック合成（Fallback Synthesis）の導入**: ツール呼び出し上限等で回答テキストが未取得の場合、これまでに取得した全クエリ結果（`artifacts`）をコンテキストに含め、未解決の `requires_action` 状態に縛られない独立したプロンプトでダッシュボードと回答を100%確実に生成。
  - **多層セーフティネットとUIフォールバックの強化**:
    - バックエンド: 万が一の合成失敗時でも取得生データの Markdown テーブル要約を自動生成し、空文字返却を完全に防止。
    - フロントエンド (`McpChat.jsx`): 「Operation completed.」という無機質な英語表示を完全排除し、取得データ件数や状況に応じた適切なメッセージを表示。

## [v2.8.2] - 2026-10-04

### ⚾ 2026年 NPB 公式確定データ完全準拠 & 3カ年戦力ダッシュボード（npb.jp公式発表）

#### ✨ Added & Updated (更新・追加内容)
- **⚾ NPB 2026年シーズン公式確定データ追加・反映（npb.jp公式完全準拠）**:
  - **チーム順位 (`team_standings`, `teams`)**:
    - **セ・リーグ**: 阪神タイガースが **77勝 60敗 2分（勝率 .562、得点 513、失点 431）** で優勝。2位 巨人（76勝64敗3分 .543 2.5差）、3位 DeNA（70勝69敗3分 .504 8.0差）、4位 広島（60勝76敗4分 .441 16.5差）、5位 ヤクルト（60勝79敗2分 .432 18.0差）、6位 中日（60勝81敗2分 .426 19.0差）。
    - **パ・リーグ**: 福岡ソフトバンクホークスが **91勝 48敗 3分（勝率 .655、得点 706、失点 449）** で優勝。2位 西武（77勝60敗4分 .562 13.0差）、3位 日本ハム（78勝62敗3分 .557 13.5差）、4位 オリックス（65勝76敗2分 .461 27.0差）、5位 ロッテ（62勝75敗3分 .453 28.0差）、6位 楽天（57勝83敗1分 .407 34.5差）。
  - **個人打撃スタッツ (`batting_stats`)**:
    - 佐藤輝明（阪神）: 打率 **.314**（首位打者）・**39本塁打**（本塁打王）・**105打点**（打点王）・164安打（**セ・リーグ三冠王**＆MVP達成）。
    - 森下翔太（阪神）: 打率 .294（2位）・35本塁打（2位）・84打点・151安打（ベストナイン）。
    - 栗原陵矢（ソフトバンク）: 打率 .271・**40本塁打**（パ本塁打王）・**118打点**（パ打点王）（**打撃2冠王**）。
    - レイエス（日本ハム）: 打率 **.313**（パ首位打者）・32本塁打・82打点・149安打。
    - 近藤健介（ソフトバンク）: 打率 .310・32本塁打・108打点・151安打。
    - 大山悠輔（阪神: .281 20本 84点）、中野拓夢（阪神: .293 146安打）、牧秀悟（DeNA: .280 30本 75点）、増田珠（ヤクルト: .293 9本 39点）。
  - **個人投手スタッツ (`pitching_stats`)**:
    - 髙橋遥人（阪神）: **16勝** 4敗・防御率 1.87（2位）（**セ最多勝**、セ投手MVP、ベストナイン）。
    - 村上頌樹（阪神）: 10勝 6敗・防御率 **1.85**（**セ最優秀防御率**）・155奪三振。
    - 才木浩人（阪神）: 10勝 7敗・防御率 2.51・**175奪三振**（**セ最多奪三振**）。
    - 平良海馬（西武）: 防御率 **1.36**（**パ最優秀防御率**）。
    - 北山亘基（日本ハム）＆A.エスピノーザ（オリックス）: **13勝**（**パ最多勝タイ**）。
    - 荘司康誠（楽天）: **171奪三振**（**パ最多奪三振**）。
    - 救援・守護神: R.マルティネス（巨人: **42S** セ最多セーブ）、杉山一樹（ソフトバンク: **35S** パ最多セーブタイ）、マチャド（オリックス: **35S** パ最多セーブタイ）、松山晋也（中日: 30S）。
- **📊 2024 vs 2025 vs 2026 NPB 投打総合・戦力進化ダッシュボード**:
  - ナレッジデータベース（`knowledge_articles`）に NPB 公式確定記録を反映したインタラクティブダッシュボードを投入。
  - Live Concierge（v2.8.1）から「🎙️ Live解説」を実行することで、2026年の佐藤輝明の三冠王や髙橋遥人の最多勝など公式記録に基づくリアルタイム音声解説・FAQ対応が可能に。
- **🤖 MCP チャット システムプロンプト更新**:
  - `server/routes/mcpChat.cjs` のプロンプト案内を NPB 公式記録に完全更新。

---

## [v2.8.1] - 2026-10-03

### 🚀 Live Concierge ナレッジデータベース音声解説 & FAQ & 自律ツール連携リリース

#### ✨ Added (新機能・機能追加)
- **📚 🎙️ Live Concierge ナレッジベース連携 & 音声解説・FAQ機能**:
  - ナレッジデータベース（`knowledge_articles`）に蓄積された DeepResearch 調査レポートや AI MCP Analytics のデータ分析ダッシュボードを Live Concierge で即座に読み込み、音声で概要やトレンドを分かりやすく解説・FAQ応答する機能を追加。
  - **Flash 3.8 Live 全二重 (Barge-in / Interrupt) 最適化**: 接続開始時、AI が「『〇〇』のレポートを読み込みました。概要を説明しますが、質問があればいつでも質問が可能です」と発話を開始し、ユーザーが途中で割り込んで質問しても即座に回答へ切り替える高レスポンスな対話を実現。
  - **画面・ナレッジ切り替え検知 (Dynamic Transition)**: 閲覧中のレポートや共有タブを切り替えた際、「画面が切り替わりました。『〇〇』のレポートを読み込みました。概要を説明します...」と AI 側からシームレスに新しい対象レポートの説明へ切り替える動的コンテキスト注入を実装。
- **🛠️ Gemini Live 自律ナレッジ参照 & 検索ツール (Function Calling)**:
  - Gemini Multimodal Live API の `setup.tools` に専用のナレッジ参照ツール（`get_knowledge_article`, `search_knowledge_articles`, `list_recent_knowledge`）を装備。
  - 音声対話中にユーザーが「他の関連レポートはある？」「前回の調査結果と比較して」と尋ねた場合、Gemini Live が自律的にツールを呼び出して DB を検索・参照し、即答する高度なエージェント挙動を実現。
  - ツール実行中は UI 上に「📚 ナレッジデータベースを検索中...」等のインジケーターをアニメーション表示。
- **🧩 ナレッジ・セマンティック抽出ユーティリティ (`knowledgeExtractor.cjs`)**:
  - 長大な Markdown 本文、HTML 見出し、データテーブル、Chart.js のデータセット定義（labels, data）、SVG テキストから、AI が高密度に理解できる要約コンテキストを自動抽出・構造化。
- **🎯 ナレッジベース & GenUI プレビューからのワンクリック連携**:
  - `KnowledgeBase.jsx`（詳細ヘッダーおよび GenUI ツールバー）に **「🎙️ Live解説」** ボタンを新設。ワンクリックで対象ナレッジを紐付けた状態で Live Concierge が起動。
  - `HtmlPreviewCodeBlock.jsx`（MCP Chat 等の GenUI ダッシュボード）にも **「🎙️ Live解説」** ボタンを設置。
- **🧭 Live Concierge 内 ナレッジセレクター & サブツールバー**:
  - Live Concierge ウィジェットの上部に、参照可能なナレッジ記事をプルダウン選択できるサブツールバーを配置。読込ステータスやタグバッジを視覚的に表示。

---

## [v2.8.0] - 2026-10-02

### 🚀 Gemini 3.8 Multimodal Live Concierge & 動的モデル管理 & Safari 完全互換リリース

#### ✨ Added (新機能・機能追加)
- **🎙️ 👁️ Gemini 3.8 Multimodal Live Concierge（画面認識・リアルタイム音声対話AI）**:
  - Google の最新マルチモーダルリアルタイムストリーミング技術「Gemini 3.8 Multimodal Live API（`BidiGenerateContent`）」を統合した新アプリ『Live Concierge』を新設。
  - **ブラウザ標準画面共有 API (`getDisplayMedia`)**: 特別なプラグインや外部ソフト不要で、ユーザーのデスクトップ画面を Canvas 経由で毎秒1回（1 FPS）の軽量 JPEG フレームとしてストリーミング送信。
  - **スマート VAD (Voice Activity Detection)**: ユーザーの発声を検出し、発話終了時の静寂（約 850ms）を自動検知して `clientContent` として即時コミット。高速かつ確実な音声ターン対話を実現。
  - **Safari / Web Audio API 完全互換**: Google Live API の 24kHz 音声を Mac / Safari のハードウェア標準レート（48kHz）へ滑らかにリアルタイム変換する高品質リサンプリング（`resampleFloat32`）およびサイレントアンロックを実装。
  - **🔊 音声テスト機能**: ヘッダーにワンクリックでテストチャイム音を再生するボタンを新設。Safari の自動再生ポリシー（Autoplay Policy）を解除し、音声出力の正常性を即時確認可能に。
  - **セキュアなバックエンド WebSocket プロキシ (`/ws/gemini-live`)**: APIキーをフロントエンドに露出させず、ZTA認証（JWT/Cookie）のもと Google アップストリーム WebSocket とセキュアに相互中継。
  - **ビジュアル・オーディオインターフェース**: AIが見ている視野のミニプレビュー小窓、発話状態に応じた動的波形ビジュアライザー、リアルタイム字幕ログ、声質（Puck, Kore, Aoede, Fenrir）の動的切替を完備。
- **⚙️ Admin 専用 Live Concierge 動的モデル設定管理タブ (`LiveConciergeTab.jsx`)**:
  - `.agents/AGENTS.md` の開発原則（ハードコード禁止）を徹底遵守し、System Settings 画面に管理者限定の専用設定タブを新設。
  - 将来の新モデル（Gemini 4 Live 等）登場時にもコード修正不要で、管理者がモデル ID・表示名・Extended Thinking 有無をデータベースへ動的登録・管理可能に。
- **🖥️ AI Analytics ダッシュボードの MacOSUI 内 Browser（iframe）統合**:
  - MCP Chat で生成された GenUI ダッシュボードにおいて、従来の「別タブ」ボタンを完全維持しつつ、新たに **「🖥️ デスクトップで開く」** ボタンを新設。
  - MacOSUI のウィンドウマネージャーを通じて独立した Browser（iframe）ウィンドウとして起動。
  - ウィンドウの自由なリサイズ、フルスクリーン最大化、上下左右のスムーズなスクロール、Chart.js や D3.js 等のベクター SVG 描画を完全にサポート。
  - Live Concierge と同一デスクトップ上で並列配置し、ダッシュボードを見ながらのリアルタイム音声FAQ・データ解説が可能に。

#### 🐛 Fixed (バグ修正・安定性向上)
- **🔌 Google Live API 重複 setup 送信の防止 (`connectOrSwitchUpstream`)**:
  - セッション接続時に setup メッセージが二重送信されることによる Google サーバー側からの切断（code 1006）を完全解消。
- **🧠 Extended Thinking モデルの必須パラメータ対応**:
  - `gemini-3.8-live-extended-thinking` 利用時に必須となる `thinkingConfig: { thinkingLevel: "low" }` を自動付与し、code 1007 切断を防止。
- **🔇 Safari での音声再生ミュート・サンプルレート不一致の解消**:
  - Safari の Autoplay Policy によるサイレントブロックを解消し、`getChannelData(0).set()` と 48kHz アップサンプリングにより Mac のスピーカーからクリアな日本語音声を再生可能に。

---

## [v2.7.3] - 2026-09-28

### 🚀 Personal RAG 情報ソース可視化・同期強化 & 参照ドキュメント追跡リリース

#### ✨ Added (新機能・機能追加)
- **📚 回答バブル下部への情報ソース可視化バッジ表示 (`renderSourceInfo`)**:
  - AIが回答を生成した根拠（情報ソース）を一目で判別できるよう、回答バブル下部に視認性の高い情報源バッジを新設。
  - **Google Drive Personal RAG**: 参照した社内ドキュメント名（複数件対応）をバッジ内に一覧表示。
  - **Google Search Grounding**: 最新のWeb検索（Grounding）に基づいて回答した旨を明示。
  - **パブリック一般知識**: RAG未連携または一般的な知識から回答した旨を明示。
  - **RAG未同期警告**: Google Drive 同期フォルダ内が0件の場合に「社内ドキュメントが未同期のため一般知識で回答中」であることをユーザーに即座に警告表示。
- **📁 RAG ファイル名永続化と自動マイグレーション (`file_name`)**:
  - `rag_files` テーブルに `file_name TEXT` カラムを追加し、SQLite / PostgreSQL 双方で起動時に自動カラム追加（マイグレーション）を行う機構を実装。
  - Google Drive から Gemini File API へのアップロード時に元ファイル名（`file_name`）を DB に保存し、チャット推論時に Gemini API の回答メタデータとしてクライアントへ正確に連携。
- **⚡ Personal RAG 同期対象フォーマット拡充 & ユーザーフィードバック強化**:
  - 対応 MIME タイプに Markdown (`text/markdown`, `.md`) および CSV (`text/csv`, `.csv`) を追加し、技術仕様書や集計データファイルの同期に対応。
  - 設定画面（`SystemSettings.jsx`）での「Sync Now」実行時、同期された正確なファイル件数（例: 「○件のファイルを同期しました」）および 0 件時の注意喚起アラートを表示するよう改善。

#### 🐛 Fixed (バグ修正・安定性向上)
- **🎯 RAG 同期ファイル存在時のプロンプト最優先参照指示**:
  - 社内ドキュメントが同期されている場合、Gemini システムプロンプトに「添付された社内ドキュメントの記述を最優先して回答し、参照した社内ドキュメント名を明記せよ」と明示的に指示し、一般知識との混同を防止。

---

## [v2.7.2] - 2026-09-28

### 🚀 MCP ツール動的バインド・GenUI 堅牢化 & Pod ナレッジ認可 (RBAC) 完全連携リリース

#### ✨ Added (新機能・機能追加)
- **📦 Data Analyst ロールへの Pod アクセス権 (`allowed_pods`) 標準追加 & JWT トークン伝達**:
  - 認可ポリシー（PDP: `RBAC_POLICIES`）において `data_analyst` に `allowed_pods: ['*']` を標準設定（新規DB作成時および自動マイグレーション対応）。
  - ログイン時および `/api/auth/me` でユーザーの複数ロールから `allowed_pods` を集約し、JWT 認証トークンに正しく伝達するよう改修。
  - `server/routes/pods.cjs` において、カンマ区切りの複数ロール（例: `admin,data_analyst`）にも対応したセキュアな管理者判定ロジックを導入。
  - ナレッジ保存モーダル（`SaveToKnowledgeModal`）で、Data Analyst ロールのユーザーでもアクセス可能な Pod（デジ庁データ分析、NPB野球データ分析等）が正しくドロップダウン表示され、分析ダッシュボードをワンクリックで Pod へ保存可能に。
- **🌐 クライアント側メタ情報読み込み & パイプライン連携エンドポイント (`GET /api/mcp/meta`)**:
  - ZTA-MCP-GATEWAY に登録されたメタ情報（サーバー定義・ツール群）をクライアントへ連携するルートを提供。

#### 🐛 Fixed (バグ修正・安定性向上)
- **🔧 MCP ツール 0件バインドバグの完全解消 (`server/mcpClient.cjs`)**:
  - `hasServerAccess(serverId, allowedWidgets, user)` を新設。
  - `app:mcp-chat` アプリ権限または `action:use_mcp_tools` アクション権限を持つユーザー（Data Analyst 等）に対して、ZTA-MCP-GATEWAY 経由の全 5 サーバー（NPB、デジタル庁、カタログ、ナレッジ、Gemma）および全 15 ツールが確実にバインドされるよう修正。
- **🛡️ GenUI ダッシュボード切断クラッシュの根絶 & 自動修復 (`safeCode`)**:
  - 分析ダッシュボード生成プロンプトに「注目対象（上位5〜8件）への絞り込み」と「末尾の `</script></body></html>` まで完全に出力する義務」を明記。
  - フロントエンドの `HtmlPreviewCodeBlock.jsx` に、万が一のトークン切断時にも構文エラーで画面が真っ白になるのを防ぐ自己修復ロジック（欠落した閉じタグの自動補完）を実装。
- **📖 ドキュメント拡充**:
  - `README.md` に Data Analyst ロールの推奨 RBAC 設定サンプルおよび各パラメータ（`allowed_widgets`, `allowed_actions`, `allowed_models`, `allowed_pods`）の解説を追記。

---

## [v2.7.1] - 2026-09-24

### 🚀 GenUI ダッシュボード描画の安定化 & EC2 永続データ保護 (Zero Data Loss) リリース

#### ✨ Added (新機能・機能追加)
- **⚡ GenUI トークン上限の大幅拡大 (`max_output_tokens: 24576`)**:
  - Gemini API によるダッシュボード生成時の `max_output_tokens` を 8,192 から **24,576** へ 3 倍に拡大。
  - 大規模な多年度比較データや複雑なインタラクティブウィジェットの出力時でも、トークン枯渇による末尾切断を完全に根絶。
- **📊 JavaScript 配列埋め込み & 動的レンダリングプロンプトの最適化**:
  - 数十行にわたる長大な静的 HTML の `<tr><td>...</td></tr>` ベタ書きを抑止し、クエリ結果をコンパクトな JavaScript オブジェクト配列（`const batterData = [...]`）として埋め込んで `map()` による動的生成を行うプロンプトへと最適化。
  - HTML のトークン消費量を 1/4 以下に劇的に削減し、末尾の `<script>`（Chart.js 初期化や詳細カード対話ロジック）が 100% 確実に完結する構造を確立。

#### 🐛 Fixed (バグ修正・安定性向上)
- **🛡️ iframe 内でのスクリプト初期化セーフティディスパッチャー**:
  - `HtmlPreviewCodeBlock.jsx` において、iframe 内の `DOMContentLoaded` イベントがすでに発火済みの場合でも、確実に Chart.js や動的スクリプトを安全に初期化・再トリガーする安全機構を導入。
- **🐳 EC2 本番環境における永続ボリューム保護 & VUP デプロイ自動化**:
  - `scripts/deploy-ec2.sh` を導入し、デプロイ直前の SQLite 自動バックアップ、永続ボリューム（`/app/data`）のマウント維持、既存ユーザー（admin 等）および蓄積データの自動生存検証ロジックを確立。
  - バージョンアップ（VUP）時にアクティベーション画面が再表示されて蓄積データがリセットされるリスクを完全に排除。

---

## [v2.7.0] - 2026-09-24

### 🚀 MCP 最新仕様 (SEP-2663 Async Tasks) & 設定画面 403 監査ノイズ解消リリース

#### ✨ Added (新機能・機能追加)
- **⚡ MCP 最新仕様準拠: 完全ステートレス化 & SEP-2663 Async Tasks 非同期エンジン**:
  - 2026年7月の MCP 公式仕様改定（SEP-2663 Async Tasks 拡張機能 & 完全ステートレス運用）に完全準拠。
  - バックグラウンド実行 API（`POST /api/mcp/tasks`、`GET /api/mcp/tasks/:taskId`、`POST /api/mcp/tasks/:taskId/cancel`）を新設。
  - SQLite および PostgreSQL に `mcp_tasks` テーブルを実装し、長時間の多段ツール呼び出しや大規模データ分析を非同期タスクとして安全に実行・永続化。
- **⏱️ Tasks 進捗リアルタイム可視化 UI & タイムアウト根本対策**:
  - `McpChat` UI において、タスクの実行経過秒数タイマー、実行中ステップメッセージ、いつでも中止可能な **[中断 (Cancel)]** ボタンを備えたリアルタイム進捗カードを導入。
  - CloudFront の 60 秒タイムアウト制限を完全に回避し、巨大な Generative UI ダッシュボード生成や反復推論処理の完了まで確実にポーリング。
- **🔍 HTML / GenUI レンダラー判定の強化**:
  - Markdown 内のコードブロックにおいて、言語指定の有無にかかわらず HTML タグや Tailwind クラスを含む Generative UI ウィジェットを確実に検出し、インタラクティブ描画。

#### 🐛 Fixed (バグ修正・安定性向上)
- **🛡️ 一般ユーザー設定画面表示時の 403 監査ログノイズ解消 (Issue #1)**:
  - `SystemSettings.jsx` において、ユーザーの認可ポリシー（`allowed_actions` / `allowed_widgets`）に基づき、利用可能なタブ（`Skills` 等）を動的に初期表示するよう改修。
  - 管理者専用 API（`/api/gemini/models`、`/api/rag/popular-queries/all`）の呼び出しを認可ガードで保護し、一般ユーザーログイン・設定画面開時に発生していた不要な 403 警告ノイズを完全撲滅。
  - 各種設定タブ（Roles, General, System, Security Logs 等）の認可ガードを強化。
- **📈 DeepResearch デイリー実行制限の引き上げ**:
  - デフォルトのデイリー実行回数上限を 1 から 5 回に引き上げ、DB 設定（`DEEP_RESEARCH_DAILY_LIMIT`）を優先参照する柔軟な設計に改善。
- **🐳 Docker ビルド環境における OS メタデータ (AppleDouble) 除外**:
  - macOS の `._*`（AppleDouble）ファイルや `.DS_Store` を `.dockerignore` および `eslint.config.js` で全階層一括無視するよう改善し、Linux コンテナビルドの堅牢性を向上。

---

## [v2.6.0] - 2026-09-18

### 🚀 AI Analytics ナレッジベース化 & Pod 共有リリース

#### ⚠️ 前提条件・連携要件 (Prerequisites & Dependencies)
- **zta-mcp-gateway v1.1.1 必須**:
  - 本バージョン（v2.6.0）で追加された「デジタル庁 行政手続分析 MCP（`admin-procedures`）」および「AI Analytics（GenUI×MCP）」機能を利用するには、**`zta-mcp-gateway v1.1.1` 以上** が必要です。
  - `zta-mcp-gateway v1.1.1` にはデジタル庁の行政手続棚卸調査データ（令和7年度・7.6万件）がプリセットされており、OAuth / A2A 認証と SSE トランスポート経由で自動連携されます。

#### ✨ Added (新機能・機能追加)
- **🏛️ デジタル庁 行政手続分析 MCP ネイティブ対応**:
  - デジタル庁が公開する「行政手続等の棚卸調査データ（全国 76,827 手続）」を AI がダイレクトに集計・可視化できる MCP サーバー（`admin-procedures`）に正式対応。
  - オンライン化率、年間申請件数、ライフイベント別分類（出生・就職・引越し・介護等）、手数料・根拠法令を自律分析し、行政改革ダッシュボードを即座に生成可能。
  - 初回起動時に ZTA MCP Gateway（ポート 8085 / `admin-procedures`）への自動登録とクイックプロンプトのマージを実行。
- **📚 AI Analytics（MCP×GenUI）のナレッジベース保存機能**:
  - `McpChat` および `Gemini` で生成されたインタラクティブな HTML ダッシュボードウィジェット上部に **[📚 ナレッジに保存]** ボタンを新設。
  - ワンクリックでタイトル、保存先 Pod（「デジ庁データ分析」「NPB野球データ分析」「🌐 共通」等）、タグを指定してナレッジベースへダイレクト保存可能に。
- **🖥️ ナレッジベース画面での「インタラクティブ GenUI プレビュー」モード**:
  - `KnowledgeBase` アプリにプレビューモードとソースコード表示の切り替えタブを追加。
  - Chart.js グラフ、TailwindCSS スタイリング、クリックイベント連動（選手詳細カードや動的フィルタ）が、安全な iframe 環境下でナレッジベース上でも 100% そのまま動的に動作。
- **👥 Pod とロールによるチーム共有・限定公開とトークン消費ゼロ化**:
  - 一度分析・生成したダッシュボードをチームや組織の Pod で共有することで、同僚やクライアントは **AI トークン消費ゼロ・待ち時間ゼロ（瞬時表示）** でいつでも最新のレポートを活用可能に。
  - 組織のロール（RBAC）に基づいて、特定の Pod にアクセスできるメンバーを厳格に限定公開・アクセス制御（PDP/PEP準拠）。
- **📦 初期 Pod ＆ サンプルダッシュボード自動初期化**:
  - 初回起動時（`autoActivate`）に「デジ庁データ分析」「NPB野球データ分析」Pod を自動生成。
  - デジタル庁 行政手続等の棚卸調査（7.6万件）に基づくインタラクティブ行政改革ダッシュボードをサンプル記事としてネイティブ同梱・自動シード。
  - NPB 2024-2025 マルチ年度 セイバーメトリクス分析ダッシュボードを自動シード。
- **💎 Gemini チャットへの GenUI レンダラー統合**:
  - `Gemini.jsx` の Markdown レンダラーを拡張し、HTML コードブロックを `HtmlPreviewCodeBlock` としてインタラクティブに直接プレビュー・操作・保存可能に統一。

#### 🛡️ Quality & Hardening (品質・セキュリティ)
- **🚫 LLM モデル名ハードコードの完全排除**:
  - `server/routes/knowledge.cjs` のトークン計算処理に残っていたモデル名固定値を排除し、システム設定（`GEMINI_MODEL`）から動的取得・フォールバックするよう改修（開発原則 RULE 遵守）。

---

## [v2.5.1] - 2026-09-10

### 🚀 AI-Native BI & Zero Trust Meta-Catalog Release

#### ✨ Added (新機能・機能追加)
- **📚 Meta-Catalog MCP による企業メタ情報・GenUI 設計図の一元管理**:
  - 膨大な社内データベースやツール群を AI が迷わず自律活用できるよう、データスキーマと推奨 GenUI 仕様をカプセル化した「Meta-Catalog MCP」との統合連携をサポート。
  - AI がテーブル探索を行うことなく、最初からカラム構造・リレーション・推奨クエリを把握して即座に本命の集計クエリを実行可能に。
  - チャットシステムプロンプトに Meta-Catalog の参照ガイダンスを追加。
- **📊 NPB プロ野球 2024-2025 マルチ年度 WAR/WAA GenUI ダッシュボード**:
  - 2024年 vs 2025年の打者・投手セイバーメトリクス指標（WAR, WAA, OPS, FIP 等）の2カ年比較棒グラフ（Chart.js）。
  - チャートのバークリックに連動して動的に更新される「選手詳細スタッツカード」。
  - 前年比増減（+緑 / -赤）の色分け比較テーブルおよび AI 要因分析インサイトバナーの描画。
- **📥 アバター画像ワンクリックダウンロード機能**:
  - 「System Settings」の Users タブにおいて、AI Avatar Creator で生成した高解像度のアバター画像（PNG/JPG）をワンクリックで手元の PC に保存できるダウンロードボタンを追加。
  - 管理者画面の Active Users リストからも、各メンバーのアバター画像を直接ダウンロード可能に。

#### 🛡️ Security & Reliability (セキュリティ・信頼性・耐障害性)
- **🔄 MCP 自己修復＆サイレント自動再接続 (Self-Healing Auto-Reconnect)**:
  - アイドル時間経過による SSE セッション切断や一時的なネットワークエラー（`SSE session not found or expired` 等）を検知した際、古いコネクションを破棄し、裏側で自動的にセッションを再確立して 1 回だけ即座にリトライするフェイルオーバー処理を `mcpClient.cjs` に実装。
- **🚫 監査ログノイズ（不要な403警告）の完全抑止**:
  - `SystemSettings.jsx` のマウント時に、一般ユーザーによる不要な管理用 FAQ API へのリクエストをフロントエンド側で権限ガードし、セキュリティ監査ログのアラートノイズを解消。

---

## [v2.4.3] - 2026-08-27

### 🐛 Google OAuth Validation & Setup Sanitization Patch

#### 🛠️ Fixed (バグ修正・改善)
- **Google OAuth Client ID / Secret 入力値の自動サニタイズ**:
  - アクティベーション画面（SetupScreen）での入力時に、コピー＆ペーストで紛れ込む先頭・末尾の半角スペースや改行を自動でトリム（`trim()`）する処理を追加。
- **Client ID 形式の厳格なリアルタイム・バリデーション**:
  - Google OAuth Client ID（`*.apps.googleusercontent.com`）の形式チェックをフロントエンドおよびバックエンド API（`/api/config`）の両層に導入。
  - 不正な形式や入力ミスがある場合、アクティベーション時に明確なエラーメッセージを表示し、Google ログイン時の `401: invalid_client (The OAuth client was not found)` エラーを未然に防止。
- **初回アクティベーション失敗時の自己復旧（リカバリー）手順の提供**:
  - 誤った Client Secret 等でアクティベーションを通過してしまった場合でも、設定リセット用ワンライナーを実行することで、安全にアクティベーション画面を再表示して再設定できるリカバリーフローを確立。

---

## [v2.5.0] - 2026-08-25

### 🚀 Gemma 4 Local LLM-RAG & Hybrid AI Release

#### ✨ Added (新機能・機能追加)
- **🛡️ Gemma 4 Local LLM-RAG (完全社内完結 / ゼロ外部漏洩)**:
  - 外部クラウドへ 1 バイトも機密データを送信することなく、Apple Silicon Mac / オンプレミス GPU 上の **Gemma 4 (128K Long Context / KV Cache)** を用いて社内文書・HTML/SVG 構造化ナレッジを高速推論。
  - チャット UI のモードセレクターに `🛡️ Gemma 4 Local RAG` を追加。
- **🌐 ハイブリッド AI 接続ガイド (Tailscale VPN 連携)**:
  - AWS EC2 上で稼働する MacOSUI と、手元の Mac 上の Ollama / MLX (Gemma 4) を Tailscale 暗号化メッシュトンネルで安全に直結。
  - ルーターのポート開放や固定 IP なしで、AWS から安全にローカル LLM を利用可能。
- **📊 リアルタイム・コンテキスト使用量メーター**:
  - Gemini / Gemma 4 のプロンプト・出力トークン数およびコンテキストウィンドウ使用率をチャットフッターにクリーンに常時表示。
- **📐 数式レンダリング (KaTeX & ReactMarkdown)**:
  - チャットメッセージ内の LaTeX 数式（インライン & ディスプレイ）を美しく高速描画。

---

## [v2.4.2] - 2026-08-25

### 🚀 Initial Public Release (Community Edition)

#### ✨ Added (新機能・機能追加)
- **Deep Research エンジン & 自動初期プロンプト**:
  - 自律型リサーチおよび HTML/SVG ナレッジ生成・インフォグラフィック生成のワークフロー定義をデータベース（SQLite / PostgreSQL）初期化時に完全自動登録。
  - Google Drive へのレポート・画像・HTML 自動エクスポート連携。
- **AWS EC2 (x86_64) Terraform 自動プロビジョニング**:
  - `terraform apply` 一発で Amazon Linux 2023 サーバーの起動、スワップメモリ作成、Docker 環境構築、コンテナ起動までを完全自動化。
  - CloudFront（低コスト・即時 HTTPS）および ALB（本番推奨）のルーティング構成に対応。
- **ナレッジベース & Gemini File Search RAG**:
  - JSON パッケージによる社内ナレッジのインポート・エクスポートをサポート。
  - Google Drive や社内文書を Gemini 3.6 Flash の File Search 機能で高速検索・要約。
- **Zero Trust Architecture (ZTA) & セキュリティ**:
  - Agent-to-Agent (A2A) 認証および JWT トークン交換プロトコル。
  - 秘密鍵のメモリ使用後即時ゼロクリア (`keyBuffer.fill(0)`) によるメモリ漏洩保護。
  - AES-256-GCM による API キーやシークレットの暗号化保管。
- **コミュニティ支援・Issue Template**:
  - バグ報告用テンプレート (`.github/ISSUE_TEMPLATE/bug_report.md`) の追加。
