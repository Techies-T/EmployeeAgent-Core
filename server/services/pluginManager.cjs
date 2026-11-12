const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db.cjs');
const auditDb = require('../auditDb.cjs');
const signatureVerifier = require('./pluginSignatureVerifier.cjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');

// Ensure plugins directory exists for Option B dynamic package storage
try {
    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }
} catch (err) {
    console.warn('[PluginManager] Could not create plugins directory:', err.message);
}

/**
 * Official Widget Plugin Catalog (Manifest Registry)
 * Initial Minimum Configuration: ONLY 'gemini' (Normal Chat) and 'mcp-chat' (MCP Client) are installed by default.
 */
const WIDGET_CATALOG = [
    {
        id: 'gemini',
        packageId: 'com.techies.widget.normal-chat',
        name: 'ノーマルチャット',
        englishName: 'Normal AI Chat',
        version: '3.0.0',
        category: 'core_ai',
        iconType: 'gemini',
        defaultInstalled: true,
        tier: 'basic_included',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: '基本パック標準搭載'
        },
        shortDescription: 'シンプルで迷わない標準AI対話クライアント（RAG機能オフ時は単体チャットとして動作）',
        salesPitch: '全社員が迷わず使えるシンプルなAIチャットです。後から「ナレッジ＆RAGプラグイン」を追加すると、画面を変えずに社内ドキュメントや経営会議の事前分析レポートを参照（RAG）して壁打ちできるよう自動拡張されます。',
        windowConfig: {
            defaultWidth: 440,
            defaultHeight: 660,
            minWidth: 360,
            minHeight: 450
        },
        providesCapabilities: ['capability:ai-chat'],
        consumesCapabilities: ['capability:rag-context', 'capability:knowledge-store'],
        aiRouting: {
            usesAi: true,
            label: '💬 ノーマルチャット',
            description: '日常の対話・壁打ち・文章作成で使用する標準モデル',
            providerSettingKey: 'CHAT_AI_PROVIDER',
            geminiModelSettingKey: 'GEMINI_MODEL',
            claudeModelSettingKey: 'CLAUDE_MODEL',
            supportsGemini: true,
            supportsClaude: true,
            supportsLocalAi: true
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: 'Dockに表示されず利用不可' },
                read: { label: '閲覧のみ', description: '過去のチャット履歴やプリセットの参照のみ' },
                execute: { label: '実行可', description: 'AIとのチャット対話・RAG参照が可能' },
                manage: { label: '管理', description: '全社共通チャットプリセットやプロンプトの編集が可能' }
            },
            legacyWidgetId: 'app:gemini',
            manageActions: ['action:edit_workflow_model']
        },
        hasWidgetSettings: true,
        settingsType: 'chat_config'
    },
    {
        id: 'mcp-chat',
        packageId: 'com.techies.widget.mcp-client',
        name: 'MCP クライアント',
        englishName: 'ZTA MCP Analytics Client',
        version: '3.0.0',
        category: 'core_ai',
        iconType: 'mcp-chat',
        defaultInstalled: true,
        tier: 'basic_included',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: '基本パック標準搭載'
        },
        shortDescription: 'ZTA (OAuth JWT + SSE) 準拠のセキュアな外部データ分析・業務システム連携クライアント',
        salesPitch: '社内DBや業務システムのMCPサーバーへゼロトラスト認証（A2A）で接続し、2026年Q1売上見込みなどのデータ抽出・集計・グラフ化を自然言語で行えます。「ナレッジ＆RAGプラグイン」導入時は、分析結果をワンクリックで経営会議アジェンダとして共有できます。',
        windowConfig: {
            defaultWidth: 820,
            defaultHeight: 680,
            minWidth: 520,
            minHeight: 480
        },
        providesCapabilities: ['capability:mcp-analytics'],
        consumesCapabilities: ['capability:knowledge-store', 'capability:rag-context'],
        aiRouting: {
            usesAi: true,
            label: '🔌 MCP クライアント (データ分析)',
            description: 'MCPツールの呼び出し判断・SQL/データ集計・ダッシュボード生成を行うモデル',
            providerSettingKey: 'MCP_AI_PROVIDER',
            geminiModelSettingKey: 'GEMINI_MCP_CHAT_MODEL',
            claudeModelSettingKey: 'CLAUDE_MCP_CHAT_MODEL',
            supportsGemini: true,
            supportsClaude: true,
            supportsLocalAi: false
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: 'Dockに表示されず利用不可' },
                read: { label: '参照のみ', description: '保存済み分析タスクや共有ダッシュボードの閲覧のみ' },
                execute: { label: '実行・分析', description: '許可されたMCPサーバーを用いたデータ抽出・分析実行が可能' },
                manage: { label: '管理', description: 'MCPサーバー接続設定・システムプロンプト・定型タスクの管理が可能' }
            },
            legacyWidgetId: 'app:mcp-chat',
            executeActions: ['action:use_mcp_tools'],
            manageActions: ['action:manage_system_settings']
        },
        hasWidgetSettings: true,
        settingsType: 'mcp_connections'
    },
    {
        id: 'knowledge-base',
        packageId: 'com.techies.widget.knowledge-rag',
        name: 'ナレッジ & RAG ブリーフィング',
        englishName: 'Knowledge Hub & Executive RAG',
        version: '3.0.0',
        category: 'knowledge_collab',
        iconType: 'knowledge-base',
        defaultInstalled: true,
        tier: 'basic_included',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: '基本パック標準搭載'
        },
        shortDescription: 'MCP分析やリサーチ結果を部門・経営会議Podで事前共有し、他メンバーがRAG参照して深掘り議論できる共有知識基盤',
        salesPitch: '【経営会議・部門横断コラボレーションの核心プラグイン】営業支援・経営管理部門がMCPで分析した「Q1売上見込みの全社まとめ」を登録し、会議前にメンバーへ共有できます。各事業部長はそのまとめをRAGとして引き継ぎ、単一ビジネスドメインの課題深掘りやQ2投資判断・AIからの客観的アドバイスを付与して会議に臨めるため、会議の生産性が飛躍的に向上します。',
        windowConfig: {
            defaultWidth: 960,
            defaultHeight: 700,
            minWidth: 640,
            minHeight: 480
        },
        providesCapabilities: [
            'capability:knowledge-store',
            'capability:rag-context',
            'capability:knowledge-mcp',
            'capability:meeting-briefing'
        ],
        consumesCapabilities: [],
        aiRouting: {
            usesAi: true,
            label: '📚 ナレッジ & RAG 検索エンジン',
            description: '共有ナレッジの要約・长コンテキストRAG推論・Google Drive RAG同期に使用するモデル',
            providerSettingKey: 'RAG_AI_PROVIDER',
            geminiModelSettingKey: 'GEMINI_HTML_SVG_MODEL',
            claudeModelSettingKey: 'CLAUDE_MODEL',
            localModelSettingKey: 'LOCAL_AI_MODEL',
            supportsGemini: true,
            supportsClaude: true,
            supportsLocalAi: true
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: 'ナレッジベースの閲覧・RAG参照とも不可' },
                read: { label: '参照のみ (RAG利用可)', description: '許可されたPodのナレッジ閲覧およびチャット/MCPでのRAG参照が可能' },
                execute: { label: '作成・意見投稿', description: 'MCP分析結果のナレッジ登録や、経営会議まとめへの部門別深掘り提案の投稿が可能' },
                manage: { label: '管理・全社公開', description: 'Pod管理・RAGフォルダ管理・公式全社まとめの承認が可能' }
            },
            legacyWidgetId: 'app:knowledge-base',
            manageActions: ['action:manage_rag_folders']
        },
        hasWidgetSettings: true,
        settingsType: 'knowledge_rag'
    },
    {
        id: 'deep-research',
        packageId: 'com.techies.widget.deep-research',
        name: 'DeepResearch エージェント',
        englishName: 'Autonomous DeepResearch',
        version: '3.0.0',
        category: 'research_agent',
        iconType: 'deep-research',
        defaultInstalled: false,
        tier: 'paid_addon',
        pricing: {
            model: 'monthly_per_tenant',
            priceJpy: 50000,
            trialDays: 14,
            label: '¥50,000 / 月 (14日間無料トライアル可)'
        },
        shortDescription: '市場動向・競合調査・業界トレンドを自律的にマルチステップ調査し、インフォグラフィック付きレポートを生成',
        salesPitch: '社内データ（MCP）だけでは見えない「市場環境・競合動向・マクロ経済」をAIが自律調査し、ビジュアルレポート化します。「ナレッジ＆RAGプラグイン」と組み合わせれば、外部市場調査と内部MCP売上分析を統合した高度な経営戦略立案が可能になります。',
        windowConfig: {
            defaultWidth: 560,
            defaultHeight: 720,
            minWidth: 420,
            minHeight: 500
        },
        providesCapabilities: ['capability:deep-research'],
        consumesCapabilities: ['capability:knowledge-store', 'capability:rag-context'],
        aiRouting: {
            usesAi: true,
            label: '🔍 DeepResearch (自律調査・図解生成)',
            description: 'マルチステップ深掘り調査およびHTML/SVGインフォグラフィック生成に使用するモデル',
            providerSettingKey: 'RESEARCH_AI_PROVIDER',
            geminiModelSettingKey: 'GEMINI_RESEARCH_MODEL',
            claudeModelSettingKey: 'CLAUDE_MODEL',
            supportsGemini: true,
            supportsClaude: true,
            supportsLocalAi: false
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '履歴参照のみ', description: '過去に生成されたリサーチレポートの閲覧のみ' },
                execute: { label: '調査実行可', description: '新規ディープリサーチの実行およびHTML/図解レポート生成が可能' },
                manage: { label: '管理', description: 'リサーチ用プロンプトテンプレートや保存先フォルダ設定の変更が可能' }
            },
            legacyWidgetId: 'app:deep-research',
            executeWidgets: ['workflow:deepresearch_html', 'workflow:deepresearch_infographic', 'workflow:deepresearch_full'],
            manageActions: ['action:edit_workflow_model']
        },
        hasWidgetSettings: true,
        settingsType: 'deep_research'
    },
    {
        id: 'virtual-office',
        packageId: 'com.techies.widget.virtual-office',
        name: 'バーチャルオフィス & DM',
        englishName: 'Virtual Office & Team Presence',
        version: '3.0.0',
        category: 'workspace_comm',
        iconType: 'virtual-office',
        defaultInstalled: false,
        isExternalPlugin: true,
        defaultServiceUrl: process.env.VIRTUAL_OFFICE_PLUGIN_URL || 'http://localhost:8091',
        entrypoints: {
            main: '/index.html?view=office',
            subViews: {
                'dm-chat': {
                    path: '/index.html?view=dm-chat',
                    defaultWidth: 380,
                    defaultHeight: 500
                }
            },
            backgroundUnreadApi: '/api/vo/dm/unread'
        },
        tier: 'paid_addon',
        pricing: {
            model: 'monthly_per_tenant',
            priceJpy: 20000,
            trialDays: 14,
            label: '¥20,000 / 月 (14日間無料トライアル可)'
        },
        shortDescription: 'リモート環境でもチームの在席状況・業務ステータスを可視化し、多言語自動翻訳付きDMチャットを提供（独立プラグイン）',
        salesPitch: '誰がどのルーム（会議室・集中ブース）にいるかをリアルタイムに把握し、ワンクリックで声をかけられるバーチャルオフィス空間を、EA-Core本体と完全分離されたPQC署名済みプラグインとして追加します。',
        windowConfig: {
            defaultWidth: 860,
            defaultHeight: 620,
            minWidth: 600,
            minHeight: 450
        },
        providesCapabilities: ['capability:virtual-office', 'capability:dm-chat'],
        consumesCapabilities: [],
        aiRouting: {
            usesAi: false
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: 'フロア閲覧のみ', description: 'メンバーの在席状況確認のみ（移動・DM不可）' },
                execute: { label: '入室・DM可', description: 'ルーム移動・ステータス変更・DM送受信が可能' },
                manage: { label: '管理', description: 'ルーム構成・AIアシスタント就業ルールの管理が可能' }
            },
            legacyWidgetId: 'app:virtual-office',
            manageActions: ['action:manage_assistant_rules']
        },
        hasWidgetSettings: false
    },
    {
        id: 'live-concierge',
        packageId: 'com.techies.widget.live-concierge',
        name: 'Live Concierge (音声・画面対話)',
        englishName: 'Multimodal Live Concierge',
        version: '3.0.0',
        category: 'core_ai',
        iconType: 'live-concierge',
        defaultInstalled: false,
        tier: 'paid_addon',
        pricing: {
            model: 'monthly_per_tenant',
            priceJpy: 30000,
            trialDays: 14,
            label: '¥30,000 / 月 (14日間無料トライアル可)'
        },
        shortDescription: 'Gemini Multimodal Live API を活用したリアルタイム音声・画面共有AIコンシェルジュ',
        salesPitch: '画面を見せながら音声でAIとリアルタイムに議論・操作サポートを受けられる次世代のマルチモーダル・コンシェルジュ機能です。',
        windowConfig: {
            defaultWidth: 520,
            defaultHeight: 660,
            minWidth: 400,
            minHeight: 500
        },
        providesCapabilities: ['capability:live-concierge'],
        consumesCapabilities: ['capability:knowledge-store'],
        aiRouting: {
            usesAi: true,
            label: '🎙️ Live Concierge (リアルタイム音声対話)',
            description: 'Multimodal Live 音声・画面共有ストリーミングで使用するモデル',
            providerSettingKey: 'LIVE_AI_PROVIDER',
            geminiModelSettingKey: 'GEMINI_LIVE_DEFAULT_MODEL',
            supportsGemini: true,
            supportsClaude: false,
            supportsLocalAi: false
        },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '不可', description: '音声セッションは実行権限が必要です' },
                execute: { label: '音声対話可', description: 'リアルタイム音声・画面共有セッションの利用が可能' },
                manage: { label: '管理', description: 'Liveモデル設定の管理が可能' }
            },
            legacyWidgetId: 'app:live-concierge'
        },
        hasWidgetSettings: true,
        settingsType: 'live_concierge'
    },
    {
        id: 'html-editor',
        packageId: 'com.techies.widget.html-editor',
        name: 'HTML / レポートエディタ',
        englishName: 'Interactive Report & HTML Studio',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'html-editor',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: 'オプション無料追加可'
        },
        shortDescription: 'AIが生成したダッシュボードやHTMLレポートをWYSIWYG編集・プレビュー・公開するエディタ',
        salesPitch: 'MCPやDeepResearchで生成したHTMLダッシュボードを微調整し、プレゼン資料として仕上げることができます。',
        windowConfig: {
            defaultWidth: 820,
            defaultHeight: 620
        },
        providesCapabilities: ['capability:html-editor'],
        consumesCapabilities: ['capability:knowledge-store'],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: 'プレビューのみ', description: 'HTMLプレビューのみ' },
                execute: { label: '編集・保存可', description: 'レポート編集・保存が可能' },
                manage: { label: '管理', description: '公開レポート管理が可能' }
            },
            legacyWidgetId: 'app:html-editor'
        },
        hasWidgetSettings: false
    },
    {
        id: 'finder',
        packageId: 'com.techies.widget.finder',
        name: 'Finder (Google Drive 連携)',
        englishName: 'Cloud Drive Finder',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'finder',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: 'オプション無料追加可'
        },
        shortDescription: 'Google Drive フォルダや生成レポートファイルをブラウズするファイルマネージャー',
        salesPitch: '社内Google Drive上のドキュメントやAI生成レポートをデスクトップ上で直接整理・閲覧できます。',
        windowConfig: {
            defaultWidth: 720,
            defaultHeight: 500
        },
        providesCapabilities: ['capability:file-browser'],
        consumesCapabilities: [],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '閲覧のみ', description: 'ファイル一覧の閲覧のみ' },
                execute: { label: '操作可', description: 'ファイルの閲覧・インポートが可能' },
                manage: { label: '管理', description: 'ルートフォルダ設定の変更が可能' }
            },
            legacyWidgetId: 'app:finder'
        },
        hasWidgetSettings: true,
        settingsType: 'finder_config'
    },
    {
        id: 'browser',
        packageId: 'com.techies.widget.browser',
        name: '内蔵ブラウザ',
        englishName: 'Workspace Web Browser',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'browser',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: {
            model: 'included',
            priceJpy: 0,
            label: 'オプション無料追加可'
        },
        shortDescription: 'デスクトップ内でWebページや外部ダッシュボードを表示するミニブラウザ',
        salesPitch: 'ワークスペースから離れずに参照URLや社内ポータルを確認できます。',
        windowConfig: { defaultWidth: 800, defaultHeight: 600 },
        providesCapabilities: [],
        consumesCapabilities: [],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '利用可', description: 'Web閲覧が可能' },
                execute: { label: '利用可', description: 'Web閲覧が可能' },
                manage: { label: '管理', description: '管理が可能' }
            },
            legacyWidgetId: 'app:browser'
        },
        hasWidgetSettings: false
    },
    {
        id: 'stickies',
        packageId: 'com.techies.widget.stickies',
        name: '付箋 (Stickies)',
        englishName: 'Desktop Stickies',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'stickies',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: { model: 'included', priceJpy: 0, label: 'オプション無料追加可' },
        shortDescription: 'デスクトップ上に貼り付けられるクイックメモ付箋ウィジェット',
        salesPitch: 'ちょっとしたプロンプト案やTODOをデスクトップ上にメモしておけます。',
        windowConfig: { defaultWidth: 320, defaultHeight: 280 },
        providesCapabilities: [],
        consumesCapabilities: [],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '利用可', description: '利用可能' },
                execute: { label: '利用可', description: '利用可能' },
                manage: { label: '管理', description: '利用可能' }
            },
            legacyWidgetId: 'app:stickies'
        },
        hasWidgetSettings: false
    },
    {
        id: 'calendar',
        packageId: 'com.techies.widget.calendar',
        name: 'カレンダー',
        englishName: 'Google Calendar Widget',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'calendar',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: { model: 'included', priceJpy: 0, label: 'オプション無料追加可' },
        shortDescription: 'Google カレンダーと連携して予定を確認するカレンダーウィジェット',
        salesPitch: '経営会議やチームMTGのスケジュールをデスクトップ上で即座に確認できます。',
        windowConfig: { defaultWidth: 680, defaultHeight: 520 },
        providesCapabilities: [],
        consumesCapabilities: [],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '利用可', description: '予定閲覧が可能' },
                execute: { label: '利用可', description: '予定閲覧・操作が可能' },
                manage: { label: '管理', description: '管理が可能' }
            },
            legacyWidgetId: 'app:calendar'
        },
        hasWidgetSettings: false
    },
    {
        id: 'calculator',
        packageId: 'com.techies.widget.calculator',
        name: '計算機',
        englishName: 'Calculator',
        version: '3.0.0',
        category: 'desktop_utility',
        iconType: 'calculator',
        defaultInstalled: false,
        tier: 'utility_addon',
        pricing: { model: 'included', priceJpy: 0, label: 'オプション無料追加可' },
        shortDescription: 'シンプルなデスクトップ電卓ウィジェット',
        salesPitch: '手元での素早い数値検算に利用できる電卓です。',
        windowConfig: { defaultWidth: 320, defaultHeight: 440 },
        providesCapabilities: [],
        consumesCapabilities: [],
        aiRouting: { usesAi: false },
        permissionsSchema: {
            levels: {
                none: { label: '不可', description: '利用不可' },
                read: { label: '利用可', description: '利用可能' },
                execute: { label: '利用可', description: '利用可能' },
                manage: { label: '管理', description: '利用可能' }
            },
            legacyWidgetId: 'app:calculator'
        },
        hasWidgetSettings: false
    }
];

const DEFAULT_INSTALLED_IDS = WIDGET_CATALOG.filter(w => w.defaultInstalled).map(w => w.id);

/**
 * Load installed plugin states from DB (or initialize with minimum configuration: normal-chat + mcp-client)
 */
async function getInstalledPluginsMap() {
    try {
        const raw = await db.getSetting('INSTALLED_WIDGET_PLUGINS');
        const now = new Date().toISOString();
        if (!raw) {
            const initialMap = {};
            for (const id of DEFAULT_INSTALLED_IDS) {
                initialMap[id] = {
                    installed: true,
                    installedAt: now,
                    licenseStatus: 'included',
                    source: 'core_bundle'
                };
            }
            await db.setSetting('INSTALLED_WIDGET_PLUGINS', JSON.stringify(initialMap));
            return initialMap;
        }
        const parsed = JSON.parse(raw);
        const map = typeof parsed === 'object' && parsed !== null ? parsed : {};
        let updated = false;
        for (const id of DEFAULT_INSTALLED_IDS) {
            if (!map[id]) {
                map[id] = {
                    installed: true,
                    installedAt: now,
                    licenseStatus: 'included',
                    source: 'core_bundle'
                };
                updated = true;
            }
        }
        if (updated) {
            await db.setSetting('INSTALLED_WIDGET_PLUGINS', JSON.stringify(map));
        }
        return map;
    } catch (err) {
        console.error('[PluginManager] Failed to read INSTALLED_WIDGET_PLUGINS:', err.message);
        return {
            gemini: { installed: true, licenseStatus: 'included', source: 'core_bundle' },
            'mcp-chat': { installed: true, licenseStatus: 'included', source: 'core_bundle' },
            'knowledge-base': { installed: true, licenseStatus: 'included', source: 'core_bundle' }
        };
    }
}

async function saveInstalledPluginsMap(map) {
    await db.setSetting('INSTALLED_WIDGET_PLUGINS', JSON.stringify(map));
}

/**
 * Scan physical plugins directory (/app/data/plugins) for Option B custom/downloaded .manifest.json files
 */
function scanExternalPluginPackages() {
    const externalManifests = [];
    try {
        if (!fs.existsSync(PLUGINS_DIR)) return externalManifests;
        const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const manifestPath = path.join(PLUGINS_DIR, entry.name, 'widget.manifest.json');
                if (fs.existsSync(manifestPath)) {
                    try {
                        const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        if (content && content.id) {
                            externalManifests.push({
                                ...content,
                                isExternalPackage: true,
                                packagePath: path.join(PLUGINS_DIR, entry.name)
                            });
                        }
                    } catch (e) {
                        console.warn(`[PluginManager] Invalid manifest in ${manifestPath}:`, e.message);
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[PluginManager] Error scanning plugins dir:', err.message);
    }
    return externalManifests;
}

/**
 * Get full catalog merged with current installation status and active capabilities
 */
async function getFullPluginCatalog() {
    const installedMap = await getInstalledPluginsMap();
    const externalPackages = scanExternalPluginPackages();

    const allCatalogItems = [...WIDGET_CATALOG];
    for (const ext of externalPackages) {
        if (!allCatalogItems.some(w => w.id === ext.id)) {
            allCatalogItems.push(ext);
        }
    }

    const nowMs = Date.now();
    const enrichedWidgets = allCatalogItems.map(widget => {
        const state = installedMap[widget.id] || { installed: false };
        let isInstalled = Boolean(state.installed);
        let licenseStatus = state.licenseStatus || (widget.tier === 'basic_included' ? 'included' : 'unlicensed');
        let trialDaysRemaining = null;

        if (isInstalled && licenseStatus === 'trial' && state.trialExpiresAt) {
            const expMs = new Date(state.trialExpiresAt).getTime();
            const diffDays = Math.ceil((expMs - nowMs) / (1000 * 60 * 60 * 24));
            if (diffDays <= 0) {
                licenseStatus = 'trial_expired';
                trialDaysRemaining = 0;
            } else {
                trialDaysRemaining = diffDays;
            }
        }

        const effectiveServiceUrl = state.serviceUrl || widget.defaultServiceUrl || null;
        const isExtPlugin = Boolean(widget.isExternalPlugin || widget.isExternalPackage || effectiveServiceUrl);
        const proxyBasePath = isExtPlugin ? `/plugin-proxy/${widget.id}` : null;
        const resolvedEntrypoints = state.verifiedManifest?.entrypoints || widget.entrypoints || null;

        return {
            ...widget,
            isExternalPlugin: isExtPlugin,
            serviceUrl: effectiveServiceUrl,
            manifestUrl: state.manifestUrl || (effectiveServiceUrl ? `${effectiveServiceUrl.replace(/\/$/, '')}/widget.manifest.json` : null),
            proxyBasePath,
            entrypoints: resolvedEntrypoints,
            signatureVerification: state.signatureVerification || null,
            packageName: widget.packageId || widget.packageName || `com.techies.widget.${widget.id}`,
            description: widget.shortDescription || widget.description || '',
            pricingLabel: typeof widget.pricing === 'object' ? (widget.pricing?.label || '') : (widget.pricing || ''),
            status: licenseStatus === 'included' ? 'core' : licenseStatus,
            installed: isInstalled,
            installedAt: state.installedAt || null,
            licenseStatus,
            trialExpiresAt: state.trialExpiresAt || null,
            trialDaysRemaining,
            licenseKeyPreview: state.licenseKeyPreview || null,
            packageSource: state.source || 'dynamic_registry'
        };
    });

    // Compute active Shared Capability Bus from all currently installed widgets
    const activeCapabilities = new Set();
    for (const w of enrichedWidgets) {
        if (w.installed && w.licenseStatus !== 'trial_expired') {
            for (const cap of (w.providesCapabilities || [])) {
                activeCapabilities.add(cap);
            }
        }
    }

    const installedList = enrichedWidgets.filter(w => w.installed && w.licenseStatus !== 'trial_expired');
    return {
        widgets: enrichedWidgets,
        installed: installedList,
        installedWidgets: installedList,
        availableAddons: enrichedWidgets.filter(w => !w.installed || w.licenseStatus === 'trial_expired'),
        capabilities: Array.from(activeCapabilities)
    };
}

/**
 * Fetch and verify remote widget.manifest.json via PQC Hybrid Gatekeeper (Ed25519 + NIST FIPS 204 ML-DSA-65)
 */
async function fetchAndVerifyExternalManifest(targetManifestUrl, req = null) {
    let remoteManifest;
    try {
        const res = await fetch(targetManifestUrl);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        remoteManifest = await res.json();
    } catch (fetchErr) {
        throw new Error(`独立ウィジェットサーバーからマニフェスト (${targetManifestUrl}) を取得できませんでした。ウィジェットサーバーが起動しているか確認してください: ${fetchErr.message}`);
    }

    const verification = await signatureVerifier.verifyPluginManifestSignature(remoteManifest);
    if (!verification.valid) {
        await auditDb.logEvent({
            userId: req?.user?.id || null,
            userEmail: req?.user?.email || null,
            eventType: 'plugin_signature_blocked',
            action: 'BLOCKED_UNSIGNED_OR_TAMPERED_PLUGIN',
            status: 'blocked',
            req,
            details: {
                manifestUrl: targetManifestUrl,
                error: verification.error,
                ...(verification.details || {})
            }
        }).catch(() => {});
        throw new Error(`【PQC署名検証エラー】${verification.error}`);
    }

    return {
        remoteManifest,
        signatureVerification: {
            valid: true,
            ...verification.details
        }
    };
}

/**
 * Install or activate a widget plugin (Option B: verifies PQC Hybrid Signature for external plugins, writes manifest to /app/data/plugins/<id>/widget.manifest.json and updates DB state)
 */
async function installWidgetPlugin(widgetId, options = {}) {
    const {
        mode = 'install',
        licenseKey = '',
        customManifest = null,
        manifestUrl = '',
        serviceUrl = '',
        req = null
    } = options;

    let resolvedManifest = customManifest;
    let signatureVerification = null;
    let resolvedServiceUrl = serviceUrl ? serviceUrl.replace(/\/$/, '') : '';
    let resolvedManifestUrl = manifestUrl ? manifestUrl.trim() : '';

    let catalogItem = widgetId ? WIDGET_CATALOG.find(w => w.id === widgetId) : null;

    // Determine if this plugin is an external independent project requiring PQC signature verification
    if (!resolvedManifest && (resolvedManifestUrl || resolvedServiceUrl || catalogItem?.isExternalPlugin)) {
        if (!resolvedServiceUrl && resolvedManifestUrl) {
            const parsedUrl = new URL(resolvedManifestUrl);
            resolvedServiceUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
        } else if (!resolvedServiceUrl && catalogItem?.defaultServiceUrl) {
            resolvedServiceUrl = catalogItem.defaultServiceUrl.replace(/\/$/, '');
        }
        if (!resolvedManifestUrl && resolvedServiceUrl) {
            resolvedManifestUrl = `${resolvedServiceUrl}/widget.manifest.json`;
        }

        const verified = await fetchAndVerifyExternalManifest(resolvedManifestUrl, req);
        resolvedManifest = verified.remoteManifest;
        signatureVerification = verified.signatureVerification;
        if (!widgetId) {
            widgetId = resolvedManifest.id;
        }
        if (!catalogItem) {
            catalogItem = WIDGET_CATALOG.find(w => w.id === widgetId) || resolvedManifest;
        }
    } else if (resolvedManifest) {
        // Direct manifest object passed: MUST still pass PQC Hybrid Signature verification!
        const verification = await signatureVerifier.verifyPluginManifestSignature(resolvedManifest);
        if (!verification.valid) {
            await auditDb.logEvent({
                userId: req?.user?.id || null,
                userEmail: req?.user?.email || null,
                eventType: 'plugin_signature_blocked',
                action: 'BLOCKED_UNSIGNED_CUSTOM_MANIFEST',
                status: 'blocked',
                req,
                details: { error: verification.error, ...(verification.details || {}) }
            }).catch(() => {});
            throw new Error(`【PQC署名検証エラー】${verification.error}`);
        }
        signatureVerification = {
            valid: true,
            ...verification.details
        };
        if (!widgetId) widgetId = resolvedManifest.id;
        if (!catalogItem) catalogItem = resolvedManifest;
    }

    if (!catalogItem) {
        throw new Error(`指定されたウィジェット (${widgetId}) はカタログに存在しません。`);
    }

    const installedMap = await getInstalledPluginsMap();
    const now = new Date();
    let licenseStatus = 'licensed';
    let trialExpiresAt = null;
    let licenseKeyPreview = null;

    if (catalogItem.tier === 'basic_included' || catalogItem.tier === 'utility_addon' || !catalogItem.tier) {
        licenseStatus = 'included';
    } else if (mode === 'trial') {
        const trialDays = catalogItem.pricing?.trialDays || 14;
        const expDate = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
        licenseStatus = 'trial';
        trialExpiresAt = expDate.toISOString();
    } else if (mode === 'license' || mode === 'licensed' || licenseKey) {
        const verification = verifyWidgetLicenseKey(licenseKey, widgetId);
        if (!verification.valid) {
            throw new Error(verification.error || '無効なライセンスキーです。');
        }
        licenseStatus = 'licensed';
        trialExpiresAt = verification.expiresAt || null;
        licenseKeyPreview = `${licenseKey.substring(0, 10)}...${licenseKey.substring(licenseKey.length - 6)}`;
    }

    const mergedManifestToPersist = {
        ...catalogItem,
        ...(resolvedManifest || {}),
        id: widgetId,
        isExternalPlugin: Boolean(catalogItem.isExternalPlugin || resolvedServiceUrl),
        serviceUrl: resolvedServiceUrl || catalogItem.defaultServiceUrl || null,
        manifestUrl: resolvedManifestUrl || null,
        signatureVerification,
        installedAt: now.toISOString(),
        licenseStatus
    };

    // Write physical package manifest to /app/data/plugins/<widgetId>/widget.manifest.json (Option B persistence)
    try {
        const targetDir = path.join(PLUGINS_DIR, widgetId);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.writeFileSync(
            path.join(targetDir, 'widget.manifest.json'),
            JSON.stringify(mergedManifestToPersist, null, 2),
            'utf8'
        );
    } catch (fsErr) {
        console.warn(`[PluginManager] Could not write manifest to disk for ${widgetId}:`, fsErr.message);
    }

    installedMap[widgetId] = {
        installed: true,
        installedAt: now.toISOString(),
        licenseStatus,
        trialExpiresAt,
        licenseKeyPreview,
        serviceUrl: resolvedServiceUrl || catalogItem.defaultServiceUrl || null,
        manifestUrl: resolvedManifestUrl || null,
        verifiedManifest: resolvedManifest || null,
        signatureVerification,
        source: resolvedManifest ? 'pqc_signed_external_plugin' : 'dynamic_registry'
    };

    await saveInstalledPluginsMap(installedMap);
    return await getFullPluginCatalog();
}

/**
 * Uninstall a widget plugin
 */
async function uninstallWidgetPlugin(widgetId) {
    const installedMap = await getInstalledPluginsMap();
    if (installedMap[widgetId]) {
        delete installedMap[widgetId];
        await saveInstalledPluginsMap(installedMap);
    }

    try {
        const targetDir = path.join(PLUGINS_DIR, widgetId);
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
    } catch (fsErr) {
        console.warn(`[PluginManager] Could not remove plugin directory for ${widgetId}:`, fsErr.message);
    }

    return await getFullPluginCatalog();
}

/**
 * Reset to Minimum Configuration (Normal Chat + MCP Client only)
 */
async function resetToMinimumConfiguration() {
    const now = new Date().toISOString();
    const initialMap = {};
    for (const id of DEFAULT_INSTALLED_IDS) {
        initialMap[id] = {
            installed: true,
            installedAt: now,
            licenseStatus: 'included',
            source: 'core_bundle'
        };
    }
    await saveInstalledPluginsMap(initialMap);
    return await getFullPluginCatalog();
}

/**
 * Generate or Verify License Key for Paid Add-on Widgets
 * Supports EA-LIC-<base64url_payload>.<hmac_sig> or demo keys starting with EA-PRO-
 */
function getLicenseSecret() {
    return process.env.LICENSE_SIGNING_SECRET || process.env.JWT_SECRET || 'employee-agent-core-zta-license-secret-2026';
}

function generateWidgetLicenseKey({ tenantName = 'Enterprise Customer', widgets = ['*'], expiresAt = null }) {
    const payloadObj = {
        iss: 'Techies-T/EmployeeAgent-Core',
        tenant: tenantName,
        widgets,
        iat: Math.floor(Date.now() / 1000),
        exp: expiresAt ? Math.floor(new Date(expiresAt).getTime() / 1000) : Math.floor(Date.now() / 1000) + 365 * 24 * 3600
    };
    const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto.createHmac('sha256', getLicenseSecret()).update(payloadB64).digest('base64url');
    return `EA-LIC-${payloadB64}.${sig}`;
}

function verifyWidgetLicenseKey(licenseKey, targetWidgetId) {
    if (!licenseKey || typeof licenseKey !== 'string') {
        return { valid: false, error: 'ライセンスキーが入力されていません。' };
    }
    const trimmed = licenseKey.trim();

    // Support universal enterprise format EA-ENT-2026-<WIDGET> for quick customer onboarding/testing
    if (trimmed.startsWith('EA-ENT-') || trimmed.startsWith('EA-PRO-')) {
        return {
            valid: true,
            tenant: 'Enterprise Licensed Tenant',
            widgets: [targetWidgetId],
            expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
        };
    }

    if (!trimmed.startsWith('EA-LIC-')) {
        return { valid: false, error: 'ライセンスキーの形式が正しくありません（EA-LIC-... または EA-PRO-... を入力してください）。' };
    }

    const body = trimmed.substring('EA-LIC-'.length);
    const parts = body.split('.');
    if (parts.length !== 2) {
        return { valid: false, error: 'ライセンスキーの署名構造が不正です。' };
    }

    const [payloadB64, providedSig] = parts;
    const expectedSig = crypto.createHmac('sha256', getLicenseSecret()).update(payloadB64).digest('base64url');
    if (providedSig !== expectedSig) {
        return { valid: false, error: 'ライセンスキーの署名検証に失敗しました。' };
    }

    try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
            return { valid: false, error: 'このライセンスキーは有効期限が切れています。' };
        }
        const allowed = payload.widgets || [];
        if (!allowed.includes('*') && !allowed.includes(targetWidgetId)) {
            return { valid: false, error: `このライセンスキーには「${targetWidgetId}」の利用権限が含まれていません。` };
        }
        return {
            valid: true,
            tenant: payload.tenant,
            widgets: allowed,
            expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null
        };
    } catch (e) {
        return { valid: false, error: 'ライセンスキーのペイロード解析に失敗しました。' };
    }
}

/**
 * Helper to check if a specific widget or capability is currently installed & active
 */
async function isWidgetInstalled(widgetId) {
    const catalog = await getFullPluginCatalog();
    return catalog.installedWidgets.some(w => w.id === widgetId);
}

async function hasCapability(capabilityId) {
    const catalog = await getFullPluginCatalog();
    return catalog.capabilities.includes(capabilityId);
}

/**
 * Retrieve runtime target URL & verified state for an installed external plugin (used by /plugin-proxy/:widgetId)
 */
async function getInstalledPluginRuntimeInfo(widgetId) {
    const catalog = await getFullPluginCatalog();
    const target = catalog.installedWidgets.find(w => w.id === widgetId);
    if (!target || !target.isExternalPlugin || !target.serviceUrl) {
        return null;
    }
    return target;
}

module.exports = {
    WIDGET_CATALOG,
    DEFAULT_INSTALLED_IDS,
    getInstalledPluginsMap,
    getFullPluginCatalog,
    installWidgetPlugin,
    uninstallWidgetPlugin,
    resetToMinimumConfiguration,
    generateWidgetLicenseKey,
    verifyWidgetLicenseKey,
    isWidgetInstalled,
    hasCapability,
    getInstalledPluginRuntimeInfo
};
