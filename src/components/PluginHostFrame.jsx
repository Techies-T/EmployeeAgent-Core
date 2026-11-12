import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';

/**
 * Modern Web Guidance (`validate-origins`):
 * Safely validate cross-window MessageEvent origins using the `Origin` API (`Origin.from` + `isSameOrigin`)
 * with a strict `new URL()` fallback that explicitly rejects `'null'` opaque origin strings.
 */
function extractOriginInstance(candidate) {
    try {
        return globalThis.Origin.from(candidate);
    } catch (err) {
        if (typeof MessageEvent !== 'undefined' && candidate instanceof MessageEvent) {
            return globalThis.Origin.from(candidate.origin);
        }
        throw err;
    }
}

function isVerifiedPluginOrigin(event, expectedWindow, trustedUrlString) {
    if (!expectedWindow || event.source !== expectedWindow) {
        return false;
    }
    try {
        if ('Origin' in globalThis) {
            return extractOriginInstance(event).isSameOrigin(globalThis.Origin.from(trustedUrlString));
        }
        const candidateUrl = new URL(event.origin);
        const trustedUrl = new URL(trustedUrlString);
        return candidateUrl.origin !== 'null' && candidateUrl.origin === trustedUrl.origin;
    } catch {
        return false;
    }
}

const PluginHostFrame = ({
    widgetId,
    title = 'EA Widget Plugin',
    pluginMeta = null,
    subView = null,
    directUrl = null,
    pluginParams = {},
    user = null,
    capabilities = [],
    onOpen = null,
    onPushNotification = null
}) => {
    const iframeRef = useRef(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [agentToken, setAgentToken] = useState(null);
    const agentTokenRef = useRef(null);

    const audience = widgetId?.startsWith('app:') ? widgetId : `app:${widgetId}`;
    const cleanWidgetId = String(widgetId || '').replace(/^app:/, '');
    const widgetLevel = user?.widget_levels?.[cleanWidgetId] || (user?.role?.includes('admin') ? 'manage' : 'execute');

    const { resolvedSrc, trustedTargetOrigin } = useMemo(() => {
        let baseHref = directUrl;
        if (!baseHref) {
            const proxyBase = pluginMeta?.proxyBasePath || `/plugin-proxy/${cleanWidgetId}`;
            let entryPath = pluginMeta?.entrypoints?.main || '/index.html';
            if (subView && pluginMeta?.entrypoints?.subViews?.[subView]?.path) {
                entryPath = pluginMeta.entrypoints.subViews[subView].path;
            } else if (subView) {
                entryPath = `/index.html?view=${encodeURIComponent(subView)}`;
            }
            const normalizedEntry = entryPath.startsWith('/') ? entryPath : `/${entryPath}`;
            baseHref = `${proxyBase}${normalizedEntry}`;
        }

        const urlObj = new URL(baseHref, window.location.origin);
        if (pluginParams && typeof pluginParams === 'object') {
            for (const [k, v] of Object.entries(pluginParams)) {
                if (v !== undefined && v !== null) {
                    urlObj.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
                }
            }
        }
        urlObj.searchParams.set('eaProxyBase', `/plugin-proxy/${cleanWidgetId}`);
        return {
            resolvedSrc: urlObj.href,
            trustedTargetOrigin: urlObj.origin
        };
    }, [directUrl, pluginMeta, cleanWidgetId, subView, pluginParams]);

    const exchangeAgentToken = useCallback(async () => {
        const res = await fetch('/api/auth/token-exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                audience
            })
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 403) {
                throw new Error(errData.error_description || `ZTA 権限エラー: 「${title}」へのアクセス権限がありません。`);
            }
            throw new Error(errData.error_description || 'ZTA エージェント認証トークンの取得に失敗しました。');
        }
        const data = await res.json();
        agentTokenRef.current = data.access_token;
        setAgentToken(data.access_token);
        return data.access_token;
    }, [audience, title]);

    const sendInitContextToIframe = useCallback((tokenToSend) => {
        const win = iframeRef.current?.contentWindow;
        const tok = tokenToSend || agentTokenRef.current;
        if (!win || !tok) return;

        // Modern Web Guidance (`security` §1.5): Always specify exact targetOrigin, never wildcard '*'
        win.postMessage(
            {
                type: 'ZTA_AUTH_TOKEN',
                payload: {
                    token: tok,
                    widgetId: cleanWidgetId,
                    widgetLevel,
                    proxyBasePath: `/plugin-proxy/${cleanWidgetId}`,
                    capabilities,
                    user: user ? {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        role: user.role,
                        avatar_url: user.avatar_url,
                        native_language: user.native_language || 'ja',
                        allowed_actions: user.allowed_actions || []
                    } : null
                }
            },
            trustedTargetOrigin
        );
    }, [cleanWidgetId, widgetLevel, capabilities, user, trustedTargetOrigin]);

    useEffect(() => {
        let cancelled = false;
        const initAuth = async () => {
            try {
                const tok = await exchangeAgentToken();
                if (!cancelled) {
                    sendInitContextToIframe(tok);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err.message);
                    setIsLoading(false);
                }
            }
        };
        if (cleanWidgetId) {
            initAuth();
        }
        return () => {
            cancelled = true;
        };
    }, [cleanWidgetId, exchangeAgentToken, sendInitContextToIframe]);

    useEffect(() => {
        const handleMessage = async (event) => {
            const expectedWin = iframeRef.current?.contentWindow;
            if (!isVerifiedPluginOrigin(event, expectedWin, resolvedSrc)) {
                return;
            }

            const data = event.data;
            if (!data || typeof data !== 'object' || !data.type) return;

            // 1. Plugin ready handshake -> deliver current ZTA token & context immediately
            if (data.type === 'EA_PLUGIN_READY') {
                if (agentTokenRef.current) {
                    sendInitContextToIframe(agentTokenRef.current);
                } else {
                    try {
                        const tok = await exchangeAgentToken();
                        sendInitContextToIframe(tok);
                    } catch (err) {
                        console.error('[PluginHostFrame] Token exchange on ready failed:', err);
                    }
                }
                return;
            }

            // 2. ZTA silent token refresh request
            if (data.type === 'REQUEST_A2A_TOKEN') {
                try {
                    const freshToken = await exchangeAgentToken();
                    sendInitContextToIframe(freshToken);
                } catch (err) {
                    console.error('[PluginHostFrame] Silent token refresh failed:', err);
                }
                return;
            }

            // 3. Multi-window subView launch bridge (e.g. VirtualOffice opening DmChat window)
            if (data.type === 'EA_OPEN_WINDOW' && onOpen) {
                const {
                    windowId,
                    subView: targetSubView,
                    title: winTitle,
                    width,
                    height,
                    params = {}
                } = data.payload || {};
                if (targetSubView) {
                    const resolvedWinId = windowId || `${cleanWidgetId}-${targetSubView}-${Date.now()}`;
                    const subMeta = pluginMeta?.entrypoints?.subViews?.[targetSubView] || {};
                    onOpen(
                        resolvedWinId,
                        `plugin-subview:${cleanWidgetId}:${targetSubView}`,
                        winTitle || title,
                        {
                            widgetId: cleanWidgetId,
                            subView: targetSubView,
                            pluginParams: params,
                            customWidth: width || subMeta.defaultWidth || 400,
                            customHeight: height || subMeta.defaultHeight || 520
                        }
                    );
                }
                return;
            }

            // 4. Desktop notification bridge
            if (data.type === 'EA_PUSH_NOTIFICATION' && onPushNotification) {
                onPushNotification(data.payload || {});
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [resolvedSrc, cleanWidgetId, pluginMeta, title, onOpen, onPushNotification, exchangeAgentToken, sendInitContextToIframe]);

    // Keep user/capability updates synced to live iframe
    useEffect(() => {
        if (!isLoading && agentToken) {
            sendInitContextToIframe(agentToken);
        }
    }, [isLoading, agentToken, sendInitContextToIframe]);

    return (
        <div className="w-full h-full flex flex-col bg-[#0b0f19] relative">
            {isLoading && !error && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0f19]/90 z-10 backdrop-blur-xs text-gray-300 gap-3">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
                    <span className="text-xs font-medium">PQC署名検証済プラグインを起動中...</span>
                </div>
            )}
            {error ? (
                <div className="flex-1 flex flex-col items-center justify-center text-red-400 p-6 text-center gap-2 bg-[#0b0f19]">
                    <span className="text-2xl">🛡️</span>
                    <p className="text-xs font-bold">{error}</p>
                </div>
            ) : (
                <iframe
                    ref={iframeRef}
                    src={resolvedSrc}
                    title={title}
                    className="w-full h-full border-0"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                    onLoad={() => {
                        setIsLoading(false);
                        sendInitContextToIframe();
                    }}
                    onError={() => {
                        setIsLoading(false);
                        setError('独立ウィジェットの読み込みに失敗しました。');
                    }}
                />
            )}
        </div>
    );
};

export default PluginHostFrame;
