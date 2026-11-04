import React, { useState, useEffect, useRef } from 'react';
import McpConnectionsTab from './McpConnectionsTab';
import ChatConfigTab from './ChatConfigTab';
import PersonalRagTab from './PersonalRagTab';
import DeepResearchTab from './DeepResearchTab';
import FinderTab from './FinderTab';
import LiveConciergeTab from './LiveConciergeTab';

const WIDGET_ICONS = {
    gemini: '💬',
    'mcp-chat': '🔌',
    'knowledge-base': '📚',
    'deep-research': '🔬',
    'virtual-office': '🏢',
    'live-concierge': '🎙️',
    finder: '📁',
    browser: '🌐',
    'html-editor': '📝',
    notes: '🗒️',
    calculator: '🧮',
    calendar: '📅',
    stickies: '📌',
    'app-monitor': '📡'
};

const WidgetStoreTab = ({
    user,
    canManageSettings,
    hasWidget,
    hasAction,
    // Encapsulated widget config props
    mcpQuickPrompts,
    setMcpQuickPrompts,
    handleSaveSettings,
    models,
    claudeModels,
    currentMcpChatModel,
    handleMcpChatModelChange,
    mcpChatSystemInstruction,
    setMcpChatSystemInstruction,
    mcpChatMaxTurns,
    setMcpChatMaxTurns,
    defaultMcpChatSystemInstruction,
    chatPresets,
    setChatPresets,
    chatPresetContext,
    setChatPresetContext,
    presetLabel,
    setPresetLabel,
    presetPrompt,
    setPresetPrompt,
    ragFaqs,
    setRagFaqs,
    ragFolders,
    newRagFolderName,
    setNewRagFolderName,
    newRagFolderId,
    setNewRagFolderId,
    handleAddRagFolder,
    handleRemoveRagFolder,
    handleSyncRag,
    isSyncing,
    syncTarget,
    lastRagSyncTime,
    lastRagSyncTimeGemini,
    lastRagSyncTimeClaude,
    ragSyncErrors,
    isGeminiConfigured,
    isClaudeConfigured,
    aiProvider,
    driveRootId,
    setDriveRootId,
    handleSaveDriveRoot,
    geminiLiveAvailableModels,
    setGeminiLiveAvailableModels,
    geminiLiveDefaultModel,
    setGeminiLiveDefaultModel,
    onPluginsChanged
}) => {
    const [installed, setInstalled] = useState([]);
    const [availableAddons, setAvailableAddons] = useState([]);
    const [capabilities, setCapabilities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [licenseInputMap, setLicenseInputMap] = useState({});
    const [generatedKeyInfo, setGeneratedKeyInfo] = useState(null);
    const [activeConfigWidget, setActiveConfigWidget] = useState(null);
    const dialogRef = useRef(null);

    const fetchPluginsState = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/core/plugins');
            if (res.ok) {
                const data = await res.json();
                setInstalled(data.installedWidgets || data.installed || []);
                setAvailableAddons(data.availableAddons || []);
                setCapabilities(data.capabilities || []);
                if (onPluginsChanged) {
                    onPluginsChanged(data);
                }
            }
        } catch (err) {
            console.error('Failed to fetch plugins state:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPluginsState();
    }, []);

    // Modern Web Guidance: light-dismiss-a-dialog fallback for browsers without native closedby="any"
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const handleDialogClick = (event) => {
            if (!('closedBy' in HTMLDialogElement.prototype) && event.target === dialog) {
                const rect = dialog.getBoundingClientRect();
                const isInDialog =
                    rect.top <= event.clientY &&
                    event.clientY <= rect.top + rect.height &&
                    rect.left <= event.clientX &&
                    event.clientX <= rect.left + rect.width;
                if (!isInDialog) {
                    dialog.close();
                }
            }
        };

        const handleClose = () => {
            setActiveConfigWidget(null);
        };

        dialog.addEventListener('click', handleDialogClick);
        dialog.addEventListener('close', handleClose);
        return () => {
            dialog.removeEventListener('click', handleDialogClick);
            dialog.removeEventListener('close', handleClose);
        };
    }, [activeConfigWidget]);

    const openWidgetConfigDrawer = (widget) => {
        setActiveConfigWidget(widget);
        setTimeout(() => {
            if (dialogRef.current && !dialogRef.current.open) {
                dialogRef.current.showModal();
            }
        }, 0);
    };

    const closeWidgetConfigDrawer = () => {
        if (dialogRef.current && dialogRef.current.open) {
            dialogRef.current.close();
        }
        setActiveConfigWidget(null);
    };

    const handleInstallWidget = async (widgetId, mode = 'trial') => {
        const licenseKey = licenseInputMap[widgetId] || '';
        if (mode === 'licensed' && !licenseKey.trim()) {
            alert('ライセンスキー（EA-LIC-... または EA-PRO-...）を入力してください。');
            return;
        }
        try {
            const res = await fetch('/api/core/plugins/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetId, mode, licenseKey: licenseKey.trim() })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.error || 'インストールに失敗しました。');
                return;
            }
            setInstalled(data.installedWidgets || data.installed || []);
            setAvailableAddons(data.availableAddons || []);
            setCapabilities(data.capabilities || []);
            if (onPluginsChanged) onPluginsChanged(data);
            window.dispatchEvent(new Event('plugins-updated'));
        } catch (err) {
            console.error('Install widget failed:', err);
            alert('ウィジェットのインストールに失敗しました。');
        }
    };

    const handleUninstallWidget = async (widgetId, widgetName) => {
        if (!window.confirm(`ウィジェット「${widgetName}」をアンインストールしますか？\n（Dockおよび画面から非表示になりますが、蓄積されたデータは保護されます）`)) {
            return;
        }
        try {
            const res = await fetch('/api/core/plugins/uninstall', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetId })
            });
            const data = await res.json();
            if (res.ok) {
                setInstalled(data.installedWidgets || data.installed || []);
                setAvailableAddons(data.availableAddons || []);
                setCapabilities(data.capabilities || []);
                if (onPluginsChanged) onPluginsChanged(data);
                window.dispatchEvent(new Event('plugins-updated'));
            }
        } catch (err) {
            console.error('Uninstall widget failed:', err);
        }
    };

    const handleResetMinimum = async () => {
        if (!window.confirm('ミニマム初期構成（ノーマルチャット + MCPクライアントのみ）にリセットしますか？\n後いつでもアドオンカタログから再プラグイン可能です。')) {
            return;
        }
        try {
            const res = await fetch('/api/core/plugins/reset-minimum', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (res.ok) {
                setInstalled(data.installedWidgets || data.installed || []);
                setAvailableAddons(data.availableAddons || []);
                setCapabilities(data.capabilities || []);
                if (onPluginsChanged) onPluginsChanged(data);
                window.dispatchEvent(new Event('plugins-updated'));
            }
        } catch (err) {
            console.error('Reset minimum failed:', err);
        }
    };

    const handleGenerateLicense = async (widgetId) => {
        try {
            const res = await fetch('/api/core/plugins/generate-license', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ widgetId })
            });
            const data = await res.json();
            if (res.ok && data.licenseKey) {
                setLicenseInputMap(prev => ({ ...prev, [widgetId]: data.licenseKey }));
                setGeneratedKeyInfo({ widgetId, licenseKey: data.licenseKey });
            }
        } catch (err) {
            console.error('Failed to generate license key:', err);
        }
    };

    const hasSpecificSettings = (widgetId) => {
        return ['gemini', 'mcp-chat', 'knowledge-base', 'deep-research', 'finder', 'live-concierge'].includes(widgetId);
    };

    return (
        <div className="space-y-6">
            {/* Shared Capability Bus Status Banner */}
            <div className="bg-gradient-to-r from-indigo-900 via-slate-900 to-indigo-950 text-white rounded-xl p-5 shadow-md border border-indigo-700/40">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-indigo-500/30 text-indigo-200 rounded border border-indigo-400/30">
                                EmployeeAgent-Core Microkernel
                            </span>
                            <h2 className="text-base font-bold">動的プラグイン & Shared Capability Bus 状態</h2>
                        </div>
                        <p className="text-xs text-indigo-200 mt-1 leading-relaxed">
                            必要なウィジェットのみをプラグインしてシンプルに運用できます。「ナレッジ & RAG ブリーフィング」を追加インストールすると、ノーマルチャットやMCPクライアントに「経営会議ブリーフィング共有・RAG参照機能」が自動注入されます。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleResetMinimum}
                        className="px-3.5 py-2 bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition"
                    >
                        🔄 ミニマム構成 (2ウィジェット) に戻す
                    </button>
                </div>

                <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-indigo-300 font-medium">現在有効な Capability Bus:</span>
                    {capabilities.length === 0 ? (
                        <span className="text-[11px] text-gray-400">なし</span>
                    ) : (
                        capabilities.map(cap => (
                            <span
                                key={cap}
                                className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${
                                    cap.includes('knowledge') || cap.includes('rag')
                                        ? 'bg-amber-400/20 text-amber-200 border-amber-400/40 font-semibold'
                                        : 'bg-indigo-500/20 text-indigo-200 border-indigo-400/30'
                                }`}
                            >
                                ⚡ {cap}
                            </span>
                        ))
                    )}
                </div>
            </div>

            {/* Section 1: Currently Installed Widgets */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="font-bold text-base text-gray-900 flex items-center gap-2">
                            <span>✅</span>
                            <span>1. インストール済みウィジェット ({installed.length} 件)</span>
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                            各ウィジェット固有の詳細設定（MCPサーバー接続先、チャット定型文、RAG同期フォルダ等）は「⚙️ 個別設定」からカプセル化されたドロワーで管理できます。
                        </p>
                    </div>
                </div>

                {loading ? (
                    <div className="py-8 text-center text-xs text-gray-400">読み込み中...</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {installed.map(widget => {
                            const effectiveStatus = widget.status || (widget.licenseStatus === 'included' ? 'core' : widget.licenseStatus);
                            const statusBadge = effectiveStatus === 'core'
                                ? { label: '標準コアパック', cls: 'bg-blue-50 text-blue-700 border-blue-200' }
                                : effectiveStatus === 'trial'
                                    ? { label: `🚀 トライアル中 (${widget.trialDaysRemaining ?? 14}日残)`, cls: 'bg-amber-50 text-amber-800 border-amber-300' }
                                    : { label: '🔑 ライセンス認証済', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };

                            return (
                                <div
                                    key={widget.id}
                                    className="p-4 rounded-xl border border-gray-200 bg-slate-50/60 hover:bg-white hover:shadow-xs transition flex flex-col justify-between gap-3"
                                >
                                    <div>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-center gap-2.5">
                                                <span className="text-2xl">{WIDGET_ICONS[widget.id] || '🧩'}</span>
                                                <div>
                                                    <div className="font-bold text-sm text-gray-900">{widget.name}</div>
                                                    <div className="text-[10px] font-mono text-gray-400">
                                                        {widget.packageName || widget.packageId} · v{widget.version}
                                                    </div>
                                                </div>
                                            </div>
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border ${statusBadge.cls}`}>
                                                {statusBadge.label}
                                            </span>
                                        </div>
                                        <p className="text-xs text-gray-600 mt-2 leading-relaxed">
                                            {widget.description || widget.shortDescription}
                                        </p>
                                    </div>

                                    <div className="pt-3 border-t border-gray-200/70 flex items-center justify-between gap-2">
                                        <div className="flex flex-wrap gap-1">
                                            {(widget.providesCapabilities || []).map(cap => (
                                                <span key={cap} className="text-[10px] font-mono bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-200">
                                                    +{cap.replace('capability:', '')}
                                                </span>
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {hasSpecificSettings(widget.id) && (
                                                <button
                                                    type="button"
                                                    onClick={() => openWidgetConfigDrawer(widget)}
                                                    className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-800 border border-gray-300 rounded-lg text-xs font-semibold shadow-2xs cursor-pointer transition"
                                                >
                                                    ⚙️ 個別設定を開く
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => handleUninstallWidget(widget.id, widget.name)}
                                                className="px-2.5 py-1.5 text-red-600 hover:bg-red-50 rounded-lg text-xs font-medium cursor-pointer transition"
                                            >
                                                解除
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Section 2: Available Add-on Widgets Catalog (Sales Pitch & License Monetization) */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="mb-4">
                    <h3 className="font-bold text-base text-gray-900 flex items-center gap-2">
                        <span>🛒</span>
                        <span>2. 追加プラグイン・ウィジェットカタログ (Add-on Store & ご提案)</span>
                    </h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                        お客様の業務フェーズに合わせて後から1クリックでプラグインを追加できます。14日間無料トライアルまたはウィジェット単位のライセンスキー（課金）で有効化できます。
                    </p>
                </div>

                {generatedKeyInfo && (
                    <div className="mb-4 p-3 bg-emerald-50 border border-emerald-300 rounded-lg flex items-center justify-between text-xs text-emerald-900">
                        <div>
                            <span className="font-bold">🔑 発行された商用ライセンスキー ({generatedKeyInfo.widgetId}): </span>
                            <code className="font-mono bg-white px-2 py-0.5 rounded border border-emerald-200 select-all">
                                {generatedKeyInfo.licenseKey}
                            </code>
                        </div>
                        <button
                            type="button"
                            onClick={() => setGeneratedKeyInfo(null)}
                            className="text-emerald-700 hover:underline text-[11px]"
                        >
                            閉じる
                        </button>
                    </div>
                )}

                {availableAddons.length === 0 ? (
                    <div className="py-8 text-center text-xs text-gray-500 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                        すべての利用可能なウィジェットがインストールされています。
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4">
                        {availableAddons.map(addon => {
                            const isFeatured = addon.id === 'knowledge-base' || addon.id === 'deep-research';
                            return (
                                <div
                                    key={addon.id}
                                    className={`p-5 rounded-xl border transition ${
                                        isFeatured
                                            ? 'border-indigo-300 bg-gradient-to-br from-indigo-50/50 via-white to-purple-50/40 shadow-xs'
                                            : 'border-gray-200 bg-white'
                                    }`}
                                >
                                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                                        <div className="space-y-2 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-2xl">{WIDGET_ICONS[addon.id] || '🧩'}</span>
                                                <h4 className="font-bold text-sm text-gray-900">{addon.name}</h4>
                                                {isFeatured && (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-600 text-white">
                                                        おすすめ拡張 (経営会議・RAG連携)
                                                    </span>
                                                )}
                                                <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 px-2.5 py-0.5 rounded-full border border-indigo-200">
                                                    💰 {typeof addon.pricing === 'object' ? (addon.pricing?.label || 'オプション追加可') : (addon.pricingLabel || addon.pricing)}
                                                </span>
                                            </div>
                                            <p className="text-xs text-gray-700 leading-relaxed">
                                                {addon.description || addon.shortDescription}
                                            </p>
                                            {addon.salesPitch && (
                                                <div className="p-2.5 rounded-lg bg-amber-50/80 border border-amber-200/80 text-[11px] text-amber-900">
                                                    💡 <strong>導入メリット・活用シナリオ:</strong> {addon.salesPitch}
                                                </div>
                                            )}
                                            <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                                <span className="text-[10px] text-gray-400">解放される機能:</span>
                                                {(addon.providesCapabilities || []).map(cap => (
                                                    <span key={cap} className="text-[10px] font-mono bg-purple-50 text-purple-700 px-2 py-0.5 rounded border border-purple-200">
                                                        ⚡ {cap}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-2 min-w-[280px] pt-3 lg:pt-0 lg:pl-4 lg:border-l border-gray-200">
                                            <button
                                                type="button"
                                                onClick={() => handleInstallWidget(addon.id, 'trial')}
                                                className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition"
                                            >
                                                🚀 14日間無料トライアルで即時追加
                                            </button>

                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="text"
                                                    value={licenseInputMap[addon.id] || ''}
                                                    onChange={(e) => setLicenseInputMap(prev => ({ ...prev, [addon.id]: e.target.value }))}
                                                    placeholder="EA-LIC-... (ライセンスキー)"
                                                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-xs font-mono bg-white focus:outline-none focus:border-indigo-500"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => handleInstallWidget(addon.id, 'licensed')}
                                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition"
                                                >
                                                    🔑 有効化
                                                </button>
                                            </div>
                                            {canManageSettings && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleGenerateLicense(addon.id)}
                                                    className="text-[10px] text-gray-500 hover:text-indigo-600 text-right underline cursor-pointer"
                                                >
                                                    🛠️ 管理者用: このウィジェットのライセンスキーを発行
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Encapsulated Widget Configuration Dialog (Modern Web Guidance light-dismiss-a-dialog compliant) */}
            <dialog
                ref={dialogRef}
                closedby="any"
                aria-labelledby="widget-config-dialog-title"
                className="w-full max-w-4xl rounded-2xl border border-gray-200 bg-[#f5f5f7] p-0 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-xs"
            >
                {activeConfigWidget && (
                    <div className="flex flex-col max-h-[82vh]">
                        <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200 sticky top-0 z-10">
                            <div className="flex items-center gap-2.5">
                                <span className="text-2xl">{WIDGET_ICONS[activeConfigWidget.id] || '⚙️'}</span>
                                <div>
                                    <h3 id="widget-config-dialog-title" className="font-bold text-base text-gray-900">
                                        {activeConfigWidget.name} — ウィジェット個別設定
                                    </h3>
                                    <p className="text-xs text-gray-500">
                                        このウィジェット固有の接続設定・プロンプト・同期フォルダを管理します（枠外クリックまたは ESC で閉じます）
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={closeWidgetConfigDrawer}
                                className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold cursor-pointer"
                            >
                                ✕ 閉じる
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto space-y-6 select-text">
                            {activeConfigWidget.id === 'mcp-chat' && (
                                <McpConnectionsTab
                                    mcpQuickPrompts={mcpQuickPrompts}
                                    setMcpQuickPrompts={setMcpQuickPrompts}
                                    handleSaveSettings={handleSaveSettings}
                                    models={models}
                                    claudeModels={claudeModels}
                                    currentMcpChatModel={currentMcpChatModel}
                                    handleMcpChatModelChange={handleMcpChatModelChange}
                                    mcpChatSystemInstruction={mcpChatSystemInstruction}
                                    setMcpChatSystemInstruction={setMcpChatSystemInstruction}
                                    mcpChatMaxTurns={mcpChatMaxTurns}
                                    setMcpChatMaxTurns={setMcpChatMaxTurns}
                                    defaultMcpChatSystemInstruction={defaultMcpChatSystemInstruction}
                                    canManageSettings={canManageSettings}
                                    user={user}
                                />
                            )}

                            {activeConfigWidget.id === 'gemini' && (
                                <ChatConfigTab
                                    chatPresets={chatPresets}
                                    setChatPresets={setChatPresets}
                                    chatPresetContext={chatPresetContext}
                                    setChatPresetContext={setChatPresetContext}
                                    presetLabel={presetLabel}
                                    setPresetLabel={setPresetLabel}
                                    presetPrompt={presetPrompt}
                                    setPresetPrompt={setPresetPrompt}
                                    ragFaqs={ragFaqs}
                                    setRagFaqs={setRagFaqs}
                                    canManageSettings={canManageSettings}
                                />
                            )}

                            {activeConfigWidget.id === 'knowledge-base' && (
                                <PersonalRagTab
                                    ragFolders={ragFolders}
                                    newRagFolderName={newRagFolderName}
                                    setNewRagFolderName={setNewRagFolderName}
                                    newRagFolderId={newRagFolderId}
                                    setNewRagFolderId={setNewRagFolderId}
                                    handleAddRagFolder={handleAddRagFolder}
                                    handleRemoveRagFolder={handleRemoveRagFolder}
                                    handleSyncRag={handleSyncRag}
                                    isSyncing={isSyncing}
                                    syncTarget={syncTarget}
                                    lastRagSyncTime={lastRagSyncTime}
                                    lastRagSyncTimeGemini={lastRagSyncTimeGemini}
                                    lastRagSyncTimeClaude={lastRagSyncTimeClaude}
                                    ragSyncErrors={ragSyncErrors}
                                />
                            )}

                            {activeConfigWidget.id === 'deep-research' && (
                                <DeepResearchTab
                                    models={models}
                                    claudeModels={claudeModels}
                                    isGeminiConfigured={isGeminiConfigured}
                                    isClaudeConfigured={isClaudeConfigured}
                                    aiProvider={aiProvider}
                                    hasWidget={hasWidget}
                                    hasAction={hasAction}
                                />
                            )}

                            {activeConfigWidget.id === 'finder' && (
                                <FinderTab
                                    driveRootId={driveRootId}
                                    setDriveRootId={setDriveRootId}
                                    handleSaveDriveRoot={handleSaveDriveRoot}
                                    canManageSettings={canManageSettings}
                                />
                            )}

                            {activeConfigWidget.id === 'live-concierge' && (
                                <LiveConciergeTab
                                    initialConfig={{
                                        geminiLiveAvailableModels,
                                        geminiLiveDefaultModel,
                                        isGeminiConfigured
                                    }}
                                    canManageSettings={canManageSettings}
                                    onSaved={({ geminiLiveAvailableModels: newModels, geminiLiveDefaultModel: newDefault }) => {
                                        if (setGeminiLiveAvailableModels) setGeminiLiveAvailableModels(newModels);
                                        if (setGeminiLiveDefaultModel) setGeminiLiveDefaultModel(newDefault);
                                    }}
                                />
                            )}
                        </div>
                    </div>
                )}
            </dialog>
        </div>
    );
};

export default WidgetStoreTab;
