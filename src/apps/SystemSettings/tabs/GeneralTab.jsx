import React, { useState, useEffect } from 'react';
import pkg from '../../../../package.json';
import { registerPasskeyClient, isPlatformPasskeySupported } from '../../../components/SessionLockModal';

const GeneralTab = () => {
    const [passkeys, setPasskeys] = useState([]);
    const [loadingPasskeys, setLoadingPasskeys] = useState(true);
    const [registering, setRegistering] = useState(false);
    const [deviceNameInput, setDeviceNameInput] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState('');
    const [passkeySupported, setPasskeySupported] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });

    const syncAcceptedCredentials = async (rpId, userId, list) => {
        if (
            typeof window === 'undefined' ||
            !window.PublicKeyCredential ||
            typeof PublicKeyCredential.signalAllAcceptedCredentials !== 'function' ||
            !rpId ||
            !userId
        ) {
            return;
        }
        try {
            const allAcceptedCredentialIds = (list || [])
                .map(pk => pk.credential_id)
                .filter(Boolean);
            await PublicKeyCredential.signalAllAcceptedCredentials({
                rpId,
                userId,
                allAcceptedCredentialIds
            });
        } catch (err) {
            console.warn('signalAllAcceptedCredentials sync skipped:', err);
        }
    };

    const fetchPasskeys = async (retries = 3) => {
        setLoadingPasskeys(true);
        let lastErr = null;
        for (let attempt = retries; attempt >= 0; attempt--) {
            try {
                const res = await fetch('/api/auth/passkey/list', { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data.passkeys) ? data.passkeys : [];
                    setPasskeys(list);
                    setLoadingPasskeys(false);
                    await syncAcceptedCredentials(data.rpId, data.userId, list);
                    return list;
                }
                lastErr = new Error(`HTTP ${res.status}`);
            } catch (err) {
                lastErr = err;
            }
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        console.error('Failed to fetch passkeys after retries', lastErr);
        setLoadingPasskeys(false);
        return null;
    };

    useEffect(() => {
        isPlatformPasskeySupported().then(setPasskeySupported);
        fetchPasskeys();
    }, []);

    const handleRegisterPasskey = async () => {
        setRegistering(true);
        setMessage({ type: '', text: '' });
        try {
            const verifyData = await registerPasskeyClient(deviceNameInput.trim());
            setDeviceNameInput('');
            if (Array.isArray(verifyData?.passkeys)) {
                setPasskeys(verifyData.passkeys);
            }
            setMessage({
                type: 'success',
                text: 'パスキー（Touch ID / Windows Hello 等）を登録しました。次回以降の30分セッションロック時にワンタッチで解除できます。'
            });
            await fetchPasskeys(2);
        } catch (err) {
            if (err?.name === 'NotAllowedError') {
                setMessage({ type: 'error', text: 'パスキーの登録がキャンセルされました。' });
            } else if (err?.name === 'InvalidStateError') {
                setMessage({ type: 'error', text: 'この端末には既にパスキーが登録されています。再登録する場合は一覧から既存のパスキーを削除してください。' });
                await fetchPasskeys(1);
            } else {
                setMessage({ type: 'error', text: err?.message || 'パスキーの登録に失敗しました。' });
            }
        } finally {
            setRegistering(false);
        }
    };

    const handleRenamePasskey = async (id) => {
        const trimmed = editingName.trim();
        if (!trimmed) return;
        try {
            const res = await fetch(`/api/auth/passkey/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceName: trimmed })
            });
            if (res.ok) {
                setPasskeys(prev => prev.map(p => (p.id === id ? { ...p, device_name: trimmed } : p)));
                setEditingId(null);
                setEditingName('');
                setMessage({ type: 'success', text: 'パスキーの名称を更新しました。' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'パスキーの名称変更に失敗しました。' });
        }
    };

    const handleDeletePasskey = async (id) => {
        if (!window.confirm('このパスキーを削除しますか？')) return;
        try {
            const res = await fetch(`/api/auth/passkey/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setPasskeys(prev => prev.filter(p => p.id !== id));
                setMessage({ type: 'success', text: 'パスキーを削除しました。' });
                await fetchPasskeys(1);
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'パスキーの削除に失敗しました。' });
        }
    };

    return (
        <div className="space-y-6">
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                    <span>About</span>
                    <span className="text-gray-500 font-medium">Employee Agent v{pkg.version}</span>
                </div>
                <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                    <span>Software Update</span>
                    <span className="text-gray-500 flex items-center gap-1">Up to date <span className="text-green-500">●</span></span>
                </div>
            </div>

            {/* ZTA Passkey Management Card */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
                <div className="flex items-start justify-between mb-3">
                    <div>
                        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                            <span>🔑</span>
                            <span>ZTA パスキー管理 (Touch ID / Windows Hello)</span>
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                            30分間の無操作によるセッション一時ロック時に、デスクトップ画面を閉じずに生体認証・PINで即座にロック解除するためのパスキーを管理します。
                        </p>
                    </div>
                </div>

                {message.text && (
                    <div
                        className={`mb-3 px-3 py-2 rounded text-xs border ${
                            message.type === 'success'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                : 'bg-red-50 border-red-200 text-red-700'
                        }`}
                    >
                        {message.text}
                    </div>
                )}

                <div className="flex flex-col sm:flex-row gap-2 mb-4">
                    <input
                        type="text"
                        value={deviceNameInput}
                        onChange={(e) => setDeviceNameInput(e.target.value)}
                        placeholder="端末名 (例: MacBook Pro Touch ID)"
                        className="flex-1 px-3 py-2 border border-gray-200 rounded text-xs bg-white focus:outline-none focus:border-blue-500"
                    />
                    <button
                        type="button"
                        disabled={registering || !passkeySupported}
                        onClick={handleRegisterPasskey}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-xs font-semibold transition cursor-pointer shadow-sm whitespace-nowrap"
                    >
                        {registering ? '登録処理中...' : '＋ この端末のパスキーを登録'}
                    </button>
                </div>

                {!passkeySupported && (
                    <p className="text-[11px] text-amber-600 mb-3">
                        ※ 現在のブラウザまたは環境ではプラットフォームパスキー（WebAuthn）が利用できません。ロック解除時は Google アカウント再認証をご利用いただけます。
                    </p>
                )}

                <div className="border-t border-gray-100 pt-3">
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-medium text-gray-600">登録済みパスキー一覧</div>
                        <button
                            type="button"
                            onClick={() => fetchPasskeys(2)}
                            className="text-[11px] text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
                        >
                            ↻ 再読み込み
                        </button>
                    </div>
                    {loadingPasskeys ? (
                        <div className="text-xs text-gray-400 py-2">読み込み中...</div>
                    ) : passkeys.length === 0 ? (
                        <div className="text-xs text-gray-400 py-2">
                            まだパスキーが登録されていません（未登録の場合はロック画面でGoogle再認証またはその場でのパスキー登録が可能です）。
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {passkeys.map(pk => (
                                <div
                                    key={pk.id}
                                    className="flex items-center justify-between px-3 py-2 rounded border border-gray-100 bg-gray-50 text-xs gap-2"
                                >
                                    <div className="flex-1 min-w-0">
                                        {editingId === pk.id ? (
                                            <div className="flex items-center gap-1.5 mb-1">
                                                <input
                                                    type="text"
                                                    value={editingName}
                                                    onChange={(e) => setEditingName(e.target.value)}
                                                    className="px-2 py-1 border border-gray-300 rounded text-xs bg-white focus:outline-none focus:border-blue-500"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => handleRenamePasskey(pk.id)}
                                                    className="px-2 py-1 bg-blue-600 text-white rounded text-[11px] font-medium hover:bg-blue-700 cursor-pointer"
                                                >
                                                    保存
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setEditingId(null); setEditingName(''); }}
                                                    className="px-2 py-1 text-gray-500 hover:text-gray-700 text-[11px] cursor-pointer"
                                                >
                                                    キャンセル
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="font-semibold text-gray-800 truncate">{pk.device_name || 'Platform Passkey'}</div>
                                        )}
                                        <div className="text-[11px] text-gray-400">
                                            登録日: {pk.created_at ? new Date(pk.created_at).toLocaleString() : '-'}
                                            {pk.last_used_at ? ` / 最終利用: ${new Date(pk.last_used_at).toLocaleString()}` : ''}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        {editingId !== pk.id && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setEditingId(pk.id);
                                                    setEditingName(pk.device_name || 'Platform Passkey');
                                                }}
                                                className="text-gray-600 hover:text-gray-800 font-medium px-2 py-1 rounded hover:bg-gray-200/60 transition cursor-pointer"
                                            >
                                                名称変更
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => handleDeletePasskey(pk.id)}
                                            className="text-red-600 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50 transition cursor-pointer"
                                        >
                                            削除
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default GeneralTab;
