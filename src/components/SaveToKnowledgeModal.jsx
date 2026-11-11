import React, { useState, useEffect } from 'react';

const extractSummaryFromHtml = (htmlStr) => {
    if (!htmlStr || typeof htmlStr !== 'string') return '';
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlStr, 'text/html');
        doc.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove());

        const sections = [];
        const headings = doc.querySelectorAll('h1, h2, h3');
        headings.forEach(h => {
            const text = (h.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) {
                const level = h.tagName.toLowerCase() === 'h1' ? '###' : '####';
                sections.push(`${level} ${text}`);
            }
        });

        const paragraphs = [];
        doc.querySelectorAll('p, li, td, th, .insight, .summary, .kpi-card').forEach(el => {
            if (el.children.length > 3) return;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text && text.length >= 12 && !paragraphs.includes(text)) {
                paragraphs.push(`- ${text}`);
            }
        });

        const combined = [
            ...sections.slice(0, 10),
            ...(paragraphs.length > 0 ? ['\n#### 主要データ・インサイト抜粋', ...paragraphs.slice(0, 25)] : [])
        ].join('\n');

        if (combined.trim()) return combined.trim();
        const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
        return bodyText ? bodyText.slice(0, 3000) : '';
    } catch {
        return '';
    }
};

const formatDurationText = (seconds) => {
    if (!seconds || seconds <= 0) return null;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
};

const SaveToKnowledgeModal = ({ isOpen, onClose, code, defaultTitle = '', context = null, onSaved }) => {
    const [title, setTitle] = useState('');
    const [pods, setPods] = useState([]);
    const [selectedPodId, setSelectedPodId] = useState('');
    const [tags, setTags] = useState('AI Analytics, GenUI');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');

    useEffect(() => {
        if (isOpen) {
            // Prefer extracting a clean title from HTML <title> or <h1> first, then fallback to defaultTitle
            const htmlSource = context?.htmlCode || code || '';
            let extractedTitle = '';
            if (htmlSource) {
                const titleMatch = htmlSource.match(/<title[^>]*>(.*?)<\/title>/i);
                if (titleMatch && titleMatch[1]) {
                    extractedTitle = titleMatch[1].replace(/<[^>]+>/g, '').trim();
                } else {
                    const h1Match = htmlSource.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
                    if (h1Match && h1Match[1]) {
                        extractedTitle = h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    }
                }
            }
            if (!extractedTitle && defaultTitle) {
                extractedTitle = defaultTitle;
            }
            setTitle(extractedTitle || 'AI Analytics レポート');
            setError('');
            setSuccessMessage('');

            // Fetch pods
            fetch('/api/pods')
                .then(res => res.json())
                .then(data => {
                    const availablePods = data.pods || [];
                    setPods(availablePods);
                    // If there is a digital agency or analytics pod, default to it
                    const defaultPod = availablePods.find(p => p.name.includes('デジ庁') || p.name.includes('分析') || p.id.includes('digital-agency'));
                    if (defaultPod) {
                        setSelectedPodId(defaultPod.id);
                    } else if (availablePods.length > 0) {
                        setSelectedPodId(availablePods[0].id);
                    } else {
                        setSelectedPodId('');
                    }
                })
                .catch(err => console.error('Failed to fetch pods:', err));
        }
    }, [isOpen, code, defaultTitle, context]);

    if (!isOpen) return null;

    const usage = context?.usage || null;
    const inputTokens = usage?.promptTokenCount || usage?.input_tokens || usage?.total_input_tokens || usage?.prompt_token_count || 0;
    const outputTokens = usage?.candidatesTokenCount || usage?.output_tokens || usage?.total_output_tokens || usage?.candidates_token_count || 0;
    const thoughtTokens = usage?.thoughtsTokenCount || usage?.total_thought_tokens || usage?.thought_tokens || 0;
    const totalTokens = usage?.totalTokenCount || usage?.total_token_count || (inputTokens + outputTokens + thoughtTokens);
    const modelName = context?.modelName || 'Default Model';
    const promptText = context?.promptText || defaultTitle || '';
    const durationText = formatDurationText(context?.durationSeconds);

    const handleSave = async (e) => {
        e.preventDefault();
        if (!title.trim()) {
            setError('タイトルを入力してください');
            return;
        }

        setIsSaving(true);
        setError('');
        try {
            const rawHtml = context?.htmlCode || ((code && (code.includes('<!DOCTYPE html') || code.includes('<html') || code.includes('<div'))) ? code : '');
            let nativeUrl = null;

            // 1. If HTML dashboard exists, publish it to /api/knowledge/publish to get an in-app URL (/reports/<id>.html)
            if (rawHtml && rawHtml.trim()) {
                try {
                    const pubRes = await fetch('/api/knowledge/publish', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: title.trim(),
                            content: rawHtml,
                            mimeType: 'text/html'
                        })
                    });
                    if (pubRes.ok) {
                        const pubData = await pubRes.json();
                        if (pubData.id) {
                            nativeUrl = `${window.location.origin}/reports/${pubData.id}.html`;
                        }
                    }
                } catch (pubErr) {
                    console.warn('Failed to publish interactive HTML report:', pubErr);
                }
            }

            // 2. Build DeepResearch-compatible rich Knowledge Base content header + summary
            let finalContent = code || '';
            if (context || nativeUrl) {
                const nowStr = new Date().toLocaleString('ja-JP');
                const queryBlock = promptText
                    ? `**調査クエリ:**\n> ${promptText.replace(/\n/g, '\n> ')}\n\n`
                    : '';

                let metricsSection = `**ワークフロー実行結果:**\n`;
                if (durationText) {
                    metricsSection += `- ⏱️ **実行時間:** ${durationText}\n`;
                }
                if (modelName) {
                    metricsSection += `- 🤖 **対象モデル:** ${modelName}\n`;
                }
                if (totalTokens > 0) {
                    const thoughtPart = thoughtTokens > 0 ? ` / 思考 ${thoughtTokens.toLocaleString()}` : '';
                    metricsSection += `- 🪙 **トークン消費:** 入力 ${inputTokens.toLocaleString()} / 出力 ${outputTokens.toLocaleString()}${thoughtPart} (合計 ${totalTokens.toLocaleString()})\n`;
                }
                metricsSection += '\n';

                let linksSection = '';
                if (nativeUrl) {
                    linksSection = `**保存先リンク**:\n- [🌐 **Webページとして開く (Secure URL)**](${nativeUrl})\n\n`;
                }

                // Extract Markdown text outside ```html ... ```
                const fullText = context?.fullText || '';
                const textOutsideHtml = fullText
                    .replace(/```html[\s\S]*?(?:```|$)/gi, '')
                    .trim();

                const htmlExtractedSummary = rawHtml ? extractSummaryFromHtml(rawHtml) : '';
                let summaryBody = '';
                if (textOutsideHtml && htmlExtractedSummary) {
                    summaryBody = `${textOutsideHtml}\n\n${htmlExtractedSummary}`;
                } else if (textOutsideHtml) {
                    summaryBody = textOutsideHtml;
                } else if (htmlExtractedSummary) {
                    summaryBody = htmlExtractedSummary;
                } else {
                    summaryBody = rawHtml ? 'インタラクティブHTMLダッシュボードが生成されました。上部の「Webページとして開く (Secure URL)」から閲覧できます。' : (code || '');
                }

                finalContent = `**実行日時:** ${nowStr}\n${queryBlock}${metricsSection}${linksSection}## リサーチ要約\n\n${summaryBody}`;
            }

            const payload = {
                title: title.trim(),
                content: finalContent,
                tags: tags.split(',').map(t => t.trim()).filter(Boolean),
                pod_id: selectedPodId || null,
                input_tokens: inputTokens,
                output_tokens: outputTokens + thoughtTokens
            };

            const res = await fetch('/api/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || 'ナレッジベースへの保存に失敗しました');
            }

            const data = await res.json();
            setSuccessMessage(nativeUrl ? 'Webレポートを公開し、ナレッジベースに保存しました！' : 'ナレッジベースに保存しました！');
            if (onSaved) onSaved(data);
            setTimeout(() => {
                onClose();
            }, 1200);
        } catch (err) {
            console.error('Save knowledge error:', err);
            setError(err.message || '保存エラーが発生しました');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
            <div className="bg-[#1e1e1e] border border-[#333] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden text-white font-sans flex flex-col">
                {/* Header */}
                <div className="px-6 py-4 bg-[#252526] border-b border-[#333] flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <span className="text-xl">📚</span>
                        <div>
                            <h3 className="font-semibold text-base">ナレッジベースに保存</h3>
                            <p className="text-xs text-gray-400">AI Analytics ダッシュボードをチームのナレッジとして共有</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Form Body */}
                <form onSubmit={handleSave} className="p-6 space-y-4">
                    {error && (
                        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg text-xs text-red-300">
                            {error}
                        </div>
                    )}
                    {successMessage && (
                        <div className="p-3 bg-emerald-900/30 border border-emerald-700/50 rounded-lg text-xs text-emerald-300 flex items-center gap-2">
                            <span>✓</span>
                            <span>{successMessage}</span>
                        </div>
                    )}

                    {/* Title */}
                    <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                            記事タイトル <span className="text-red-400">*</span>
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="例: 行政手続 ライフイベント別デジタル化＆行政改革ダッシュボード"
                            className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                            required
                        />
                    </div>

                    {/* Pod Selection */}
                    <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                            保存先 Pod（共有グループ）
                        </label>
                        <select
                            value={selectedPodId}
                            onChange={(e) => setSelectedPodId(e.target.value)}
                            className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                        >
                            <option value="">🌐 共通（パブリック - 全員に公開）</option>
                            {pods.map((pod) => (
                                <option key={pod.id} value={pod.id}>
                                    📦 {pod.name}
                                </option>
                            ))}
                        </select>
                        <p className="text-[11px] text-gray-400 mt-1">
                            {selectedPodId ? '指定したPodのメンバー限定で共有・閲覧されます。' : 'すべての組織メンバーが閲覧できます。'}
                        </p>
                    </div>

                    {/* Tags */}
                    <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                            タグ（カンマ区切り）
                        </label>
                        <input
                            type="text"
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                            placeholder="AI Analytics, GenUI, デジタル庁"
                            className="w-full bg-[#2a2d2e] border border-[#3c3c3c] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                        />
                    </div>

                    {/* Metadata Preview (DeepResearch-style unified header info) */}
                    {context && (
                        <div className="bg-[#252526] border border-[#383838] rounded-lg p-3 space-y-1.5 text-xs text-gray-300">
                            <div className="font-semibold text-blue-400 flex items-center gap-1.5 mb-1">
                                <span>📋</span>
                                <span>自動付与されるナレッジメタデータ (DeepResearch互換)</span>
                            </div>
                            <div className="flex items-center justify-between text-[11px]">
                                <span className="text-gray-400">🤖 対象モデル:</span>
                                <span className="font-mono text-gray-200">{modelName}</span>
                            </div>
                            {totalTokens > 0 && (
                                <div className="flex items-center justify-between text-[11px]">
                                    <span className="text-gray-400">🪙 トークン消費:</span>
                                    <span className="font-mono text-gray-200">
                                        入力 {inputTokens.toLocaleString()} / 出力 {outputTokens.toLocaleString()}{thoughtTokens > 0 ? ` / 思考 ${thoughtTokens.toLocaleString()}` : ''} (合計 {totalTokens.toLocaleString()})
                                    </span>
                                </div>
                            )}
                            {durationText && (
                                <div className="flex items-center justify-between text-[11px]">
                                    <span className="text-gray-400">⏱️ 実行時間:</span>
                                    <span className="font-mono text-gray-200">{durationText}</span>
                                </div>
                            )}
                            <div className="flex items-center justify-between text-[11px]">
                                <span className="text-gray-400">🌐 EA内Webサイト掲載:</span>
                                <span className="text-emerald-400 font-medium">保存時に /reports/*.html URLを自動発行</span>
                            </div>
                        </div>
                    )}

                    {/* Footer Actions */}
                    <div className="pt-3 flex justify-end gap-3 border-t border-[#333]">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={isSaving}
                            className="px-4 py-2 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                        >
                            キャンセル
                        </button>
                        <button
                            type="submit"
                            disabled={isSaving || !!successMessage}
                            className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-lg transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            {isSaving ? (
                                <>
                                    <span className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></span>
                                    <span>保存中...</span>
                                </>
                            ) : successMessage ? (
                                <>
                                    <span>✓ 保存完了</span>
                                </>
                            ) : (
                                <>
                                    <span>📚 ナレッジに保存する</span>
                                </>
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default SaveToKnowledgeModal;
