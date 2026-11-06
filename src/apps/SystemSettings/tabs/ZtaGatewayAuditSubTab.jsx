import React, { useState, useEffect } from 'react';

const ZtaGatewayAuditSubTab = () => {
    const [logs, setLogs] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [connected, setConnected] = useState(false);
    const [gatewayUrl, setGatewayUrl] = useState('');
    const [error, setError] = useState(null);

    // Filters
    const [searchTerm, setSearchTerm] = useState('');
    const [actionFilter, setActionFilter] = useState('all');
    const [consistencyFilter, setConsistencyFilter] = useState('all');
    const [decisionFilter, setDecisionFilter] = useState('all');

    // Selected modal log
    const [selectedLog, setSelectedLog] = useState(null);
    const [copied, setCopied] = useState(false);

    const fetchData = async () => {
        setLoading(true);
        setError(null);
        try {
            // Fetch logs & summary concurrently
            const [logsRes, summaryRes] = await Promise.all([
                fetch('/api/zta/audit/logs?limit=200'),
                fetch('/api/zta/audit/summary')
            ]);

            if (logsRes.ok) {
                const logsData = await logsRes.json();
                setConnected(logsData.connected !== false);
                setGatewayUrl(logsData.gatewayUrl || '');
                setLogs(logsData.logs || []);
            } else {
                setConnected(false);
            }

            if (summaryRes.ok) {
                const summaryData = await summaryRes.json();
                setSummary(summaryData);
            }
        } catch (err) {
            setError(err.message);
            setConnected(false);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    // Filter logic
    const filteredLogs = logs.filter(log => {
        const searchLower = searchTerm.toLowerCase();
        const tablesStr = (log.sql_inspection?.target_tables || []).join(' ').toLowerCase();
        const queryStr = (log.sql_inspection?.sanitized_query || '').toLowerCase();
        const clientStr = (log.client?.client_id || '').toLowerCase();
        const userEmailStr = (log.client?.user_email || '').toLowerCase();
        const userNameStr = (log.client?.user_name || '').toLowerCase();
        const toolStr = (log.upstream?.tool_name || '').toLowerCase();

        const matchesSearch = 
            !searchTerm ||
            tablesStr.includes(searchLower) ||
            queryStr.includes(searchLower) ||
            clientStr.includes(searchLower) ||
            userEmailStr.includes(searchLower) ||
            userNameStr.includes(searchLower) ||
            toolStr.includes(searchLower);

        const matchesAction = 
            actionFilter === 'all' || 
            log.sql_inspection?.action_type === actionFilter;

        const matchesConsistency = 
            consistencyFilter === 'all' || 
            (consistencyFilter === 'consistent' && log.consistency?.is_consistent) ||
            (consistencyFilter === 'deviation' && !log.consistency?.is_consistent);

        const matchesDecision = 
            decisionFilter === 'all' || 
            log.decision?.policy_enforcement === decisionFilter;

        return matchesSearch && matchesAction && matchesConsistency && matchesDecision;
    });

    const handleCopyDetails = (log) => {
        navigator.clipboard.writeText(JSON.stringify(log, null, 2))
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => alert('コピーに失敗しました'));
    };

    return (
        <div className="space-y-4">
            {/* Gateway Status Header */}
            <div className="flex flex-wrap items-center justify-between bg-slate-900 border border-slate-800 p-4 rounded-xl shadow-sm text-white">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">🌐</span>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="font-bold text-base">ZTA-MCP-Gateway トランザクション監査ログ</h3>
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                connected 
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            }`}>
                                {connected ? '🟢 Gateway 接続中' : '🟠 Gateway 未接続 / オフライン'}
                            </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                            ゲートウェイを通過する全トランザクション（SQLテーブル解析・READ/WRITE判別・YAMLメタ情報一貫性検証）を独立管理
                            {gatewayUrl && <span className="ml-2 font-mono text-[11px] text-slate-500">[{gatewayUrl}]</span>}
                        </p>
                    </div>
                </div>
                <button
                    onClick={fetchData}
                    disabled={loading}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow"
                >
                    <span className={loading ? 'animate-spin' : ''}>🔄</span> 最新ログを取得
                </button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl">
                    <span className="text-xs font-medium text-slate-400">総トランザクション数</span>
                    <div className="text-2xl font-bold text-white mt-1">
                        {summary?.total_transactions ?? logs.length} <span className="text-xs font-normal text-slate-500">件</span>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl">
                    <span className="text-xs font-medium text-emerald-400">認可通過 (ALLOW)</span>
                    <div className="text-2xl font-bold text-emerald-400 mt-1">
                        {summary?.allowed_count ?? logs.filter(l => l.decision?.policy_enforcement === 'ALLOW').length} <span className="text-xs font-normal text-slate-500">件</span>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl">
                    <span className="text-xs font-medium text-rose-400">ファイアウォール遮断 (DENY)</span>
                    <div className="text-2xl font-bold text-rose-400 mt-1">
                        {summary?.blocked_count ?? logs.filter(l => l.decision?.policy_enforcement === 'DENY').length} <span className="text-xs font-normal text-slate-500">件</span>
                    </div>
                </div>

                <div className={`p-3.5 rounded-xl border ${
                    (summary?.deviation_count || 0) > 0 
                        ? 'bg-amber-950/20 border-amber-500/40' 
                        : 'bg-slate-900 border-slate-800'
                }`}>
                    <span className="text-xs font-medium text-amber-400">YAML一貫性逸脱 (DEVIATION)</span>
                    <div className="text-2xl font-bold text-amber-400 mt-1">
                        {summary?.deviation_count ?? logs.filter(l => l.consistency && !l.consistency.is_consistent).length} <span className="text-xs font-normal text-slate-500">件</span>
                        {(summary?.deviation_count || 0) > 0 && <span className="ml-1 text-sm">⚠️</span>}
                    </div>
                </div>
            </div>

            {/* Filter Toolbar */}
            <div className="bg-slate-900 border border-slate-800 p-3.5 rounded-xl flex flex-wrap gap-3 items-center justify-between text-white text-xs">
                <div className="flex flex-wrap gap-2.5 items-center flex-1">
                    {/* Search Input */}
                    <div className="relative min-w-[220px] flex-1">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="テーブル名, クエリ, クライアント名等で検索..."
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 outline-none focus:border-blue-500"
                        />
                        {searchTerm && (
                            <button
                                onClick={() => setSearchTerm('')}
                                className="absolute right-2 top-1.5 text-slate-500 hover:text-white"
                            >
                                ✕
                            </button>
                        )}
                    </div>

                    {/* Action Filter */}
                    <div className="flex items-center gap-1 text-slate-400">
                        <span>操作:</span>
                        <select
                            value={actionFilter}
                            onChange={(e) => setActionFilter(e.target.value)}
                            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
                        >
                            <option value="all">すべて</option>
                            <option value="READ">READ (参照)</option>
                            <option value="WRITE">WRITE (更新・追加)</option>
                            <option value="DDL">DDL (スキーマ変更)</option>
                        </select>
                    </div>

                    {/* Consistency Filter */}
                    <div className="flex items-center gap-1 text-slate-400">
                        <span>YAML整合性:</span>
                        <select
                            value={consistencyFilter}
                            onChange={(e) => setConsistencyFilter(e.target.value)}
                            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
                        >
                            <option value="all">すべて</option>
                            <option value="consistent">✅ 整合 (Consistent)</option>
                            <option value="deviation">⚠️ 逸脱 (Deviation)</option>
                        </select>
                    </div>

                    {/* Decision Filter */}
                    <div className="flex items-center gap-1 text-slate-400">
                        <span>判定:</span>
                        <select
                            value={decisionFilter}
                            onChange={(e) => setDecisionFilter(e.target.value)}
                            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
                        >
                            <option value="all">すべて</option>
                            <option value="ALLOW">ALLOW (許可)</option>
                            <option value="DENY">DENY (遮断)</option>
                        </select>
                    </div>
                </div>

                <div className="text-slate-400 font-mono text-[11px]">
                    表示件数: {filteredLogs.length} / {logs.length}
                </div>
            </div>

            {/* Logs Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow">
                {loading ? (
                    <div className="p-8 text-center text-slate-400">
                        <div className="animate-spin text-2xl mb-2">⏳</div>
                        ログを読み込み中...
                    </div>
                ) : filteredLogs.length === 0 ? (
                    <div className="p-8 text-center text-slate-500">
                        {connected 
                            ? '該当するトランザクションログはありません。' 
                            : 'ZTA-MCP-Gateway に接続できません。Gateway が起動しているか確認してください。'}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs text-slate-300">
                            <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                                <tr>
                                    <th className="py-2.5 px-3">日時 (JST)</th>
                                    <th className="py-2.5 px-3">実行ユーザー / A2Aクライアント</th>
                                    <th className="py-2.5 px-3">対象MCP / ツール</th>
                                    <th className="py-2.5 px-3">対象テーブル</th>
                                    <th className="py-2.5 px-3">操作種別</th>
                                    <th className="py-2.5 px-3">YAML整合性</th>
                                    <th className="py-2.5 px-3">判定</th>
                                    <th className="py-2.5 px-3 text-right">時間</th>
                                    <th className="py-2.5 px-3 text-center">詳細</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                                {filteredLogs.map((log) => {
                                    const actionType = log.sql_inspection?.action_type || 'UNKNOWN';
                                    const isConsistent = log.consistency?.is_consistent ?? true;
                                    const decision = log.decision?.policy_enforcement || 'ALLOW';
                                    const tables = log.sql_inspection?.target_tables || [];

                                    return (
                                        <tr key={log.transaction_id} className="hover:bg-slate-800/40 transition-colors">
                                            <td className="py-2 px-3 whitespace-nowrap text-slate-400">
                                                {new Date(log.timestamp).toLocaleString('ja-JP', {
                                                    month: '2-digit', day: '2-digit',
                                                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                                                })}
                                            </td>
                                            <td className="py-2 px-3">
                                                {log.client?.user_email ? (
                                                    <div className="flex flex-col">
                                                        <span className="font-sans font-semibold text-white text-[11px]">
                                                            👤 {log.client.user_email}
                                                        </span>
                                                        <span className="text-[10px] text-slate-500">
                                                            🔑 A2A: {log.client?.client_id || 'unknown'}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="font-semibold text-slate-200">
                                                        🔑 {log.client?.client_id || 'unknown'}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-2 px-3">
                                                <span className="text-slate-400">{log.upstream?.upstream_id}</span>
                                                <span className="text-slate-600 mx-1">/</span>
                                                <span className="text-blue-400">{log.upstream?.tool_name}</span>
                                            </td>
                                            <td className="py-2 px-3">
                                                {tables.length > 0 ? (
                                                    <div className="flex flex-wrap gap-1">
                                                        {tables.map(tbl => (
                                                            <span key={tbl} className="px-1.5 py-0.5 bg-slate-800 text-sky-300 rounded text-[10px] font-sans border border-slate-700">
                                                                {tbl}
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <span className="text-slate-600">-</span>
                                                )}
                                            </td>
                                            <td className="py-2 px-3">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                    actionType === 'READ'
                                                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                                                        : actionType === 'WRITE'
                                                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                        : actionType === 'DDL'
                                                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                                        : 'bg-slate-800 text-slate-400'
                                                }`}>
                                                    {actionType}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                    isConsistent
                                                        ? 'bg-emerald-500/20 text-emerald-400'
                                                        : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                                                }`}>
                                                    {isConsistent ? '✅ 整合' : '⚠️ 逸脱検知'}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                                    decision === 'ALLOW'
                                                        ? 'bg-emerald-500/20 text-emerald-300'
                                                        : 'bg-rose-500/20 text-rose-400 font-extrabold'
                                                }`}>
                                                    {decision}
                                                </span>
                                            </td>
                                            <td className="py-2 px-3 text-right text-slate-400">
                                                {log.decision?.execution_time_ms ?? 0} ms
                                            </td>
                                            <td className="py-2 px-3 text-center">
                                                <button
                                                    onClick={() => setSelectedLog(log)}
                                                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] font-sans transition-colors"
                                                >
                                                    詳細
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Detail Modal */}
            {selectedLog && (
                <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col shadow-2xl text-white">
                        {/* Modal Header */}
                        <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-950">
                            <div>
                                <h4 className="font-bold text-sm flex items-center gap-2">
                                    <span>🛡️ ZTA トランザクション監査詳細</span>
                                    <span className="font-mono text-xs text-slate-500 font-normal">
                                        ({selectedLog.transaction_id})
                                    </span>
                                </h4>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    {new Date(selectedLog.timestamp).toLocaleString('ja-JP')}
                                </p>
                            </div>
                            <button
                                onClick={() => setSelectedLog(null)}
                                className="text-slate-400 hover:text-white text-lg font-bold p-1"
                            >
                                ✕
                            </button>
                        </div>

                        {/* Modal Body */}
                        <div className="p-5 overflow-y-auto space-y-4 text-xs font-sans">
                            {/* Policy Consistency Alert if any */}
                            {selectedLog.consistency && !selectedLog.consistency.is_consistent && (
                                <div className="p-3 bg-amber-950/40 border border-amber-500/50 rounded-xl text-amber-200">
                                    <div className="font-bold flex items-center gap-1.5 mb-1">
                                        <span>⚠️</span> YAMLメタ情報ポリシー逸脱検知 ({selectedLog.consistency.status})
                                    </div>
                                    <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-300">
                                        {selectedLog.consistency.deviations.map((dev, i) => (
                                            <li key={i}>{dev}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* SQL Inspection Section */}
                            {selectedLog.sql_inspection?.is_sql && (
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <span className="font-bold text-slate-300">🔍 SQLディープインスペクション</span>
                                        <span className="font-mono text-[10px] text-slate-500">
                                            Fingerprint: {selectedLog.sql_inspection.query_fingerprint.substring(0, 16)}...
                                        </span>
                                    </div>
                                    <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-sky-200 overflow-x-auto whitespace-pre-wrap">
                                        {selectedLog.sql_inspection.sanitized_query || '(クエリ情報なし)'}
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                                        <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                                            <span className="text-slate-400">対象テーブル / 参照カラム:</span>
                                            <div className="font-bold text-white mt-0.5">
                                                {selectedLog.sql_inspection.target_tables.join(', ') || 'なし'}
                                            </div>
                                            {selectedLog.sql_inspection.accessed_columns?.length > 0 && (
                                                <div className="text-[10px] text-sky-400 mt-0.5">
                                                    カラム: {selectedLog.sql_inspection.accessed_columns.join(', ')}
                                                </div>
                                            )}
                                        </div>
                                        <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                                            <span className="text-slate-400">操作種別 / サブクエリ:</span>
                                            <div className="font-bold text-white mt-0.5">
                                                {selectedLog.sql_inspection.action_type}
                                                {selectedLog.sql_inspection.has_subquery && ' (サブクエリあり)'}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Client & Execution Context */}
                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800 space-y-1">
                                    <div>
                                        <span className="text-slate-400">実行ユーザー (社員):</span>{' '}
                                        <span className="font-bold text-sky-300">
                                            {selectedLog.client?.user_email || '未特定 (A2A直接通信)'}
                                        </span>
                                        {selectedLog.client?.user_id && (
                                            <span className="text-slate-500 ml-1">(ID: {selectedLog.client.user_id})</span>
                                        )}
                                    </div>
                                    <div>
                                        <span className="text-slate-400">社員ロール:</span>{' '}
                                        [{(selectedLog.client?.user_roles || selectedLog.client?.roles || []).join(', ')}]
                                    </div>
                                    <div>
                                        <span className="text-slate-400">A2A クライアントID:</span>{' '}
                                        <span className="font-bold">{selectedLog.client?.client_id}</span>
                                        <span className="text-slate-500 ml-1">([{selectedLog.client?.roles?.join(', ')}])</span>
                                    </div>
                                    <div><span className="text-slate-400">IPアドレス:</span> {selectedLog.client?.ip_address}</div>
                                </div>
                                <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800 space-y-1">
                                    <div><span className="text-slate-400">判定:</span> <span className="font-bold text-emerald-400">{selectedLog.decision?.policy_enforcement}</span></div>
                                    <div><span className="text-slate-400">所要時間:</span> {selectedLog.decision?.execution_time_ms} ms</div>
                                    <div><span className="text-slate-400">カタログID:</span> {selectedLog.consistency?.catalog_id || 'なし'}</div>
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex justify-between items-center">
                            <button
                                onClick={() => handleCopyDetails(selectedLog)}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition-all flex items-center gap-1"
                            >
                                {copied ? '✅ コピー完了' : '📋 JSON全体をコピー'}
                            </button>
                            <button
                                onClick={() => setSelectedLog(null)}
                                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition-all"
                            >
                                閉じる
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ZtaGatewayAuditSubTab;
