import React, { useState, useRef, useEffect } from 'react';

// Generative UI: HTML Live Preview Component
const HtmlPreviewCodeBlock = ({ code, onSaveToKnowledge, onOpen }) => {
    const [viewMode, setViewMode] = useState('preview'); // 'preview' or 'code'
    const [isExpanded, setIsExpanded] = useState(false);
    const iframeRef = useRef(null);

    const updateHeight = () => {
        try {
            if (iframeRef.current && iframeRef.current.contentWindow) {
                const doc = iframeRef.current.contentWindow.document;
                if (doc && doc.body) {
                    const scrollH = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 500);
                    iframeRef.current.style.height = `${Math.min(scrollH + 30, 1200)}px`;
                }
            }
        } catch (_) {}
    };

    useEffect(() => {
        if (viewMode === 'preview') {
            const timer = setTimeout(updateHeight, 400);
            return () => clearTimeout(timer);
        }
    }, [viewMode, code, isExpanded]);

    const openInNewTab = () => {
        const blob = new Blob([code], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    };

    const openInBrowserWindow = () => {
        if (onOpen) {
            const windowId = `analytics-dashboard-${Date.now()}`;
            let title = 'AI Analytics ダッシュボード';
            const titleMatch = code.match(/<title>([^<]+)<\/title>/i) || code.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
            if (titleMatch && titleMatch[1]) {
                title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            }
            onOpen(windowId, 'browser', title, { liveContent: code });
        } else {
            openInNewTab();
        }
    };

    // srcDoc 用に未完結スクリプトの自動補完および DOMContentLoaded / 耐障害フォールバックを注入
    const preparedCode = React.useMemo(() => {
        if (!code) return '';
        let sanitized = code;
        const scriptOpenCount = (sanitized.match(/<script\b[^>]*>/gi) || []).length;
        const scriptCloseCount = (sanitized.match(/<\/script>/gi) || []).length;
        if (scriptOpenCount > scriptCloseCount) {
            sanitized += '\n;/* unclosed block auto-recovery */\n</script></body></html>';
        }

        const headSafetyScript = `
<script>
window.onerror = function(msg, url, line, col, error) {
    console.warn("GenUI Widget script error intercepted:", msg);
    // スクリプトエラーでタブ切り替え等が停止した場合に備え、デフォルトで最初のタブコンテンツを表示
    setTimeout(function() {
        var panels = document.querySelectorAll('[id^="content-"], [id^="tab-content-"]');
        if (panels.length > 0) {
            var anyVisible = false;
            panels.forEach(function(p) {
                if (!p.classList.contains('hidden') && p.style.display !== 'none') anyVisible = true;
            });
            if (!anyVisible && panels[0]) {
                panels[0].classList.remove('hidden');
                panels[0].style.display = 'block';
            }
        }
    }, 150);
    return false;
};
(function() {
    function fireReady() {
        try {
            window.dispatchEvent(new Event('DOMContentLoaded'));
            window.dispatchEvent(new Event('load'));
        } catch (_) {}
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(fireReady, 50);
        setTimeout(fireReady, 300);
    } else {
        document.addEventListener('DOMContentLoaded', () => setTimeout(fireReady, 50));
        window.addEventListener('load', () => setTimeout(fireReady, 50));
    }
})();
</script>
`;
        if (sanitized.includes('<head>')) {
            return sanitized.replace('<head>', `<head>${headSafetyScript}`);
        }
        if (sanitized.includes('</body>')) {
            return sanitized.replace('</body>', `${headSafetyScript}</body>`);
        }
        return headSafetyScript + sanitized;
    }, [code]);

    return (
        <div className={`my-4 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm bg-white dark:bg-[#1a1a1a] not-prose transition-all ${isExpanded ? 'ring-2 ring-indigo-400' : ''}`}>
            <div className="bg-gray-100/90 dark:bg-[#252526] backdrop-blur px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-base">⚡</span>
                    <span className="font-semibold text-gray-700 dark:text-gray-200">Generative UI Widget</span>
                    <span className="text-[10px] bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded border border-indigo-100 dark:border-indigo-800/40 font-medium">Interactive Preview</span>
                </div>
                <div className="flex items-center gap-2">
                    {onSaveToKnowledge && (
                        <button
                            type="button"
                            onClick={() => onSaveToKnowledge(code)}
                            className="px-2.5 py-1 rounded-md bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-semibold transition-colors border border-indigo-200 dark:border-indigo-700/50 flex items-center gap-1.5 shadow-xs"
                            title="このダッシュボードをナレッジベースに保存してチームで共有"
                        >
                            <span>📚</span>
                            <span>ナレッジに保存</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="px-2 py-1 rounded-md text-gray-600 dark:text-gray-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white dark:hover:bg-gray-800 text-xs font-medium transition-colors border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
                        title={isExpanded ? "通常サイズに戻す" : "ウィジェットを縦に拡大表示"}
                    >
                        {isExpanded ? "縮小" : "拡大"}
                    </button>
                    {onOpen && (
                        <button
                            type="button"
                            onClick={() => {
                                const titleMatch = code.match(/<title>([^<]+)<\/title>/i) || code.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
                                const title = (titleMatch && titleMatch[1]) ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'AI Analytics ダッシュボード';
                                onOpen('live-concierge', 'live-concierge', 'Live Concierge', {
                                    initialKnowledgeTitle: title,
                                    initialRawHtml: code,
                                    triggerTs: Date.now()
                                });
                            }}
                            className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-xs"
                            title="Live Concierge を起動し、この HTML/SVG ダッシュボードを画面表示しながら音声解説を聞く"
                        >
                            <span>🎙️</span>
                            <span>Live解説</span>
                        </button>
                    )}
                    {onOpen && (
                        <button
                            type="button"
                            onClick={openInBrowserWindow}
                            className="px-2.5 py-1 rounded-md bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 text-xs font-semibold transition-colors border border-emerald-200 dark:border-emerald-800/50 flex items-center gap-1.5 shadow-xs"
                            title="Employee Agent デスクトップ内のBrowserウィンドウとして開く（リサイズ・スクロール対応）"
                        >
                            <span>🖥️</span>
                            <span>デスクトップで開く</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={openInNewTab}
                        className="px-2 py-1 rounded-md text-gray-600 dark:text-gray-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white dark:hover:bg-gray-800 text-xs font-medium transition-colors border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
                        title="別タブで全画面表示"
                    >
                        別タブ
                    </button>
                    <div className="flex bg-gray-200 dark:bg-gray-800 p-0.5 rounded-lg text-xs">
                        <button
                            type="button"
                            onClick={() => setViewMode('preview')}
                            className={`px-3 py-1 rounded-md transition-all font-medium ${viewMode === 'preview' ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
                        >
                            プレビュー
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode('code')}
                            className={`px-3 py-1 rounded-md transition-all font-medium ${viewMode === 'code' ? 'bg-white dark:bg-gray-700 text-indigo-600 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
                        >
                            HTMLコード
                        </button>
                    </div>
                </div>
            </div>
            {viewMode === 'preview' ? (
                <div className="w-full bg-slate-900/5 p-2 overflow-auto">
                    <iframe
                        ref={iframeRef}
                        onLoad={updateHeight}
                        srcDoc={preparedCode}
                        className={`w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white transition-all ${isExpanded ? 'h-[800px]' : 'min-h-[500px] h-[520px]'}`}
                        sandbox="allow-scripts allow-same-origin allow-popups allow-modals allow-forms allow-downloads"
                        title="GenUI Preview"
                    />
                </div>
            ) : (
                <pre className="p-4 bg-gray-900 text-gray-100 text-xs overflow-x-auto m-0">
                    <code>{code}</code>
                </pre>
            )}
        </div>
    );
};

export default React.memo(HtmlPreviewCodeBlock);
