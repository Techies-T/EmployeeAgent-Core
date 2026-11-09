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
    const [isDashboardExpanded, setIsDashboardExpanded] = useState(false);
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
        if (/switchTab|showTab|changeTab|openTab|selectTab|setYear|setLeague|setView|setCategory/i.test(onclickAttr) || /^(?:tab-|btn-)/i.test(idAttr) || roleAttr === 'tab' || hasDataTab) {
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
            {/* Compact Header Toolbar (対象ナレッジ選択 + モデル/音声設定を省スペース集約) */}
            <div className="flex-none px-3 py-1.5 bg-[#202024] border-b border-gray-800 flex items-center justify-between gap-2 flex-wrap shadow-xs">
                {/* 左側: タイトル・接続状態・対象ナレッジ選択 */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="w-6 h-6 rounded-lg bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center shadow-sm">
                            <span className="text-xs">🎙️</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${
                                connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                                connectionStatus === 'connecting' ? 'bg-amber-500 animate-ping' : 'bg-red-500'
                            }`} title={statusMessage}></span>
                            <h2 className="text-xs font-bold text-gray-100 tracking-wide hidden sm:inline">Live Concierge</h2>
                        </div>
                    </div>

                    <div className="h-4 w-px bg-gray-800 shrink-0 hidden sm:block" />

                    {/* 対象ナレッジ選択プルダウン */}
                    <div className="flex items-center gap-1.5 min-w-0 flex-1 max-w-xl">
                        <span className="flex items-center gap-1 text-indigo-400 text-[11px] font-semibold shrink-0">
                            <span>📚</span>
                            <span>対象ナレッジ:</span>
                        </span>
                        <select
                            value={selectedKnowledgeId}
                            onChange={(e) => handleSelectKnowledge(e.target.value, true)}
                            className="bg-gray-900 text-gray-100 border border-gray-700 rounded-md px-2 py-1 text-xs focus:outline-none focus:border-indigo-500 flex-1 min-w-[180px] truncate cursor-pointer shadow-xs"
                        >
                            <option value="">なし（一般的なデスクトップ操作案内）</option>
                            {knowledgeList.map(k => (
                                <option key={k.id} value={k.id}>
                                    #{k.id} {k.title}
                                </option>
                            ))}
                        </select>
                        {currentKnowledge && (
                            <span className="text-[10px] bg-indigo-950/80 text-indigo-300 border border-indigo-800/50 px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                <span>読込完了</span>
                            </span>
                        )}
                        {isToolExecuting && (
                            <span className="text-[10px] bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 px-2 py-0.5 rounded-full animate-pulse shrink-0">
                                {executingToolLabel || '参照中...'}
                            </span>
                        )}
                    </div>
                </div>

                {/* 右側: モデル・音声・テスト・接続制御 */}
                <div className="flex items-center gap-1.5 shrink-0">
                    <div className="flex items-center gap-1 text-[11px] bg-gray-900/90 px-2 py-0.5 rounded-md border border-gray-800" title="Live Concierge 専用モデル">
                        <span className="text-emerald-400">⚡</span>
                        {!isCustomMode ? (
                            <select
                                value={selectedModel}
                                onChange={(e) => handleModelSelect(e.target.value)}
                                disabled={isLoadingModels}
                                className="bg-transparent text-emerald-300 font-mono text-[11px] focus:outline-none cursor-pointer max-w-[170px] truncate"
                            >
                                {isLoadingModels && <option value="" className="bg-gray-900 text-gray-400">読込中...</option>}
                                {!isLoadingModels && availableModels.length === 0 && (
                                    <option value={selectedModel} className="bg-gray-900 text-gray-200">{selectedModel || '未選択'}</option>
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
                                    placeholder="モデル名..."
                                    className="bg-gray-950 text-emerald-300 font-mono text-[10px] px-1.5 py-0.5 rounded border border-gray-700 w-28 focus:outline-none"
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
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-1 text-[11px] bg-gray-900/80 px-2 py-0.5 rounded-md border border-gray-800">
                        <span className="text-gray-400 text-[10px]">声:</span>
                        <select
                            value={selectedVoice}
                            onChange={(e) => handleVoiceChange(e.target.value)}
                            className="bg-transparent text-gray-200 text-[11px] focus:outline-none cursor-pointer max-w-[115px] truncate"
                        >
                            {AVAILABLE_VOICES.map(v => (
                                <option key={v.id} value={v.id} className="bg-gray-900 text-gray-200">
                                    {v.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            audioPlayerRef.current?.playTestSound();
                        }}
                        className="text-[11px] px-2 py-0.5 rounded-md bg-indigo-950/80 hover:bg-indigo-900 text-indigo-300 transition-colors border border-indigo-700/60 flex items-center gap-1 cursor-pointer"
                        title="スピーカーテスト音（Safari自動再生ロック解除）"
                    >
                        <span>🔊</span>
                        <span className="hidden md:inline">テスト</span>
                    </button>

                    {connectionStatus === 'connected' ? (
                        <button
                            type="button"
                            onClick={disconnectAll}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors border border-gray-700"
                        >
                            切断
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={connectWebSocket}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
                        >
                            再接続
                        </button>
                    )}
                </div>
            </div>

            {/* Main Split Body: 左側 = 縦フルハイト HTML/SVG ダッシュボード領域 / 右側 = ステータス・波形・字幕チャット・操作パネル */}
            <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
                {/* 左カラム: HTML/SVG ダッシュボード または 画面共有ビューア（縦100%フルハイト表示） */}
                <div className="flex-1 min-w-0 h-full flex flex-col bg-[#111114] relative overflow-hidden">
                    {/* ダッシュボード上部スリムステータスバー */}
                    <div className="flex-none px-3 py-1 bg-[#1b1b20] text-gray-200 border-b border-gray-800 flex items-center justify-between text-[11px] gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white text-[10px] font-bold shrink-0">
                                📊 HTML/SVG 同期表示
                            </span>
                            <span className="font-semibold text-gray-100 truncate">
                                {currentKnowledge?.title || (isScreenActive ? '画面共有ストリーミング中' : '対象ナレッジを選択してください')}
                            </span>
                            {activeDashboardTab && (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-950/90 text-emerald-300 border border-emerald-700/60 text-[10px] font-medium shrink-0">
                                    表示タブ: {activeDashboardTab}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            {/* 右パネル収納時でもマイク操作・発話状態がすぐわかるクイックコントロール */}
                            {isDashboardExpanded && (
                                <button
                                    type="button"
                                    onClick={toggleMic}
                                    className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 border transition-colors ${
                                        isMicActive
                                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                            : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700'
                                    }`}
                                >
                                    <span>{isMicActive ? '🎙️ マイクON' : '🔇 マイクOFF'}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setIsDashboardExpanded(prev => !prev)}
                                className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 text-[10px] font-medium transition-colors cursor-pointer"
                                title={isDashboardExpanded ? '右側の対話ステータス・字幕パネルを表示する' : '右側のパネルを隠してHTML/SVGを横幅いっぱいに表示する'}
                            >
                                {isDashboardExpanded ? '◫ 対話パネルを表示' : '⤢ ダッシュボード全画面'}
                            </button>
                        </div>
                    </div>

                    {/* メインビューポート（縦一杯に HTML/SVG を表示） */}
                    <div className="flex-1 min-h-0 w-full relative flex items-center justify-center bg-black/50">
                        {preparedDashboardHtml && !isScreenActive ? (
                            <iframe
                                title={currentKnowledge?.title || 'Knowledge HTML/SVG Dashboard'}
                                srcDoc={preparedDashboardHtml}
                                className="w-full h-full border-0 bg-white"
                                sandbox="allow-scripts allow-same-origin"
                            />
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
                            <div className="flex flex-col items-center justify-center text-gray-400 p-6 text-center max-w-md">
                                <div className="w-14 h-14 rounded-2xl bg-gray-800/80 border border-gray-700/60 flex items-center justify-center mb-3 text-2xl shadow-inner">
                                    📊
                                </div>
                                <p className="text-sm font-semibold text-gray-200">
                                    {currentKnowledge ? `「${currentKnowledge.title}」のテキスト要約を読み込み済みです` : '上部の「📚 対象ナレッジ」を選択すると、ここにHTML/SVG画面が大きく表示されます'}
                                </p>
                                <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
                                    Browserウィジェットを開かなくても、この領域で縦長のHTML/SVGダッシュボードをスクロール・タブ切り替えしながら、右パネルのAI音声解説と同期して確認できます。
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                {/* 右カラム: マルチモーダル対話ステータス & 音声波形 & 字幕チャット履歴 & マイク/テキスト操作 */}
                {!isDashboardExpanded && (
                    <div className="w-[310px] lg:w-[340px] shrink-0 h-full flex flex-col bg-[#1c1c20] border-l border-gray-800 overflow-hidden">
                        {/* 1. コンパクト・マルチモーダル対話ステータス & スリム波形 */}
                        <div className="flex-none px-3 py-2.5 bg-[#202024]/90 border-b border-gray-800 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold text-gray-200 flex items-center gap-1.5">
                                    <span className="text-indigo-400">⚡</span>
                                    <span>マルチモーダル対話ステータス</span>
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                                    isAiSpeaking ? 'bg-purple-900/60 text-purple-300 border border-purple-700/50 animate-pulse' :
                                    isMicActive && userVolume > 5 ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 animate-pulse' :
                                    'bg-gray-800 text-gray-400'
                                }`}>
                                    {isAiSpeaking ? 'AIが話しています 🔊' : isMicActive && userVolume > 5 ? '発話中 🎙️' : '対話待機中'}
                                </span>
                            </div>

                            {/* スリム音声ビジュアライザー波形 (高さを h-7 に抑えて省スペース化) */}
                            <div className="h-7 bg-black/40 rounded-md flex items-center justify-center gap-1 px-3 overflow-hidden border border-gray-800/80">
                                {[...Array(20)].map((_, i) => {
                                    const baseVol = isAiSpeaking ? aiVolume : (isMicActive ? userVolume : 2);
                                    const factor = Math.sin((i / 20) * Math.PI) * 1.4;
                                    const barHeight = Math.min(22, Math.max(4, Math.round(baseVol * factor * 0.35)));

                                    return (
                                        <div
                                            key={i}
                                            className={`w-1 rounded-full transition-all duration-75 ${
                                                isAiSpeaking ? 'bg-gradient-to-t from-indigo-500 to-pink-500' :
                                                isMicActive && userVolume > 5 ? 'bg-gradient-to-t from-emerald-500 to-teal-400' :
                                                'bg-gray-700/60'
                                            }`}
                                            style={{ height: `${barHeight}px` }}
                                        />
                                    );
                                })}
                            </div>

                            {/* 操作同期ナビヒント */}
                            <div className="text-[10px] leading-snug text-gray-400 bg-gray-900/70 px-2.5 py-1.5 rounded-md border border-gray-800/70 flex items-start gap-1.5">
                                <span className="text-amber-400 shrink-0">💡</span>
                                <span>
                                    <strong className="text-gray-300">操作同期ナビ:</strong> AIが「〇〇タブを開いてご覧ください」と案内します。左画面のタブをクリックするとAI解説も自動で切り替わります。
                                </span>
                            </div>
                        </div>

                        {/* 2. 字幕・トランスクリプト履歴エリア (右カラム中央・縦スクロール) */}
                        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5 scrollbar-thin">
                            {transcripts.map((t, idx) => (
                                <div
                                    key={idx}
                                    className={`flex gap-2 ${t.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                                >
                                    <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${
                                        t.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-gradient-to-tr from-indigo-600 to-purple-600 text-white shadow-xs'
                                    }`}>
                                        {t.role === 'user' ? 'You' : 'AI'}
                                    </div>
                                    <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
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
                                <div className="flex gap-2">
                                    <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold bg-gradient-to-tr from-indigo-600 to-purple-600 text-white animate-pulse">
                                        AI
                                    </div>
                                    <div className="max-w-[85%] rounded-xl rounded-tl-none px-3 py-2 text-xs leading-relaxed bg-[#252528] text-gray-100 border border-indigo-500/40 shadow-xs">
                                        <p className="whitespace-pre-wrap">{currentAiStreamingText}</p>
                                        <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-1"></span>
                                    </div>
                                </div>
                            )}
                            <div ref={transcriptEndRef} />
                        </div>

                        {/* 3. 右カラム下部: 音声マイク・画面共有・テキスト質問入力 */}
                        <div className="flex-none p-2.5 bg-[#202024] border-t border-gray-800 space-y-2">
                            <div className="grid grid-cols-2 gap-1.5">
                                {/* マイクボタン */}
                                <button
                                    type="button"
                                    onClick={toggleMic}
                                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-xs border cursor-pointer ${
                                        isMicActive
                                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30 ring-1 ring-emerald-500/30'
                                            : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700'
                                    }`}
                                    title="マイクをONにして声で話しかけます"
                                >
                                    <span>{isMicActive ? '🎙️' : '🔇'}</span>
                                    <span>{isMicActive ? 'マイク: ON' : 'マイク: OFF'}</span>
                                </button>

                                {/* 画面共有ボタン */}
                                <button
                                    type="button"
                                    onClick={toggleScreen}
                                    className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-xs border cursor-pointer ${
                                        isScreenActive
                                            ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
                                            : 'bg-indigo-600/90 hover:bg-indigo-500 text-white border-indigo-500'
                                    }`}
                                    title="別ウィンドウの画面をAIにリアルタイム共有します"
                                >
                                    <span>{isScreenActive ? '🛑' : '🖥️'}</span>
                                    <span>{isScreenActive ? '共有停止' : '画面共有'}</span>
                                </button>
                            </div>

                            {/* テキスト入力フォーム */}
                            <form onSubmit={handleSendText} className="flex items-center gap-1.5">
                                <input
                                    type="text"
                                    value={manualText}
                                    onChange={(e) => setManualText(e.target.value)}
                                    placeholder="声またはテキストで質問..."
                                    className="flex-1 min-w-0 bg-gray-900/90 border border-gray-700/80 rounded-lg px-2.5 py-1.5 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                                />
                                <button
                                    type="submit"
                                    disabled={!manualText.trim()}
                                    className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-all shrink-0 shadow-xs"
                                >
                                    送信
                                </button>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default LiveConcierge;
