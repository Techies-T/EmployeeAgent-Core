import React, { useState } from 'react';

const AI_WIDGET_DEFINITIONS = [
    {
        id: 'gemini',
        name: 'ノーマルチャット (Normal Chat)',
        icon: '💬',
        description: '全社標準の汎用AI対話・文書作成・壁打ちクライアント',
        providerKey: 'normalChatProvider',
        geminiModelKey: 'geminiModel',
        claudeModelKey: 'claudeModel'
    },
    {
        id: 'mcp-chat',
        name: 'MCP クライアント (ZTA A2A)',
        icon: '🔌',
        description: 'ZTA OAuth JWT / SSE 経由で社内データ（売上見込み・DB等）を分析するクライアント',
        providerKey: 'mcpChatProvider',
        geminiModelKey: 'geminiMcpChatModel',
        claudeModelKey: 'claudeMcpChatModel'
    },
    {
        id: 'knowledge-base',
        name: 'ナレッジ & RAG ブリーフィング',
        icon: '📚',
        description: '経営会議の事前共有レポート作成・RAGコンテキスト検索・AI要約',
        providerKey: 'knowledgeProvider',
        geminiModelKey: 'geminiModel',
        claudeModelKey: 'claudeModel'
    },
    {
        id: 'deep-research',
        name: 'DeepResearch & 図解生成',
        icon: '🔬',
        description: 'マルチステップ市場調査・競合分析・HTML/SVGインフォグラフィック出力',
        providerKey: 'deepResearchProvider',
        geminiModelKey: 'geminiResearchModel',
        claudeModelKey: 'geminiHtmlSvgModel'
    },
    {
        id: 'live-concierge',
        name: 'Live Concierge (音声・画面共有)',
        icon: '🎙️',
        description: 'Gemini Multimodal Live API によるリアルタイム音声・画面共有アシスタント',
        providerKey: 'geminiOnly',
        geminiModelKey: 'geminiLiveDefaultModel',
        claudeModelKey: null
    }
];

const AiHubTab = ({
    geminiApiKey,
    setGeminiApiKey,
    claudeApiKey,
    setClaudeApiKey,
    aiProvider = 'gemini',
    handleAiProviderChange,
    isGeminiConfigured,
    isClaudeConfigured,
    handleSaveSettings,
    filteredModels = [],
    claudeModels = [],
    currentModel,
    handleModelChange,
    currentClaudeModel,
    handleClaudeModelChange,
    currentMcpChatModel,
    handleMcpChatModelChange,
    currentResearchModel,
    handleResearchModelChange,
    currentHtmlSvgModel,
    handleHtmlSvgModelChange,
    currentNanoBananaModel,
    handleNanoBananaModelChange,
    geminiLiveDefaultModel,
    refreshModelsList,
    localAiEnabled,
    setLocalAiEnabled,
    localAiHost,
    setLocalAiHost,
    localAiModel,
    setLocalAiModel,
    localAiTemperature,
    setLocalAiTemperature,
    installedWidgets = []
}) => {
    const [routingMap, setRoutingMap] = useState({
        gemini: aiProvider || 'gemini',
        'mcp-chat': (currentMcpChatModel || '').startsWith('claude-') ? 'claude' : (aiProvider || 'gemini'),
        'knowledge-base': aiProvider || 'gemini',
        'deep-research': (currentResearchModel || '').startsWith('claude-') ? 'claude' : (aiProvider || 'gemini'),
        'live-concierge': 'gemini'
    });
    const [savingWidgetId, setSavingWidgetId] = useState(null);

    const installedIds = new Set(
        (installedWidgets || []).map(w => typeof w === 'string' ? w : w.id)
    );
    // Always show at least the minimum core widgets ('gemini', 'mcp-chat')
    if (installedIds.size === 0) {
        installedIds.add('gemini');
        installedIds.add('mcp-chat');
    }

    const activeAiWidgets = AI_WIDGET_DEFINITIONS.filter(w => installedIds.has(w.id));

    const handleWidgetRoutingSave = async (widgetId, provider, modelName) => {
        setSavingWidgetId(widgetId);
        try {
            setRoutingMap(prev => ({ ...prev, [widgetId]: provider }));
            await fetch('/api/core/ai-routing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetId, provider, model: modelName })
            });

            if (widgetId === 'gemini') {
                if (provider === 'claude' && modelName && handleClaudeModelChange) {
                    handleClaudeModelChange(modelName);
                } else if (provider === 'gemini' && modelName && handleModelChange) {
                    handleModelChange(modelName);
                }
            } else if (widgetId === 'mcp-chat' && modelName && handleMcpChatModelChange) {
                handleMcpChatModelChange(modelName);
            } else if (widgetId === 'deep-research' && modelName && handleResearchModelChange) {
                handleResearchModelChange(modelName);
            }
        } catch (err) {
            console.error('Failed to save widget AI routing:', err);
        } finally {
            setSavingWidgetId(null);
        }
    };

    const getSelectedModelForWidget = (widgetId, provider) => {
        if (provider === 'local') return localAiModel || 'gemma4:26b-mlx';
        if (widgetId === 'mcp-chat') {
            if (currentMcpChatModel) return currentMcpChatModel.replace(/^models\//, '');
            return provider === 'claude'
                ? (currentClaudeModel || 'claude-sonnet-4-6').replace(/^models\//, '')
                : (currentModel || '').replace(/^models\//, '');
        }
        if (widgetId === 'deep-research') {
            return (currentResearchModel || currentModel || '').replace(/^models\//, '');
        }
        if (widgetId === 'live-concierge') {
            return (geminiLiveDefaultModel || 'gemini-3.8-live').replace(/^models\//, '');
        }
        return provider === 'claude'
            ? (currentClaudeModel || 'claude-sonnet-4-6').replace(/^models\//, '')
            : (currentModel || '').replace(/^models\//, '');
    };

    return (
        <div className="space-y-6">
            {/* Responsive Table Scoped Styles (Modern Web Guidance compliant) */}
            <style>{`
                .ea-ai-routing-wrapper {
                    container-type: inline-size;
                    overflow-x: auto;
                    max-inline-size: 100%;
                    border-radius: 0.75rem;
                    border: 1px solid #e5e7eb;
                    background: #ffffff;
                }
                .ea-ai-routing-wrapper:focus-visible {
                    outline: 2px solid #2563eb;
                    outline-offset: 2px;
                }
                .ea-ai-routing-table {
                    width: 100%;
                    border-collapse: separate;
                    border-spacing: 0;
                    font-size: 0.8125rem;
                }
                .ea-ai-routing-table th,
                .ea-ai-routing-table td {
                    padding: 0.75rem 1rem;
                    border-block-end: 1px solid #f1f5f9;
                    vertical-align: middle;
                }
                .ea-ai-routing-table thead th {
                    position: sticky;
                    inset-block-start: 0;
                    z-index: 2;
                    background: #f8fafc;
                    font-weight: 600;
                    color: #475569;
                    text-align: left;
                }
                .ea-ai-routing-table tbody th {
                    position: sticky;
                    inset-inline-start: 0;
                    z-index: 1;
                    background: #ffffff;
                    font-weight: 600;
                    color: #0f172a;
                    text-align: left;
                    border-inline-end: 1px solid #f1f5f9;
                }
            `}</style>

            {/* Section 1: Unified AI Provider Credentials Pool */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4 pb-3 border-b border-gray-100">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-lg">🔑</span>
                            <h2 className="font-bold text-base text-gray-900">1. 共通 AI プロバイダー認証プール (API Keys & Local LLM)</h2>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                            ノーマルチャット (Gemini / Claude) や MCP クライアント等、すべてのウィジェットで利用する API キーを一元管理します。
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {refreshModelsList && (
                            <button
                                type="button"
                                onClick={refreshModelsList}
                                className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg border border-gray-300 font-medium cursor-pointer transition"
                            >
                                🔄 モデル一覧を再取得
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleSaveSettings}
                            className="text-xs px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold shadow-sm cursor-pointer transition"
                        >
                            💾 認証設定を保存
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Google Gemini Card */}
                    <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/30 flex flex-col justify-between gap-3">
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="font-bold text-xs text-blue-900 flex items-center gap-1.5">
                                    <span>✨ Google Gemini API</span>
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isGeminiConfigured ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-amber-100 text-amber-800'}`}>
                                    {isGeminiConfigured ? '● 接続済 (Ready)' : '未設定'}
                                </span>
                            </div>
                            <p className="text-[11px] text-gray-600 mb-2">
                                ノーマルチャット、MCP 分析、DeepResearch、画像/音声生成で利用します。
                            </p>
                            <input
                                type="password"
                                value={geminiApiKey}
                                onChange={(e) => setGeminiApiKey(e.target.value)}
                                placeholder={isGeminiConfigured ? '•••••••••••••••• (更新時のみ入力)' : 'AIzaSy... (Gemini API Key)'}
                                className="w-full px-3 py-1.5 border border-blue-200 rounded-lg bg-white text-xs focus:outline-none focus:border-blue-500"
                            />
                        </div>
                        <div className="pt-2 border-t border-blue-100 flex items-center justify-between text-[11px]">
                            <span className="text-gray-500">標準プロバイダー指定:</span>
                            <button
                                type="button"
                                onClick={() => handleAiProviderChange && handleAiProviderChange('gemini')}
                                className={`px-2.5 py-0.5 rounded font-semibold cursor-pointer transition ${aiProvider === 'gemini' ? 'bg-blue-600 text-white' : 'bg-white text-blue-700 border border-blue-300'}`}
                            >
                                {aiProvider === 'gemini' ? '✓ デフォルト採用中' : 'デフォルトにする'}
                            </button>
                        </div>
                    </div>

                    {/* Anthropic Claude Card */}
                    <div className="p-4 rounded-xl border border-purple-200 bg-purple-50/30 flex flex-col justify-between gap-3">
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="font-bold text-xs text-purple-900 flex items-center gap-1.5">
                                    <span>🟣 Anthropic Claude API</span>
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${isClaudeConfigured ? 'bg-purple-100 text-purple-800 border border-purple-300' : 'bg-gray-100 text-gray-600'}`}>
                                    {isClaudeConfigured ? '● 接続済 (Ready)' : '未設定'}
                                </span>
                            </div>
                            <p className="text-[11px] text-gray-600 mb-2">
                                MCP クライアントでの高精度ツール呼び出し・経営データ分析やノーマルチャットで利用します。
                            </p>
                            <input
                                type="password"
                                value={claudeApiKey || ''}
                                onChange={(e) => setClaudeApiKey && setClaudeApiKey(e.target.value)}
                                placeholder={isClaudeConfigured ? '•••••••••••••••• (更新時のみ入力)' : 'sk-ant-api03-... (Claude API Key)'}
                                className="w-full px-3 py-1.5 border border-purple-200 rounded-lg bg-white text-xs focus:outline-none focus:border-purple-500"
                            />
                        </div>
                        <div className="pt-2 border-t border-purple-100 flex items-center justify-between text-[11px]">
                            <span className="text-gray-500">標準プロバイダー指定:</span>
                            <button
                                type="button"
                                onClick={() => handleAiProviderChange && handleAiProviderChange('claude')}
                                className={`px-2.5 py-0.5 rounded font-semibold cursor-pointer transition ${aiProvider === 'claude' ? 'bg-purple-600 text-white' : 'bg-white text-purple-700 border border-purple-300'}`}
                            >
                                {aiProvider === 'claude' ? '✓ デフォルト採用中' : 'デフォルトにする'}
                            </button>
                        </div>
                    </div>

                    {/* Local AI (Ollama / MLX) Card */}
                    <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/30 flex flex-col justify-between gap-3">
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="font-bold text-xs text-emerald-900 flex items-center gap-1.5">
                                    <span>🏠 Local AI (Gemma 4 / Ollama)</span>
                                </span>
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={!!localAiEnabled}
                                        onChange={(e) => setLocalAiEnabled && setLocalAiEnabled(e.target.checked)}
                                        className="rounded text-emerald-600"
                                    />
                                    <span className="text-[10px] font-semibold text-emerald-800">有効</span>
                                </label>
                            </div>
                            <div className="space-y-1.5">
                                <input
                                    type="text"
                                    value={localAiHost || ''}
                                    onChange={(e) => setLocalAiHost && setLocalAiHost(e.target.value)}
                                    placeholder="http://localhost:11434"
                                    className="w-full px-2.5 py-1 border border-emerald-200 rounded bg-white text-xs font-mono"
                                />
                                <input
                                    type="text"
                                    value={localAiModel || ''}
                                    onChange={(e) => setLocalAiModel && setLocalAiModel(e.target.value)}
                                    placeholder="gemma4:26b-mlx"
                                    className="w-full px-2.5 py-1 border border-emerald-200 rounded bg-white text-xs font-mono"
                                />
                            </div>
                        </div>
                        <div className="pt-2 border-t border-emerald-100 flex items-center justify-between text-[11px]">
                            <span className="text-gray-500">Temperature:</span>
                            <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="2"
                                value={localAiTemperature || '0.7'}
                                onChange={(e) => setLocalAiTemperature && setLocalAiTemperature(e.target.value)}
                                className="w-16 px-2 py-0.5 border border-emerald-200 rounded bg-white text-xs text-right font-mono"
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Section 2: Per-Widget AI Model Routing Matrix */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="mb-4">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🧭</span>
                        <h2 id="ai-routing-table-heading" className="font-bold text-base text-gray-900">
                            2. インストール済みウィジェット別 AI モデル割当マトリクス
                        </h2>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                        現在インストールされている AI ウィジェットのみが表示されます。「ノーマルチャットの Gemini はどこ？」「MCP クライアントの Claude はどこ？」と迷うことなく、この表から一目で割り当てを変更できます。
                    </p>
                </div>

                <div
                    className="ea-ai-routing-wrapper"
                    role="region"
                    aria-labelledby="ai-routing-table-heading"
                    tabIndex={0}
                >
                    <table className="ea-ai-routing-table">
                        <thead>
                            <tr>
                                <th scope="col" style={{ minWidth: '220px' }}>対象ウィジェット</th>
                                <th scope="col" style={{ minWidth: '210px' }}>利用 AI プロバイダー</th>
                                <th scope="col" style={{ minWidth: '280px' }}>割り当てモデル (デフォルト実行エンジン)</th>
                                <th scope="col" style={{ minWidth: '110px' }}>ステータス</th>
                            </tr>
                        </thead>
                        <tbody>
                            {activeAiWidgets.map(widget => {
                                const currentProv = widget.id === 'live-concierge'
                                    ? 'gemini'
                                    : (routingMap[widget.id] || aiProvider || 'gemini');
                                const selectedModel = getSelectedModelForWidget(widget.id, currentProv);

                                return (
                                    <tr key={widget.id} className="hover:bg-slate-50/80 transition-colors">
                                        <th scope="row">
                                            <div className="flex items-start gap-2.5">
                                                <span className="text-xl leading-none mt-0.5">{widget.icon}</span>
                                                <div>
                                                    <div className="font-bold text-xs text-gray-900">{widget.name}</div>
                                                    <div className="text-[11px] font-normal text-gray-500 mt-0.5">{widget.description}</div>
                                                </div>
                                            </div>
                                        </th>
                                        <td>
                                            {widget.id === 'live-concierge' ? (
                                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold">
                                                    ✨ Gemini Live 専用
                                                </span>
                                            ) : (
                                                <div className="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-100">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleWidgetRoutingSave(widget.id, 'gemini', currentModel)}
                                                        className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition ${
                                                            currentProv === 'gemini'
                                                                ? 'bg-blue-600 text-white shadow-xs'
                                                                : 'text-gray-600 hover:text-gray-900'
                                                        }`}
                                                    >
                                                        ✨ Gemini
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleWidgetRoutingSave(widget.id, 'claude', currentClaudeModel)}
                                                        className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition ${
                                                            currentProv === 'claude'
                                                                ? 'bg-purple-600 text-white shadow-xs'
                                                                : 'text-gray-600 hover:text-gray-900'
                                                        }`}
                                                    >
                                                        🟣 Claude
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleWidgetRoutingSave(widget.id, 'local', localAiModel)}
                                                        className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition ${
                                                            currentProv === 'local'
                                                                ? 'bg-emerald-600 text-white shadow-xs'
                                                                : 'text-gray-600 hover:text-gray-900'
                                                        }`}
                                                    >
                                                        🏠 Local
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                        <td>
                                            {currentProv === 'local' ? (
                                                <div className="text-xs font-mono text-emerald-800 bg-emerald-50 px-2.5 py-1.5 rounded border border-emerald-200">
                                                    {localAiModel || 'gemma4:26b-mlx'} ({localAiHost})
                                                </div>
                                            ) : currentProv === 'claude' ? (
                                                <select
                                                    value={selectedModel}
                                                    onChange={(e) => handleWidgetRoutingSave(widget.id, 'claude', e.target.value)}
                                                    className="w-full px-2.5 py-1.5 border border-purple-200 rounded-lg bg-white text-xs font-mono text-gray-800 focus:outline-none focus:border-purple-500"
                                                >
                                                    <option value="">-- Claude モデルを選択 --</option>
                                                    {(claudeModels || []).map(m => {
                                                        const cleanId = (m.id || m.name || '').replace(/^models\//, '');
                                                        return (
                                                            <option key={cleanId} value={cleanId}>
                                                                {m.displayName || cleanId} ({cleanId})
                                                            </option>
                                                        );
                                                    })}
                                                    {(!claudeModels || claudeModels.length === 0) && (
                                                        <>
                                                            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (claude-sonnet-4-6)</option>
                                                            <option value="claude-opus-4-6">Claude Opus 4.6 (claude-opus-4-6)</option>
                                                        </>
                                                    )}
                                                </select>
                                            ) : (
                                                <select
                                                    value={selectedModel}
                                                    onChange={(e) => handleWidgetRoutingSave(widget.id, 'gemini', e.target.value)}
                                                    className="w-full px-2.5 py-1.5 border border-blue-200 rounded-lg bg-white text-xs font-mono text-gray-800 focus:outline-none focus:border-blue-500"
                                                >
                                                    <option value="">-- Gemini モデルを選択 --</option>
                                                    {(filteredModels || []).map(m => {
                                                        const cleanId = (m.name || '').replace(/^models\//, '');
                                                        return (
                                                            <option key={cleanId} value={cleanId}>
                                                                {m.displayName || cleanId} ({cleanId})
                                                            </option>
                                                        );
                                                    })}
                                                </select>
                                            )}
                                        </td>
                                        <td>
                                            {savingWidgetId === widget.id ? (
                                                <span className="text-xs text-blue-600 font-medium">保存中...</span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                                    ● 割当済
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Image / HTML / SVG Sub-model Settings when DeepResearch is installed */}
                {installedIds.has('deep-research') && (
                    <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-gray-700 mb-1">
                                🎨 画像・インフォグラフィック生成モデル (Nano Banana / Avatar)
                            </label>
                            <select
                                value={currentNanoBananaModel ? currentNanoBananaModel.replace(/^models\//, '') : ''}
                                onChange={(e) => handleNanoBananaModelChange && handleNanoBananaModelChange(e.target.value)}
                                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg bg-white text-xs font-mono"
                            >
                                <option value="">-- 画像生成モデルを選択 --</option>
                                {(filteredModels || []).map(m => {
                                    const cleanId = (m.name || '').replace(/^models\//, '');
                                    return (
                                        <option key={cleanId} value={cleanId}>
                                            {m.displayName || cleanId}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-semibold text-gray-700 mb-1">
                                📊 HTML / SVG 図解レポート生成モデル
                            </label>
                            <select
                                value={currentHtmlSvgModel ? currentHtmlSvgModel.replace(/^models\//, '') : ''}
                                onChange={(e) => handleHtmlSvgModelChange && handleHtmlSvgModelChange(e.target.value)}
                                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg bg-white text-xs font-mono"
                            >
                                <option value="">-- 基本モデルを使用 (Default) --</option>
                                {(filteredModels || []).map(m => {
                                    const cleanId = (m.name || '').replace(/^models\//, '');
                                    return (
                                        <option key={`gem-${cleanId}`} value={cleanId}>
                                            ✨ {m.displayName || cleanId}
                                        </option>
                                    );
                                })}
                                {(claudeModels || []).map(m => {
                                    const cleanId = (m.id || m.name || '').replace(/^models\//, '');
                                    return (
                                        <option key={`claude-${cleanId}`} value={cleanId}>
                                            🟣 {m.displayName || cleanId}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AiHubTab;
