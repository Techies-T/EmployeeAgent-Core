import React, { useState, useEffect } from 'react';

const RESOURCE_TYPE_OPTIONS = [
    { value: 'mcp_server', label: '🔌 MCP サーバー / データベース権限', icon: '🔌', badgeCls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
    { value: 'widget', label: '🧩 AI ウィジェット / アプリ機能権限', icon: '🧩', badgeCls: 'bg-sky-50 text-sky-700 border-sky-200' },
    { value: 'organization_pod', label: '🏢 組織・部門 Pod データスコープ', icon: '🏢', badgeCls: 'bg-purple-50 text-purple-700 border-purple-200' },
    { value: 'knowledge_space', label: '📚 ナレッジ・RAG フォルダ権限', icon: '📚', badgeCls: 'bg-amber-50 text-amber-800 border-amber-200' },
    { value: 'system_governance', label: '⚙️ システム管理・ガバナンスタスク', icon: '⚙️', badgeCls: 'bg-emerald-50 text-emerald-800 border-emerald-200' }
];

const OPERATION_LEVEL_OPTIONS = [
    {
        value: 'read_only',
        label: '👁️ 参照のみ (Read-Only)',
        short: '参照のみ',
        desc: 'SELECT検索・集計・過去履歴の閲覧のみ許可。DB更新(write_query)や新規ジョブ実行を遮断',
        cls: 'bg-sky-50 text-sky-700 border-sky-200'
    },
    {
        value: 'execute',
        label: '⚡ 実行・分析 (Execute)',
        short: '実行・分析',
        desc: 'AI分析・調査ジョブ実行・標準ツールの実行を許可',
        cls: 'bg-indigo-50 text-indigo-700 border-indigo-200'
    },
    {
        value: 'read_write',
        label: '✏️ 作成・更新可 (Read/Write)',
        short: '作成・更新可',
        desc: 'DB更新クエリ(write_query)や公式ナレッジベースへの新規登録・更新を許可',
        cls: 'bg-amber-50 text-amber-800 border-amber-300'
    },
    {
        value: 'admin',
        label: '🛠️ 管理・全権限 (Admin)',
        short: '管理',
        desc: 'サーバー接続管理・ハーネス定義更新・テーブル管理を含むフル権限',
        cls: 'bg-emerald-50 text-emerald-800 border-emerald-300'
    }
];

const DATA_SCOPE_OPTIONS = [
    { value: 'all_company', label: '🏢 全社・全データ (All Company / 全12球団)', cls: 'bg-slate-100 text-slate-800 border-slate-300' },
    { value: 'department_pod', label: '👥 所属部門・担当Pod限定 (Department / 特定球団スコープ)', cls: 'bg-purple-50 text-purple-800 border-purple-200' },
    { value: 'own_only', label: '👤 自分のデータのみ (Own Data Only)', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
    { value: 'public_summary', label: '🌐 公開・統計サマリーのみ (Public / 個人情報除外)', cls: 'bg-teal-50 text-teal-800 border-teal-200' }
];

const WIDGET_META = {
    gemini: { name: 'ノーマルチャット (AI Assistant)', icon: '💬' },
    'mcp-chat': { name: 'MCP クライアント (Tool Agent)', icon: '🔌' },
    'knowledge-base': { name: 'ナレッジ & RAG ブリーフィング', icon: '📚' },
    'deep-research': { name: 'DeepResearch & 図解エージェント', icon: '🔬' },
    'virtual-office': { name: 'バーチャルオフィス & Pod', icon: '🏢' },
    'live-concierge': { name: 'Live Concierge (音声対話)', icon: '🎙️' },
    finder: { name: 'Finder (Google Drive)', icon: '📁' },
    browser: { name: 'セキュアブラウザ', icon: '🌐' },
    'html-editor': { name: 'HTMLエディタ', icon: '📝' },
    notes: { name: 'メモ', icon: '🗒️' },
    calculator: { name: '計算機', icon: '🧮' },
    calendar: { name: 'カレンダー', icon: '📅' },
    stickies: { name: '付箋', icon: '📌' },
    'app-monitor': { name: 'サーバーモニター', icon: '📡' }
};

const SYSTEM_GOVERNANCE_RESOURCES = [
    { id: 'manage_settings', label: 'システム基本設定・MCP接続/ハーネス管理' },
    { id: 'manage_roles', label: 'ZTA ロール・権限ポリシー管理' },
    { id: 'manage_users', label: 'ユーザー・ロール割当管理' },
    { id: 'invite_users', label: '新規ユーザー招待' },
    { id: 'manage_rag_folders', label: 'RAG ナレッジフォルダ構成管理' },
    { id: '*', label: '全システム管理権限 (*)' }
];

const MODEL_PERMISSION_CHOICES = [
    { id: 'model:gemini-flash', label: '✨ Gemini Flash シリーズ (3.8 Flash 等・高速標準)' },
    { id: 'model:gemini-pro', label: '✨ Gemini Pro / Gen-4 シリーズ (Pro / Argon / Carbon 等・高度推論)' },
    { id: 'model:claude-sonnet', label: '🟣 Claude Sonnet / Haiku シリーズ (Sonnet 5.5 等・MCP標準分析)' },
    { id: 'model:claude-opus', label: '🟣 Claude Opus / Fable シリーズ (Opus 5.5 / Fable 5.5 等・最高峰詳細分析)' },
    { id: 'model:nano-banana', label: '🎨 Nano Banana / Image シリーズ (画像・図解生成)' }
];

const ZtaPolicyMatrixTab = ({
    installedWidgets = [],
    ragFolders = [],
    onPoliciesUpdated,
    onNavigateTab
}) => {
    const [pdpPolicies, setPdpPolicies] = useState({});
    const [presets, setPresets] = useState({});
    const [mcpServers, setMcpServers] = useState([]);
    const [pods, setPods] = useState([]);
    const [selectedRoleKey, setSelectedRoleKey] = useState('admin');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveBanner, setSaveBanner] = useState('');

    // New Role Creation form
    const [showNewRoleModal, setShowNewRoleModal] = useState(false);
    const [newRoleKey, setNewRoleKey] = useState('');
    const [newRoleLabel, setNewRoleLabel] = useState('');
    const [newRoleDesc, setNewRoleDesc] = useState('');

    // Preset Role Template Picker Drawer (AWS/GCP IAM-style search & category filter, hidden by default)
    const [showPresetDrawer, setShowPresetDrawer] = useState(false);
    const [templateSearchQuery, setTemplateSearchQuery] = useState('');
    const [templateCategoryFilter, setTemplateCategoryFilter] = useState('all');

    // Left Pane Defined Roles Search
    const [roleSearchQuery, setRoleSearchQuery] = useState('');
    const [serverInstalledWidgets, setServerInstalledWidgets] = useState([]);

    // New Permission Grant Builder state
    const [showAddGrantForm, setShowAddGrantForm] = useState(false);
    const [draftGrant, setDraftGrant] = useState({
        resource_type: 'mcp_server',
        resource_id: '*',
        operation_level: 'read_only',
        data_scope: 'all_company',
        restricted_identifiers: '',
        blocked_tools: '',
        scope_prompt_guard: ''
    });

    const fetchPdpAll = async () => {
        setLoading(true);
        try {
            const [pdpRes, mcpRes, podsRes] = await Promise.all([
                fetch('/api/core/pdp').then(r => r.json()).catch(() => ({})),
                fetch('/api/mcp/servers').then(r => r.json()).catch(() => []),
                fetch('/api/pods').then(r => r.json()).catch(() => ({}))
            ]);
            const loadedPolicies = pdpRes.pdp || pdpRes.policies || {};
            setPdpPolicies(loadedPolicies);
            if (pdpRes.presets || pdpRes.rolePresets) {
                setPresets(pdpRes.presets || pdpRes.rolePresets);
            }
            if (Array.isArray(pdpRes.installedWidgets)) {
                setServerInstalledWidgets(pdpRes.installedWidgets);
            }
            if (Array.isArray(mcpRes) && mcpRes.length > 0) setMcpServers(mcpRes);
            else if (Array.isArray(pdpRes.mcpServers)) setMcpServers(pdpRes.mcpServers);
            if (Array.isArray(podsRes.pods)) setPods(podsRes.pods);
            else if (Array.isArray(pdpRes.pods)) setPods(pdpRes.pods);

            const keys = Object.keys(loadedPolicies);
            if (keys.length > 0 && !loadedPolicies[selectedRoleKey]) {
                setSelectedRoleKey(keys.includes('user') ? 'user' : keys[0]);
            }
        } catch (err) {
            console.error('Failed to load ZTA PDP data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPdpAll();
    }, []);

    const savePdpToServer = async (updatedPdp, bannerMsg = 'ロール権限ポリシーを保存しました') => {
        setSaving(true);
        setPdpPolicies(updatedPdp);
        try {
            const res = await fetch('/api/core/pdp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdp: updatedPdp })
            });
            const data = await res.json();
            if (res.ok && data.pdp) {
                setPdpPolicies(data.pdp);
                if (onPoliciesUpdated && data.rbacPolicies) {
                    onPoliciesUpdated(data.rbacPolicies);
                }
                setSaveBanner(bannerMsg);
                setTimeout(() => setSaveBanner(''), 3000);
            }
        } catch (err) {
            console.error('Failed to save ZTA PDP:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleApplyRolePreset = async (presetKey) => {
        if (!presetKey) return;
        setSaving(true);
        try {
            const res = await fetch('/api/core/pdp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ applyPresetKey: presetKey })
            });
            const data = await res.json();
            if (res.ok && data.pdp) {
                setPdpPolicies(data.pdp);
                setSelectedRoleKey(presetKey);
                if (onPoliciesUpdated && data.rbacPolicies) {
                    onPoliciesUpdated(data.rbacPolicies);
                }
                setSaveBanner(`テンプレート「${presets[presetKey]?.displayName || presetKey}」を追加・有効化しました`);
                setTimeout(() => setSaveBanner(''), 3500);
            }
        } catch (err) {
            console.error('Failed to apply preset:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleCreateCustomRole = () => {
        const key = newRoleKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        if (!key) return;
        if (pdpPolicies[key]) {
            alert('そのロールIDは既に存在します。別のIDを指定してください。');
            return;
        }
        const label = newRoleLabel.trim() || key;
        const desc = newRoleDesc.trim() || 'カスタム作成ロール';
        const initialGrants = [
            {
                id: `grant_widget_gemini_${Date.now()}`,
                resource_type: 'widget',
                resource_id: 'gemini',
                resource_label: 'ノーマルチャット (AI Assistant)',
                operation_level: 'execute',
                data_scope: 'all_company',
                constraints: { restricted_identifiers: [], blocked_tools: [], scope_prompt_guard: '' }
            }
        ];
        const updatedPdp = {
            ...pdpPolicies,
            [key]: {
                roleCategory: 'custom',
                label,
                displayName: label,
                description: desc,
                grants: initialGrants,
                _grantsAuthoritative: true,
                widget_levels: { gemini: 'execute' },
                allowed_models: ['model:gemini-flash', 'model:gemini-pro', 'model:claude-sonnet']
            }
        };
        savePdpToServer(updatedPdp, `新規ロール「${label} (${key})」を作成しました`);
        setSelectedRoleKey(key);
        setNewRoleKey('');
        setNewRoleLabel('');
        setNewRoleDesc('');
        setShowNewRoleModal(false);
    };

    const handleDeleteRole = (roleKey) => {
        if (roleKey === 'admin' || roleKey === 'user') return;
        const roleName = pdpPolicies[roleKey]?.label || roleKey;
        if (!window.confirm(`ロール「${roleName} (${roleKey})」を削除しますか？`)) return;
        const next = { ...pdpPolicies };
        delete next[roleKey];
        const remainingKeys = Object.keys(next);
        if (selectedRoleKey === roleKey) {
            setSelectedRoleKey(remainingKeys[0] || 'admin');
        }
        savePdpToServer(next, `ロール「${roleName}」を削除しました`);
    };

    const resolveResourceLabel = (resourceType, resourceId) => {
        const idStr = String(resourceId);
        if (resourceType === 'mcp_server') {
            if (idStr === '*') return '全 MCP サーバー (*)';
            const found = mcpServers.find(s => String(s.id) === idStr);
            return found ? `[#${found.id}] ${found.name}` : `MCP サーバー #${idStr}`;
        }
        if (resourceType === 'widget') {
            if (idStr === '*') return '全 AI ウィジェット (*)';
            return WIDGET_META[idStr]?.name || idStr;
        }
        if (resourceType === 'organization_pod') {
            if (idStr === '*') return '全社・全部門 Pod (*)';
            const found = pods.find(p => String(p.id) === idStr);
            return found ? `Pod: ${found.name} (${found.id})` : `Pod: ${idStr}`;
        }
        if (resourceType === 'knowledge_space') {
            if (idStr === '*') return '全 RAG ナレッジフォルダ (*)';
            const found = (ragFolders || []).find(f => String(f.id) === idStr);
            return found ? `RAG フォルダ: ${found.name || found.id}` : `RAG フォルダ: ${idStr}`;
        }
        if (resourceType === 'system_governance') {
            const found = SYSTEM_GOVERNANCE_RESOURCES.find(r => r.id === idStr);
            return found ? found.label : idStr;
        }
        return idStr;
    };

    const handleAddGrantToRole = () => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentGrants = Array.isArray(currentRole.grants) ? [...currentRole.grants] : [];

        const newGrant = {
            id: `grant_${draftGrant.resource_type}_${draftGrant.resource_id}_${Date.now()}`,
            resource_type: draftGrant.resource_type,
            resource_id: String(draftGrant.resource_id),
            resource_label: resolveResourceLabel(draftGrant.resource_type, draftGrant.resource_id),
            operation_level: draftGrant.operation_level,
            data_scope: draftGrant.data_scope,
            constraints: {
                restricted_identifiers: draftGrant.restricted_identifiers
                    ? draftGrant.restricted_identifiers.split(',').map(s => s.trim()).filter(Boolean)
                    : [],
                blocked_tools: draftGrant.blocked_tools
                    ? draftGrant.blocked_tools.split(',').map(s => s.trim()).filter(Boolean)
                    : (draftGrant.operation_level === 'read_only' && draftGrant.resource_type === 'mcp_server'
                        ? ['write_query', 'drop_table']
                        : []),
                scope_prompt_guard: draftGrant.scope_prompt_guard.trim(),
                allowed_tasks: draftGrant.operation_level === 'read_write' || draftGrant.operation_level === 'admin'
                    ? ['publish_knowledge']
                    : []
            }
        };

        // Replace existing grant if same resource_type + resource_id, otherwise append
        const existingIdx = currentGrants.findIndex(
            g => g.resource_type === newGrant.resource_type && String(g.resource_id) === String(newGrant.resource_id)
        );
        if (existingIdx >= 0) {
            currentGrants[existingIdx] = newGrant;
        } else {
            currentGrants.push(newGrant);
        }

        const updatedRole = {
            ...currentRole,
            grants: currentGrants,
            _grantsAuthoritative: true
        };

        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: updatedRole
        }, `権限ルール「${newGrant.resource_label}」を付与しました`);

        setShowAddGrantForm(false);
        setDraftGrant({
            resource_type: 'mcp_server',
            resource_id: '*',
            operation_level: 'read_only',
            data_scope: 'all_company',
            restricted_identifiers: '',
            blocked_tools: '',
            scope_prompt_guard: ''
        });
    };

    const handleUpdateGrantField = (grantId, updater) => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentGrants = Array.isArray(currentRole.grants) ? [...currentRole.grants] : [];
        const updatedGrants = currentGrants.map(g => {
            if (g.id !== grantId) return g;
            return updater(g);
        });

        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: {
                ...currentRole,
                grants: updatedGrants,
                _grantsAuthoritative: true
            }
        });
    };

    const handleRemoveGrant = (grantId) => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentGrants = Array.isArray(currentRole.grants) ? currentRole.grants : [];
        const updatedGrants = currentGrants.filter(g => g.id !== grantId);

        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: {
                ...currentRole,
                grants: updatedGrants,
                _grantsAuthoritative: true
            }
        }, '権限ルールを削除しました');
    };

    const handleWidgetQuickLevelChange = (widgetId, newWidgetLevel) => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentGrants = Array.isArray(currentRole.grants) ? [...currentRole.grants] : [];

        const filteredGrants = currentGrants.filter(
            g => !(g.resource_type === 'widget' && g.resource_id === widgetId)
        );

        if (newWidgetLevel !== 'none') {
            const opLevel = newWidgetLevel === 'manage'
                ? 'admin'
                : newWidgetLevel === 'execute'
                    ? 'execute'
                    : 'read_only';
            filteredGrants.push({
                id: `grant_widget_${widgetId}`,
                resource_type: 'widget',
                resource_id: widgetId,
                resource_label: resolveResourceLabel('widget', widgetId),
                operation_level: opLevel,
                data_scope: 'all_company',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: '',
                    allowed_tasks: newWidgetLevel === 'manage' ? ['publish_knowledge'] : []
                }
            });
        }

        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: {
                ...currentRole,
                widget_levels: {
                    ...(currentRole.widget_levels || {}),
                    [widgetId]: newWidgetLevel
                },
                grants: filteredGrants,
                _grantsAuthoritative: true
            }
        });
    };

    const handleToggleAllowedModel = (modelId) => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentModels = Array.isArray(currentRole.allowed_models) ? [...currentRole.allowed_models] : [];
        const nextModels = currentModels.includes(modelId)
            ? currentModels.filter(m => m !== modelId)
            : [...currentModels, modelId];
        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: {
                ...currentRole,
                allowed_models: nextModels.length > 0 ? nextModels : ['model:gemini-flash']
            }
        });
    };

    const handlePodQuickScopeChange = (podId, newScopeLevel) => {
        if (!selectedRoleKey || selectedRoleKey === 'admin') return;
        const currentRole = pdpPolicies[selectedRoleKey] || {};
        const currentGrants = Array.isArray(currentRole.grants) ? [...currentRole.grants] : [];

        const filteredGrants = currentGrants.filter(
            g => !(g.resource_type === 'organization_pod' && String(g.resource_id) === String(podId))
        );

        const nextPodScopes = { ...(currentRole.pod_scopes || {}) };
        if (newScopeLevel === 'none') {
            delete nextPodScopes[podId];
        } else {
            nextPodScopes[podId] = newScopeLevel;
            const opLevel = newScopeLevel === 'manage'
                ? 'admin'
                : newScopeLevel === 'write'
                    ? 'read_write'
                    : 'read_only';
            filteredGrants.push({
                id: `grant_pod_${podId}`,
                resource_type: 'organization_pod',
                resource_id: String(podId),
                resource_label: resolveResourceLabel('organization_pod', podId),
                operation_level: opLevel,
                data_scope: podId === '*' ? 'all_company' : podId === 'public' ? 'public_summary' : 'department_pod',
                constraints: {
                    restricted_identifiers: [],
                    blocked_tools: [],
                    scope_prompt_guard: '',
                    allowed_tasks: newScopeLevel === 'write' || newScopeLevel === 'manage' ? ['publish_knowledge'] : ['rag_chat']
                }
            });
        }

        const nextAllowedPods = Object.entries(nextPodScopes)
            .filter(([, perm]) => perm && perm !== 'none')
            .map(([id]) => id);

        savePdpToServer({
            ...pdpPolicies,
            [selectedRoleKey]: {
                ...currentRole,
                pod_scopes: nextPodScopes,
                allowed_pods: nextAllowedPods,
                grants: filteredGrants,
                _grantsAuthoritative: true
            }
        }, `Pod「${podId}」のナレッジアクセス権限を「${newScopeLevel}」に更新しました`);
    };

    const propInstalledIds = (installedWidgets || []).map(w => typeof w === 'string' ? w : w.id);
    const apiInstalledIds = (serverInstalledWidgets || []).map(w => typeof w === 'string' ? w : w.id);
    const activeWidgetIds = propInstalledIds.length > 0
        ? propInstalledIds
        : apiInstalledIds.length > 0
            ? apiInstalledIds
            : ['gemini', 'mcp-chat', 'knowledge-base'];

    const roleKeys = Object.keys(pdpPolicies);
    const filteredRoleKeys = roleKeys.filter(rKey => {
        if (!roleSearchQuery.trim()) return true;
        const q = roleSearchQuery.trim().toLowerCase();
        const rObj = pdpPolicies[rKey] || {};
        const hay = `${rKey} ${rObj.label || ''} ${rObj.displayName || ''} ${rObj.description || ''}`.toLowerCase();
        return hay.includes(q);
    });

    const filteredPresetEntries = Object.entries(presets).filter(([key, tpl]) => {
        if (templateCategoryFilter !== 'all') {
            if (templateCategoryFilter === 'mcp' && tpl.roleCategory !== 'mcp' && tpl.roleCategory !== 'mcp_sample' && !(tpl.tags || []).includes('MCP')) {
                return false;
            }
            if (templateCategoryFilter === 'knowledge_pod' && tpl.roleCategory !== 'knowledge_pod' && !(tpl.tags || []).includes('Pod') && !(tpl.tags || []).includes('Knowledge')) {
                return false;
            }
            if (templateCategoryFilter === 'domain' && !['hr_domain', 'mcp_sample', 'business'].includes(tpl.roleCategory)) {
                return false;
            }
            if (templateCategoryFilter === 'widget' && tpl.roleCategory !== 'widget_task') {
                return false;
            }
        }
        if (!templateSearchQuery.trim()) return true;
        const q = templateSearchQuery.trim().toLowerCase();
        const tagStr = Array.isArray(tpl.tags) ? tpl.tags.join(' ') : '';
        const hay = `${key} ${tpl.displayName || ''} ${tpl.description || ''} ${tpl.roleCategory || ''} ${tagStr}`.toLowerCase();
        return hay.includes(q);
    });

    const activeRole = pdpPolicies[selectedRoleKey] || {};
    const isAdminRole = selectedRoleKey === 'admin';
    const isProtectedCoreRole = ['admin', 'user', 'guest', 'manager'].includes(selectedRoleKey);
    const activeGrants = Array.isArray(activeRole.grants) ? activeRole.grants : [];

    return (
        <div className="space-y-5">
            {/* Top Header Banner */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-xl">🛡️</span>
                            <h2 className="font-bold text-base text-gray-900">
                                ZTA 汎用ロール・権限ビルダー (Universal Permission Grant Model)
                            </h2>
                            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                                MCP・ウィジェット・ナレッジ・Pod 統合制御
                            </span>
                            {saving && (
                                <span className="text-xs text-indigo-600 font-semibold animate-pulse">保存中...</span>
                            )}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                            左下の基本ロール（<strong>Admin / Manager / General_User / Guest</strong>）を選択して右下で権限ルール（対象リソース × 操作レベル × データスコープ × カラム/ツール制約）を編集するか、右上のボタンから<strong>プリセット検索</strong>または<strong>新規カスタムロール作成</strong>を行えます。
                        </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <button
                            type="button"
                            onClick={() => {
                                setShowPresetDrawer(!showPresetDrawer);
                                if (!showPresetDrawer) setShowNewRoleModal(false);
                            }}
                            className={`px-3.5 py-2 rounded-lg text-xs font-bold border shadow-xs cursor-pointer transition flex items-center gap-1.5 ${
                                showPresetDrawer
                                    ? 'bg-slate-800 text-white border-slate-900'
                                    : 'bg-white hover:bg-slate-50 text-slate-700 border-gray-300'
                            }`}
                        >
                            <span>🔍</span>
                            <span>プリセット・テンプレートから追加 ({Object.keys(presets).length})</span>
                            <span className="text-[10px]">{showPresetDrawer ? '▲' : '▼'}</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setShowNewRoleModal(!showNewRoleModal);
                                if (!showNewRoleModal) setShowPresetDrawer(false);
                            }}
                            className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition"
                        >
                            ＋ 新規カスタムロール作成
                        </button>
                    </div>
                </div>

                {saveBanner && (
                    <div className="mt-3 px-3.5 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center justify-between">
                        <span>✅ {saveBanner}</span>
                        <button type="button" onClick={() => setSaveBanner('')} className="text-emerald-600 hover:text-emerald-900 cursor-pointer">✕</button>
                    </div>
                )}

                {/* Inline New Role Modal / Collapse */}
                {showNewRoleModal && (
                    <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-indigo-200 space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="font-bold text-xs text-indigo-950">✨ 新規カスタムロールの作成</h3>
                            <button type="button" onClick={() => setShowNewRoleModal(false)} className="text-xs text-gray-500 hover:text-gray-800 cursor-pointer">✕ 閉じる</button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                                <label className="block text-[11px] font-semibold text-gray-700 mb-1">ロールID (英数字・アンダースコア)</label>
                                <input
                                    type="text"
                                    value={newRoleKey}
                                    onChange={(e) => setNewRoleKey(e.target.value)}
                                    placeholder="例: npb_team_director"
                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-mono bg-white"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-semibold text-gray-700 mb-1">ロール表示名</label>
                                <input
                                    type="text"
                                    value={newRoleLabel}
                                    onChange={(e) => setNewRoleLabel(e.target.value)}
                                    placeholder="例: 球団編成部長"
                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white"
                                />
                            </div>
                            <div>
                                <label className="block text-[11px] font-semibold text-gray-700 mb-1">説明・用途</label>
                                <input
                                    type="text"
                                    value={newRoleDesc}
                                    onChange={(e) => setNewRoleDesc(e.target.value)}
                                    placeholder="例: NPBデータの参照のみ許可（投手査定・年俸カラムは除外）"
                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={handleCreateCustomRole}
                                disabled={!newRoleKey.trim()}
                                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg text-xs font-bold cursor-pointer"
                            >
                                ロールを作成して権限を設定する
                            </button>
                        </div>
                    </div>
                )}

                {/* Collapsible AWS / GCP IAM-Style Preset Role Template Catalog */}
                {showPresetDrawer && (
                    <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div>
                                <h3 className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                                    <span>⚡ プリセット・権限テンプレートカタログ (AWS / GCP IAM 方式フィルタ)</span>
                                    <span className="px-2 py-0.5 text-[10px] rounded-full bg-indigo-100 text-indigo-800 font-semibold">
                                        インストール済みウィジェット連動 ({activeWidgetIds.join(', ')})
                                    </span>
                                </h3>
                                <p className="text-[11px] text-gray-500 mt-0.5">
                                    キーワード（例: <code className="px-1 py-0.5 bg-white border rounded">MCP</code>, <code className="px-1 py-0.5 bg-white border rounded">NPB</code>, <code className="px-1 py-0.5 bg-white border rounded">球団編成部長</code>, <code className="px-1 py-0.5 bg-white border rounded">人事</code>）で検索し、必要なときだけ左下の定義済みロール一覧へ追加できます。※未インストールのウィジェット専用テンプレート（DeepResearch等）は自動的に非表示になります。
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowPresetDrawer(false)}
                                className="text-xs text-gray-500 hover:text-gray-800 shrink-0 cursor-pointer"
                            >
                                ✕ カタログを隠す
                            </button>
                        </div>

                        {/* Search Bar + Category Filter Pills */}
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 pt-1">
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    value={templateSearchQuery}
                                    onChange={(e) => setTemplateSearchQuery(e.target.value)}
                                    placeholder="🔍 プリセットを検索 (例: MCP, NPB, 球団編成部長, 人事, Read-Only, デジタル庁...)"
                                    className="w-full pl-3 pr-8 py-1.5 bg-white border border-gray-300 rounded-lg text-xs focus:outline-none focus:border-indigo-500"
                                />
                                {templateSearchQuery && (
                                    <button
                                        type="button"
                                        onClick={() => setTemplateSearchQuery('')}
                                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-700 cursor-pointer"
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center gap-1 flex-wrap">
                                {[
                                    { id: 'all', label: 'すべて' },
                                    { id: 'mcp', label: '🔌 MCP サーバー権限' },
                                    { id: 'knowledge_pod', label: '📚 ナレッジ & Pod 権限' },
                                    { id: 'domain', label: '🏢 部門・業務検証 (人事 / NPB / 行政)' },
                                    ...(activeWidgetIds.includes('deep-research')
                                        ? [{ id: 'widget', label: '🧩 DeepResearch・ウィジェット' }]
                                        : [])
                                ].map(tab => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        onClick={() => setTemplateCategoryFilter(tab.id)}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition border ${
                                            templateCategoryFilter === tab.id
                                                ? 'bg-indigo-600 text-white border-indigo-600'
                                                : 'bg-white hover:bg-gray-100 text-gray-700 border-gray-300'
                                        }`}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Filtered Preset Template List */}
                        {filteredPresetEntries.length === 0 ? (
                            <div className="p-6 text-center bg-white rounded-lg border border-gray-200 text-xs text-gray-400">
                                条件に一致するプリセット・テンプレートが見つかりません。検索ワードを変更してください。
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-h-72 overflow-y-auto pr-1">
                                {filteredPresetEntries.map(([key, tpl]) => {
                                    const alreadyExists = Boolean(pdpPolicies[key]);
                                    return (
                                        <div
                                            key={key}
                                            className={`p-3 rounded-lg border bg-white flex flex-col justify-between gap-2 transition ${
                                                selectedRoleKey === key
                                                    ? 'border-indigo-500 ring-1 ring-indigo-500'
                                                    : 'border-gray-200 hover:border-indigo-300'
                                            }`}
                                        >
                                            <div>
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="font-bold text-xs text-gray-900">
                                                        {tpl.displayName || key}
                                                    </div>
                                                    <span className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-slate-100 text-slate-600 shrink-0">
                                                        {key}
                                                    </span>
                                                </div>
                                                <p className="text-[11px] text-gray-500 mt-1 line-clamp-2">
                                                    {tpl.description}
                                                </p>
                                            </div>
                                            <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-100">
                                                <div className="flex flex-wrap gap-1">
                                                    {(tpl.tags || []).slice(0, 4).map(tag => (
                                                        <span
                                                            key={tag}
                                                            onClick={() => setTemplateSearchQuery(tag)}
                                                            className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-indigo-50 text-indigo-700 cursor-pointer hover:bg-indigo-100"
                                                        >
                                                            #{tag}
                                                        </span>
                                                    ))}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleApplyRolePreset(key)}
                                                    className={`px-2.5 py-1 rounded text-[11px] font-bold cursor-pointer transition shrink-0 ${
                                                        alreadyExists
                                                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                                            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                                                    }`}
                                                >
                                                    {alreadyExists ? '✓ 追加済み (再適用)' : '＋ このロールを追加'}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {loading ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-xs text-gray-400">
                    ZTA ロール・権限ポリシーを読み込み中...
                </div>
            ) : (
                /* Main 2-Pane Universal Role Builder Layout */
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                    {/* LEFT PANE: Role List (4 cols on lg) */}
                    <div className="lg:col-span-4 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        <div className="px-4 py-3 bg-slate-50 border-b border-gray-200 space-y-2">
                            <div className="flex items-center justify-between">
                                <h3 className="font-bold text-xs text-gray-800">
                                    📋 定義済みロール一覧 ({filteredRoleKeys.length} / {roleKeys.length})
                                </h3>
                                <span className="text-[10px] text-gray-500">クリックして権限を編集</span>
                            </div>
                            <input
                                type="text"
                                value={roleSearchQuery}
                                onChange={(e) => setRoleSearchQuery(e.target.value)}
                                placeholder="🔍 定義済みロールをフィルタ..."
                                className="w-full px-2.5 py-1 bg-white border border-gray-200 rounded-md text-[11px] focus:outline-none focus:border-indigo-400"
                            />
                        </div>
                        <div className="divide-y divide-gray-100 max-h-[680px] overflow-y-auto">
                            {filteredRoleKeys.map(rKey => {
                                const rObj = pdpPolicies[rKey] || {};
                                const isSelected = rKey === selectedRoleKey;
                                const grantsCount = Array.isArray(rObj.grants) ? rObj.grants.length : 0;
                                const mcpCount = (rObj.mcp_scopes || []).includes('*')
                                    ? '全MCP(*)'
                                    : `${(rObj.mcp_scopes || []).length} MCP`;
                                const isCore = ['admin', 'manager', 'user', 'guest'].includes(rKey);

                                return (
                                    <div
                                        key={rKey}
                                        onClick={() => setSelectedRoleKey(rKey)}
                                        className={`p-3.5 cursor-pointer transition border-l-4 ${
                                            isSelected
                                                ? 'bg-indigo-50/60 border-l-indigo-600'
                                                : 'hover:bg-gray-50 border-l-transparent'
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="font-bold text-xs text-gray-900 truncate flex items-center gap-1.5">
                                                    <span>{rObj.label || rObj.displayName || rKey}</span>
                                                    {isCore && (
                                                        <span className="px-1.5 py-0.2 text-[9px] font-semibold rounded bg-slate-100 text-slate-600 border border-slate-200">
                                                            基本
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] font-mono text-gray-400 mt-0.5">
                                                    ID: {rKey}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-white border border-gray-200 text-gray-600">
                                                    {grantsCount} ルール
                                                </span>
                                                {!isCore && (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteRole(rKey);
                                                        }}
                                                        className="px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-50 rounded cursor-pointer"
                                                        title="このロールを削除"
                                                    >
                                                        削除
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        {rObj.description && (
                                            <p className="text-[11px] text-gray-500 mt-1.5 line-clamp-2">
                                                {rObj.description}
                                            </p>
                                        )}
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-700 font-medium">
                                                🔌 {mcpCount}
                                            </span>
                                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-50 text-emerald-700 font-medium">
                                                🏢 Pod: {(rObj.allowed_pods || []).includes('*')
                                                    ? '全Pod(*)'
                                                    : (rObj.allowed_pods || []).length > 0
                                                        ? (rObj.allowed_pods || []).join(', ')
                                                        : '所属Podのみ'}
                                            </span>
                                            {Object.entries(rObj.mcp_rules || {}).map(([sId, rule]) => (
                                                <span
                                                    key={sId}
                                                    className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                                                        rule.operation_level === 'read_only'
                                                            ? 'bg-sky-50 text-sky-700'
                                                            : 'bg-amber-50 text-amber-800'
                                                    }`}
                                                >
                                                    MCP({sId}): {rule.operation_level} / {rule.data_scope}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* RIGHT PANE: Role Permission Builder & PEP Simulator (8 cols on lg) */}
                    <div className="lg:col-span-8 space-y-5">
                        {/* Role Summary & Metadata Card */}
                        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded bg-slate-100 text-slate-700 border border-slate-300">
                                            ROLE: {selectedRoleKey}
                                        </span>
                                        <h3 className="font-bold text-base text-gray-900">
                                            {activeRole.label || activeRole.displayName || selectedRoleKey}
                                        </h3>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        {activeRole.description || 'このロールに付与する権限ルール (Permission Grants) とデータスコープを構成します。'}
                                    </p>
                                </div>

                                {!isAdminRole && (
                                    <button
                                        type="button"
                                        onClick={() => setShowAddGrantForm(!showAddGrantForm)}
                                        className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer transition shrink-0"
                                    >
                                        {showAddGrantForm ? '✕ ルール追加フォームを閉じる' : '＋ 権限ルール (Grant) を追加'}
                                    </button>
                                )}
                            </div>

                            {/* Add New Universal Permission Grant Form */}
                            {showAddGrantForm && !isAdminRole && (
                                <div className="mt-4 p-4 rounded-xl bg-indigo-50/50 border border-indigo-200 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h4 className="font-bold text-xs text-indigo-950">
                                            ➕ 新しい権限ルール (Universal Permission Grant) をこのロールに付与
                                        </h4>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {/* Axis 1: Resource Type */}
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                ① リソース種別 (Resource Type)
                                            </label>
                                            <select
                                                value={draftGrant.resource_type}
                                                onChange={(e) => {
                                                    const nextType = e.target.value;
                                                    let defaultId = '*';
                                                    if (nextType === 'mcp_server' && mcpServers.length > 0) defaultId = String(mcpServers[0].id);
                                                    if (nextType === 'widget') defaultId = activeWidgetIds[0] || 'gemini';
                                                    if (nextType === 'organization_pod' && pods.length > 0) defaultId = String(pods[0].id);
                                                    if (nextType === 'system_governance') defaultId = 'manage_settings';
                                                    setDraftGrant({ ...draftGrant, resource_type: nextType, resource_id: defaultId });
                                                }}
                                                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                            >
                                                {RESOURCE_TYPE_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {/* Axis 1b: Target Resource ID */}
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                ② 対象リソース (Target Resource)
                                            </label>
                                            {draftGrant.resource_type === 'mcp_server' && (
                                                <select
                                                    value={draftGrant.resource_id}
                                                    onChange={(e) => setDraftGrant({ ...draftGrant, resource_id: e.target.value })}
                                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                                >
                                                    <option value="*">🌐 全 MCP サーバー (*)</option>
                                                    {mcpServers.map(srv => (
                                                        <option key={srv.id} value={String(srv.id)}>
                                                            [#{srv.id}] {srv.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {draftGrant.resource_type === 'widget' && (
                                                <select
                                                    value={draftGrant.resource_id}
                                                    onChange={(e) => setDraftGrant({ ...draftGrant, resource_id: e.target.value })}
                                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                                >
                                                    <option value="*">🧩 全 AI ウィジェット (*)</option>
                                                    {activeWidgetIds.map((wId) => {
                                                        const meta = WIDGET_META[wId] || { name: wId, icon: '🧩' };
                                                        return (
                                                            <option key={wId} value={wId}>
                                                                {meta.icon} {meta.name} ({wId})
                                                            </option>
                                                        );
                                                    })}
                                                </select>
                                            )}
                                            {draftGrant.resource_type === 'organization_pod' && (
                                                <select
                                                    value={draftGrant.resource_id}
                                                    onChange={(e) => setDraftGrant({ ...draftGrant, resource_id: e.target.value })}
                                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                                >
                                                    <option value="*">🏢 全社・全部門 Pod (*)</option>
                                                    <option value="public">🌐 公開・全社共通 Pod (public)</option>
                                                    {pods.map(p => (
                                                        <option key={p.id} value={String(p.id)}>
                                                            {p.name} ({p.id})
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {draftGrant.resource_type === 'knowledge_space' && (
                                                <select
                                                    value={draftGrant.resource_id}
                                                    onChange={(e) => setDraftGrant({ ...draftGrant, resource_id: e.target.value })}
                                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                                >
                                                    <option value="*">📚 全 RAG ナレッジフォルダ (*)</option>
                                                    {(ragFolders || []).map(f => (
                                                        <option key={f.id} value={String(f.id)}>
                                                            {f.name || f.id}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {draftGrant.resource_type === 'system_governance' && (
                                                <select
                                                    value={draftGrant.resource_id}
                                                    onChange={(e) => setDraftGrant({ ...draftGrant, resource_id: e.target.value })}
                                                    className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                                >
                                                    {SYSTEM_GOVERNANCE_RESOURCES.map(r => (
                                                        <option key={r.id} value={r.id}>{r.label}</option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>

                                        {/* Axis 2: Operation Level */}
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                ③ 操作権限レベル (Operation Level)
                                            </label>
                                            <select
                                                value={draftGrant.operation_level}
                                                onChange={(e) => setDraftGrant({ ...draftGrant, operation_level: e.target.value })}
                                                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                            >
                                                {OPERATION_LEVEL_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {/* Axis 3: Data Scope */}
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                ④ データアクセス範囲 (Data Scope)
                                            </label>
                                            <select
                                                value={draftGrant.data_scope}
                                                onChange={(e) => setDraftGrant({ ...draftGrant, data_scope: e.target.value })}
                                                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white font-semibold"
                                            >
                                                {DATA_SCOPE_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>

                                    {/* Axis 4: Fine-grained Constraints (for MCP / DB / Prompt Guard) */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                🔒 禁止テーブル / 機密カラム (カンマ区切り・SQL PEP 遮断対象)
                                            </label>
                                            <input
                                                type="text"
                                                value={draftGrant.restricted_identifiers}
                                                onChange={(e) => setDraftGrant({ ...draftGrant, restricted_identifiers: e.target.value })}
                                                placeholder="例: salary, bonus, pitching_stats"
                                                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-mono bg-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                🛡️ AI スコープガード指示 (プロンプト制約注入)
                                            </label>
                                            <input
                                                type="text"
                                                value={draftGrant.scope_prompt_guard}
                                                onChange={(e) => setDraftGrant({ ...draftGrant, scope_prompt_guard: e.target.value })}
                                                placeholder="例: 所属部門（または阪神タイガース）のデータのみ参照可。給与カラムは除外。"
                                                className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex justify-end gap-2 pt-1">
                                        <button
                                            type="button"
                                            onClick={() => setShowAddGrantForm(false)}
                                            className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-semibold text-gray-700 cursor-pointer"
                                        >
                                            キャンセル
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleAddGrantToRole}
                                            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer"
                                        >
                                            ＋ この権限ルールをロールに付与する
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Attached Permission Grant Cards List */}
                            <div className="mt-4 space-y-2.5">
                                <div className="flex items-center justify-between">
                                    <h4 className="font-bold text-xs text-gray-800">
                                        🎴 アタッチ済み権限ルール一覧 ({activeGrants.length} 件)
                                    </h4>
                                    <span className="text-[11px] text-gray-400">
                                        各カードで操作レベル（参照のみ / 作成・更新）やデータスコープ・禁止カラムを即時変更できます
                                    </span>
                                </div>

                                {activeGrants.length === 0 ? (
                                    <div className="p-6 rounded-xl border border-dashed border-gray-300 text-center text-xs text-gray-400">
                                        このロールにはまだ権限ルールが付与されていません。「＋ 権限ルール (Grant) を追加」ボタンから追加してください。
                                    </div>
                                ) : (
                                    <div className="space-y-2.5">
                                        {activeGrants.map((grant) => {
                                            const rTypeMeta = RESOURCE_TYPE_OPTIONS.find(r => r.value === grant.resource_type) || RESOURCE_TYPE_OPTIONS[0];
                                            const opMeta = OPERATION_LEVEL_OPTIONS.find(o => o.value === grant.operation_level) || OPERATION_LEVEL_OPTIONS[0];
                                            const resolvedLabel = resolveResourceLabel(grant.resource_type, grant.resource_id) || grant.resource_label;
                                            const restrictedStr = Array.isArray(grant.constraints?.restricted_identifiers)
                                                ? grant.constraints.restricted_identifiers.join(', ')
                                                : '';

                                            return (
                                                <div
                                                    key={grant.id}
                                                    className="p-3.5 rounded-xl border border-gray-200 bg-slate-50/60 hover:bg-white hover:border-indigo-200 transition space-y-2.5"
                                                >
                                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className={`px-2 py-0.5 text-[10px] font-bold rounded border ${rTypeMeta.badgeCls}`}>
                                                                {rTypeMeta.icon} {grant.resource_type}
                                                            </span>
                                                            <span className="font-bold text-xs text-gray-900">
                                                                {resolvedLabel}
                                                            </span>
                                                        </div>

                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            {/* Operation Level Selector */}
                                                            <select
                                                                disabled={isAdminRole}
                                                                value={grant.operation_level}
                                                                onChange={(e) => handleUpdateGrantField(grant.id, g => ({
                                                                    ...g,
                                                                    operation_level: e.target.value,
                                                                    constraints: {
                                                                        ...(g.constraints || {}),
                                                                        blocked_tools: e.target.value === 'read_only' && g.resource_type === 'mcp_server'
                                                                            ? ['write_query', 'drop_table']
                                                                            : []
                                                                    }
                                                                }))}
                                                                className={`px-2.5 py-1 rounded-lg text-xs font-bold border cursor-pointer ${opMeta.cls}`}
                                                            >
                                                                {OPERATION_LEVEL_OPTIONS.map(opt => (
                                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                                ))}
                                                            </select>

                                                            {/* Data Scope Selector */}
                                                            <select
                                                                disabled={isAdminRole}
                                                                value={grant.data_scope || 'all_company'}
                                                                onChange={(e) => handleUpdateGrantField(grant.id, g => ({
                                                                    ...g,
                                                                    data_scope: e.target.value
                                                                }))}
                                                                className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-gray-300 bg-white text-gray-800 cursor-pointer"
                                                            >
                                                                {DATA_SCOPE_OPTIONS.map(opt => (
                                                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                                ))}
                                                            </select>

                                                            {!isAdminRole && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleRemoveGrant(grant.id)}
                                                                    className="px-2 py-1 text-[11px] text-red-500 hover:bg-red-50 rounded-lg cursor-pointer"
                                                                    title="この権限ルールを削除"
                                                                >
                                                                    🗑️
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Fine-Grained Constraint Row for MCP Server Grants */}
                                                    {grant.resource_type === 'mcp_server' && (
                                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-gray-200/70 text-[11px]">
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="text-gray-600 font-semibold shrink-0">🔒 禁止テーブル/カラム:</span>
                                                                <input
                                                                    type="text"
                                                                    disabled={isAdminRole}
                                                                    defaultValue={restrictedStr}
                                                                    placeholder="なし (例: salary, bonus, pitching_stats)"
                                                                    onBlur={(e) => {
                                                                        const nextArr = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                                                                        if (nextArr.join(',') !== restrictedStr) {
                                                                            handleUpdateGrantField(grant.id, g => ({
                                                                                ...g,
                                                                                constraints: {
                                                                                    ...(g.constraints || {}),
                                                                                    restricted_identifiers: nextArr
                                                                                }
                                                                            }));
                                                                        }
                                                                    }}
                                                                    className="w-full px-2 py-1 rounded border border-gray-200 bg-white font-mono text-[11px]"
                                                                />
                                                            </div>
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="text-gray-600 font-semibold shrink-0">🛡️ スコープ制約指示:</span>
                                                                <input
                                                                    type="text"
                                                                    disabled={isAdminRole}
                                                                    defaultValue={grant.constraints?.scope_prompt_guard || ''}
                                                                    placeholder="例: 所属部門または阪神タイガースの分析のみ許可"
                                                                    onBlur={(e) => {
                                                                        const val = e.target.value.trim();
                                                                        if (val !== (grant.constraints?.scope_prompt_guard || '')) {
                                                                            handleUpdateGrantField(grant.id, g => ({
                                                                                ...g,
                                                                                constraints: {
                                                                                    ...(g.constraints || {}),
                                                                                    scope_prompt_guard: val
                                                                                }
                                                                            }));
                                                                        }
                                                                    }}
                                                                    className="w-full px-2 py-1 rounded border border-gray-200 bg-white text-[11px]"
                                                                />
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Quick Widget & AI Model Toggles */}
                            <div className="mt-5 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Quick Widget Access */}
                                <div className="p-3.5 rounded-xl bg-slate-50 border border-gray-200">
                                    <h4 className="font-bold text-xs text-gray-800 mb-2">
                                        🧩 インストール済みウィジェット基本権限 (クイック切替)
                                    </h4>
                                    <div className="space-y-1.5">
                                        {activeWidgetIds.map(wId => {
                                            const meta = WIDGET_META[wId] || { name: wId, icon: '🧩' };
                                            const lvl = isAdminRole
                                                ? 'manage'
                                                : (activeRole.widget_levels?.[wId] || activeRole.v2_matrix?.[wId]?.level || 'none');
                                            return (
                                                <div key={wId} className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs">
                                                    <span className="font-semibold text-gray-800">
                                                        {meta.icon} {meta.name}
                                                    </span>
                                                    <select
                                                        disabled={isAdminRole}
                                                        value={lvl}
                                                        onChange={(e) => handleWidgetQuickLevelChange(wId, e.target.value)}
                                                        className="px-2 py-0.5 rounded border border-gray-300 text-[11px] font-bold bg-slate-50 cursor-pointer"
                                                    >
                                                        <option value="none">🚫 不可</option>
                                                        <option value="read">👁️ 参照のみ (Read-Only)</option>
                                                        <option value="execute">⚡ 実行・分析 (Execute)</option>
                                                        <option value="manage">🛠️ 管理・公開 (Manage)</option>
                                                    </select>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Allowed AI Models */}
                                <div className="p-3.5 rounded-xl bg-slate-50 border border-gray-200">
                                    <h4 className="font-bold text-xs text-gray-800 mb-2">
                                        🤖 このロールで利用を許可する AI モデル
                                    </h4>
                                    <div className="space-y-1.5">
                                        {MODEL_PERMISSION_CHOICES.map(m => {
                                            const checked = isAdminRole || (activeRole.allowed_models || []).includes(m.id);
                                            return (
                                                <label
                                                    key={m.id}
                                                    className="flex items-center gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs cursor-pointer"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        disabled={isAdminRole}
                                                        checked={checked}
                                                        onChange={() => handleToggleAllowedModel(m.id)}
                                                        className="rounded text-indigo-600"
                                                    />
                                                    <span className="font-medium text-gray-800">{m.label}</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Quick Knowledge Base Pod Access Scopes */}
                            <div className="mt-4 p-3.5 rounded-xl bg-emerald-50/40 border border-emerald-200">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2.5">
                                    <h4 className="font-bold text-xs text-emerald-950 flex items-center gap-1.5">
                                        <span>🏢 ナレッジベース Pod アクセス権限 (Pod 単位の閲覧・MCP保存・管理スコープ)</span>
                                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-emerald-100 text-emerald-800 font-semibold">
                                            knowledge-base 連動
                                        </span>
                                    </h4>
                                    <span className="text-[10px] text-emerald-700">
                                        MCP分析結果のナレッジ保存先・RAG参照可能なPodスコープをロール単位で制御します
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {[
                                        { id: 'public', name: '🌐 共通・パブリック Pod (public)', desc: '全社公開ナレッジ・共有ブリーフィング' },
                                        { id: '*', name: '🏢 全社・全部門 Pod (*)', desc: 'すべての部門Podに対する横断アクセス権限' },
                                        ...(pods || [])
                                            .filter(p => p.id !== 'public' && p.id !== '*')
                                            .map(p => ({
                                                id: String(p.id),
                                                name: `📦 ${p.name} (${p.id})`,
                                                desc: p.description || '部門・プロジェクト専用 Pod'
                                            }))
                                    ].map(podItem => {
                                        const rawScope = isAdminRole
                                            ? 'manage'
                                            : (activeRole.pod_scopes?.[podItem.id] ||
                                                ((activeRole.allowed_pods || []).includes(podItem.id) ? 'read' : 'none'));
                                        return (
                                            <div
                                                key={podItem.id}
                                                className="flex items-center justify-between gap-2 bg-white px-3 py-2 rounded-lg border border-emerald-200/80 text-xs shadow-2xs"
                                            >
                                                <div className="min-w-0">
                                                    <div className="font-bold text-gray-800 truncate">{podItem.name}</div>
                                                    <div className="text-[10px] text-gray-400 truncate">{podItem.desc}</div>
                                                </div>
                                                <select
                                                    disabled={isAdminRole}
                                                    value={rawScope}
                                                    onChange={(e) => handlePodQuickScopeChange(podItem.id, e.target.value)}
                                                    className={`px-2 py-1 rounded border text-[11px] font-bold cursor-pointer shrink-0 ${
                                                        rawScope === 'manage'
                                                            ? 'bg-purple-50 text-purple-800 border-purple-300'
                                                            : rawScope === 'write'
                                                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                                                : rawScope === 'read'
                                                                    ? 'bg-sky-50 text-sky-800 border-sky-300'
                                                                    : 'bg-gray-50 text-gray-500 border-gray-200'
                                                    }`}
                                                >
                                                    <option value="none">🚫 アクセス不可 (none)</option>
                                                    <option value="read">👁️ 閲覧・RAG参照のみ (read)</option>
                                                    <option value="write">✏️ MCP保存・投稿可 (write)</option>
                                                    <option value="manage">🛠️ Pod管理・承認 (manage)</option>
                                                </select>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* Compact Link Card to MCP-ZTA-Gateway Simulator */}
                        <div className="bg-indigo-50/70 rounded-xl border border-indigo-200/80 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-start gap-2.5">
                                <span className="text-base mt-0.5">🔌</span>
                                <div>
                                    <h4 className="font-bold text-xs text-indigo-950">
                                        MCP-ZTA-Gateway の SQL / ツール権限シミュレーター (PEP Dry-Run)
                                    </h4>
                                    <p className="text-[11px] text-indigo-800/80 mt-0.5">
                                        MCP サーバーに対するロール別アクセス検証（Read-Only 検査・禁止テーブル/給与カラム遮断・スコープ制約）は、独立した「<strong>🔌 MCP サーバー & Gateway 管理</strong>」タブへ統合されました。
                                    </p>
                                </div>
                            </div>
                            {onNavigateTab && (
                                <button
                                    type="button"
                                    onClick={() => onNavigateTab('MCP Gateway')}
                                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold whitespace-nowrap cursor-pointer transition shadow-xs"
                                >
                                    🔌 MCP Gateway 管理を開く →
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ZtaPolicyMatrixTab;
