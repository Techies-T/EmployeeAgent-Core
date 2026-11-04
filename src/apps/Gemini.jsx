import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import WeatherForecastMap from './WeatherForecastMap';
import SaveToKnowledgeModal from '../components/SaveToKnowledgeModal';
import HtmlPreviewCodeBlock from '../components/HtmlPreviewCodeBlock';

const SLASH_COMMANDS = [];

const renderContextUsage = (usage, isDark = true) => {
    if (!usage) return null;
    const promptTokens = usage.promptTokenCount ?? usage.prompt_token_count ?? usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt_eval_count ?? 0;
    const responseTokens = usage.candidatesTokenCount ?? usage.candidates_token_count ?? usage.response_tokens ?? usage.candidates_tokens ?? usage.output_tokens ?? usage.eval_count ?? 0;
    const totalTokens = usage.totalTokenCount ?? usage.total_token_count ?? usage.total_tokens ?? (promptTokens + responseTokens);

    if (totalTokens === 0) return null;

    const limit = 1000000;
    const percentage = ((totalTokens / limit) * 100).toFixed(2);

    return (
        <div className={`mt-2 pt-2 border-t flex flex-wrap items-center justify-between gap-2 text-xs font-sans ${isDark ? 'border-white/10 text-white/80' : 'border-gray-200 text-gray-600'}`}>
            <span className="font-medium">
                📊 コンテキスト使用量: <span className={`font-mono font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{totalTokens.toLocaleString()}</span> / {limit.toLocaleString()} tokens ({percentage}%)
            </span>
            {(promptTokens > 0 || responseTokens > 0) && (
                <span className={`text-[11px] font-mono ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                    [入力: {promptTokens.toLocaleString()} / 出力: {responseTokens.toLocaleString()}]
                </span>
            )}
        </div>
    );
};

const renderSourceInfo = (sourceInfo) => {
    if (!sourceInfo) return null;

    if (sourceInfo.type === 'google_drive') {
        return (
            <div className="mt-2.5 pt-2 border-t border-white/10 flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/20 text-[10px]">📚</span>
                    <span>情報源: Google Drive (Personal RAG)</span>
                    {sourceInfo.sources && sourceInfo.sources.length > 0 && (
                        <span className="text-[10px] font-normal text-emerald-300 bg-emerald-900/60 px-2 py-0.5 rounded-full border border-emerald-500/30">
                            {sourceInfo.sources.length} 件のドキュメントを参照
                        </span>
                    )}
                </div>
                {sourceInfo.sources && sourceInfo.sources.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pl-5">
                        {sourceInfo.sources.map((s, idx) => (
                            <span key={idx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-black/40 border border-emerald-500/30 text-[11px] font-mono text-emerald-200">
                                📄 {s.name}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (sourceInfo.warning === 'RAG_EMPTY') {
        return (
            <div className="mt-2.5 pt-2 border-t border-amber-500/20 flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500/20 text-[10px]">⚠️</span>
                    <span>情報源: パブリック一般知識 (※ Google Drive 未同期)</span>
                </div>
                <p className="text-[11px] text-amber-200/80 pl-5">
                    対象フォルダに同期ファイルが存在しないため、Gemini のパブリック知識で回答しました。System Settings ＞ Personal RAG で同期を実行してください。
                </p>
            </div>
        );
    }

    if (sourceInfo.type === 'google_search') {
        return (
            <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-sky-500/20 text-[10px]">🌐</span>
                <span>情報源: Google Search (パブリックWeb検索)</span>
            </div>
        );
    }

    if (sourceInfo.type === 'anthropic_web_search') {
        return (
            <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center gap-1.5 text-xs font-semibold text-purple-300">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500/20 text-[10px]">🌐</span>
                <span>情報源: Anthropic Web Search (Claude パブリックWeb検索)</span>
            </div>
        );
    }

    if (sourceInfo.type === 'local_ai') {
        return (
            <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center gap-1.5 text-xs font-semibold text-indigo-300">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500/20 text-[10px]">🛡️</span>
                <span>情報源: Local Gemma 4 (完全社内完結)</span>
            </div>
        );
    }

    if (sourceInfo.type === 'general_knowledge') {
        return (
            <div className="mt-2.5 pt-2 border-t border-white/10 flex items-center gap-1.5 text-xs text-purple-200/80">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500/20 text-[10px]">🧠</span>
                <span>情報源: パブリック一般知識 ({sourceInfo.provider === 'claude' ? 'Claude' : 'Gemini'} 事前学習データ)</span>
            </div>
        );
    }

    return null;
};

const Gemini = ({ user: initialUser, capabilities = [], onOpen, initialBriefingReport = null }) => {
    const [currentUser, setCurrentUser] = useState(initialUser || null);
    const [activeBriefingReport, setActiveBriefingReport] = useState(initialBriefingReport || null);
    const hasRagCapability = Array.isArray(capabilities) && capabilities.includes('capability:rag-context');
    const hasKnowledgeStoreCapability = Array.isArray(capabilities) && capabilities.includes('capability:knowledge-store');
    const hasDeepResearchCapability = Array.isArray(capabilities) && capabilities.includes('capability:deep-research');

    useEffect(() => {
        if (initialBriefingReport) {
            setActiveBriefingReport(initialBriefingReport);
        }
    }, [initialBriefingReport]);
    const [mode, setMode] = useState('normal');
    const [useGrounding, setUseGrounding] = useState(true);
    const [messages, setMessages] = useState([]);
    const [previousInteractionId, setPreviousInteractionId] = useState(null);
    const [environmentId, setEnvironmentId] = useState(null);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [lastRagSyncTime, setLastRagSyncTime] = useState(null);
    const [targetRagFolderId, setTargetRagFolderId] = useState(null);
    const [ragFolders, setRagFolders] = useState([]);
    const [isConfigLoaded, setIsConfigLoaded] = useState(false);
    const [isInlineSyncing, setIsInlineSyncing] = useState(false);
    const [isRagExpired, setIsRagExpired] = useState(false);
    const [showSlashMenu, setShowSlashMenu] = useState(false);
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const [filteredSlashCommands, setFilteredSlashCommands] = useState([]);
    const [hasWarnedExpiry, setHasWarnedExpiry] = useState(false);
    const [inputHistory, setInputHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [popularQueries, setPopularQueries] = useState([]);
    const [chatPresets, setChatPresets] = useState({});

    // Multi-LLM Provider & Model states
    const [aiProvider, setAiProvider] = useState('gemini');
    const [isGeminiConfigured, setIsGeminiConfigured] = useState(true);
    const [isClaudeConfigured, setIsClaudeConfigured] = useState(false);
    const [geminiModels, setGeminiModels] = useState([]);
    const [claudeModels, setClaudeModels] = useState([]);
    const [selectedChatModel, setSelectedChatModel] = useState('');
    const [defaultGeminiModel, setDefaultGeminiModel] = useState('');
    const [defaultClaudeModel, setDefaultClaudeModel] = useState('');

    const [copiedIndex, setCopiedIndex] = useState(null);
    const messagesEndRef = useRef(null);

    // Save to Knowledge state
    const [saveKnowledgeModalOpen, setSaveKnowledgeModalOpen] = useState(false);
    const [codeToSave, setCodeToSave] = useState('');
    const [saveKnowledgeDefaultTitle, setSaveKnowledgeDefaultTitle] = useState('');
    const [toastMessage, setToastMessage] = useState(null);

    const handleOpenSaveKnowledge = (code, title = '') => {
        setCodeToSave(code);
        setSaveKnowledgeDefaultTitle(title || 'AI Analytics ダッシュボード');
        setSaveKnowledgeModalOpen(true);
    };

    const handleSavedToKnowledge = (article) => {
        setToastMessage(`ナレッジ「${article.title}」に保存しました！`);
        setTimeout(() => setToastMessage(null), 4000);
    };
    const inputRef = useRef(null);

    const scrollToBottom = () => {
        if (messages.length > 0) {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        if (!currentUser) {
            fetch('/api/auth/me')
                .then(res => res.json())
                .then(data => {
                    if (data.user) setCurrentUser(data.user);
                })
                .catch(err => console.error("Failed to fetch current user in Gemini:", err));
        }
    }, [currentUser]);

    const allowedWidgets = currentUser?.allowed_widgets || [];
    const accessibleRagFolders = ragFolders.filter(folder => 
        allowedWidgets.includes('*') || allowedWidgets.includes(`rag:${folder.id}`)
    );

    // If active targetRagFolderId is no longer accessible, fallback to normal chat
    useEffect(() => {
        if (mode === 'rag' && targetRagFolderId && isConfigLoaded) {
            const hasAccess = accessibleRagFolders.some(f => f.id === targetRagFolderId);
            if (!hasAccess) {
                setTargetRagFolderId(null);
                setMode('normal');
                setUseGrounding(true);
            }
        }
    }, [mode, targetRagFolderId, accessibleRagFolders, isConfigLoaded]);

    // Fetch config on mount
    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await fetch('/api/config');
                const data = await res.json();
                if (data.lastRagSyncTime) {
                    setLastRagSyncTime(data.lastRagSyncTime);
                }
                if (data.googleDriveRagFolders) {
                    setRagFolders(data.googleDriveRagFolders);
                }
                if (data.aiProvider) setAiProvider(data.aiProvider);
                if (data.isGeminiConfigured !== undefined) setIsGeminiConfigured(data.isGeminiConfigured);
                if (data.isClaudeConfigured !== undefined) setIsClaudeConfigured(data.isClaudeConfigured);
                if (data.geminiModel) setDefaultGeminiModel(data.geminiModel);
                if (data.claudeModel) setDefaultClaudeModel(data.claudeModel);
            } catch (err) {
                console.error("Failed to fetch config for RAG expiry check:", err);
            } finally {
                setIsConfigLoaded(true);
            }

            try {
                const modelsRes = await fetch('/api/gemini/models');
                if (modelsRes.ok) {
                    const modelsData = await modelsRes.json();
                    if (Array.isArray(modelsData.models)) setGeminiModels(modelsData.models);
                    if (Array.isArray(modelsData.claudeModels)) setClaudeModels(modelsData.claudeModels);
                }
            } catch (err) {
                console.error("Failed to load models list:", err);
            }

            try {
                const presetRes = await fetch('/api/chat/presets');
                const presetData = await presetRes.json();
                setChatPresets(presetData);
            } catch (error) {
                console.error("Failed to load chat presets:", error);
            }
        };
        fetchConfig();

        // Load local query history
        try {
            const savedHistory = localStorage.getItem('rag_query_history');
            if (savedHistory) {
                setInputHistory(JSON.parse(savedHistory));
            }
        } catch (e) {
            console.error("Failed to load local query history", e);
        }
    }, []);

    // Fetch popular queries when mode changes
    useEffect(() => {
        if (mode === 'rag') {
            fetch('/api/rag/popular-queries')
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) setPopularQueries(data);
                })
                .catch(err => console.error("Failed to fetch popular queries:", err));
        }
    }, [mode]);

    const triggerInlineRagSync = async () => {
        setIsInlineSyncing(true);
        try {
            const res = await fetch('/api/rag/sync', { method: 'POST' });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                alert('Sync Failed: ' + (errData.error || res.statusText));
                setIsInlineSyncing(false);
                return;
            }
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch('/api/rag/status');
                    const statusData = await statusRes.json();
                    if (statusData.state === 'completed') {
                        clearInterval(pollInterval);
                        setIsInlineSyncing(false);
                        const newSyncTime = new Date().toISOString();
                        setLastRagSyncTime(newSyncTime);
                        setIsRagExpired(false);
                        window.dispatchEvent(new CustomEvent('rag-synced', { detail: { lastRagSyncTime: newSyncTime } }));
                    } else if (statusData.state === 'error') {
                        clearInterval(pollInterval);
                        setIsInlineSyncing(false);
                        alert('Sync Error: ' + statusData.error);
                    }
                } catch (e) {
                    clearInterval(pollInterval);
                    setIsInlineSyncing(false);
                }
            }, 2000);
        } catch (err) {
            alert('Failed to trigger sync: ' + err.message);
            setIsInlineSyncing(false);
        }
    };

    // Check RAG expiry/sync need when mode changes to 'rag'
    useEffect(() => {
        if (!isConfigLoaded) return; // Wait for config to load

        const checkRagSync = async () => {
            if (mode === 'rag') {
                // Fetch latest config to get the updated lastRagSyncTime and folders
                let currentSyncTime = lastRagSyncTime;
                try {
                    const configRes = await fetch('/api/config');
                    const configData = await configRes.json();
                    if (configData.lastRagSyncTime) {
                        currentSyncTime = configData.lastRagSyncTime;
                        setLastRagSyncTime(configData.lastRagSyncTime);
                    }
                    if (configData.googleDriveRagFolders) {
                        setRagFolders(configData.googleDriveRagFolders);
                        // If selected target folder is no longer in configured folders, reset
                        if (targetRagFolderId && !configData.googleDriveRagFolders.some(f => f.id === targetRagFolderId)) {
                            setTargetRagFolderId(null);
                            setMode('normal');
                            setUseGrounding(true);
                        }
                    }
                } catch (configErr) {
                    console.error("Failed to fetch latest config in checkRagSync:", configErr);
                }

                // 1. Check time-based expiry first locally (40h limit for Gemini File API)
                let isTimeExpired = false;
                if (!currentSyncTime) {
                    isTimeExpired = true;
                } else {
                    const syncTime = new Date(currentSyncTime).getTime();
                    const now = new Date().getTime();
                    const diffHours = (now - syncTime) / (1000 * 60 * 60);
                    if (diffHours >= 40) {
                        isTimeExpired = true;
                    }
                }

                setIsRagExpired(isTimeExpired);

                if (isTimeExpired && !hasWarnedExpiry) {
                    setMessages(prev => [...prev, {
                        role: 'model',
                        text: '⚠️ **RAGデータの有効期限切れ（または未同期）**\n\nGemini File APIの保持期限（40時間）を超過しているか、まだ同期されていません。上の「今すぐ同期」ボタンまたはSystem Settingsから同期を実行してください。'
                    }]);
                    setHasWarnedExpiry(true);
                    return; // Skip explicit drive check if it's already expired by time
                }

                // 2. Perform dynamic Drive checks
                try {
                    const res = await fetch('/api/rag/check-sync-needed');
                    const data = await res.json();
                    
                    if (data.syncNeeded && !hasWarnedExpiry) {
                        setMessages(prev => [...prev, {
                            role: 'model',
                            text: '⚠️ **RAGデータの更新を検知しました（未同期）**\n\nGoogle Driveのファイルが追加・更新、または削除されています。上の「今すぐ同期」ボタンまたはSystem Settingsから同期を実行してください。'
                        }]);
                        setHasWarnedExpiry(true);
                        setIsRagExpired(true);
                    }
                } catch (err) {
                    console.error("Failed to check dynamic RAG sync status:", err);
                }
            } else {
                setIsRagExpired(false);
            }
        };

        checkRagSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, isConfigLoaded]);

    // Handle RAG synced event to reset expiry state and clean warnings
    useEffect(() => {
        const handleRagSynced = (e) => {
            if (e.detail && e.detail.lastRagSyncTime) {
                setLastRagSyncTime(e.detail.lastRagSyncTime);
                setHasWarnedExpiry(false);
                setIsRagExpired(false);
                setMessages(prev => prev.filter(msg => 
                    !(msg.text && (
                        msg.text.includes('⚠️ **RAGデータの有効期限切れ（または未同期）**') ||
                        msg.text.includes('⚠️ **RAGデータの更新を検知しました（未同期）**')
                    ))
                ));
            }
            // Refresh folders list from config
            fetch('/api/config')
                .then(res => res.json())
                .then(data => {
                    if (data.googleDriveRagFolders) {
                        setRagFolders(data.googleDriveRagFolders);
                    }
                })
                .catch(err => console.error("Failed to refresh folders on rag-synced:", err));
        };
        window.addEventListener('rag-synced', handleRagSynced);
        return () => window.removeEventListener('rag-synced', handleRagSynced);
    }, []);

    const selectSlashCommand = (cmd) => {
        setInput(cmd.prompt);
        setShowSlashMenu(false);
        setActiveSlashIndex(0);
        setTimeout(() => {
            inputRef.current?.focus();
        }, 50);
    };

    const handleInputChange = (e) => {
        const val = e.target.value;
        setInput(val);

        if (val.startsWith('/')) {
            const searchWord = val.toLowerCase();
            const filtered = SLASH_COMMANDS.filter(cmd => 
                cmd.command.toLowerCase().startsWith(searchWord)
            );
            setFilteredSlashCommands(filtered);
            setShowSlashMenu(filtered.length > 0);
            setActiveSlashIndex(0);
        } else {
            setShowSlashMenu(false);
        }
    };

    const handleSend = async () => {
        const textToSend = input.trim();
        if (!textToSend) return;

        // Save to local history (unique up to 50 items)
        const newHistory = [textToSend, ...inputHistory.filter(q => q !== textToSend)].slice(0, 50);
        setInputHistory(newHistory);
        setHistoryIndex(-1);
        try {
            localStorage.setItem('rag_query_history', JSON.stringify(newHistory));
        } catch(e) {}

        const userMessage = { role: 'user', text: textToSend };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const history = messages.map(m => ({
                role: m.role,
                parts: [{ text: m.text }]
            }));

            const isWeatherQuery = /天気|台風|雨|雪|雷|forecast|weather/i.test(textToSend);
            let dynamicSystemInstruction = undefined;

            if (isWeatherQuery && mode === 'normal') {
                const today = new Date();
                const todayStr = today.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }); // 例: "5月27日(水)"
                
                dynamicSystemInstruction = "You have access to Google Search. ALWAYS use Google Search for any questions about weather. Prioritize search results over internal knowledge. \n\n" +
                    "【重要】本日は " + todayStr + " です。ユーザーの質問内容に応じて、最も適切な天気の形式を選び、以下のJSONスキーマに従って出力してください。テキストの末尾に、必ず ` ```json-weather` と ` ``` ` で囲んだコードブロックとして記述すること。\n\n" +
                    "1. 質問が「全国の天気」や特定の地域を指定していない場合：\n" +
                    "   viewMode: 'national'\n" +
                    "   cities: 全国主要10都市（札幌、仙台、東京、新潟、名古屋、大阪、広島、高松、福岡、那覇）の今日の天気（hourlyに2時間おきのデータ）\n\n" +
                    "2. 質問が特定の地域（例：関西、大阪、東京など）の「今日の天気」の場合：\n" +
                    "   viewMode: 'local_hourly'\n" +
                    "   cities: 指定された地域（複数可）の今日の天気（hourlyに2時間おきのデータ）\n\n" +
                    "3. 質問が特定の地域の「今週の天気」や「週間天気予報」の場合：\n" +
                    "   viewMode: 'local_weekly'\n" +
                    "   cities: 指定された地域（複数可）の週間天気（dailyに1週間分のデータ）\n\n" +
                    "JSONの基本スキーマ：\n" +
                    "{\n" +
                    "  \"viewMode\": \"national\", // \"national\", \"local_hourly\", \"local_weekly\" のいずれか\n" +
                    "  \"title\": \"ウィジェットのタイトル（例：全国都市別天気ダッシュボード、大阪府 週間天気予報 など）\",\n" +
                    "  \"date\": \"" + todayStr + "\", \n" +
                    "  \"comment\": \"天気概況の短い解説\",\n" +
                    "  \"cities\": [\n" +
                    "    {\n" +
                    "      \"id\": \"osaka\", \"name\": \"大阪\", \"weather\": \"晴れ時々曇り\", \"type\": \"sunny\", \"tempMax\": 33, \"tempMin\": 25, \"pop\": 20, \"humidity\": 60,\n" +
                    "      \"hourly\": [\n" +
                    "        {\"time\": \"08:00\", \"temp\": 22, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"10:00\", \"temp\": 25, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"12:00\", \"temp\": 30, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"14:00\", \"temp\": 33, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"16:00\", \"temp\": 31, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"18:00\", \"temp\": 28, \"weather\": \"晴れ\", \"type\": \"sunny\"},\n" +
                    "        {\"time\": \"20:00\", \"temp\": 25, \"weather\": \"晴れ\", \"type\": \"sunny\"}\n" +
                    "      ],\n" +
                    "      \"daily\": [\n" +
                    "        {\"date\": \"8/12(月)\", \"tempMax\": 33, \"tempMin\": 25, \"weather\": \"晴れ\", \"type\": \"sunny\", \"pop\": 10}\n" +
                    "      ]\n" +
                    "    }\n" +
                    "  ]\n" +
                    "}\n" +
                    "※ cities配列内の各都市について、hourly または daily データのいずれかを必ず7要素分作成すること（typeは 'sunny', 'cloudy', 'rainy', 'snowy'）。\n" +
                    "ユーザーには通常の言葉で天気を解説するテキストを必ず先に書き、その後にこのJSONブロックを記述してください。";
            }

            if (mode === 'gemma4' || mode === 'local_rag') {
                // Direct LiveStream from Local Gemma 4 (or Local RAG)
                try {
                    const endpoint = mode === 'local_rag' ? '/api/local-rag/stream' : '/api/gemma/stream';
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            prompt: userMessage.text,
                            systemInstruction: dynamicSystemInstruction || "You are Gemma 4, a powerful, fast, and secure local AI running on Apple Silicon. Answer helpfully, accurately, and concisely in Japanese or the language requested."
                        })
                    });

                    if (!response.ok) {
                        const errData = await response.json().catch(() => ({}));
                        throw new Error(errData.error || `Server returned ${response.status}`);
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let streamText = '';

                    // Add placeholder model message for streaming
                    setMessages(prev => [...prev, { role: 'model', text: '', isStreaming: true }]);

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value, { stream: true });
                        const lines = chunk.split('\n').filter(l => l.trim().length > 0);
                        for (const line of lines) {
                            if (line.includes('[DONE]')) continue;
                            const jsonStr = line.replace(/^data:\s*/, '').trim();
                            if (!jsonStr) continue;
                            try {
                                const json = JSON.parse(jsonStr);
                                if (json.error) throw new Error(json.error);
                                if (json.text) {
                                    streamText += json.text;
                                    const currentUsage = (json.prompt_eval_count || json.eval_count) ? {
                                        promptTokenCount: json.prompt_eval_count,
                                        candidatesTokenCount: json.eval_count,
                                        totalTokenCount: (json.prompt_eval_count || 0) + (json.eval_count || 0)
                                    } : null;

                                    setMessages(prev => {
                                        const updated = [...prev];
                                        if (updated.length > 0) {
                                            updated[updated.length - 1] = {
                                                role: 'model',
                                                text: streamText,
                                                isStreaming: !json.done,
                                                usage: currentUsage || updated[updated.length - 1]?.usage
                                            };
                                        }
                                        return updated;
                                    });
                                }
                            } catch (e) {}
                        }
                    }
                    setIsLoading(false);
                    return;
                } catch (gemmaErr) {
                    console.error("Gemma stream error:", gemmaErr);
                    setMessages(prev => [...prev, { role: 'model', text: "Error connecting to Local Gemma 4: " + gemmaErr.message + " (Make sure Ollama is running)" }]);
                    setIsLoading(false);
                    return;
                }
            }

            // Start Job
            const enrichedMessage = activeBriefingReport
                ? `【事前共有ブリーフィングレポート参照: ${activeBriefingReport.title}】\n${(activeBriefingReport.content || '').slice(0, 12000)}\n\n---\n【ユーザーの質問・深掘り指示】\n${userMessage.text}`
                : userMessage.text;

            const requestBody = {
                message: enrichedMessage,
                history: history,
                previous_interaction_id: previousInteractionId,
                environment_id: environmentId,
                config: { 
                    mode: mode, 
                    grounding: useGrounding, 
                    targetRagFolderId: targetRagFolderId,
                    systemInstruction: dynamicSystemInstruction,
                    model: selectedChatModel || undefined
                } // Pass selected mode, grounding flag, custom instruction, and optional model override
            };

            const response = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "Failed to start request");
            }

            const jobId = data.jobId;
            let attempts = 0;
            // RAGやClaude利用時はドキュメント解析(PDF/Prompt Caching)に時間を要するためタイムアウトを180秒に拡張
            const isRAG = mode === 'rag' || mode === 'research';
            const isClaude = (selectedChatModel && selectedChatModel.startsWith('claude')) || (aiProvider === 'claude');
            const maxAttempts = (isRAG || isClaude) ? 180 : 60; // 180s for RAG/Claude, 60s for standard Gemini

            // Poll for result
            const pollInterval = setInterval(async () => {
                attempts++;
                try {
                    const jobRes = await fetch(`/api/gemini/job/${jobId}`);
                    const jobData = await jobRes.json();

                    if (jobData.state === 'completed') {
                        clearInterval(pollInterval);
                        setMessages(prev => [...prev, { 
                            role: 'model', 
                            text: jobData.reply, 
                            usage: jobData.usageMetadata,
                            sourceInfo: jobData.sourceInfo 
                        }]);
                        if (jobData.interactionId) setPreviousInteractionId(jobData.interactionId);
                        if (jobData.environmentId) setEnvironmentId(jobData.environmentId);
                        setIsLoading(false);
                    } else if (jobData.state === 'error') {
                        clearInterval(pollInterval);
                        setMessages(prev => [...prev, { role: 'model', text: "Error: " + jobData.error }]);
                        setIsLoading(false);
                    } else if (attempts >= maxAttempts) {
                        clearInterval(pollInterval);
                        setMessages(prev => [...prev, { 
                            role: 'model', 
                            text: `⚠️ リクエストがタイムアウトしました (${maxAttempts}秒)。ドキュメントサイズが大きいか、AIプロバイダーの解析に時間を要しています。` 
                        }]);
                        setIsLoading(false);
                    }
                } catch (err) {
                    console.error("Polling Error:", err);
                    clearInterval(pollInterval);
                    setMessages(prev => [...prev, { role: 'model', text: "Network error during polling." }]);
                    setIsLoading(false);
                }
            }, 1000);

        } catch (error) {
            console.error("Chat Error:", error);
            setMessages(prev => [...prev, { role: 'model', text: "Sorry, I couldn't reach the server." }]);
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e) => {
        if (showSlashMenu) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveSlashIndex(prev => 
                    prev < filteredSlashCommands.length - 1 ? prev + 1 : 0
                );
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveSlashIndex(prev => 
                    prev > 0 ? prev - 1 : filteredSlashCommands.length - 1
                );
                return;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredSlashCommands[activeSlashIndex]) {
                    selectSlashCommand(filteredSlashCommands[activeSlashIndex]);
                }
                return;
            } else if (e.key === 'Escape') {
                e.preventDefault();
                setShowSlashMenu(false);
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            handleSend();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (inputHistory.length > 0) {
                const nextIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
                setHistoryIndex(nextIndex);
                setInput(inputHistory[nextIndex]);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
                const prevIndex = historyIndex - 1;
                setHistoryIndex(prevIndex);
                setInput(inputHistory[prevIndex]);
            } else if (historyIndex === 0) {
                setHistoryIndex(-1);
                setInput('');
            }
        }
    };

    const handleCopy = (text, index) => {
        navigator.clipboard.writeText(text);
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    const handleEditQuery = (text) => {
        setInput(text);
        setHistoryIndex(-1);
        inputRef.current?.focus();
    };

    const isClaudeActive = selectedChatModel
        ? selectedChatModel.startsWith('claude-')
        : aiProvider === 'claude';

    return (
        <div className="relative h-full overflow-hidden bg-gradient-to-br from-purple-600 via-pink-500 to-blue-500 flex flex-col font-sans">
            {/* Animated gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-br from-purple-400/30 via-pink-400/30 to-blue-400/30 animate-pulse pointer-events-none"></div>

            {/* Content */}
            <div className="relative z-10 flex-1 flex flex-col overflow-hidden">

                {/* Header / Mode Selector */}
                <div className="absolute top-4 left-4 right-4 z-10 flex justify-between items-center gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="relative min-w-0 flex-1 max-w-[200px] bg-white/20 backdrop-blur-md rounded-lg p-1 flex items-center shadow-sm border border-white/10">
                            <select
                                value={mode === 'rag' ? `rag_${targetRagFolderId}` : mode}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setPreviousInteractionId(null);
                                    setEnvironmentId(null);
                                    if (val === 'normal') { setMode('normal'); setUseGrounding(true); setTargetRagFolderId(null); }
                                    else if (val.startsWith('rag_')) { setMode('rag'); setUseGrounding(false); setTargetRagFolderId(val.replace('rag_', '')); }
                                    else { setMode(val); setUseGrounding(false); setTargetRagFolderId(null); }
                                }}
                                className="w-full truncate bg-transparent border-none text-white text-sm font-medium outline-none cursor-pointer appearance-none pr-6 pl-3 py-1.5 focus:ring-0"
                                style={{ backgroundImage: 'none' }}
                            >
                                <option value="normal" className="text-gray-800">💬 Normal Chat</option>
                                {hasRagCapability && (
                                    <option value="local_rag" className="text-gray-800">🛡️ Gemma 4 Local RAG (完全社内完結)</option>
                                )}
                                {hasRagCapability && accessibleRagFolders.map((f, idx) => (
                                    <option key={f.id || idx} value={`rag_${f.id}`} className="text-gray-800">📚 Cloud: {f.name}</option>
                                ))}
                                <option value="gemma4" className="text-gray-800">🦙 Gemma 4 (Direct)</option>
                                {hasDeepResearchCapability && (
                                    <option value="research" className="text-gray-800">🔍 Deep Research</option>
                                )}
                                {hasDeepResearchCapability && (
                                    <option value="html_svg" className="text-gray-800">🎨 HTML/SVG Dev</option>
                                )}
                            </select>
                            <span className="text-white/80 text-[10px] pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 transform">▼</span>
                        </div>

                        {mode !== 'gemma4' && mode !== 'local_rag' && (
                            <div className="relative min-w-0 flex-1 max-w-[220px] bg-white/15 backdrop-blur-md rounded-lg p-1 flex items-center shadow-sm border border-white/10">
                                <select
                                    value={selectedChatModel}
                                    onChange={(e) => {
                                        setSelectedChatModel(e.target.value);
                                        setPreviousInteractionId(null);
                                        setEnvironmentId(null);
                                    }}
                                    className="w-full truncate bg-transparent border-none text-white text-xs font-medium outline-none cursor-pointer appearance-none pr-5 pl-2.5 py-1.5 focus:ring-0"
                                    style={{ backgroundImage: 'none' }}
                                    title="使用するAIモデルを切り替え (System Default / Gemini / Claude)"
                                >
                                    <option value="" className="text-gray-800">
                                        {aiProvider === 'claude' ? `🟣 Default (${defaultClaudeModel || 'Claude'})` : `✨ Default (${defaultGeminiModel || 'Gemini'})`}
                                    </option>
                                    {geminiModels.length > 0 && (
                                        <optgroup label="✨ Google Gemini" className="text-gray-800">
                                            {geminiModels.map(m => {
                                                const val = m.name.replace('models/', '');
                                                return (
                                                    <option key={val} value={val} className="text-gray-800">
                                                        ✨ {m.displayName || val}
                                                    </option>
                                                );
                                            })}
                                        </optgroup>
                                    )}
                                    {claudeModels.length > 0 && (
                                        <optgroup label="🟣 Anthropic Claude" className="text-gray-800">
                                            {claudeModels.map(m => {
                                                const val = m.name.replace('models/', '');
                                                return (
                                                    <option key={val} value={val} className="text-gray-800">
                                                        🟣 {m.displayName || val}
                                                    </option>
                                                );
                                            })}
                                        </optgroup>
                                    )}
                                </select>
                                <span className="text-white/80 text-[10px] pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 transform">▼</span>
                            </div>
                        )}
                    </div>
                    {mode === 'normal' && (
                        <div className="flex-shrink-0 flex items-center bg-white/10 backdrop-blur-md rounded-lg px-3 py-1.5 border border-white/10 cursor-pointer" onClick={() => setUseGrounding(!useGrounding)}>
                            <span className="text-xs font-medium text-white mr-2">Grounding</span>
                            <div className={`w-8 h-4 rounded-full transition-colors relative ${useGrounding ? 'bg-green-400' : 'bg-white/20'}`}>
                                <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform ${useGrounding ? 'translate-x-4' : 'translate-x-0.5'}`}></div>
                            </div>
                        </div>
                    )}
                    {mode === 'local_rag' && (
                        <div className="flex-shrink-0 flex items-center bg-indigo-500/20 backdrop-blur-md rounded-lg px-2.5 py-1.5 border border-indigo-400/30 shadow-sm">
                            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse mr-1.5"></span>
                            <span className="text-[11px] font-semibold text-indigo-200 whitespace-nowrap">🛡️ Air-Gapped</span>
                        </div>
                    )}
                    {mode === 'rag' && isRagExpired && !isClaudeActive && (
                        <div className="flex-shrink-0 flex items-center bg-amber-500/90 backdrop-blur-md rounded-lg px-2.5 py-1 text-white text-xs shadow-md border border-amber-400/30">
                            <span className="mr-2 font-medium">⚠️ 期限切れ (40h)</span>
                            <button
                                onClick={triggerInlineRagSync}
                                disabled={isInlineSyncing}
                                className="bg-white/20 hover:bg-white/30 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors disabled:opacity-50"
                            >
                                {isInlineSyncing ? '同期中...' : '今すぐ同期'}
                            </button>
                        </div>
                    )}
                    {mode === 'gemma4' && (
                        <div className="ml-3 flex items-center bg-emerald-500/20 backdrop-blur-md rounded-lg px-3 py-1.5 border border-emerald-400/30">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-2"></span>
                            <span className="text-xs font-semibold text-emerald-200">⚡️ Local MoE (Apple MLX)</span>
                        </div>
                    )}
                </div>

                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto p-4 pt-16 space-y-6 scrollbar-hide">
                    {messages.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-white/90 text-center mt-10 animate-fadeIn">
                            <div className="w-20 h-20 mb-4 rounded-full bg-white/20 backdrop-blur-xl flex items-center justify-center shadow-lg ring-1 ring-white/40">
                                <span className="text-4xl">{isClaudeActive ? '🟣' : '✨'}</span>
                            </div>
                            <h2 className="text-2xl font-medium mb-1">{isClaudeActive ? 'Claude AI' : 'Gemini AI'}</h2>
                            <p className="text-sm opacity-80 mb-4">How can I help you today?</p>

                            <div className="bg-white/10 px-3 py-1 mb-4 rounded-full text-xs font-medium border border-white/10">
                                {mode === 'rag' ? 'Using: Personal Documents' : mode === 'search' ? 'Using: Web Search' : `Mode: Chat (${selectedChatModel || (isClaudeActive ? defaultClaudeModel || 'Claude' : defaultGeminiModel || 'Gemini')})`}
                            </div>

                            {isConfigLoaded && !isGeminiConfigured && !isClaudeConfigured && mode !== 'gemma4' && mode !== 'local_rag' && (
                                <div className="max-w-md mb-4 p-3 rounded-xl bg-amber-500/30 border border-amber-300/40 text-xs text-white backdrop-blur-md">
                                    ⚠️ Gemini API Key および Claude API Key が未設定です。System Settings ＞ System タブからいずれかのAPIキーを設定してください。
                                </div>
                            )}
                            {isConfigLoaded && isClaudeActive && !isClaudeConfigured && mode !== 'gemma4' && mode !== 'local_rag' && (
                                <div className="max-w-md mb-4 p-3 rounded-xl bg-amber-500/30 border border-amber-300/40 text-xs text-white backdrop-blur-md">
                                    ⚠️ Claude モデルが選択されていますが、Claude API Key が未設定です。System Settings から設定するか、モデル選択で Gemini に切り替えてください。
                                </div>
                            )}
                            {isConfigLoaded && !isClaudeActive && !isGeminiConfigured && mode !== 'gemma4' && mode !== 'local_rag' && (
                                <div className="max-w-md mb-4 p-3 rounded-xl bg-amber-500/30 border border-amber-300/40 text-xs text-white backdrop-blur-md">
                                    ⚠️ Gemini モデルが選択されていますが、Gemini API Key が未設定です。System Settings から設定するか、モデル選択で Claude に切り替えてください。
                                </div>
                            )}

                            {mode === 'rag' && popularQueries.length > 0 && (
                                <div className="max-w-md w-full">
                                    <div className="flex items-center justify-center gap-1.5 mb-3">
                                        <span className="text-yellow-300">🌟</span>
                                        <span className="text-xs font-semibold text-white/90">人気の社内FAQクエリ</span>
                                    </div>
                                    <div className="flex flex-wrap justify-center gap-2">
                                        {popularQueries.map((pq, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleEditQuery(pq.query_text)}
                                                className="bg-white/10 hover:bg-white/20 transition-colors border border-white/20 rounded-lg px-3 py-2 text-[13px] text-white/90 text-left max-w-full truncate shadow-sm backdrop-blur-md cursor-pointer"
                                                title={pq.query_text}
                                            >
                                                {pq.query_text}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {messages.map((msg, index) => (
                        <div
                            key={index}
                            className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-fadeIn group`}
                        >
                            {/* Avatar */}
                            <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden shadow-sm border border-white/20 bg-white/10 backdrop-blur-md flex items-center justify-center self-end">
                                {msg.role === 'user' ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                                        <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z" clipRule="evenodd" />
                                    </svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                                        <path fillRule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813a3.75 3.75 0 002.576-2.576l.813-2.846A.75.75 0 019 4.5z" clipRule="evenodd" />
                                    </svg>
                                )}
                            </div>

                            {/* Bubble Container */}
                            <div className={`max-w-[75%] flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                <div
                                    className={`px-4 py-2.5 shadow-sm backdrop-blur-md text-[15px] leading-relaxed ${msg.role === 'user'
                                        ? 'bg-[#007AFF] text-white rounded-2xl rounded-br-sm'
                                        : 'bg-white/20 text-white border border-white/20 rounded-2xl rounded-bl-sm w-full'
                                        }`}
                                >
                                    {(() => {
                                        if (msg.role === 'user') {
                                            return <p className="whitespace-pre-wrap">{msg.text}</p>;
                                        }

                                        // JSON形式の天気予報データを検出
                                        const match = msg.text.match(/```json-weather\s*([\s\S]*?)\s*```/);
                                        if (match) {
                                            const jsonStr = match[1];
                                            const cleanText = msg.text.replace(/```json-weather\s*([\s\S]*?)\s*```/, '').trim();
                                            
                                            let weatherData = null;
                                            try {
                                                weatherData = JSON.parse(jsonStr);
                                            } catch (e) {
                                                console.error("Failed to parse weather JSON:", e);
                                            }

                                            return (
                                                <div className="space-y-4 w-full">
                                                    {cleanText && <p className="whitespace-pre-wrap mb-4 text-white">{cleanText}</p>}
                                                    <WeatherForecastMap data={weatherData} />
                                                </div>
                                            );
                                        }

                                        // インテリジェント自動フォールバック検知 (JSON出力が無い場合)
                                        const textLower = msg.text.toLowerCase();
                                        const hasWeatherWords = (textLower.match(/天気|台風|気圧|降水|雨|雪|晴|曇/g) || []).length >= 2;
                                        const hasCityNames = (textLower.match(/札幌|仙台|東京|新潟|名古屋|大阪|広島|高松|福岡|那覇|都市/g) || []).length >= 2;

                                        if (hasWeatherWords && hasCityNames) {
                                            return (
                                                <div className="space-y-4 w-full">
                                                    <div className="prose prose-invert max-w-none text-white text-[15px] leading-relaxed break-words">
                                                        <ReactMarkdown
                                                            remarkPlugins={[remarkGfm, remarkMath]}
                                                            rehypePlugins={[rehypeKatex]}
                                                        >
                                                            {msg.text}
                                                        </ReactMarkdown>
                                                    </div>
                                                    <WeatherForecastMap data={null} />
                                                </div>
                                            );
                                        }

                                        return (
                                            <div className="prose prose-invert max-w-none text-white text-[15px] leading-relaxed break-words">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm, remarkMath]}
                                                    rehypePlugins={[rehypeKatex]}
                                                    components={{
                                                        p: ({ children }) => <p className="mb-2.5 last:mb-0 leading-relaxed">{children}</p>,
                                                        h1: ({ children }) => <h1 className="text-xl font-bold mt-3.5 mb-2 text-white border-b border-white/10 pb-1">{children}</h1>,
                                                        h2: ({ children }) => <h2 className="text-lg font-bold mt-3 mb-1.5 text-white">{children}</h2>,
                                                        h3: ({ children }) => <h3 className="text-base font-semibold mt-2.5 mb-1 text-indigo-200">{children}</h3>,
                                                        ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
                                                        ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
                                                        li: ({ children }) => <li className="my-0.5 leading-relaxed">{children}</li>,
                                                        strong: ({ children }) => <strong className="font-bold text-white bg-indigo-500/20 px-1 py-0.5 rounded">{children}</strong>,
                                                        code: ({ inline, className, children, ...props }) => {
                                                            const match = /language-(\w+)/.exec(className || '');
                                                            const lang = match ? match[1].toLowerCase() : '';
                                                            const codeStr = String(children).replace(/\n$/, '');

                                                            if (!inline && (lang === 'html' || (!lang && (codeStr.includes('<!DOCTYPE html>') || codeStr.includes('<html'))))) {
                                                                return (
                                                                    <HtmlPreviewCodeBlock
                                                                        code={codeStr}
                                                                        onSaveToKnowledge={hasKnowledgeStoreCapability ? handleOpenSaveKnowledge : undefined}
                                                                        onOpen={onOpen}
                                                                    />
                                                                );
                                                            }

                                                            if (inline) {
                                                                return (
                                                                    <code className="bg-black/40 text-cyan-300 px-1.5 py-0.5 rounded text-xs font-mono border border-white/10" {...props}>
                                                                        {children}
                                                                    </code>
                                                                );
                                                            }
                                                            return (
                                                                <div className="my-2.5 rounded-xl bg-black/60 border border-white/10 p-3 overflow-x-auto text-xs font-mono text-gray-200">
                                                                    <code className={className} {...props}>
                                                                        {children}
                                                                    </code>
                                                                </div>
                                                            );
                                                        },
                                                        table: ({ children }) => (
                                                            <div className="overflow-x-auto my-3 rounded-lg border border-white/10">
                                                                <table className="min-w-full text-xs text-left divide-y divide-white/10">{children}</table>
                                                            </div>
                                                        ),
                                                        th: ({ children }) => <th className="px-3 py-2 bg-black/40 font-bold text-white border-b border-white/10">{children}</th>,
                                                        td: ({ children }) => <td className="px-3 py-2 text-gray-200 border-b border-white/5">{children}</td>,
                                                        hr: () => <hr className="my-3 border-white/10" />
                                                    }}
                                                >
                                                    {msg.text}
                                                </ReactMarkdown>
                                            </div>
                                        );
                                    })()}
                                    {msg.role === 'model' && renderSourceInfo(msg.sourceInfo)}
                                    {msg.role === 'model' && renderContextUsage(msg.usage, true)}
                                </div>
                                {/* Actions Area */}
                                <div className="flex gap-2 mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {msg.role === 'user' && (
                                        <>
                                            <button onClick={() => handleCopy(msg.text, `user-${index}`)} className="text-white/60 hover:text-white transition-colors" title="プロンプトをコピー">
                                                {copiedIndex === `user-${index}` ? (
                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-green-400">
                                                        <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" />
                                                    </svg>
                                                ) : (
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                                                    </svg>
                                                )}
                                            </button>
                                            <button onClick={() => handleEditQuery(msg.text)} className="text-white/60 hover:text-white transition-colors" title="Edit Query">
                                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                                                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                                                </svg>
                                            </button>
                                        </>
                                    )}
                                    {msg.role === 'model' && (
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => handleCopy(msg.text, index)} className="text-white/60 hover:text-white transition-colors" title="Copy to clipboard">
                                                {copiedIndex === index ? (
                                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-green-400">
                                                        <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 01.208 1.04l-9 13.5a.75.75 0 01-1.154.114l-6-6a.75.75 0 011.06-1.06l5.353 5.353 8.493-12.739a.75.75 0 011.04-.208z" clipRule="evenodd" />
                                                    </svg>
                                                ) : (
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5">
                                                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                                                    </svg>
                                                )}
                                            </button>
                                            {hasKnowledgeStoreCapability && (
                                                <button
                                                    onClick={() => handleOpenSaveKnowledge(msg.text, '経営会議・分析メモ')}
                                                    className="text-[11px] px-2 py-0.5 rounded-full bg-white/15 hover:bg-white/25 text-white border border-white/20 transition-colors flex items-center gap-1"
                                                    title="ナレッジベース（経営会議ブリーフィング）に登録"
                                                >
                                                    <span>📚 ナレッジに登録</span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}

                    {isLoading && (
                        <div className="flex items-end gap-2 flex-row animate-fadeIn">
                            <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden shadow-sm border border-white/20 bg-white/10 backdrop-blur-md flex items-center justify-center">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                                    <path fillRule="evenodd" d="M9 4.5a.75.75 0 01.721.544l.813 2.846a3.75 3.75 0 002.576 2.576l2.846.813a.75.75 0 010 1.442l-2.846.813a3.75 3.75 0 00-2.576 2.576l-.813 2.846a.75.75 0 01-1.442 0l-.813-2.846a3.75 3.75 0 00-2.576-2.576l-2.846-.813a.75.75 0 010-1.442l2.846-.813a3.75 3.75 0 002.576-2.576l.813-2.846A.75.75 0 019 4.5z" clipRule="evenodd" />
                                </svg>
                            </div>
                            <div className="bg-white/20 text-white border border-white/20 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm backdrop-blur-md">
                                <div className="flex gap-2 items-center h-5">
                                    <div className="flex gap-1.5 items-center">
                                        <div className="w-1.5 h-1.5 rounded-full bg-white/90 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                                        <div className="w-1.5 h-1.5 rounded-full bg-white/90 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                                        <div className="w-1.5 h-1.5 rounded-full bg-white/90 animate-bounce" style={{ animationDelay: '300ms' }}></div>
                                    </div>
                                    {mode === 'rag' && (
                                        <span className="text-xs text-white/90 ml-1.5 animate-pulse font-medium">
                                            {isClaudeActive ? '社内ドキュメントを解析中 (Claude Prompt Caching)...' : '社内ドキュメントを参照中...'}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 pt-2 relative">
                    {/* Slash Command Autocomplete Popover */}
                    {showSlashMenu && filteredSlashCommands.length > 0 && (
                        <div className="absolute bottom-full left-4 right-4 mb-2 backdrop-blur-xl bg-black/60 border border-white/10 rounded-[18px] shadow-2xl p-2 z-50 animate-fadeIn max-h-[220px] overflow-y-auto scrollbar-hide">
                            <div className="text-[10px] font-semibold text-white/40 px-3 py-1.5 uppercase tracking-wider border-b border-white/5 mb-1.5">
                                アジャイル支援ワークフロー
                            </div>
                            <div className="space-y-0.5">
                                {filteredSlashCommands.map((cmd, idx) => {
                                    const isActive = idx === activeSlashIndex;
                                    return (
                                        <div
                                            key={cmd.command}
                                            onClick={() => selectSlashCommand(cmd)}
                                            onMouseEnter={() => setActiveSlashIndex(idx)}
                                            className={`flex items-start gap-3 px-3 py-2.5 rounded-[12px] cursor-pointer transition-all duration-150 ${
                                                isActive
                                                    ? 'bg-[#007AFF] text-white shadow-lg'
                                                    : 'hover:bg-white/5 text-white/90'
                                            }`}
                                        >
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between">
                                                    <span className={`text-[14px] font-bold ${isActive ? 'text-white' : 'text-white'}`}>
                                                        {cmd.title}
                                                    </span>
                                                    <span className={`text-[11px] font-mono opacity-60 ml-2 ${isActive ? 'text-white' : 'text-[#007AFF]'}`}>
                                                        {cmd.command}
                                                    </span>
                                                </div>
                                                <div className={`text-[12px] mt-0.5 leading-normal ${isActive ? 'text-white/80' : 'text-white/60'}`}>
                                                    {cmd.description}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Executive Meeting Briefing Context Banner */}
                    {activeBriefingReport && (
                        <div className="mb-2.5 px-3.5 py-2.5 rounded-2xl bg-indigo-950/70 border border-indigo-400/40 backdrop-blur-xl text-white shadow-lg flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="px-2 py-0.5 rounded-full bg-indigo-500/40 border border-indigo-300/40 text-[10px] font-bold tracking-wide flex-shrink-0">
                                        📊 経営会議ブリーフィング参照中
                                    </span>
                                    <span className="text-xs font-semibold truncate">
                                        {activeBriefingReport.title}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setActiveBriefingReport(null)}
                                    className="text-[11px] text-indigo-200 hover:text-white px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 flex-shrink-0"
                                >
                                    解除 ✕
                                </button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setInput('この全社まとめレポートを踏まえ、単一ビジネスドメインにおける潜在課題と、第2四半期(Q2)にアクセルを踏むべき成長領域について経営視点でアドバイスしてください。');
                                        inputRef.current?.focus();
                                    }}
                                    className="text-[11px] px-2.5 py-1 rounded-full bg-indigo-500/30 hover:bg-indigo-500/50 border border-indigo-300/30 text-indigo-100 transition-colors"
                                >
                                    💡 単一ドメイン課題 & Q2投資判断のAI壁打ち
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setInput('この事前共有レポートに対して、経営会議で議論すべき重要アジェンダと想定される質問・反論を3点に整理してください。');
                                        inputRef.current?.focus();
                                    }}
                                    className="text-[11px] px-2.5 py-1 rounded-full bg-indigo-500/30 hover:bg-indigo-500/50 border border-indigo-300/30 text-indigo-100 transition-colors"
                                >
                                    📋 経営会議のアジェンダ・論点抽出
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Preset Button Area */}
                    <div className="flex gap-2 mb-2 px-1">

                        {(() => {
                            const currentContext = mode === 'rag' && targetRagFolderId ? `rag_${targetRagFolderId}` : 'normal';
                            const currentPresets = chatPresets[currentContext] || [];
                            
                            if (currentPresets.length > 0) {
                                return currentPresets.map((preset, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => {
                                            setInput(preset.prompt);
                                            inputRef.current?.focus();
                                        }}
                                        className="text-xs px-3 py-1.5 bg-white/10 text-white hover:bg-white/20 rounded-full border border-white/20 transition-colors shadow-sm backdrop-blur-md"
                                    >
                                        {preset.label}
                                    </button>
                                ));
                            } else {
                                // Fallback default presets if no config exists
                                if (currentContext === 'normal') {
                                    return (
                                        <button
                                            onClick={() => {
                                                setInput("今週のAI3大ニュースについて教えてください");
                                                inputRef.current?.focus();
                                            }}
                                            className="text-xs px-3 py-1.5 bg-white/10 text-white hover:bg-white/20 rounded-full border border-white/20 transition-colors shadow-sm backdrop-blur-md"
                                        >
                                            📰 今週のAI3大ニュース
                                        </button>
                                    );
                                }
                                return null;
                            }
                        })()}

                    </div>
                    <div className="backdrop-blur-xl bg-white/10 rounded-[20px] border border-white/20 shadow-lg p-1.5 flex items-center gap-2 transition-all focus-within:bg-white/20 focus-within:border-white/30">
                        <input
                            ref={inputRef}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            placeholder={isClaudeActive ? "Ask Claude..." : "Ask Gemini..."}
                            className="flex-1 bg-transparent border-none focus:outline-none text-white placeholder-white/50 text-[15px] px-3 py-1.5"
                        />
                        <button
                            onClick={handleSend}
                            disabled={!input.trim() || isLoading}
                            className="w-8 h-8 rounded-full bg-[#007AFF] hover:bg-[#0062cc] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center transition-all duration-200 shadow-md active:scale-95"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" className="w-4 h-4">
                                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* Save to Knowledge Modal */}
            <SaveToKnowledgeModal
                isOpen={saveKnowledgeModalOpen}
                onClose={() => setSaveKnowledgeModalOpen(false)}
                code={codeToSave}
                defaultTitle={saveKnowledgeDefaultTitle}
                onSaved={handleSavedToKnowledge}
            />

            {/* Toast Notification */}
            {toastMessage && (
                <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-gray-900/95 border border-indigo-500/50 text-white px-4 py-2.5 rounded-xl shadow-2xl backdrop-blur-md flex items-center gap-2.5 text-xs font-medium animate-fadeIn">
                    <span className="text-base">📚</span>
                    <span>{toastMessage}</span>
                </div>
            )}

            <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
        </div >
    );
};

export default Gemini;
