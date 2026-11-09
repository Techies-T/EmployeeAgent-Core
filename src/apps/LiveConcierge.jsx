import React, { useState, useEffect, useRef } from 'react';
import { AudioRecorder, AudioPlayer } from '../utils/audioStreamer';
import { ScreenCaptureManager } from '../utils/screenCapture';

const AVAILABLE_VOICES = [
    { id: 'Puck', name: 'Puck (快活・親しみやすい男声)' },
    { id: 'Kore', name: 'Kore (落ち着いた知的な女声)' },
    { id: 'Aoede', name: 'Aoede (明瞭でクリアな女声)' },
    { id: 'Fenrir', name: 'Fenrir (重厚で信頼感のある男声)' }
];

const LiveConcierge = ({ onOpen: _onOpen, user: _user, initialKnowledgeId, initialKnowledgeTitle, initialRawHtml, triggerTs }) => {
    // 接続状態
    const [connectionStatus, setConnectionStatus] = useState('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'error'
    const [statusMessage, setStatusMessage] = useState('接続待機中');
    const [activeModel, setActiveModel] = useState('');
    const [selectedModel, setSelectedModel] = useState('');
    const [availableModels, setAvailableModels] = useState([]);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [customModelName, setCustomModelName] = useState('');
    const [isCustomMode, setIsCustomMode] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('Kore');
    const [isConfigOpen, setIsConfigOpen] = useState(false);

    // ナレッジデータベース & 内蔵HTML/SVGダッシュボード連携状態
    const [knowledgeList, setKnowledgeList] = useState([]);
    const [selectedKnowledgeId, setSelectedKnowledgeId] = useState(initialKnowledgeId ? String(initialKnowledgeId) : '');
    const [currentKnowledge, setCurrentKnowledge] = useState(
        initialRawHtml
            ? { id: null, title: initialKnowledgeTitle || 'AI Analytics ダッシュボード', rawHtml: initialRawHtml, tags: ['MCP Direct'] }
            : (initialKnowledgeId ? { id: initialKnowledgeId, title: initialKnowledgeTitle || '読み込み中...' } : null)
    );
    const [activeDashboardTab, setActiveDashboardTab] = useState('');
    const [isDashboardExpanded, setIsDashboardExpanded] = useState(true);
    const [isToolExecuting, setIsToolExecuting] = useState(false);
    const [executingToolLabel, setExecutingToolLabel] = useState('');

    // デバイス状態
    const [isMicActive, setIsMicActive] = useState(false);
    const [isScreenActive, setIsScreenActive] = useState(false);
    const [screenPreviewUrl, setScreenPreviewUrl] = useState(null);

    // 音量レベル (0 ~ 100)
    const [userVolume, setUserVolume] = useState(0);
    const [aiVolume, setAiVolume] = useState(0);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);

    // 字幕・トランスクリプト
    const [transcripts, setTranscripts] = useState([
        {
            role: 'assistant',
            text: initialKnowledgeTitle
                ? `ダッシュボード「${initialKnowledgeTitle}」を表示しています。画面のタブ構成に沿って音声で解説します（マイクをONにすると質問も可能です）。`
                : 'こんにちは！Employee Agent Live Concierge です。上部の「対象ナレッジ」を選択すると、この画面内にHTML/SVGダッシュボードを表示してタブ操作を案内しながら音声解説します。',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
    ]);
    const [currentAiStreamingText, setCurrentAiStreamingText] = useState('');
    const [manualText, setManualText] = useState('');

    // インスタンス Refs
    const wsRef = useRef(null);
    const audioRecorderRef = useRef(null);
    const audioPlayerRef = useRef(null);
    const screenCaptureRef = useRef(null);
    const transcriptEndRef = useRef(null);

    // 自動スクロール
    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [transcripts, currentAiStreamingText]);

    // 初期化: Gemini API から動的にモデル一覧を取得 (ハードコード禁止原則に準拠)
    useEffect(() => {
        setIsLoadingModels(true);
        fetch('/api/gemini-live/models')
            .then(res => res.json())
            .then(data => {
                if (data.models && Array.isArray(data.models)) {
                    setAvailableModels(data.models);
                }
                const initialModel = data.currentModel || (data.models && data.models[0]?.id) || '';
                if (initialModel) {
                    setSelectedModel(initialModel);
                    setActiveModel(initialModel);
                    const matched = (data.models || []).some(m => m.id === initialModel);
                    if (!matched && initialModel) {
                        setIsCustomMode(true);
                        setCustomModelName(initialModel);
                    }
                }
            })
            .catch(err => {
                console.error('[LiveConcierge] Failed to load models from API:', err);
            })
            .finally(() => {
                setIsLoadingModels(false);
            });
    }, []);

    // 初期化: 参照可能なナレッジ記事一覧の取得
    useEffect(() => {
        fetch('/api/gemini-live/knowledge/list')
            .then(res => res.json())
            .then(data => {
                if (data.articles && Array.isArray(data.articles)) {
                    setKnowledgeList(data.articles);
                    if (selectedKnowledgeId) {
                        fetch(`/api/gemini-live/knowledge/${selectedKnowledgeId}`)
                            .then(r => r.ok ? r.json() : null)
                            .then(detail => {
                                if (detail) {
                                    setCurrentKnowledge(detail);
                                    if (detail.uiTabs && detail.uiTabs.length > 0) {
                                        setActiveDashboardTab(detail.uiTabs[0]);
                                    }
                                }
                            })
                            .catch(() => {});
                    }
                }
            })
            .catch(err => {
                console.error('[LiveConcierge] Failed to load knowledge list:', err);
            });
    }, []);

    // 外部 props (initialKnowledgeId) が変更された場合の動的ロード
    useEffect(() => {
        if (initialKnowledgeId && String(initialKnowledgeId) !== selectedKnowledgeId) {
            setSelectedKnowledgeId(String(initialKnowledgeId));
            handleSelectKnowledge(String(initialKnowledgeId), true);
        }
    }, [initialKnowledgeId]);

    // 外部 props (initialRawHtml: MCPチャットの[Live解説]ボタン) が渡された場合の動的ロード
    useEffect(() => {
        if (initialRawHtml) {
            setSelectedKnowledgeId('');
            setCurrentKnowledge({
                id: null,
                title: initialKnowledgeTitle || 'AI Analytics ダッシュボード',
                rawHtml: initialRawHtml,
                tags: ['MCP Direct']
            });
            setActiveDashboardTab('');
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'load_raw_html',
                    title: initialKnowledgeTitle || 'AI Analytics ダッシュボード',
                    rawHtml: initialRawHtml
                }));
            }
        }
    }, [initialRawHtml, triggerTs]);

    // 内蔵 HTML/SVG ダッシュボード iframe 内のタブクリックイベントを受信し、AI音声解説と同期
    useEffect(() => {
        const handleIframeMessage = (event) => {
            if (event.data && event.data.type === 'EA_LIVE_TAB_CHANGED' && event.data.tabName) {
                const tabName = String(event.data.tabName).trim();
                setActiveDashboardTab(tabName);
                setStatusMessage(`ダッシュボードの「${tabName}」タブを表示中`);
                setTranscripts(prev => [
                    ...prev,
                    {
                        role: 'user',
                        text: `🖱️ [画面操作] ダッシュボードの「${tabName}」タブを開きました`,
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    }
                ]);
                if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    audioPlayerRef.current?.unlock();
                    wsRef.current.send(JSON.stringify({
                        type: 'user_tab_changed',
                        tabName
                    }));
                }
            }
        };
        window.addEventListener('message', handleIframeMessage);
        return () => window.removeEventListener('message', handleIframeMessage);
    }, []);

    const handleSelectKnowledge = (knowledgeId, isSwitch = false) => {
        setSelectedKnowledgeId(knowledgeId);
        if (!knowledgeId) {
            setCurrentKnowledge(null);
            setActiveDashboardTab('');
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'load_knowledge',
                    knowledgeId: null
                }));
            }
            return;
        }

        // REST API から即座に HTML/SVG コンテンツとタブ構成を取得して画面表示
        fetch(`/api/gemini-live/knowledge/${knowledgeId}`)
            .then(r => r.ok ? r.json() : null)
            .then(detail => {
                if (detail) {
                    setCurrentKnowledge(detail);
                    setActiveDashboardTab((detail.uiTabs && detail.uiTabs.length > 0) ? detail.uiTabs[0] : '');
                }
            })
            .catch(() => {
                const matched = knowledgeList.find(k => k.id === Number(knowledgeId));
                if (matched) setCurrentKnowledge(matched);
            });

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            audioPlayerRef.current?.unlock();
            wsRef.current.send(JSON.stringify({
                type: 'load_knowledge',
                knowledgeId: Number(knowledgeId),
                isSwitch
            }));
        }
    };

    const saveLiveModelSetting = async (modelName) => {
        try {
            await fetch('/api/gemini-live/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName })
            });
            console.log(`[LiveConcierge] Dedicated Live model saved: ${modelName} (GEMINI_MODEL unchanged)`);

            // 接続中のセッションにも再適用
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'init_session',
                    model: modelName,
                    voiceName: selectedVoice,
                    initialKnowledgeId: selectedKnowledgeId ? Number(selectedKnowledgeId) : undefined
                }));
            }
        } catch (err) {
            console.error('[LiveConcierge] Error saving dedicated live model:', err);
        }
    };

    const handleModelSelect = async (modelId) => {
        if (modelId === 'custom') {
            setIsCustomMode(true);
            return;
        }
        setIsCustomMode(false);
        setSelectedModel(modelId);
        setActiveModel(modelId);
        await saveLiveModelSetting(modelId);
    };

    const handleCustomModelApply = async () => {
        if (!customModelName.trim()) return;
        const clean = customModelName.trim();
        setSelectedModel(clean);
        setActiveModel(clean);
        await saveLiveModelSetting(clean);
    };

    // WebSocket 接続確立
    const connectWebSocket = (overrideModel = null) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

        setConnectionStatus('connecting');
        setStatusMessage('Gemini Live API に接続中...');

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/gemini-live`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('[LiveConcierge] WebSocket connected.');
            setConnectionStatus('connected');
            setStatusMessage('接続完了。初期セットアップを送信中...');

            const modelToUse = overrideModel || selectedModel;
            // 初期セッションパラメータを送信 (専用Liveモデルと対象ナレッジまたはMCP直接HTMLを指定)
            ws.send(JSON.stringify({
                type: 'init_session',
                model: modelToUse,
                voiceName: selectedVoice,
                initialKnowledgeId: selectedKnowledgeId ? Number(selectedKnowledgeId) : undefined,
                initialKnowledgeTitle: initialKnowledgeTitle || undefined,
                initialRawHtml: (!selectedKnowledgeId && initialRawHtml) ? initialRawHtml : undefined
            }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'ready') {
                    setActiveModel(data.model || 'Gemini 3.8 Live');
                    setStatusMessage('準備完了。画面共有またはマイクを開始してください。');
                    return;
                }

                if (data.type === 'error') {
                    console.error('[LiveConcierge] Error from server:', data.message);
                    setStatusMessage(`エラー: ${data.message}`);
                    setConnectionStatus('error');
                    return;
                }

                if (data.type === 'knowledge_loaded') {
                    setCurrentKnowledge(prev => ({
                        ...(prev || {}),
                        ...data.knowledge,
                        rawHtml: data.knowledge.rawHtml || prev?.rawHtml || null,
                        rawContent: data.knowledge.rawContent || prev?.rawContent || null,
                        uiTabs: data.knowledge.uiTabs || prev?.uiTabs || []
                    }));
                    if (data.knowledge.uiTabs && data.knowledge.uiTabs.length > 0) {
                        setActiveDashboardTab(data.knowledge.uiTabs[0]);
                    }
                    setStatusMessage(`ダッシュボード「${data.knowledge.title}」を表示・読み込みました`);
                    return;
                }

                if (data.type === 'knowledge_unloaded') {
                    setCurrentKnowledge(null);
                    setActiveDashboardTab('');
                    setStatusMessage('ナレッジ選択を解除しました');
                    return;
                }

                if (data.type === 'tool_execution') {
                    const toolNames = (data.functionCalls || []).map(f => f.name);
                    let label = 'ナレッジを参照中...';
                    if (toolNames.includes('search_knowledge_articles')) label = 'ナレッジデータベースを検索中...';
                    if (toolNames.includes('get_knowledge_article')) label = '詳細レポートを取得中...';
                    if (toolNames.includes('list_recent_knowledge')) label = '最新レポート一覧を取得中...';
                    setExecutingToolLabel(label);
                    setIsToolExecuting(true);
                    setTimeout(() => setIsToolExecuting(false), 3500);
                    return;
                }

                // Gemini からのマルチモーダルレスポンス
                if (data.serverContent) {
                    const modelTurn = data.serverContent.modelTurn;
                    if (modelTurn && modelTurn.parts) {
                        for (const part of modelTurn.parts) {
                            // 音声チャンクの再生
                            if (part.inlineData && part.inlineData.data) {
                                if (audioPlayerRef.current) {
                                    audioPlayerRef.current.ensureContext();
                                    audioPlayerRef.current.playChunk(part.inlineData.data);
                                }
                                setIsAiSpeaking(true);
                                // テキストが未受信の場合のプレースホルダー案内
                                setCurrentAiStreamingText(prev => prev || '🔊 [AI音声応答中...]');
                            }
                            // テキスト字幕のストリーミング蓄積
                            if (part.text) {
                                setCurrentAiStreamingText(prev => {
                                    if (prev === '🔊 [AI音声応答中...]') return part.text;
                                    return prev + part.text;
                                });
                            }
                        }
                    }

                    // ユーザーの割り込み（バージイン）検知
                    if (data.serverContent.interrupted) {
                        console.log('[LiveConcierge] AI speech interrupted by user.');
                        if (audioPlayerRef.current) {
                            audioPlayerRef.current.stop();
                        }
                        setIsAiSpeaking(false);
                        setCurrentAiStreamingText('');
                    }

                    // ターン完了（AIの発話完了）
                    if (data.serverContent.turnComplete) {
                        setCurrentAiStreamingText(prev => {
                            const textToRecord = prev.trim() || '🔊 [音声応答完了]';
                            setTranscripts(list => [
                                ...list,
                                {
                                    role: 'assistant',
                                    text: textToRecord,
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                }
                            ]);
                            return '';
                        });
                        setTimeout(() => setIsAiSpeaking(false), 500);
                    }
                }
            } catch (err) {
                console.error('[LiveConcierge] Message parse error:', err);
            }
        };

        ws.onerror = (err) => {
            console.error('[LiveConcierge] WebSocket error:', err);
            setConnectionStatus('error');
            setStatusMessage('WebSocket通信エラーが発生しました。');
        };

        ws.onclose = () => {
            console.log('[LiveConcierge] WebSocket disconnected.');
            setConnectionStatus('disconnected');
            setStatusMessage('切断されました。');
            stopAllMedia();
        };
    };

    // すべてのメディアとソケットを切断
    const disconnectAll = () => {
        stopAllMedia();
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setConnectionStatus('disconnected');
        setStatusMessage('切断中');
    };

    const stopAllMedia = () => {
        if (audioRecorderRef.current) {
            audioRecorderRef.current.stop();
        }
        if (audioPlayerRef.current) {
            audioPlayerRef.current.stop();
        }
        if (screenCaptureRef.current) {
            screenCaptureRef.current.stopCapture();
        }
        setIsMicActive(false);
        setIsScreenActive(false);
        setScreenPreviewUrl(null);
        setUserVolume(0);
        setAiVolume(0);
        setIsAiSpeaking(false);
    };

    // マイクのトグル
    const toggleMic = async () => {
        // Safari 等の AudioContext を同期的にアンロック
        audioPlayerRef.current?.unlock();

        if (isMicActive) {
            if (audioRecorderRef.current) audioRecorderRef.current.stop();
            setIsMicActive(false);
            setUserVolume(0);
        } else {
            if (connectionStatus !== 'connected') {
                connectWebSocket();
            }
            try {
                if (!audioRecorderRef.current) {
                    audioRecorderRef.current = new AudioRecorder({
                        onAudioData: (base64Pcm) => {
                            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                                wsRef.current.send(JSON.stringify({
                                    realtimeInput: {
                                        mediaChunks: [
                                            {
                                                mimeType: 'audio/pcm;rate=16000',
                                                data: base64Pcm
                                            }
                                        ]
                                    }
                                }));
                            }
                        },
                        onSpeechTurnComplete: (base64Pcm) => {
                            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                                console.log('[LiveConcierge] Committing voice turn via clientContent...');
                                setStatusMessage('発話を検出しました。AIが音声応答を生成中...');
                                setTranscripts(prev => [
                                    ...prev,
                                    {
                                        role: 'user',
                                        text: '🎙️ (音声発話)',
                                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                    }
                                ]);
                                wsRef.current.send(JSON.stringify({
                                    clientContent: {
                                        turns: [
                                            {
                                                role: 'user',
                                                parts: [
                                                    {
                                                        inlineData: {
                                                            mimeType: 'audio/pcm;rate=16000',
                                                            data: base64Pcm
                                                        }
                                                    }
                                                ]
                                            }
                                        ],
                                        turnComplete: true
                                    }
                                }));
                            }
                        },
                        onVolumeChange: (vol) => setUserVolume(vol)
                    });
                }
                await audioRecorderRef.current.start();
                setIsMicActive(true);
            } catch (err) {
                alert(`マイクの起動に失敗しました: ${err.message}`);
            }
        }
    };

    // 画面共有のトグル
    const toggleScreen = async () => {
        // Safari 等の AudioContext をアンロック
        audioPlayerRef.current?.unlock();

        if (isScreenActive) {
            if (screenCaptureRef.current) screenCaptureRef.current.stopCapture();
            setIsScreenActive(false);
            setScreenPreviewUrl(null);
        } else {
            if (connectionStatus !== 'connected') {
                connectWebSocket();
            }
            try {
                if (!screenCaptureRef.current) {
                    screenCaptureRef.current = new ScreenCaptureManager({
                        onFrame: ({ base64Data, previewUrl }) => {
                            setScreenPreviewUrl(previewUrl);
                            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                                wsRef.current.send(JSON.stringify({
                                    realtimeInput: {
                                        mediaChunks: [
                                            {
                                                mimeType: 'image/jpeg',
                                                data: base64Data
                                            }
                                        ]
                                    }
                                }));
                            }
                        },
                        onStopped: () => {
                            setIsScreenActive(false);
                            setScreenPreviewUrl(null);
                        }
                    });
                }
                await screenCaptureRef.current.startCapture(1); // 1 FPS でキャプチャ
                setIsScreenActive(true);
            } catch (err) {
                console.log('Screen capture cancelled or failed:', err.message);
            }
        }
    };

    // テキストでの手動送信
    const handleSendText = (e) => {
        e?.preventDefault();
        if (!manualText.trim()) return;

        const textToSend = manualText.trim();
        setManualText('');

        // ログに追加
        setTranscripts(prev => [
            ...prev,
            {
                role: 'user',
                text: textToSend,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            }
        ]);

        // Safari 等の AudioContext をアンロック
        audioPlayerRef.current?.unlock();

        // Gemini Live へテキスト送信 (Google Multimodal Live API clientContent 仕様準拠)
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                clientContent: {
                    turns: [
                        {
                            role: 'user',
                            parts: [{ text: textToSend }]
                        }
                    ],
                    turnComplete: true
                }
            }));
        }
    };

    // 初期化: AudioPlayer の生成 & 自動接続
    useEffect(() => {
        audioPlayerRef.current = new AudioPlayer({
            onVolumeChange: (vol) => setAiVolume(vol),
            onPlaybackStateChange: (speaking) => setIsAiSpeaking(speaking)
        });

        // 自動接続
        connectWebSocket();

        return () => {
            disconnectAll();
        };
    }, []);

    // 声の設定が変更された場合
    const handleVoiceChange = (voiceId) => {
        setSelectedVoice(voiceId);
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'init_session',
                voiceName: voiceId
            }));
        }
    };

    // 内蔵 HTML/SVG ダッシュボード用の srcDoc 生成（タブ操作検知ブリッジ & 未完結タグ補完付き）
    const preparedDashboardHtml = React.useMemo(() => {
        const raw = currentKnowledge?.rawHtml;
        if (!raw) return '';
        let sanitized = raw;
        const scriptOpenCount = (sanitized.match(/<script\b[^>]*>/gi) || []).length;
        const scriptCloseCount = (sanitized.match(/<\/script>/gi) || []).length;
        if (scriptOpenCount > scriptCloseCount) {
            sanitized += '\n;/* unclosed block auto-recovery */\n</script></body></html>';
        }

        const bridgeScript = `
<script>
window.onerror = function(msg) {
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
        document.addEventListener('DOMContentLoaded', function() { setTimeout(fireReady, 50); });
        window.addEventListener('load', function() { setTimeout(fireReady, 50); });
    }

    // ユーザーがダッシュボード内のタブボタンをクリックした際に親(LiveConcierge)へ通知してAI解説を同期
    document.addEventListener('click', function(e) {
        var btn = e.target && e.target.closest ? e.target.closest('button, [role="tab"], [data-tab]') : null;
        if (!btn) return;
        var onclickAttr = btn.getAttribute('onclick') || '';
        var idAttr = btn.getAttribute('id') || '';
        var roleAttr = btn.getAttribute('role') || '';
        var hasDataTab = btn.hasAttribute('data-tab');
        if (/switchTab|showTab|changeTab|openTab|selectTab/i.test(onclickAttr) || /^tab-/i.test(idAttr) || roleAttr === 'tab' || hasDataTab) {
            var label = (btn.innerText || btn.textContent || '').replace(/\\s+/g, ' ').trim();
            if (label && window.parent) {
                window.parent.postMessage({ type: 'EA_LIVE_TAB_CHANGED', tabName: label }, '*');
            }
        }
    }, true);
})();
</script>
`;
        if (sanitized.includes('<head>')) {
            return sanitized.replace('<head>', `<head>${bridgeScript}`);
        }
        if (sanitized.includes('</body>')) {
            return sanitized.replace('</body>', `${bridgeScript}</body>`);
        }
        return bridgeScript + sanitized;
    }, [currentKnowledge?.rawHtml]);

    return (
        <div 
            onClick={() => audioPlayerRef.current?.unlock()}
            className="w-full h-full flex flex-col bg-[#18181b] text-gray-100 font-sans select-none overflow-hidden"
        >
            {/* Header Toolbar */}
            <div className="flex-none px-4 py-3 bg-[#202024] border-b border-gray-800 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center shadow-md shadow-indigo-500/20">
                        <span className="text-base">🎙️</span>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-xs font-bold text-gray-100 tracking-wide">Employee Agent Live Concierge</h2>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-900/60 text-indigo-300 font-mono border border-indigo-700/50">
                                {activeModel || 'Gemini 3.8 Flash Live'}
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={`w-2 h-2 rounded-full ${
                                connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                                connectionStatus === 'connecting' ? 'bg-amber-500 animate-ping' : 'bg-red-500'
                            }`}></span>
                            <span className="text-[11px] text-gray-400">{statusMessage}</span>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Live 専用モデルセレクター (他機能の通常モデル設定とは完全独立) */}
                    <div className="flex items-center gap-1.5 text-xs bg-gray-900/90 px-2.5 py-1 rounded-lg border border-gray-800" title="Live Concierge 専用モデル（他の通常チャット等の設定には一切影響しません）">
                        <span className="text-gray-400 text-[11px] flex items-center gap-1">
                            <span className="text-emerald-400">⚡</span>
                            <span>Liveモデル:</span>
                        </span>
                        {!isCustomMode ? (
                            <select
                                value={selectedModel}
                                onChange={(e) => handleModelSelect(e.target.value)}
                                disabled={isLoadingModels}
                                className="bg-transparent text-emerald-300 font-mono text-xs focus:outline-none cursor-pointer max-w-[280px] truncate"
                            >
                                {isLoadingModels && <option value="" className="bg-gray-900 text-gray-400">APIからモデル読込中...</option>}
                                {!isLoadingModels && availableModels.length === 0 && (
                                    <option value={selectedModel} className="bg-gray-900 text-gray-200">{selectedModel || 'モデル未選択'}</option>
                                )}
                                {availableModels.map(m => (
                                    <option key={m.id} value={m.id} className="bg-gray-900 text-gray-200">
                                        {m.isLiveOptimized ? `⚡ ${m.displayName || m.name}` : (m.displayName || m.name)}
                                    </option>
                                ))}
                                <option value="custom" className="bg-gray-900 text-gray-400">＋ 手動指定...</option>
                            </select>
                        ) : (
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    value={customModelName}
                                    onChange={(e) => setCustomModelName(e.target.value)}
                                    placeholder="モデル名を入力..."
                                    className="bg-gray-950 text-emerald-300 font-mono text-[11px] px-1.5 py-0.5 rounded border border-gray-700 w-36 focus:outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={handleCustomModelApply}
                                    className="px-1.5 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] rounded font-medium"
                                >
                                    適用
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleModelSelect(availableModels[0]?.id || '')}
                                    className="text-gray-400 hover:text-gray-200 text-[10px]"
                                    title="一覧選択に戻る"
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                        <span className="text-[9px] bg-emerald-950/80 text-emerald-400 border border-emerald-800/40 px-1 py-0.2 rounded font-medium hidden lg:inline" title="この設定は本ウィジェット専用です">
                            独立設定
                        </span>
                    </div>

                    {/* Voice Selector */}
                    <div className="flex items-center gap-1.5 text-xs bg-gray-900/80 px-2.5 py-1 rounded-lg border border-gray-800">
                        <span className="text-gray-400 text-[11px]">音声:</span>
                        <select
                            value={selectedVoice}
                            onChange={(e) => handleVoiceChange(e.target.value)}
                            className="bg-transparent text-gray-200 text-xs focus:outline-none cursor-pointer"
                        >
                            {AVAILABLE_VOICES.map(v => (
                                <option key={v.id} value={v.id} className="bg-gray-900 text-gray-200">
                                    {v.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* 音声テスト (Safari Web Audio アンロック用) */}
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            audioPlayerRef.current?.playTestSound();
                        }}
                        className="text-xs px-2.5 py-1 rounded-lg bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 transition-colors border border-indigo-700/60 flex items-center gap-1.5 shadow-xs font-medium cursor-pointer"
                        title="クリックしてMacのスピーカーからテスト音（ピロリン♪）を鳴らします。Safariの自動再生制限も同時に解除されます。"
                    >
                        <span>🔊</span>
                        <span>音声テスト</span>
                    </button>

                    {connectionStatus === 'connected' ? (
                        <button
                            type="button"
                            onClick={disconnectAll}
                            className="text-xs px-2.5 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors border border-gray-700"
                        >
                            切断
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={connectWebSocket}
                            className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors shadow-xs"
                        >
                            再接続
                        </button>
                    )}
                </div>
            </div>

            {/* Knowledge Base Integration Sub-Toolbar */}
            <div className="flex-none px-4 py-2 bg-[#1c1c20] border-b border-gray-800/80 flex items-center justify-between text-xs flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 text-indigo-400 font-medium shrink-0">
                        <span>📚</span>
                        <span>対象ナレッジ:</span>
                    </span>
                    <select
                        value={selectedKnowledgeId}
                        onChange={(e) => handleSelectKnowledge(e.target.value, true)}
                        className="bg-gray-900 text-gray-200 border border-gray-700 rounded-md px-2.5 py-1 text-xs focus:outline-none focus:border-indigo-500 max-w-[360px] truncate cursor-pointer shadow-xs"
                    >
                        <option value="">なし（一般的なデスクトップ操作案内）</option>
                        {knowledgeList.map(k => (
                            <option key={k.id} value={k.id}>
                                #{k.id} {k.title}
                            </option>
                        ))}
                    </select>
                    {currentKnowledge && (
                        <div className="flex items-center gap-1.5 shrink-0 overflow-hidden text-ellipsis">
                            <span className="text-[10px] bg-indigo-950/80 text-indigo-300 border border-indigo-800/50 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                <span>読込完了</span>
                            </span>
                            {currentKnowledge.tags && Array.isArray(currentKnowledge.tags) && currentKnowledge.tags.slice(0, 2).map((t, idx) => (
                                <span key={idx} className="text-[9px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded hidden sm:inline">
                                    {t}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* ツール実行中インジケーター (AIが自律検索・ナレッジ取得中) */}
                {isToolExecuting && (
                    <div className="flex items-center gap-1.5 bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 px-2.5 py-0.5 rounded-full text-[11px] animate-pulse shrink-0">
                        <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                        <span className="font-medium">{executingToolLabel || 'ナレッジを参照中...'}</span>
                    </div>
                )}
            </div>

            {/* Main Stage Area: 内蔵 HTML/SVG ダッシュボード または 画面共有プレビュー & 波形ビジュアライザー */}
            <div className="flex-none p-4 bg-gradient-to-b from-[#202024] to-[#18181b] border-b border-gray-800">
                <div className={`grid gap-4 ${preparedDashboardHtml && isDashboardExpanded ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
                    {/* 左ステージ: 内蔵 HTML/SVG ダッシュボード (ナレッジ選択時・MCP直行時) または 画面共有プレビュー */}
                    <div className={`relative ${preparedDashboardHtml ? (isDashboardExpanded ? 'h-[360px] sm:h-[420px]' : 'h-[260px]') : 'aspect-video'} bg-black/60 rounded-xl overflow-hidden border border-gray-800/80 flex flex-col items-center justify-center group shadow-inner`}>
                        {preparedDashboardHtml && !isScreenActive ? (
                            <div className="w-full h-full flex flex-col bg-white">
                                {/* ダッシュボード上部同期バー */}
                                <div className="flex-none px-3 py-1.5 bg-[#1e1e24] text-gray-200 border-b border-gray-800 flex items-center justify-between text-[11px] gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold shrink-0">
                                            📊 HTML/SVG 同期表示
                                        </span>
                                        <span className="font-semibold text-gray-100 truncate">
                                            {currentKnowledge?.title || 'ダッシュボード'}
                                        </span>
                                        {activeDashboardTab && (
                                            <span className="px-2 py-0.5 rounded-full bg-emerald-950/90 text-emerald-300 border border-emerald-700/60 text-[10px] font-medium shrink-0">
                                                表示タブ: {activeDashboardTab}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => setIsDashboardExpanded(prev => !prev)}
                                            className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 text-[10px] font-medium transition-colors"
                                            title={isDashboardExpanded ? '2カラム表示に戻す' : 'ダッシュボードを横幅いっぱいに拡大表示'}
                                        >
                                            {isDashboardExpanded ? '◫ 2カラム表示' : '⤢ 拡大表示'}
                                        </button>
                                    </div>
                                </div>
                                {/* インタラクティブ HTML/SVG ダッシュボード本体 (Browserウィジェット不要でタブ操作・Chart.js描画が動作) */}
                                <iframe
                                    title={currentKnowledge?.title || 'Knowledge HTML/SVG Dashboard'}
                                    srcDoc={preparedDashboardHtml}
                                    className="w-full flex-1 border-0 bg-white"
                                    sandbox="allow-scripts allow-same-origin"
                                />
                            </div>
                        ) : isScreenActive && screenPreviewUrl ? (
                            <>
                                <img
                                    src={screenPreviewUrl}
                                    alt="Screen Share Preview"
                                    className="w-full h-full object-contain"
                                />
                                <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded text-[10px] text-emerald-400 font-mono border border-emerald-500/30 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                    <span>AI Vision Streaming (1 FPS)</span>
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center text-gray-500 p-4 text-center">
                                <div className="w-12 h-12 rounded-full bg-gray-800/80 flex items-center justify-center mb-2 text-xl">
                                    📊
                                </div>
                                <p className="text-xs font-medium text-gray-300">上部の「対象ナレッジ」を選択すると、ここにHTML/SVG画面が表示されます</p>
                                <p className="text-[11px] text-gray-500 mt-1 max-w-xs">
                                    Browserウィジェット不要でダッシュボード内のタブを切り替えながら、AIの音声解説を聞くことができます。
                                </p>
                            </div>
                        )}
                    </div>

                    {/* 音声波形ビジュアライザー & アナリスト状態 */}
                    <div className="bg-[#202024]/80 rounded-xl p-4 border border-gray-800/80 flex flex-col justify-between">
                        <div>
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                                    <span className="text-indigo-400">⚡</span>
                                    <span>マルチモーダル対話ステータス</span>
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                                    isAiSpeaking ? 'bg-purple-900/60 text-purple-300 border border-purple-700/50 animate-pulse' :
                                    isMicActive && userVolume > 5 ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 animate-pulse' :
                                    'bg-gray-800 text-gray-400'
                                }`}>
                                    {isAiSpeaking ? 'AIが話しています 🔊' : isMicActive && userVolume > 5 ? 'あなたが話しています 🎙️' : '対話待機中'}
                                </span>
                            </div>

                            {/* 音声ビジュアライザー波形 */}
                            <div className={`${preparedDashboardHtml && isDashboardExpanded ? 'h-12' : 'h-20'} bg-black/40 rounded-lg flex items-center justify-center gap-1.5 px-4 overflow-hidden border border-gray-800`}>
                                {[...Array(24)].map((_, i) => {
                                    // AI発話時またはユーザー発話時の動的波形高さ
                                    const baseVol = isAiSpeaking ? aiVolume : (isMicActive ? userVolume : 2);
                                    const factor = Math.sin((i / 24) * Math.PI) * 1.5;
                                    const barHeight = Math.min(64, Math.max(6, Math.round(baseVol * factor * 0.8)));

                                    return (
                                        <div
                                            key={i}
                                            className={`w-1.5 rounded-full transition-all duration-75 ${
                                                isAiSpeaking ? 'bg-gradient-to-t from-indigo-500 to-pink-500' :
                                                isMicActive && userVolume > 5 ? 'bg-gradient-to-t from-emerald-500 to-teal-400' :
                                                'bg-gray-700/60'
                                            }`}
                                            style={{ height: `${barHeight}px` }}
                                        />
                                    );
                                })}
                            </div>
                        </div>

                        {/* クイックヒント */}
                        <div className="text-[11px] text-gray-400 bg-gray-900/60 p-2.5 rounded-lg border border-gray-800/60 mt-3 flex items-start gap-2">
                            <span className="text-amber-400">💡</span>
                            <span>
                                <strong>操作同期ナビ:</strong> AIが「〇〇タブを開いてご覧ください」と案内します。また、あなたがダッシュボード内のタブをクリックして切り替えると、AIも自動的にそのタブの解説へ切り替わります。
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Transcript & Chat History Area */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5 scrollbar-thin">
                {transcripts.map((t, idx) => (
                    <div
                        key={idx}
                        className={`flex gap-3 ${t.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                    >
                        <div className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                            t.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-gradient-to-tr from-indigo-600 to-purple-600 text-white shadow-xs'
                        }`}>
                            {t.role === 'user' ? 'You' : 'AI'}
                        </div>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                            t.role === 'user'
                                ? 'bg-emerald-600/90 text-white rounded-tr-none'
                                : 'bg-[#252528] text-gray-200 border border-gray-800 rounded-tl-none shadow-xs'
                        }`}>
                            <p className="whitespace-pre-wrap">{t.text}</p>
                            <span className="block text-[9px] text-gray-400/80 mt-1 text-right">{t.timestamp}</span>
                        </div>
                    </div>
                ))}

                {/* リアルタイムストリーミング中の字幕 */}
                {currentAiStreamingText && (
                    <div className="flex gap-3">
                        <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold bg-gradient-to-tr from-indigo-600 to-purple-600 text-white animate-pulse">
                            AI
                        </div>
                        <div className="max-w-[80%] rounded-2xl rounded-tl-none px-4 py-2.5 text-xs leading-relaxed bg-[#252528] text-gray-100 border border-indigo-500/40 shadow-xs">
                            <p className="whitespace-pre-wrap">{currentAiStreamingText}</p>
                            <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-1"></span>
                        </div>
                    </div>
                )}
                <div ref={transcriptEndRef} />
            </div>

            {/* Bottom Controls Bar */}
            <div className="flex-none p-3.5 bg-[#202024] border-t border-gray-800">
                <div className="flex items-center gap-3">
                    {/* 画面共有ボタン */}
                    <button
                        type="button"
                        onClick={toggleScreen}
                        className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all shadow-xs border ${
                            isScreenActive
                                ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
                                : 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500 shadow-indigo-600/20'
                        }`}
                        title="画面をAIにリアルタイムで共有して視覚認識させます"
                    >
                        <span>{isScreenActive ? '🛑' : '🖥️'}</span>
                        <span>{isScreenActive ? '画面共有を停止' : '画面共有を開始'}</span>
                    </button>

                    {/* マイクボタン */}
                    <button
                        type="button"
                        onClick={toggleMic}
                        className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all shadow-xs border ${
                            isMicActive
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30 ring-2 ring-emerald-500/30'
                                : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                        }`}
                        title="マイクをONにして声で話しかけます"
                    >
                        <span>{isMicActive ? '🎙️' : '🔇'}</span>
                        <span>{isMicActive ? 'マイク: ON' : 'マイク: OFF'}</span>
                    </button>

                    {/* テキスト入力フォーム（マイクが使えない時の予備） */}
                    <form onSubmit={handleSendText} className="flex-1 flex items-center gap-2">
                        <input
                            type="text"
                            value={manualText}
                            onChange={(e) => setManualText(e.target.value)}
                            placeholder="声またはテキストで質問..."
                            className="flex-1 bg-gray-900/90 border border-gray-700/80 rounded-xl px-3.5 py-2 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                        />
                        <button
                            type="submit"
                            disabled={!manualText.trim()}
                            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white rounded-xl text-xs font-semibold transition-all flex items-center gap-1 shadow-xs"
                        >
                            <span>送信</span>
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};

export default LiveConcierge;
