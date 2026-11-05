import React, { useState, useEffect } from 'react';

const DOMAIN_KEY_OPTIONS = [
    { value: '', label: '🔍 自動判定 (mcp-harness.yaml のキーワード・URLルールに従う)' },
    { value: 'npb_baseball', label: '⚾ プロ野球データ分析 (npb_baseball)' },
    { value: 'digital_agency', label: '🏛️ 行政手続・政府統計データ (digital_agency)' },
    { value: 'hr_personnel', label: '👥 人事・組織データベース (hr_personnel)' },
    { value: 'knowledge_base', label: '📚 社内ナレッジベース (knowledge_base)' },
    { value: 'google_workspace', label: '📅 Google Workspace 連携 (google_workspace)' },
    { value: 'catalog', label: '🗂️ メタデータ・データカタログ (catalog)' },
    { value: 'general', label: '🔌 汎用 MCP ツール (general)' }
];

const MCP_GATEWAY_SIMULATION_SCENARIOS = [
    {
        id: 'npb_read',
        label: '⚾ シナリオ1A: NPB 成績参照 (SELECT)',
        desc: 'NPB 管理者用 MCP (#5) に対する通常の参照クエリ実行',
        resource_type: 'mcp_server',
        resource_id: '5',
        action_type: 'read_query',
        sample_query: "SELECT name, batting_avg, home_runs, rbi FROM batting_stats JOIN players USING(player_id) WHERE year = 2026 LIMIT 5;"
    },
    {
        id: 'npb_write',
        label: '🚫 シナリオ1B: NPB データ更新試行 (write_query)',
        desc: 'NPB 管理者用 MCP (#5) で選手成績を書き換える UPDATE クエリを実行',
        resource_type: 'mcp_server',
        resource_id: '5',
        action_type: 'write_query',
        sample_query: "UPDATE batting_stats SET home_runs = 99 WHERE player_id = 101 AND year = 2026;"
    },
    {
        id: 'hr_restricted_col',
        label: '🔒 シナリオ2: 機密テーブル/給与カラム照会 (pitching_stats / salary)',
        desc: '球団編成部長や人事部長ロール等で禁止指定されたカラム・テーブル (salary, bonus, pitching_stats) を含む SELECT クエリ',
        resource_type: 'mcp_server',
        resource_id: '5',
        action_type: 'read_query',
        sample_query: "SELECT player_id, era, salary, bonus FROM pitching_stats WHERE year = 2026;"
    },
    {
        id: 'gov_mcp',
        label: '🏛️ シナリオ3: デジタル庁 行政手続 MCP (#7) 参照',
        desc: 'デジタル庁 行政手続分析 MCP (#7) の query_records ツール呼び出し',
        resource_type: 'mcp_server',
        resource_id: '7',
        action_type: 'query_records',
        sample_query: "dataset=procedures, life_event=引越し"
    }
];

const McpConnectionsTab = ({ 
    mcpQuickPrompts = [], 
    setMcpQuickPrompts, 
    handleSaveSettings,
    models = [],
    claudeModels = [],
    currentMcpChatModel = 'gemini-2.5-pro',
    handleMcpChatModelChange,
    mcpChatSystemInstruction = '',
    setMcpChatSystemInstruction,
    mcpChatMaxTurns = 15,
    setMcpChatMaxTurns,
    defaultMcpChatSystemInstruction = '',
    canManageSettings = true,
    user,
    onPoliciesUpdated,
    onNavigateTab
}) => {
    const [activeSubTab, setActiveSubTab] = useState('connections'); // 'connections' | 'gateway_sim' | 'prompts' | 'model' | 'harness'
    const [servers, setServers] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    // MCP-ZTA-Gateway Role Policy & PEP Dry-Run Simulator State
    const [pdpPolicies, setPdpPolicies] = useState({});
    const [mcpPresets, setMcpPresets] = useState({});
    const [simSelectedRoleKey, setSimSelectedRoleKey] = useState('admin');
    const [simScenario, setSimScenario] = useState(MCP_GATEWAY_SIMULATION_SCENARIOS[0]);
    const [simResult, setSimResult] = useState(null);
    const [simRunning, setSimRunning] = useState(false);
    const [presetNotice, setPresetNotice] = useState('');
    
    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [editingServer, setEditingServer] = useState(null);
    const [formData, setFormData] = useState({
        id: null,
        name: '',
        endpoint_url: '',
        connection_mode: 'zta_gateway',
        domain_key: '',
        token_url: '',
        client_id: '',
        client_secret: ''
    });
    
    // Connection Test State
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [testingServerId, setTestingServerId] = useState(null); // For inline list testing

    // Quick Prompts State
    const [newPromptLabel, setNewPromptLabel] = useState('');
    const [newPromptText, setNewPromptText] = useState('');

    // Dynamic MCP Harness YAML State (Phase 2)
    const [harnessYaml, setHarnessYaml] = useState('');
    const [harnessConfig, setHarnessConfig] = useState(null);
    const [harnessPath, setHarnessPath] = useState('/app/data/mcp-harness.yaml');
    const [isSavingHarness, setIsSavingHarness] = useState(false);
    const [harnessStatusMsg, setHarnessStatusMsg] = useState(null);

    const fetchServers = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/mcp/servers');
            if (res.ok) {
                const data = await res.json();
                setServers(data);
            }
        } catch (e) {
            console.error("Failed to fetch MCP servers", e);
        } finally {
            setIsLoading(false);
        }
    };

    const fetchHarnessYaml = async () => {
        try {
            const res = await fetch('/api/mcp/servers/harness');
            if (res.ok) {
                const data = await res.json();
                setHarnessYaml(data.yaml || '');
                setHarnessConfig(data.config || null);
                if (data.filePath) setHarnessPath(data.filePath);
            }
        } catch (e) {
            console.error("Failed to fetch MCP harness YAML", e);
        }
    };

    const fetchMcpPdpPolicies = async () => {
        try {
            const res = await fetch('/api/core/pdp');
            if (res.ok) {
                const data = await res.json();
                const loadedPdp = data.pdp || data.policies || {};
                setPdpPolicies(loadedPdp);
                const rawPresets = data.presets || data.rolePresets || {};
                const onlyMcpPresets = Object.fromEntries(
                    Object.entries(rawPresets).filter(([, tpl]) =>
                        tpl.roleCategory === 'mcp' ||
                        tpl.roleCategory === 'mcp_sample' ||
                        tpl.roleCategory === 'hr_domain' ||
                        (Array.isArray(tpl.tags) && tpl.tags.includes('MCP'))
                    )
                );
                setMcpPresets(onlyMcpPresets);
                const roleKeys = Object.keys(loadedPdp);
                if (roleKeys.length > 0 && !loadedPdp[simSelectedRoleKey]) {
                    setSimSelectedRoleKey(roleKeys.includes('user') ? 'user' : roleKeys[0]);
                }
            }
        } catch (e) {
            console.error('Failed to fetch MCP PDP policies:', e);
        }
    };

    const handleActivateMcpRolePreset = async (presetKey) => {
        if (!presetKey) return;
        try {
            const res = await fetch('/api/core/pdp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applyPresetKey: presetKey })
            });
            const data = await res.json();
            if (res.ok && data.pdp) {
                setPdpPolicies(data.pdp);
                setSimSelectedRoleKey(presetKey);
                if (onPoliciesUpdated && data.rbacPolicies) {
                    onPoliciesUpdated(data.rbacPolicies);
                }
                setPresetNotice(`✅ MCP ロール「${mcpPresets[presetKey]?.displayName || presetKey}」を追加し、テスト対象に選択しました`);
                setTimeout(() => setPresetNotice(''), 4000);
            }
        } catch (e) {
            console.error('Failed to activate MCP role preset:', e);
        }
    };

    const runGatewaySimulation = async (scenarioOverride = null, roleOverride = null) => {
        const targetScenario = scenarioOverride || simScenario;
        const targetRole = roleOverride || simSelectedRoleKey;
        if (scenarioOverride) setSimScenario(scenarioOverride);
        setSimRunning(true);
        try {
            const res = await fetch('/api/core/pdp/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roleKeys: [targetRole],
                    scenario: targetScenario,
                    draftPolicies: pdpPolicies
                })
            });
            const data = await res.json();
            setSimResult(data);
        } catch (err) {
            setSimResult({
                allowed: false,
                decision: 'ERROR',
                reason: err.message || 'MCP-ZTA-Gateway シミュレーション通信エラー'
            });
        } finally {
            setSimRunning(false);
        }
    };

    useEffect(() => {
        fetchServers();
        fetchHarnessYaml();
        fetchMcpPdpPolicies();
    }, []);

    const handleSaveHarnessYaml = async () => {
        setIsSavingHarness(true);
        setHarnessStatusMsg(null);
        try {
            const res = await fetch('/api/mcp/servers/harness', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ yaml: harnessYaml })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setHarnessYaml(data.yaml || harnessYaml);
                setHarnessConfig(data.config || null);
                setHarnessStatusMsg({
                    type: 'success',
                    text: data.message || '✅ mcp-harness.yaml を保存し、0秒ホットリロードを適用しました。'
                });
                fetchServers();
            } else {
                setHarnessStatusMsg({
                    type: 'error',
                    text: data.error || 'ハーネス定義の保存に失敗しました。'
                });
            }
        } catch (e) {
            setHarnessStatusMsg({
                type: 'error',
                text: '通信エラーが発生しました。'
            });
        } finally {
            setIsSavingHarness(false);
        }
    };

    const handleResetHarnessYaml = async () => {
        if (!confirm('mcp-harness.yaml をシステム初期定義（NPB・デジタル庁・人事DB・社内ナレッジ・Google Workspace）にリセットし、即時ホットリロードしますか？')) return;
        setIsSavingHarness(true);
        setHarnessStatusMsg(null);
        try {
            const res = await fetch('/api/mcp/servers/harness/reset', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                setHarnessYaml(data.yaml || '');
                setHarnessConfig(data.config || null);
                setHarnessStatusMsg({
                    type: 'success',
                    text: data.message || '🔄 mcp-harness.yaml を初期状態に復元し、ホットリロードしました。'
                });
                fetchServers();
            } else {
                setHarnessStatusMsg({
                    type: 'error',
                    text: data.error || 'リセットに失敗しました。'
                });
            }
        } catch (e) {
            setHarnessStatusMsg({
                type: 'error',
                text: '通信エラーが発生しました。'
            });
        } finally {
            setIsSavingHarness(false);
        }
    };

    const handleOpenModal = (server = null) => {
        if (server) {
            setEditingServer(server);
            setFormData({
                id: server.id,
                name: server.name,
                endpoint_url: server.endpoint_url,
                connection_mode: server.connection_mode || 'zta_gateway',
                domain_key: server.domain_key || '',
                token_url: server.token_url || '',
                client_id: server.client_id || '',
                client_secret: '' // Do not populate secret for security, leave blank to not update
            });
        } else {
            setEditingServer(null);
            setFormData({
                id: null,
                name: '',
                endpoint_url: '',
                connection_mode: 'zta_gateway',
                domain_key: '',
                token_url: '',
                client_id: '',
                client_secret: ''
            });
        }
        setTestResult(null); // Reset test result
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
        setEditingServer(null);
        setTestResult(null);
    };

    const handleTestConnection = async () => {
        if (!formData.endpoint_url) {
            setTestResult({ success: false, message: 'Endpoint URL is required to test.' });
            return;
        }

        setIsTesting(true);
        setTestResult(null);

        try {
            const res = await fetch('/api/mcp/servers/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            const data = await res.json();
            
            if (res.ok && data.success) {
                const toolsText = data.tools && data.tools.length > 0 ? ` (${data.tools.join(', ')})` : '';
                setTestResult({ success: true, message: `✅ 接続成功！ ${data.toolCount} 個のツールを認識しました${toolsText}` });
            } else {
                setTestResult({ success: false, message: data.error || '接続に失敗しました。' });
            }
        } catch (e) {
            setTestResult({ success: false, message: 'ネットワークエラーまたは接続が拒否されました。' });
        } finally {
            setIsTesting(false);
        }
    };

    const handleTestExisting = async (id) => {
        setTestingServerId(id);
        try {
            const res = await fetch(`/api/mcp/servers/${id}/test`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                const toolList = data.tools && data.tools.length > 0 ? `\n\n【利用可能ツール一覧】\n・${data.tools.join('\n・')}` : '';
                alert(`✅ 接続成功！\n${data.toolCount} 個のツールを正常に認識しました。${toolList}`);
            } else {
                alert(`❌ 接続失敗:\n${data.error || 'エラーが発生しました'}`);
            }
        } catch (e) {
            alert('❌ ネットワークエラーまたは接続が拒否されました。');
        } finally {
            setTestingServerId(null);
        }
    };

    const handleSave = async () => {
        if (!formData.name || !formData.endpoint_url) {
            alert('Name and Endpoint URL are required.');
            return;
        }

        try {
            const method = editingServer ? 'PUT' : 'POST';
            const url = editingServer ? `/api/mcp/servers/${editingServer.id}` : '/api/mcp/servers';
            
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (res.ok) {
                handleCloseModal();
                fetchServers();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to save MCP server.');
            }
        } catch (e) {
            console.error("Error saving MCP server", e);
            alert("Error saving MCP server");
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Are you sure you want to delete this MCP Server connection?')) return;
        try {
            const res = await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                fetchServers();
            }
        } catch (e) {
            console.error("Error deleting MCP server", e);
        }
    };

    const renderConnectionModeBadge = (server) => {
        const mode = server.connection_mode || 'zta_gateway';
        if (mode === 'direct_public') {
            return (
                <span className="text-[10px] px-2.5 py-0.5 rounded-full font-semibold bg-sky-100 text-sky-800 border border-sky-200 flex items-center gap-1">
                    <span>🌐</span>
                    <span>Direct Public (公開データ直接接続 / Gatewayバイパス)</span>
                </span>
            );
        }
        if (mode === 'builtin_local') {
            return (
                <span className="text-[10px] px-2.5 py-0.5 rounded-full font-semibold bg-purple-100 text-purple-800 border border-purple-200 flex items-center gap-1">
                    <span>🏠</span>
                    <span>Built-in Local (内部ナレッジ直結)</span>
                </span>
            );
        }
        return (
            <span className="text-[10px] px-2.5 py-0.5 rounded-full font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200 flex items-center gap-1">
                <span>🛡️</span>
                <span>ZTA Gateway (OAuth A2A 認証経由)</span>
            </span>
        );
    };

    return (
        <div className="space-y-6">
            {/* Sub Tab Navigation */}
            <div className="flex flex-wrap border-b border-gray-200 gap-1">
                <button
                    onClick={() => setActiveSubTab('connections')}
                    className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${activeSubTab === 'connections' ? 'border-indigo-600 text-indigo-600 bg-indigo-50/40 rounded-t-lg' : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'}`}
                >
                    <span>🔌</span>
                    <span>サーバー接続 & Gateway ルーティング</span>
                </button>
                <button
                    onClick={() => {
                        setActiveSubTab('gateway_sim');
                        fetchMcpPdpPolicies();
                    }}
                    className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${activeSubTab === 'gateway_sim' ? 'border-indigo-600 text-indigo-600 bg-indigo-50/40 rounded-t-lg' : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'}`}
                >
                    <span>🧪</span>
                    <span>ZTA Gateway ロール権限 & シミュレーター</span>
                </button>
                <button
                    onClick={() => setActiveSubTab('harness')}
                    className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${activeSubTab === 'harness' ? 'border-indigo-600 text-indigo-600 bg-indigo-50/40 rounded-t-lg' : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'}`}
                >
                    <span>🛡️</span>
                    <span>ハーネス & ルール (YAML Hot-Reload)</span>
                </button>
                <button
                    onClick={() => setActiveSubTab('prompts')}
                    className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${activeSubTab === 'prompts' ? 'border-indigo-600 text-indigo-600 bg-indigo-50/40 rounded-t-lg' : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'}`}
                >
                    <span>⚡</span>
                    <span>クイックプロンプト</span>
                </button>
                <button
                    onClick={() => setActiveSubTab('model')}
                    className={`px-4 py-2.5 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${activeSubTab === 'model' ? 'border-indigo-600 text-indigo-600 bg-indigo-50/40 rounded-t-lg' : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'}`}
                >
                    <span>🤖</span>
                    <span>MCP チャット AI モデル</span>
                </button>
            </div>

            {/* Sub-Tab: ZTA Gateway Role Permissions & PEP Dry-Run Simulator */}
            {activeSubTab === 'gateway_sim' && (() => {
                const currentRoleObj = pdpPolicies[simSelectedRoleKey] || {};
                const roleMcpGrants = (Array.isArray(currentRoleObj.grants) ? currentRoleObj.grants : []).filter(
                    g => g.resource_type === 'mcp_server'
                );

                return (
                    <div className="space-y-5 animate-fadeIn">
                        {/* Overview Card: Role Selection & MCP Server Grants */}
                        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-gray-100">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg">🛡️</span>
                                        <h2 className="font-bold text-sm text-gray-900">
                                            MCP-ZTA-Gateway ロール別アクセスルール & PEP シミュレーター
                                        </h2>
                                        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                                            OAuth A2A / SQL & Tool 実行前インターセプト検証
                                        </span>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        MCP チャットが MCP-ZTA-Gateway 経由で外部データベース（NPB 統計 DB・人事 DB・デジタル庁 MCP 等）へクエリを発行する際、各ロールの操作レベル（Read-Only / Read-Write）、禁止カラム（<code>salary</code>, <code>pitching_stats</code> 等）、AI スコープ制約がどう動作するかをリアルタイムに検証できます。
                                    </p>
                                </div>
                                {onNavigateTab && (
                                    <button
                                        type="button"
                                        onClick={() => onNavigateTab('ZTA PDP')}
                                        className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold whitespace-nowrap cursor-pointer transition border border-slate-300"
                                    >
                                        🛡️ ロール & 権限ビルダーで編集 →
                                    </button>
                                )}
                            </div>

                            {presetNotice && (
                                <div className="px-3.5 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
                                    {presetNotice}
                                </div>
                            )}

                            {/* Role Selector & Quick MCP Preset Activator */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <div className="p-3.5 rounded-xl bg-slate-50 border border-gray-200 space-y-2">
                                    <label className="block text-xs font-bold text-gray-800">
                                        ① 検証対象の定義済みロールを選択 ({Object.keys(pdpPolicies).length} ロール)
                                    </label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Object.entries(pdpPolicies).map(([rKey, rVal]) => {
                                            const active = rKey === simSelectedRoleKey;
                                            return (
                                                <button
                                                    key={rKey}
                                                    type="button"
                                                    onClick={() => {
                                                        setSimSelectedRoleKey(rKey);
                                                        if (simResult) {
                                                            runGatewaySimulation(simScenario, rKey);
                                                        }
                                                    }}
                                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition border ${
                                                        active
                                                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                                            : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-200'
                                                    }`}
                                                >
                                                    {rVal.label || rVal.displayName || rKey}
                                                    <span className={`ml-1 text-[10px] font-mono ${active ? 'text-indigo-200' : 'text-gray-400'}`}>
                                                        ({rKey})
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="p-3.5 rounded-xl bg-indigo-50/40 border border-indigo-100 space-y-2">
                                    <label className="block text-xs font-bold text-indigo-950">
                                        ⚡ MCP 専用プリセットロールをワンクリック有効化してテスト
                                    </label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {Object.entries(mcpPresets).map(([pKey, pTpl]) => {
                                            const isInstalledRole = Boolean(pdpPolicies[pKey]);
                                            return (
                                                <button
                                                    key={pKey}
                                                    type="button"
                                                    onClick={() => {
                                                        if (isInstalledRole) {
                                                            setSimSelectedRoleKey(pKey);
                                                            if (simResult) runGatewaySimulation(simScenario, pKey);
                                                        } else {
                                                            handleActivateMcpRolePreset(pKey);
                                                        }
                                                    }}
                                                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition border ${
                                                        isInstalledRole
                                                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                                                            : 'bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50'
                                                    }`}
                                                >
                                                    {isInstalledRole ? '✓ ' : '＋ '}
                                                    {pTpl.displayName || pKey}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Active Role's MCP Server Permission Grants Summary */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-xs font-bold text-gray-800">
                                        🔌 選択中ロール「{currentRoleObj.label || simSelectedRoleKey} ({simSelectedRoleKey})」の MCP-ZTA-Gateway 権限ルール ({roleMcpGrants.length} 件)
                                    </h3>
                                </div>
                                {roleMcpGrants.length === 0 ? (
                                    <div className="p-3 rounded-lg bg-rose-50/60 border border-rose-200 text-rose-800 text-xs">
                                        🚫 このロールには <code>mcp_server</code> 権限ルールがアタッチされていません。すべての MCP サーバー呼び出しが Zero-Trust 原則（Default Deny）によりブロックされます。
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                        {roleMcpGrants.map((g, idx) => {
                                            const restricted = g.constraints?.restricted_identifiers || [];
                                            const guardText = g.constraints?.scope_prompt_guard || '';
                                            return (
                                                <div
                                                    key={g.id || idx}
                                                    className="p-3 rounded-xl bg-slate-50 border border-gray-200 text-xs space-y-1.5"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="font-bold text-gray-900">
                                                            🔌 {g.resource_label || `MCP Server (${g.resource_id})`}
                                                        </span>
                                                        <div className="flex items-center gap-1">
                                                            <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-indigo-100 text-indigo-800">
                                                                op: {g.operation_level}
                                                            </span>
                                                            <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold bg-amber-100 text-amber-800">
                                                                scope: {g.data_scope}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div className="text-[11px] text-gray-600 flex flex-wrap gap-2">
                                                        <span>
                                                            🔒 禁止テーブル/カラム:{' '}
                                                            {restricted.length > 0 ? (
                                                                <code className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 font-mono">
                                                                    {restricted.join(', ')}
                                                                </code>
                                                            ) : (
                                                                <span className="text-gray-400">なし</span>
                                                            )}
                                                        </span>
                                                    </div>
                                                    {guardText && (
                                                        <div className="text-[11px] text-amber-900 bg-amber-50/80 border border-amber-200/80 rounded px-2 py-1">
                                                            🛡️ <strong>AIスコープ制約:</strong> {guardText}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Dark Simulator Panel */}
                        <div className="bg-slate-900 text-white rounded-xl border border-slate-700 shadow-md p-5 space-y-4">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-700">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-lg">🧪</span>
                                        <h3 className="font-bold text-sm text-white">
                                            MCP-ZTA-Gateway ロール権限シミュレーター (1クリック PEP Dry-Run 検証パネル)
                                        </h3>
                                        <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-indigo-500/30 text-indigo-200 border border-indigo-400/40">
                                            テスト対象ロール: {currentRoleObj.label || simSelectedRoleKey} ({simSelectedRoleKey})
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-slate-300 mt-1">
                                        別アカウントでログインし直さなくても、選択中のロール「<strong>{currentRoleObj.label || simSelectedRoleKey}</strong>」で NPB 統計 DB・人事機密カラム・デジタル庁 MCP を操作した際に MCP-ZTA-Gateway PEP がどう判定するか即座にテストできます。
                                    </p>
                                </div>
                            </div>

                            {/* Preset Test Scenario Buttons */}
                            <div className="space-y-1.5">
                                <span className="text-[11px] font-bold text-slate-300">
                                    ⚡ MCP 検証シナリオを選択して1クリック実行:
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                    {MCP_GATEWAY_SIMULATION_SCENARIOS.map(sc => (
                                        <button
                                            key={sc.id}
                                            type="button"
                                            onClick={() => runGatewaySimulation(sc)}
                                            className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer transition border ${
                                                simScenario.id === sc.id
                                                    ? 'bg-indigo-600 text-white border-indigo-400 shadow-xs'
                                                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600'
                                            }`}
                                        >
                                            {sc.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Custom / Editable Scenario Inputs */}
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 bg-slate-800/90 p-3 rounded-xl border border-slate-700 text-xs">
                                <div>
                                    <label className="block text-[10px] text-slate-400 mb-1">対象リソース種別</label>
                                    <input
                                        type="text"
                                        readOnly
                                        value="🔌 mcp_server (MCP Gateway)"
                                        className="w-full px-2 py-1.5 rounded bg-slate-900/70 border border-slate-700 text-slate-300 text-xs"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-400 mb-1">対象 MCP サーバー</label>
                                    <select
                                        value={simScenario.resource_id}
                                        onChange={(e) => setSimScenario({ ...simScenario, id: 'custom', resource_type: 'mcp_server', resource_id: e.target.value })}
                                        className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-600 text-white text-xs"
                                    >
                                        <option value="5">[#5] NPB 統計データ分析 MCP</option>
                                        <option value="7">[#7] デジタル庁 行政手続 MCP</option>
                                        {servers.filter(s => String(s.id) !== '5' && String(s.id) !== '7').map(s => (
                                            <option key={s.id} value={String(s.id)}>
                                                [#{s.id}] {s.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] text-slate-400 mb-1">実行 MCP ツール名</label>
                                    <input
                                        type="text"
                                        value={simScenario.action_type}
                                        onChange={(e) => setSimScenario({ ...simScenario, id: 'custom', resource_type: 'mcp_server', action_type: e.target.value })}
                                        placeholder="例: read_query / write_query / query_records"
                                        className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-600 text-white font-mono text-xs"
                                    />
                                </div>
                                <div className="flex items-end">
                                    <button
                                        type="button"
                                        onClick={() => runGatewaySimulation()}
                                        disabled={simRunning}
                                        className="w-full py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs cursor-pointer transition"
                                    >
                                        {simRunning ? '判定中...' : '▶ PEP 判定テスト実行'}
                                    </button>
                                </div>
                                <div className="sm:col-span-4">
                                    <label className="block text-[10px] text-slate-400 mb-1">
                                        テスト実行 SQL / ツール引数ペイロード (restricted_identifiers や UPDATE/DROP 検査対象)
                                    </label>
                                    <input
                                        type="text"
                                        value={simScenario.sample_query}
                                        onChange={(e) => setSimScenario({ ...simScenario, id: 'custom', resource_type: 'mcp_server', sample_query: e.target.value })}
                                        placeholder="SELECT * FROM batting_stats ..."
                                        className="w-full px-2.5 py-1.5 rounded bg-slate-900 border border-slate-600 text-amber-200 font-mono text-xs"
                                    />
                                </div>
                            </div>

                            {/* Simulation Output Result Box */}
                            {simResult && (
                                <div
                                    className={`p-4 rounded-xl border ${
                                        simResult.allowed
                                            ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-100'
                                            : 'bg-rose-950/80 border-rose-500/60 text-rose-100'
                                    }`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <span className={`px-2.5 py-0.5 rounded text-xs font-extrabold ${
                                                simResult.allowed ? 'bg-emerald-500 text-slate-950' : 'bg-rose-500 text-white'
                                            }`}>
                                                {simResult.allowed ? '✅ PERMIT (Gateway 通過・実行許可)' : '🚫 DENY (MCP-ZTA-Gateway ブロック)'}
                                            </span>
                                            <span className="text-xs font-mono text-slate-300">
                                                判定ステージ: {simResult.stage}
                                            </span>
                                        </div>
                                        {simResult.grant && (
                                            <span className="text-[11px] font-mono text-slate-300">
                                                op={simResult.grant.operation_level} | scope={simResult.grant.data_scope}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs mt-2 font-medium leading-relaxed">
                                        {simResult.reason}
                                    </p>
                                    {simResult.grant?.scope_prompt_guard && (
                                        <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-amber-200">
                                            🛡️ <strong>MCP チャットへ自動注入されるAIスコープガード:</strong> {simResult.grant.scope_prompt_guard}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })()}

            {activeSubTab === 'prompts' && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 animate-fadeIn">
                <div className="flex justify-between items-center mb-4">
                    <div>
                        <h2 className="font-semibold text-gray-900">MCP Quick Prompts</h2>
                        <p className="text-xs text-gray-500">
                            Configure globally available quick prompts that appear as suggestion buttons in the MCP Chat.
                        </p>
                    </div>
                    <button
                        onClick={handleSaveSettings}
                        className="px-4 py-2 bg-indigo-500 text-white rounded text-xs font-medium hover:bg-indigo-600 transition-colors shadow-sm"
                    >
                        Save Prompts
                    </button>
                </div>

                <div className="space-y-3 mb-4">
                    {mcpQuickPrompts.map((prompt, index) => (
                        <div key={index} className="flex flex-col gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg relative group">
                            <button
                                onClick={() => setMcpQuickPrompts(prev => prev.filter((_, i) => i !== index))}
                                className="absolute top-2 right-2 w-6 h-6 rounded bg-white border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                                title="Remove prompt"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                            <div>
                                <label className="text-[10px] font-semibold text-gray-500 uppercase">Button Label</label>
                                <input
                                    type="text"
                                    value={prompt.label}
                                    onChange={(e) => {
                                        const newPrompts = [...mcpQuickPrompts];
                                        newPrompts[index].label = e.target.value;
                                        setMcpQuickPrompts(newPrompts);
                                    }}
                                    className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-semibold text-gray-500 uppercase">Prompt</label>
                                <textarea
                                    value={prompt.prompt}
                                    onChange={(e) => {
                                        const newPrompts = [...mcpQuickPrompts];
                                        newPrompts[index].prompt = e.target.value;
                                        setMcpQuickPrompts(newPrompts);
                                    }}
                                    rows={2}
                                    className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
                                />
                            </div>
                        </div>
                    ))}
                    {mcpQuickPrompts.length === 0 && (
                        <div className="text-sm text-gray-400 py-4 text-center italic border-2 border-dashed border-gray-100 rounded-lg">
                            No quick prompts configured.
                        </div>
                    )}
                </div>

                <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-indigo-900 mb-2">Add New Quick Prompt</h4>
                    <div className="flex flex-col gap-2">
                        <input
                            type="text"
                            placeholder="Button Label (e.g., 'Docker Status')"
                            value={newPromptLabel}
                            onChange={(e) => setNewPromptLabel(e.target.value)}
                            className="w-full bg-white border border-indigo-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <textarea
                            placeholder="Prompt text that will be sent to the AI..."
                            value={newPromptText}
                            onChange={(e) => setNewPromptText(e.target.value)}
                            rows={2}
                            className="w-full bg-white border border-indigo-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
                        />
                        <div className="flex justify-end mt-1">
                            <button
                                onClick={() => {
                                    if (!newPromptLabel || !newPromptText) return;
                                    setMcpQuickPrompts([...mcpQuickPrompts, { label: newPromptLabel, prompt: newPromptText }]);
                                    setNewPromptLabel('');
                                    setNewPromptText('');
                                }}
                                disabled={!newPromptLabel || !newPromptText}
                                className="px-3 py-1.5 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                            >
                                Add Prompt
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            )}

            {activeSubTab === 'connections' && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 animate-fadeIn">
                <div className="flex justify-between items-center mb-4">
                    <div>
                        <h2 className="font-semibold text-gray-900">MCP Server Connections & Routing Mode</h2>
                        <p className="text-xs text-gray-500">
                            機密データ用の「🛡️ ZTA Gateway (OAuth A2A認証)」と、公開統計・オープンデータ用の「🌐 Direct Public (Gatewayバイパス直接接続)」をサーバー単位で選択できます。
                        </p>
                    </div>
                    <button
                        onClick={() => handleOpenModal()}
                        className="px-4 py-2 bg-indigo-500 text-white rounded text-xs font-medium hover:bg-indigo-600 transition-colors flex items-center gap-2"
                    >
                        <span>+ Add Server</span>
                    </button>
                </div>
                
                {isLoading ? (
                    <div className="text-sm text-gray-500 py-4 text-center">Loading connections...</div>
                ) : servers.length === 0 ? (
                    <div className="text-sm text-gray-400 py-8 text-center italic border-2 border-dashed border-gray-100 rounded-lg">
                        No MCP servers configured. Add one to enable external tools.
                    </div>
                ) : (
                    <div className="space-y-3">
                        {servers.map(server => (
                            <div key={server.id} className="flex flex-col sm:flex-row justify-between sm:items-center p-3.5 bg-gray-50 border border-gray-200 rounded-lg gap-3">
                                <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[11px] font-mono font-bold text-gray-400">#{server.id}</span>
                                        <h3 className="font-semibold text-sm text-gray-800">{server.name}</h3>
                                        {server.domain_category && (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-medium">
                                                {server.domain_category}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-500 font-mono mt-1">{server.endpoint_url}</p>
                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {renderConnectionModeBadge(server)}
                                        {server.connection_mode !== 'direct_public' && server.connection_mode !== 'builtin_local' && (
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${server.client_id ? 'bg-emerald-100 text-emerald-700 font-medium' : 'bg-gray-200 text-gray-600'}`}>
                                                {server.client_id ? `🔑 OAuth (${server.client_id})` : 'No OAuth Client ID'}
                                            </span>
                                        )}
                                        {server.domain_key && (
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-mono">
                                                domain: {server.domain_key}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <button
                                        onClick={() => handleTestExisting(server.id)}
                                        disabled={testingServerId === server.id}
                                        className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded text-xs font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
                                    >
                                        {testingServerId === server.id ? 'Testing...' : 'Test'}
                                    </button>
                                    <button
                                        onClick={() => handleOpenModal(server)}
                                        className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-xs font-medium hover:bg-gray-50 transition-colors"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => handleDelete(server.id)}
                                        className="px-3 py-1.5 bg-white border border-red-200 text-red-600 rounded text-xs font-medium hover:bg-red-50 transition-colors"
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            )}

            {activeSubTab === 'model' && (
                <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 animate-fadeIn">
                    <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
                        <span className="text-2xl">🤖</span>
                        <div>
                            <h2 className="font-semibold text-gray-900">MCP Agent Model Selection</h2>
                            <p className="text-xs text-gray-500">
                                Select the Gemini model used by the MCP chat agent. Models with high reasoning capacity (e.g., Gemini Pro) are recommended for complex tool execution.
                            </p>
                        </div>
                    </div>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">Active MCP Agent Model (Gemini / Claude)</label>
                            <select
                                value={(currentMcpChatModel || '').replace(/^models\//, '')}
                                onChange={(e) => handleMcpChatModelChange(e.target.value)}
                                className="w-full max-w-md px-3 py-2 border border-gray-300 rounded bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono transition-shadow shadow-sm"
                            >
                                <option value="">Select a model (Default)...</option>
                                <optgroup label="✨ Google Gemini Models">
                                    {models?.map(m => {
                                        const cleanVal = (m.name || '').replace(/^models\//, '');
                                        return (
                                            <option key={`mcp-gem-${cleanVal}`} value={cleanVal}>
                                                ✨ {m.displayName || cleanVal} ({cleanVal})
                                            </option>
                                        );
                                    })}
                                </optgroup>
                                <optgroup label="🟣 Anthropic Claude Models">
                                    {(claudeModels || []).map(m => {
                                        const cleanId = (m.id || m.name || '').replace(/^models\//, '');
                                        return (
                                            <option key={`mcp-claude-${cleanId}`} value={cleanId}>
                                                🟣 {m.displayName || cleanId} ({cleanId})
                                            </option>
                                        );
                                    })}
                                </optgroup>
                            </select>
                        </div>
                        
                        <div className="bg-indigo-50/50 border border-indigo-100 rounded-lg p-4 mt-6">
                            <h4 className="text-xs font-semibold text-indigo-900 mb-1.5 flex items-center gap-1.5">
                                💡 推奨モデルについて (Gemini / Claude 両対応)
                            </h4>
                            <p className="text-xs text-indigo-700/80 leading-relaxed">
                                MCP（Model Context Protocol）は外部サーバーから提供される関数定義を読み取り、適切に引数を解釈して実行する必要があります。高度なツール呼び出しの正確性を確保するため、<strong>Gemini Pro / Flash</strong> または <strong>Claude Sonnet 4.6 / Opus 4.7</strong> の利用を推奨します。
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {activeSubTab === 'harness' && (
                <div className="space-y-6 animate-fadeIn">
                    {/* Phase 2: Dynamic MCP Harness YAML Live Editor & 0-Second Hot-Reload */}
                    <div className="bg-white rounded-lg border border-indigo-200 shadow-sm p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-3 border-b border-gray-200">
                            <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xl">📄</span>
                                    <h2 className="font-bold text-gray-900 text-base">
                                        動的 MCP ハーネス定義 (YAML) エディタ & 0秒ホットリロード
                                    </h2>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-mono font-bold border border-emerald-200">
                                        Hot-Reload Ready ({harnessPath})
                                    </span>
                                </div>
                                <p className="text-xs text-gray-600 mt-1">
                                    新しいMCPサーバー（例: 人事DB、経理DB、外部オープンデータ等）を追加した際、コンテナを再デプロイすることなく、ドメイン分類・発火キーワード・ルーティング指示・公開データ送信ガード（<code className="font-mono text-indigo-700">mcp-harness.yaml</code>）をGUIから直接編集・即時反映できます。
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    type="button"
                                    disabled={!canManageSettings || isSavingHarness}
                                    onClick={handleResetHarnessYaml}
                                    className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium transition-colors border border-gray-300 flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <span>🔄</span>
                                    <span>YAML初期化</span>
                                </button>
                                <button
                                    type="button"
                                    disabled={!canManageSettings || isSavingHarness}
                                    onClick={handleSaveHarnessYaml}
                                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-semibold transition-colors shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <span>⚡</span>
                                    <span>{isSavingHarness ? '反映中...' : '0秒ホットリロード保存'}</span>
                                </button>
                            </div>
                        </div>

                        {harnessStatusMsg && (
                            <div className={`p-3 rounded-lg text-xs font-medium border ${harnessStatusMsg.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                                {harnessStatusMsg.text}
                            </div>
                        )}

                        {/* Active Domains Summary Pills */}
                        {harnessConfig && harnessConfig.domains && (
                            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                                <div className="text-[11px] font-semibold text-slate-600 mb-2 flex items-center justify-between">
                                    <span>現在アクティブなハーネス・ドメイン定義 ({Object.keys(harnessConfig.domains).length} ドメイン)</span>
                                    <span className="text-[10px] font-mono text-slate-400">version: {harnessConfig.version || '1.2'}</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {Object.entries(harnessConfig.domains).map(([key, dom]) => (
                                        <div key={key} className="px-2.5 py-1 bg-white border border-slate-200 rounded-md text-xs flex items-center gap-2 shadow-2xs">
                                            <span className="font-semibold text-slate-800">{dom.category_label || key}</span>
                                            <span className="text-[10px] font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">{key}</span>
                                            <span className="text-[10px] text-slate-400">
                                                {(dom.match_keywords || []).length} keywords
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div>
                            <div className="flex justify-between items-center mb-1.5">
                                <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                                    📝 mcp-harness.yaml ソースコード (YAML)
                                </label>
                                <span className="text-[11px] text-gray-500">
                                    保存するとインメモリキャッシュと永続ボリューム (<code className="font-mono">{harnessPath}</code>) が即時更新されます
                                </span>
                            </div>
                            <textarea
                                disabled={!canManageSettings}
                                value={harnessYaml}
                                onChange={(e) => setHarnessYaml(e.target.value)}
                                rows={16}
                                placeholder="version: '1.2'..."
                                className="w-full bg-[#0f172a] text-sky-300 border border-slate-700 rounded-lg p-3.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500 shadow-inner resize-y disabled:opacity-60"
                                spellCheck={false}
                            />
                        </div>
                    </div>

                    {/* Existing System Instructions & Max Turns Card */}
                    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5 space-y-5">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pb-4 border-b border-gray-200">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xl">🛡️</span>
                                    <h2 className="font-semibold text-gray-900 text-base">MCP Chat Base System Instructions & Max Turns</h2>
                                    <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold border ${canManageSettings ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                        {canManageSettings ? 'Admin Configurable' : 'Read Only (Admin Required)'}
                                    </span>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">
                                    AIモデルがMCPツールを実行してデータ分析やGenUIダッシュボードを生成する際の共通行動原則・制約ルールを一元定義します。
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={!canManageSettings}
                                    onClick={() => {
                                        if (confirm('システム定義のビルトイン・デフォルトハーネス（最新のデータ可視化スケール分離ルール・NPB確定データ・GenUI完全完結規約含む）にリセットしますか？')) {
                                            setMcpChatSystemInstruction(defaultMcpChatSystemInstruction);
                                        }
                                    }}
                                    className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-xs font-medium transition-colors border border-gray-300 flex items-center gap-1.5 disabled:opacity-50"
                                    title="ビルトイン・デフォルト定義に戻す"
                                >
                                    <span>🔄</span>
                                    <span>デフォルトに戻す</span>
                                </button>
                                <button
                                    type="button"
                                    disabled={!canManageSettings}
                                    onClick={handleSaveSettings}
                                    className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-semibold transition-colors shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                                >
                                    <span>💾</span>
                                    <span>システム指示を保存</span>
                                </button>
                            </div>
                        </div>

                        {/* Max Turns Setting */}
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-gray-800">最大ツール実行ターン数 (Max Turns)</span>
                                    <span className="text-xs px-2.5 py-0.5 bg-indigo-100 text-indigo-800 rounded font-mono font-bold">
                                        {mcpChatMaxTurns} ターン
                                    </span>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">
                                    AIがツール（SQL実行やメタカタログ参照）を連続して呼び出せる最大回数です。複雑な複数テーブル比較には 15 ターン以上を推奨します。
                                </p>
                            </div>
                            <div className="flex items-center gap-3 w-full sm:w-auto">
                                <input
                                    type="range"
                                    min="3"
                                    max="30"
                                    step="1"
                                    disabled={!canManageSettings}
                                    value={mcpChatMaxTurns}
                                    onChange={(e) => setMcpChatMaxTurns(parseInt(e.target.value, 10))}
                                    className="w-36 accent-indigo-600 cursor-pointer disabled:opacity-50"
                                />
                                <input
                                    type="number"
                                    min="1"
                                    max="50"
                                    disabled={!canManageSettings}
                                    value={mcpChatMaxTurns}
                                    onChange={(e) => setMcpChatMaxTurns(Math.max(1, parseInt(e.target.value, 10) || 15))}
                                    className="w-16 px-2 py-1 text-xs border border-gray-300 rounded font-mono text-center bg-white disabled:opacity-50"
                                />
                            </div>
                        </div>

                        {/* System Instruction / Harness Editor */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
                                    <span>📝 システム指示・ガイドライン (System Prompt & Constraints)</span>
                                    <span className="text-[10px] text-gray-400 font-normal">
                                        ({(mcpChatSystemInstruction !== '' ? mcpChatSystemInstruction : defaultMcpChatSystemInstruction || '').length} 文字)
                                    </span>
                                </label>
                                <span className="text-[11px] text-indigo-600 font-medium">
                                    ※ 未編集（空欄）の場合は自動的にビルトイン・デフォルトハーネスが適用されます
                                </span>
                            </div>
                            <textarea
                                disabled={!canManageSettings}
                                value={mcpChatSystemInstruction !== '' ? mcpChatSystemInstruction : defaultMcpChatSystemInstruction}
                                onChange={(e) => setMcpChatSystemInstruction(e.target.value)}
                                rows={14}
                                placeholder="ハーネス指示を入力してください..."
                                className="w-full bg-[#1e1e1e] text-emerald-300 border border-gray-700 rounded-lg p-3 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-inner resize-y selection:bg-indigo-900 disabled:opacity-60"
                                spellCheck={false}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-fadeIn p-4">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
                        <div className="px-6 py-4 border-b border-gray-100">
                            <h3 className="font-semibold text-lg text-gray-900">
                                {editingServer ? 'Edit MCP Server Connection' : 'Add MCP Server Connection'}
                            </h3>
                        </div>
                        <div className="p-6 space-y-4 overflow-y-auto">
                            <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">Server Name *</label>
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                                    placeholder="e.g. NPB公式記録オープンデータ / 人事労務MCPサーバー"
                                    className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">SSE Endpoint URL *</label>
                                <input
                                    type="text"
                                    value={formData.endpoint_url}
                                    onChange={(e) => setFormData({...formData, endpoint_url: e.target.value})}
                                    placeholder="http://localhost:8085/sse"
                                    className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                />
                            </div>

                            {/* Phase 3: Connection Routing Mode Selector */}
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                                    通信・認証ルーティング方式 (Connection Mode) *
                                </label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, connection_mode: 'zta_gateway'})}
                                        className={`p-3 rounded-lg border text-left transition-all ${
                                            formData.connection_mode === 'zta_gateway'
                                                ? 'bg-indigo-50 border-indigo-500 ring-2 ring-indigo-500/20'
                                                : 'bg-white border-gray-200 hover:bg-gray-50'
                                        }`}
                                    >
                                        <div className="flex items-center gap-1.5 font-bold text-xs text-indigo-950">
                                            <span>🛡️</span>
                                            <span>ZTA Gateway 経由 (OAuth A2A)</span>
                                        </div>
                                        <p className="text-[11px] text-gray-600 mt-1 leading-snug">
                                            社内DB・人事・機密データ向け。JWTトークンの自動取得・サイレントリフレッシュとゼロトラスト認可を強制します。
                                        </p>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, connection_mode: 'direct_public'})}
                                        className={`p-3 rounded-lg border text-left transition-all ${
                                            formData.connection_mode === 'direct_public'
                                                ? 'bg-sky-50 border-sky-500 ring-2 ring-sky-500/20'
                                                : 'bg-white border-gray-200 hover:bg-gray-50'
                                        }`}
                                    >
                                        <div className="flex items-center gap-1.5 font-bold text-xs text-sky-950">
                                            <span>🌐</span>
                                            <span>Direct Public (公開データ直接接続)</span>
                                        </div>
                                        <p className="text-[11px] text-gray-600 mt-1 leading-snug">
                                            e-Stat・NPB等の公開データ向け。ZTA Gateway認証をバイパスして高速直結し、社内機密の外部送信防止ガードを適用します。
                                        </p>
                                    </button>
                                </div>
                            </div>

                            {/* Domain Key Mapping */}
                            <div>
                                <label className="block text-xs font-medium text-gray-700 mb-1">
                                    ハーネス・ドメイン分類 (Domain Key)
                                </label>
                                <select
                                    value={formData.domain_key || ''}
                                    onChange={(e) => setFormData({...formData, domain_key: e.target.value})}
                                    className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                >
                                    {DOMAIN_KEY_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Conditional OAuth Fields vs Direct Public Info Banner */}
                            {formData.connection_mode === 'direct_public' ? (
                                <div className="p-3.5 bg-sky-50 border border-sky-200 rounded-lg text-xs text-sky-900 space-y-1">
                                    <div className="font-bold flex items-center gap-1.5">
                                        <span>🌐</span>
                                        <span>公開データ直接接続モード (ZTA Gateway バイパス有効)</span>
                                    </div>
                                    <p className="text-[11px] text-sky-800 leading-relaxed">
                                        OAuth トークン交換（Client ID / Secret）を行わず、SSE エンドポイントへ直接接続します。同時に <code className="font-mono">mcp-harness.yaml</code> の <code className="font-mono">public_direct_guard</code> が自動適用され、クエリ引数への社内機密・個人情報の混入を遮断します。
                                    </p>
                                </div>
                            ) : (
                                <div className="pt-2 border-t border-gray-100">
                                    <div className="flex items-center gap-2 mb-3">
                                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">OAuth A2A Authentication (ZTA Gateway)</h4>
                                        <button 
                                            type="button"
                                            onClick={() => setShowHelp(!showHelp)}
                                            className="w-5 h-5 rounded-full bg-gray-200 text-gray-500 hover:bg-indigo-100 hover:text-indigo-600 flex items-center justify-center text-xs font-bold transition-colors"
                                            title="About API Keys & Scopes"
                                        >
                                            ?
                                        </button>
                                    </div>
                                    
                                    {showHelp && (
                                        <div className="mb-4 bg-indigo-50/80 p-3 rounded-lg border border-indigo-100/50 shadow-inner animate-fadeIn">
                                            <h4 className="text-xs font-semibold text-indigo-900 mb-1 flex items-center gap-1">
                                                API Key (Client ID) とユニバーサルロール権限について
                                            </h4>
                                            <ul className="text-[11px] text-indigo-700/80 space-y-1 list-disc list-inside ml-1">
                                                <li><strong>ZTA Gateway 連携</strong>：MCP側で発行された Client ID / Secret により JWT 認証を行います。</li>
                                                <li><strong>ユニバーサル・ロールビルダー連携</strong>：同一のMCPサーバーであっても、「ZTA ロール＆権限ビルダー」タブ側でロールごとに Read-Only / Read-Write や禁止テーブル（給与カラム等）を動的に分離できます。</li>
                                            </ul>
                                        </div>
                                    )}
                                    <div className="space-y-3">
                                        <div>
                                            <label className="block text-xs font-medium text-gray-700 mb-1">Token URL</label>
                                            <input
                                                type="text"
                                                value={formData.token_url}
                                                onChange={(e) => setFormData({...formData, token_url: e.target.value})}
                                                placeholder="http://localhost:8085/oauth/token"
                                                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-700 mb-1">Client ID</label>
                                            <input
                                                type="text"
                                                value={formData.client_id}
                                                onChange={(e) => setFormData({...formData, client_id: e.target.value})}
                                                placeholder="client-id"
                                                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-700 mb-1">Client Secret</label>
                                            <input
                                                type="password"
                                                value={formData.client_secret}
                                                onChange={(e) => setFormData({...formData, client_secret: e.target.value})}
                                                placeholder={editingServer ? "******** (Leave blank to keep existing)" : "client-secret"}
                                                className="w-full px-3 py-2 bg-white text-gray-900 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        {testResult && (
                            <div className={`px-6 py-3 border-t text-sm font-medium ${testResult.success ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-red-50 text-red-700 border-red-100'}`}>
                                {testResult.success ? '✅ ' : '❌ '}
                                {testResult.message}
                            </div>
                        )}
                        <div className="px-6 py-4 bg-gray-50 flex justify-between gap-3 rounded-b-xl">
                            <div>
                                <button
                                    onClick={handleTestConnection}
                                    disabled={isTesting || !formData.endpoint_url}
                                    className="px-4 py-2 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 transition-colors flex items-center gap-2"
                                >
                                    {isTesting ? (
                                        <>
                                            <svg className="animate-spin h-4 w-4 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                            Testing...
                                        </>
                                    ) : (
                                        'Test Connection'
                                    )}
                                </button>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleCloseModal}
                                    className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium hover:bg-indigo-600 shadow-sm"
                                >
                                    Save Connection
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default McpConnectionsTab;
