import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import Desktop from './components/Desktop';
import LoginScreen from './components/LoginScreen';
import SetupScreen from './components/SetupScreen';
import SessionLockModal from './components/SessionLockModal';

// ZTA 無操作タイムアウト閾値 (30分)
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// 定期セッション検証間隔 (60秒)
const SESSION_CHECK_INTERVAL_MS = 60 * 1000;
// デフォルトの最大ロック回数 (30分 × 6回 = 3時間)
const DEFAULT_MAX_LOCK_COUNT = 6;

const App = () => {
    const [user, setUser] = useState(null);
    const [config, setConfig] = useState({ isConfigured: false, clientId: '', sessionLockMaxCount: DEFAULT_MAX_LOCK_COUNT });
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [loadingSession, setLoadingSession] = useState(true);
    const [authNotice, setAuthNotice] = useState('');
    const [isSessionLocked, setIsSessionLocked] = useState(false);
    const [lockCycleCount, setLockCycleCount] = useState(0);
    const userRef = useRef(null);
    const lastActivityRef = useRef(0);
    const hasRecentActivityRef = useRef(false);
    const isLoggingOutRef = useRef(false);
    const isSessionLockedRef = useRef(false);
    const lastNotifiedCycleRef = useRef(0);
    const maxLockCountRef = useRef(DEFAULT_MAX_LOCK_COUNT);

    useEffect(() => {
        userRef.current = user;
        if (user && !lastActivityRef.current) {
            lastActivityRef.current = Date.now();
        }
    }, [user]);

    useEffect(() => {
        isSessionLockedRef.current = isSessionLocked;
    }, [isSessionLocked]);

    useEffect(() => {
        const parsed = parseInt(config?.sessionLockMaxCount, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 48) {
            maxLockCountRef.current = parsed;
        } else {
            maxLockCountRef.current = DEFAULT_MAX_LOCK_COUNT;
        }
    }, [config?.sessionLockMaxCount]);

    const forceLogoutWithNotice = useCallback(async (reasonMessage, logoutReason = 'logout', extraDetails = {}) => {
        if (isLoggingOutRef.current) return;
        isLoggingOutRef.current = true;
        try {
            const rawFetch = window.__eaOriginalFetch || window.fetch;
            await rawFetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reason: logoutReason,
                    message: reasonMessage || undefined,
                    ...extraDetails
                })
            }).catch(() => {});
        } finally {
            setIsSessionLocked(false);
            isSessionLockedRef.current = false;
            setLockCycleCount(0);
            lastNotifiedCycleRef.current = 0;
            setUser(null);
            userRef.current = null;
            if (reasonMessage) {
                setAuthNotice(reasonMessage);
            }
            isLoggingOutRef.current = false;
        }
    }, []);

    const notifyServerSoftLock = useCallback(async (cycle, idleMinutes) => {
        if (lastNotifiedCycleRef.current === cycle) return;
        lastNotifiedCycleRef.current = cycle;
        try {
            const rawFetch = window.__eaOriginalFetch || window.fetch;
            const res = await rawFetch('/api/auth/session-lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lockCycle: cycle, idleMinutes })
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 401 && data?.code === 'SESSION_EXPIRED') {
                await forceLogoutWithNotice(
                    `30分の無操作タイムアウトが規定回数（${data?.maxLockCount || maxLockCountRef.current}回）に達したため、セキュリティ保護により強制ログアウトしました。`,
                    'session_timeout',
                    { idleMinutes, lockCycles: cycle, trigger: 'max_lock_cycles_exceeded' }
                );
            }
        } catch {
            // ignore network error during soft lock notification
        }
    }, [forceLogoutWithNotice]);

    // グローバル fetch インターセプター: APIが 401(SESSION_LOCKED / SESSION_EXPIRED) または 403 を返した場合のハンドリング
    useEffect(() => {
        if (!window.__eaOriginalFetch) {
            window.__eaOriginalFetch = window.fetch.bind(window);
        }
        const rawFetch = window.__eaOriginalFetch;

        window.fetch = async (...args) => {
            const response = await rawFetch(...args);
            try {
                const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const isApiCall = reqUrl.startsWith('/api/');
                const isExcluded =
                    reqUrl.startsWith('/api/auth/logout') ||
                    reqUrl.startsWith('/api/auth/google') ||
                    reqUrl.startsWith('/api/auth/unlock-google') ||
                    reqUrl.startsWith('/api/auth/session-lock') ||
                    reqUrl.startsWith('/api/auth/passkey/');

                if (isApiCall && !isExcluded && userRef.current) {
                    if (response.status === 401) {
                        const cloned = response.clone();
                        const errData = await cloned.json().catch(() => ({}));
                        if (errData?.code === 'SESSION_LOCKED') {
                            const cycle = Number(errData.lockCount) || 1;
                            if (errData.maxLockCount) {
                                maxLockCountRef.current = Number(errData.maxLockCount);
                            }
                            isSessionLockedRef.current = true;
                            setIsSessionLocked(true);
                            setLockCycleCount(cycle);
                        } else if (errData?.code !== 'GOOGLE_TOKEN_MISSING') {
                            forceLogoutWithNotice(
                                'セッションの有効期限（最大ロック回数）を超過したため、セキュリティ保護により自動ログアウトしました。再度ログインしてください。',
                                'session_timeout',
                                { trigger: 'api_401', endpoint: reqUrl }
                            );
                        }
                    } else if (response.status === 403) {
                        const cloned = response.clone();
                        const errData = await cloned.json().catch(() => ({}));
                        const errMsg = errData?.error || '';
                        if (
                            errData?.code === 'SESSION_EXPIRED' ||
                            /Invalid( or expired)? token|Not authenticated|Session context mismatch|User not found/i.test(errMsg)
                        ) {
                            forceLogoutWithNotice(
                                'セッションの有効期限切れ、またはネットワーク環境の変化を検知したためログアウトしました。再度ログインしてください。',
                                'session_timeout',
                                { trigger: 'api_403_session_expired', endpoint: reqUrl }
                            );
                        }
                    }
                }
            } catch {
                // ignore interceptor parse errors
            }
            return response;
        };

        return () => {
            if (window.__eaOriginalFetch) {
                window.fetch = window.__eaOriginalFetch;
            }
        };
    }, [forceLogoutWithNotice]);

    const fetchConfig = useCallback(async (retries = 3) => {
        const rawFetch = window.__eaOriginalFetch || window.fetch;
        for (let attempt = retries; attempt >= 0; attempt--) {
            try {
                const res = await rawFetch('/api/config');
                if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                const data = await res.json();
                setConfig(data);
                setLoadingConfig(false);
                return data;
            } catch (error) {
                console.error("Failed to load config", error);
                if (attempt > 0) {
                    console.log(`Retrying config fetch... (${attempt} attempts left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        setLoadingConfig(false);
        return null;
    }, []);

    const checkSession = useCallback(async (silent = false, isUserActive = false) => {
        try {
            const rawFetch = window.__eaOriginalFetch || window.fetch;
            const endpoint = (isUserActive && !isSessionLockedRef.current) ? '/api/auth/me?active=1' : '/api/auth/me';
            const response = await rawFetch(endpoint);
            if (response.ok) {
                const data = await response.json();
                if (data.maxLockCount) {
                    maxLockCountRef.current = Number(data.maxLockCount);
                }
                if (data.sessionLocked) {
                    const cycle = Number(data.lockCount) || 1;
                    isSessionLockedRef.current = true;
                    setIsSessionLocked(true);
                    setLockCycleCount(cycle);
                    lastNotifiedCycleRef.current = cycle;
                    if (data.lastActiveAt) {
                        const serverLastMs = new Date(data.lastActiveAt).getTime();
                        if (!isNaN(serverLastMs)) {
                            lastActivityRef.current = serverLastMs;
                        }
                    }
                }
                setUser(prev => {
                    if (!prev || !silent) return data.user;
                    if (
                        prev.id === data.user?.id &&
                        prev.role === data.user?.role &&
                        prev.status_text === data.user?.status_text &&
                        prev.current_room === data.user?.current_room &&
                        prev.avatar_url === data.user?.avatar_url &&
                        prev.native_language === data.user?.native_language
                    ) {
                        return prev;
                    }
                    return data.user;
                });
                return true;
            } else if (silent && userRef.current && (response.status === 401 || response.status === 403)) {
                await forceLogoutWithNotice(
                    'セッションの有効期限が切れました。再度ログインしてください。',
                    'session_timeout',
                    { trigger: 'periodic_session_check', status: response.status }
                );
                return false;
            }
        } catch (error) {
            console.error("Session check failed", error);
        } finally {
            if (!silent) {
                setLoadingSession(false);
            }
        }
        return false;
    }, [forceLogoutWithNotice]);

    useEffect(() => {
        const init = async () => {
            const conf = await fetchConfig();
            if (conf?.isConfigured) {
                // 初回ロード時は active=1 を付けずにソフトロック状態やアイドル時間を正確に判定する
                const loggedIn = await checkSession(false, false);
                if (loggedIn) {
                    await fetchConfig(1);
                }
            } else {
                setLoadingSession(false); // No session to check if not configured
            }
        };
        init();
    }, [fetchConfig, checkSession]);

    // Listen to dynamic plugin install/uninstall events so Dock and Capabilities update immediately
    useEffect(() => {
        const handlePluginsUpdated = () => {
            fetchConfig(1);
            checkSession(true, false);
        };
        window.addEventListener('plugins-updated', handlePluginsUpdated);
        return () => window.removeEventListener('plugins-updated', handlePluginsUpdated);
    }, [fetchConfig, checkSession]);

    const userId = user?.id;

    // ZTA: 30分無操作ソフトロック（最大N回）& 強制ログアウト監視
    useEffect(() => {
        if (!userId) return;

        if (!lastActivityRef.current) {
            lastActivityRef.current = Date.now();
        }
        hasRecentActivityRef.current = false;
        const lastMousePos = { x: null, y: null };

        const evaluateIdleState = (now, triggerSource) => {
            const idleTime = now - lastActivityRef.current;
            if (idleTime < IDLE_TIMEOUT_MS) return false;

            const maxCycles = maxLockCountRef.current || DEFAULT_MAX_LOCK_COUNT;
            const cycles = Math.max(1, Math.floor(idleTime / IDLE_TIMEOUT_MS));
            const idleMinutes = Math.round(idleTime / 60000);

            if (cycles >= maxCycles) {
                forceLogoutWithNotice(
                    `30分の無操作タイムアウトが規定回数（${maxCycles}回 / 計${maxCycles * 30}分）に達したため、セキュリティ保護により強制ログアウトしました。`,
                    'session_timeout',
                    { idleMinutes, lockCycles: cycles, trigger: triggerSource }
                );
                return true;
            }

            // ソフトロックへ移行またはサイクル数の更新
            isSessionLockedRef.current = true;
            setIsSessionLocked(true);
            setLockCycleCount(cycles);
            setUser(prev => (prev ? { ...prev, status_text: 'Offline' } : prev));
            notifyServerSoftLock(cycles, idleMinutes);
            return true;
        };

        let lastThrottle = 0;
        const updateActivity = (evt) => {
            // ソフトロック中はマウス操作やキー入力でタイマーをリセットさせない（パスキーまたはGoogle再認証完了時のみ解除）
            if (isSessionLockedRef.current) return;

            if (evt?.type === 'mousemove') {
                if (lastMousePos.x === null && lastMousePos.y === null) {
                    lastMousePos.x = evt.clientX;
                    lastMousePos.y = evt.clientY;
                    return;
                }
                if (Math.abs(evt.clientX - lastMousePos.x) < 3 && Math.abs(evt.clientY - lastMousePos.y) < 3) {
                    return; // DOM再描画（バッジ表示・3秒ポーリング）や微小ジッターによる疑似mousemoveを無視
                }
                lastMousePos.x = evt.clientX;
                lastMousePos.y = evt.clientY;
            }
            const now = Date.now();
            if (now - lastThrottle < 2000) return;
            lastThrottle = now;

            // スリープ復帰等で既に30分以上経過していた場合はソフトロックまたは強制ログアウトを評価
            if (evaluateIdleState(now, 'activity_resume_after_idle')) {
                return;
            }
            lastActivityRef.current = now;
            hasRecentActivityRef.current = true;
        };

        const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'click'];
        activityEvents.forEach(evt => window.addEventListener(evt, updateActivity, { passive: true }));

        const intervalId = setInterval(() => {
            const now = Date.now();
            if (evaluateIdleState(now, 'idle_interval_timer')) {
                return;
            }
            const wasActive = hasRecentActivityRef.current;
            hasRecentActivityRef.current = false;
            checkSession(true, wasActive);
        }, SESSION_CHECK_INTERVAL_MS);

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                const now = Date.now();
                if (!evaluateIdleState(now, 'visibility_resume_after_idle')) {
                    checkSession(true, false);
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            activityEvents.forEach(evt => window.removeEventListener(evt, updateActivity));
            clearInterval(intervalId);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [userId, checkSession, forceLogoutWithNotice, notifyServerSoftLock]);

    const handleActivate = async () => {
        setLoadingConfig(true);
        const conf = await fetchConfig();
        if (conf?.isConfigured) {
            // After activation, we are not logged in yet, so just stop loading
        }
    };

    const handleLogin = async (userData) => {
        setAuthNotice('');
        lastActivityRef.current = Date.now();
        isSessionLockedRef.current = false;
        setIsSessionLocked(false);
        setLockCycleCount(0);
        lastNotifiedCycleRef.current = 0;
        setUser(userData);
        await fetchConfig(1);
    };

    const handleUnlockSession = (unlockedUser) => {
        lastActivityRef.current = Date.now();
        hasRecentActivityRef.current = true;
        isSessionLockedRef.current = false;
        setIsSessionLocked(false);
        setLockCycleCount(0);
        lastNotifiedCycleRef.current = 0;
        if (unlockedUser) {
            setUser(unlockedUser);
        }
    };

    const handleLogout = async () => {
        await forceLogoutWithNotice('');
    };

    if (loadingConfig || loadingSession) {
        return <div className="w-full h-screen bg-black text-white flex items-center justify-center">Loading System...</div>;
    }

    if (!config.isConfigured) {
        return <SetupScreen onActivate={handleActivate} />;
    }

    return (
        <GoogleOAuthProvider clientId={config.clientId}>
            {user ? (
                <>
                    <Desktop user={user} onLogout={handleLogout} config={config} />
                    <SessionLockModal
                        isOpen={isSessionLocked}
                        user={user}
                        lockCycleCount={lockCycleCount || 1}
                        maxLockCount={Number(config?.sessionLockMaxCount) || DEFAULT_MAX_LOCK_COUNT}
                        onUnlock={handleUnlockSession}
                        onLogout={handleLogout}
                    />
                </>
            ) : (
                <LoginScreen onLogin={handleLogin} authNotice={authNotice} onClearNotice={() => setAuthNotice('')} />
            )}
        </GoogleOAuthProvider>
    );
};

export default App;
