import React, { useState, useEffect, useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';

export function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToUint8Array(base64Url) {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

export async function isPlatformPasskeySupported() {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
    try {
        if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
            const caps = await PublicKeyCredential.getClientCapabilities();
            if (caps && typeof caps.passkeyPlatformAuthenticator === 'boolean') {
                return caps.passkeyPlatformAuthenticator;
            }
        }
        if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        }
    } catch {
        return false;
    }
    return true;
}

export async function registerPasskeyClient(deviceName = '') {
    const rawFetch = window.__eaOriginalFetch || window.fetch;
    const optRes = await rawFetch('/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (!optRes.ok) {
        const err = await optRes.json().catch(() => ({}));
        throw new Error(err.error || 'パスキー登録オプションの取得に失敗しました。');
    }
    const rawOptions = await optRes.json();

    let publicKeyOptions;
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
        publicKeyOptions = PublicKeyCredential.parseCreationOptionsFromJSON(rawOptions);
    } else {
        publicKeyOptions = {
            ...rawOptions,
            challenge: base64UrlToUint8Array(rawOptions.challenge),
            user: {
                ...rawOptions.user,
                id: base64UrlToUint8Array(rawOptions.user.id)
            },
            excludeCredentials: (rawOptions.excludeCredentials || []).map(cred => ({
                ...cred,
                id: base64UrlToUint8Array(cred.id)
            }))
        };
    }

    const cred = await navigator.credentials.create({ publicKey: publicKeyOptions });
    if (!cred || !cred.response) {
        throw new Error('パスキーの作成がキャンセルされました。');
    }

    const attestationResponse = cred.response;
    const spkiBuffer = typeof attestationResponse.getPublicKey === 'function'
        ? attestationResponse.getPublicKey()
        : null;
    if (!spkiBuffer) {
        throw new Error('お使いのブラウザはパスキー公開鍵エクスポート(getPublicKey)に対応していません。');
    }

    const publicKeySpki = bufferToBase64Url(spkiBuffer);
    const publicKeyAlg = typeof attestationResponse.getPublicKeyAlgorithm === 'function'
        ? attestationResponse.getPublicKeyAlgorithm()
        : -7;
    const transports = typeof attestationResponse.getTransports === 'function'
        ? attestationResponse.getTransports()
        : ['internal'];

    const authDataBuffer = typeof attestationResponse.getAuthenticatorData === 'function'
        ? attestationResponse.getAuthenticatorData()
        : null;

    const defaultLabel = deviceName || (navigator.platform ? `${navigator.platform} Passkey` : 'Platform Passkey');
    const rpId = rawOptions?.rp?.id || window.location.hostname;

    let verifyRes;
    try {
        verifyRes = await rawFetch('/api/auth/passkey/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceName: defaultLabel,
                publicKeySpki,
                publicKeyAlg,
                credential: {
                    id: cred.id,
                    rawId: bufferToBase64Url(cred.rawId),
                    type: cred.type,
                    response: {
                        clientDataJSON: bufferToBase64Url(attestationResponse.clientDataJSON),
                        attestationObject: bufferToBase64Url(attestationResponse.attestationObject),
                        authenticatorData: authDataBuffer ? bufferToBase64Url(authDataBuffer) : undefined,
                        transports
                    }
                }
            })
        });
    } catch (networkErr) {
        if (typeof PublicKeyCredential.signalUnknownCredential === 'function') {
            try {
                await PublicKeyCredential.signalUnknownCredential({
                    rpId,
                    credentialId: cred.id
                });
            } catch (_) {}
        }
        throw networkErr;
    }

    const verifyData = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
        if (typeof PublicKeyCredential.signalUnknownCredential === 'function') {
            try {
                await PublicKeyCredential.signalUnknownCredential({
                    rpId,
                    credentialId: cred.id
                });
            } catch (_) {}
        }
        throw new Error(verifyData.error || 'パスキーの検証に失敗しました。');
    }
    return verifyData;
}

export async function authenticateWithPasskeyClient() {
    const rawFetch = window.__eaOriginalFetch || window.fetch;
    const optRes = await rawFetch('/api/auth/passkey/reauth/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    const rawOptions = await optRes.json().catch(() => ({}));
    if (!optRes.ok) {
        const err = new Error(rawOptions.error || 'パスキー認証オプションの取得に失敗しました。');
        err.code = rawOptions.code;
        throw err;
    }

    let publicKeyOptions;
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
        publicKeyOptions = PublicKeyCredential.parseRequestOptionsFromJSON(rawOptions);
    } else {
        publicKeyOptions = {
            ...rawOptions,
            challenge: base64UrlToUint8Array(rawOptions.challenge),
            allowCredentials: (rawOptions.allowCredentials || []).map(cred => ({
                ...cred,
                id: base64UrlToUint8Array(cred.id)
            }))
        };
    }

    const cred = await navigator.credentials.get({ publicKey: publicKeyOptions });
    if (!cred || !cred.response) {
        throw new Error('パスキー認証がキャンセルされました。');
    }

    const assertionResponse = cred.response;
    const verifyRes = await rawFetch('/api/auth/passkey/reauth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            credential: {
                id: cred.id,
                rawId: bufferToBase64Url(cred.rawId),
                type: cred.type,
                response: {
                    clientDataJSON: bufferToBase64Url(assertionResponse.clientDataJSON),
                    authenticatorData: bufferToBase64Url(assertionResponse.authenticatorData),
                    signature: bufferToBase64Url(assertionResponse.signature),
                    userHandle: assertionResponse.userHandle
                        ? bufferToBase64Url(assertionResponse.userHandle)
                        : null
                }
            }
        })
    });

    const verifyData = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
        if (
            verifyData.code === 'CREDENTIAL_NOT_FOUND' &&
            verifyData.credentialId &&
            typeof PublicKeyCredential.signalUnknownCredential === 'function'
        ) {
            try {
                await PublicKeyCredential.signalUnknownCredential({
                    rpId: rawOptions.rpId || window.location.hostname,
                    credentialId: verifyData.credentialId
                });
            } catch (_) {}
        }
        throw new Error(verifyData.error || 'パスキー認証の検証に失敗しました。');
    }
    return verifyData;
}

const SessionLockModal = ({
    isOpen,
    user,
    lockCycleCount = 1,
    maxLockCount = 6,
    onUnlock,
    onLogout
}) => {
    const dialogRef = useRef(null);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [hasPasskeys, setHasPasskeys] = useState(false);
    const [passkeySupported, setPasskeySupported] = useState(false);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (isOpen) {
            if (!dialog.open) {
                dialog.showModal();
            }
        } else if (dialog.open) {
            dialog.close();
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        setErrorMessage('');
        setStatusMessage('');

        isPlatformPasskeySupported().then(setPasskeySupported);

        const rawFetch = window.__eaOriginalFetch || window.fetch;
        rawFetch('/api/auth/passkey/list', { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : { passkeys: [] }))
            .then(data => {
                setHasPasskeys(Array.isArray(data.passkeys) && data.passkeys.length > 0);
            })
            .catch(() => setHasPasskeys(false));
    }, [isOpen]);

    const handlePasskeyUnlock = async () => {
        setLoading(true);
        setErrorMessage('');
        setStatusMessage('');
        try {
            const data = await authenticateWithPasskeyClient();
            if (data?.user) {
                onUnlock(data.user);
            }
        } catch (err) {
            if (err?.name === 'NotAllowedError') {
                setErrorMessage('パスキー認証がキャンセルされたか、タイムアウトしました。');
            } else {
                setErrorMessage(err?.message || 'パスキーによるロック解除に失敗しました。');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleRegisterAndUnlock = async () => {
        setLoading(true);
        setErrorMessage('');
        setStatusMessage('');
        try {
            const data = await registerPasskeyClient();
            setHasPasskeys(true);
            setStatusMessage('この端末のパスキー（Touch ID / Windows Hello）を登録し、ロックを解除しました。');
            if (data?.user) {
                onUnlock(data.user);
            }
        } catch (err) {
            if (err?.name === 'NotAllowedError') {
                setErrorMessage('パスキーの登録がキャンセルされました。');
            } else {
                setErrorMessage(err?.message || 'パスキーの登録に失敗しました。');
            }
        } finally {
            setLoading(false);
        }
    };

    const googleReauth = useGoogleLogin({
        flow: 'auth-code',
        onSuccess: async (codeResponse) => {
            setLoading(true);
            setErrorMessage('');
            try {
                const rawFetch = window.__eaOriginalFetch || window.fetch;
                const res = await rawFetch('/api/auth/unlock-google', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: codeResponse.code })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setErrorMessage(data.error || 'Google再認証に失敗しました。');
                    return;
                }
                if (data?.user) {
                    onUnlock(data.user);
                }
            } catch {
                setErrorMessage('サーバー通信エラーによりロック解除に失敗しました。');
            } finally {
                setLoading(false);
            }
        },
        onError: () => {
            setErrorMessage('Google認証ポップアップが閉じられたか、認証に失敗しました。');
        }
    });

    const remainingCycles = Math.max(0, maxLockCount - lockCycleCount);
    const remainingMinutes = remainingCycles * 30;

    return (
        <>
            <style>{`
                dialog.zta-session-lock-dialog:modal {
                    overscroll-behavior: contain;
                    max-width: 100vw;
                    max-height: 100vh;
                    width: 100vw;
                    height: 100vh;
                    margin: 0;
                    padding: 0;
                    border: none;
                    background: transparent;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                dialog.zta-session-lock-dialog::backdrop {
                    background: rgba(10, 14, 24, 0.72);
                    backdrop-filter: blur(14px);
                    -webkit-backdrop-filter: blur(14px);
                    overflow: hidden;
                    overscroll-behavior: contain;
                }
            `}</style>
            <dialog
                ref={dialogRef}
                closedby="none"
                aria-labelledby="session-lock-title"
                onCancel={(e) => e.preventDefault()}
                className="zta-session-lock-dialog z-[99999]"
            >
                <div className="w-[460px] max-w-[92vw] bg-gray-900/90 border border-white/20 rounded-2xl shadow-2xl p-7 text-white backdrop-blur-2xl">
                    {/* Top Security Badge */}
                    <div className="flex items-center justify-between mb-5">
                        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-400/30">
                            <span>🔒</span>
                            <span>ZTA セッション保護ロック中</span>
                        </span>
                        <span className="text-xs font-mono text-gray-300 bg-white/10 px-2.5 py-1 rounded-md border border-white/10">
                            30分タイムアウト: {lockCycleCount} / {maxLockCount} 回目
                        </span>
                    </div>

                    {/* User Avatar & Identity */}
                    <div className="flex flex-col items-center text-center mb-5">
                        <div className="relative mb-3">
                            <img
                                src={user?.avatar_url || user?.picture || 'https://ui-avatars.com/api/?name=User&background=random'}
                                alt={user?.display_name || user?.name || 'User'}
                                className="w-20 h-20 rounded-full object-cover border-2 border-amber-400/60 shadow-lg"
                            />
                            <span
                                className="absolute bottom-0 right-0 w-5 h-5 rounded-full bg-gray-600 border-2 border-gray-900 flex items-center justify-center text-[10px]"
                                title="Virtual Office: Offline"
                            >
                                ⚫
                            </span>
                        </div>
                        <h2 id="session-lock-title" className="text-xl font-bold text-white">
                            {user?.display_name || user?.name || 'User'}
                        </h2>
                        <p className="text-xs text-gray-400 mt-0.5">{user?.email}</p>
                    </div>

                    {/* Notification Notice */}
                    <div className="bg-amber-500/10 border border-amber-400/30 rounded-xl p-3.5 mb-5 text-xs text-amber-100 leading-relaxed">
                        <p className="font-semibold text-amber-200 mb-1">
                            ⚠️ 30分間操作がなかったためセッションを一時ロックしました
                        </p>
                        <p className="text-amber-100/90">
                            開いている画面や作業状態は保持されています（バーチャルオフィス上は <strong>Offline</strong> 表示に切り替わっています）。再開するには本人確認を行ってください。
                        </p>
                        <p className="mt-2 text-[11px] text-amber-300/90 border-t border-amber-400/20 pt-1.5">
                            ※ あと <strong>{remainingCycles}回（約{remainingMinutes}分）</strong> 無操作が継続すると（計{maxLockCount}回達成時）、自動的に完全ログアウトされます。
                        </p>
                    </div>

                    {errorMessage && (
                        <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-500/20 border border-red-400/40 text-xs text-red-200">
                            {errorMessage}
                        </div>
                    )}

                    {statusMessage && (
                        <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-emerald-500/20 border border-emerald-400/40 text-xs text-emerald-200">
                            {statusMessage}
                        </div>
                    )}

                    {/* Unlock Action Buttons */}
                    <div className="space-y-2.5">
                        {hasPasskeys && passkeySupported && (
                            <button
                                type="button"
                                disabled={loading}
                                onClick={handlePasskeyUnlock}
                                className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-2 cursor-pointer"
                            >
                                <span>🔑</span>
                                <span>{loading ? '認証確認中...' : 'パスキー（Touch ID / 生体認証）でロック解除'}</span>
                            </button>
                        )}

                        <button
                            type="button"
                            disabled={loading}
                            onClick={() => googleReauth()}
                            className={`w-full py-3 px-4 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2 cursor-pointer ${
                                hasPasskeys && passkeySupported
                                    ? 'bg-white/10 hover:bg-white/20 text-white border border-white/20'
                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30'
                            } disabled:opacity-50`}
                        >
                            <span>🌐</span>
                            <span>{loading ? '認証処理中...' : 'Google アカウントで再認証してロック解除'}</span>
                        </button>

                        {!hasPasskeys && passkeySupported && (
                            <button
                                type="button"
                                disabled={loading}
                                onClick={handleRegisterAndUnlock}
                                className="w-full py-2.5 px-4 rounded-xl bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-400/30 text-emerald-200 font-medium text-xs transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                            >
                                <span>✨</span>
                                <span>この端末のパスキー（Touch ID 等）を登録して即座にロック解除</span>
                            </button>
                        )}
                    </div>

                    {/* Footer Manual Logout */}
                    <div className="mt-5 pt-4 border-t border-white/10 flex items-center justify-between text-xs text-gray-400">
                        <span>別アカウントで入り直す場合</span>
                        <button
                            type="button"
                            disabled={loading}
                            onClick={onLogout}
                            className="text-red-300 hover:text-red-200 font-medium underline cursor-pointer"
                        >
                            完全にログアウトする
                        </button>
                    </div>
                </div>
            </dialog>
        </>
    );
};

export default SessionLockModal;
