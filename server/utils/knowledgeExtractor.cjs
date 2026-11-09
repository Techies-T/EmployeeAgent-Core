/**
 * Knowledge Base Content Extractor & Summarizer for Gemini Live
 * Markdown、HTML、SVG、Chart.js を含むナレッジ記事から、
 * ダッシュボードのタブ構造・操作ボタン一覧およびAIが理解しやすい高密度のセマンティックコンテキストを抽出・生成します。
 */

/**
 * HTML 内のタブ切り替えボタンやナビゲーション要素を抽出
 * @param {string} html
 * @returns {string[]} タブラベルの配列
 */
function extractDashboardTabs(html) {
    if (!html) return [];
    const tabs = [];
    const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let match;
    while ((match = buttonRegex.exec(html)) !== null) {
        const attrs = match[1] || '';
        const innerText = (match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!innerText) continue;
        // onclick="switchTab(...)" や id="tab-..." や data-tab などのタブ切り替えボタンを検出
        if (/switchTab|showTab|changeTab|openTab|selectTab|data-tab|role=["']tab["']|id=["']tab-|tab-btn/i.test(attrs)) {
            if (!tabs.includes(innerText)) {
                tabs.push(innerText);
            }
        }
    }
    return tabs;
}

function sanitizeHtmlToText(html) {
    if (!html) return '';

    // 1. スクリプト、スタイル、SVGパス等の不要なバイナリ/定義を除去（Chart.jsのデータは保持）
    let text = html
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, (match) => {
            const chartDataMatches = match.match(/(?:labels|label|datasets|data):\s*(?:\[[^\]]+\]|['"][^'"]+['"])/gi);
            if (chartDataMatches) {
                return `\n[グラフデータ定義: ${chartDataMatches.slice(0, 12).join(', ')}]\n`;
            }
            return '';
        })
        .replace(/<path\b[^>]*>/gi, '') // SVG path 除去
        .replace(/<!--[\s\S]*?-->/g, ''); // コメント除去

    // 2. タブボタンやタブコンテンツパネルの区切りを明示的なマーカーに変換（AIがどのタブに何があるか把握できるようにする）
    text = text
        .replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (full, attrs, inner) => {
            const cleanInner = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (/switchTab|showTab|changeTab|openTab|selectTab|data-tab|role=["']tab["']|id=["']tab-|tab-btn/i.test(attrs)) {
                return `\n[画面上部タブボタン: 「${cleanInner}」]\n`;
            }
            return cleanInner ? ` [ボタン: ${cleanInner}] ` : '';
        })
        .replace(/<div\b([^>]*\bid=["'](?:content-|tab-content-|panel-|tab-)[^"']+["'][^>]*)>/gi, (full, attrs) => {
            const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
            return idMatch ? `\n\n=== [タブ表示パネル (${idMatch[1]})] ===\n` : '\n';
        })
        .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n### $1\n')
        .replace(/<tr[^>]*>/gi, '\n')
        .replace(/<t[hd][^>]*>(.*?)<\/t[hd]>/gi, ' | $1')
        .replace(/<p[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<br\s*\/?>/gi, '\n');

    // 3. 残りの全HTMLタグを除去
    text = text.replace(/<[^>]+>/g, ' ');

    // 4. HTML エンティティのデコード
    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // 5. 連続する空白・改行を整理
    return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/**
 * コンテンツ文字列から埋め込み HTML/SVG ダッシュボードコードとタブ構成を抽出
 * @param {string} rawContent
 * @returns {{ htmlBlocks: string[], primaryHtml: string|null, uiTabs: string[], markdownWithoutHtml: string }}
 */
function parseDashboardBlocks(rawContent) {
    if (!rawContent) {
        return { htmlBlocks: [], primaryHtml: null, uiTabs: [], markdownWithoutHtml: '' };
    }

    const htmlBlocks = [];
    const markdownWithoutHtml = rawContent.replace(/```(?:html|htm|svg|xml)?\s*([\s\S]*?)```/gi, (full, code) => {
        if (/<html|<!DOCTYPE|<div|<svg|<script|cdn\.tailwindcss\.com|chart\.js/i.test(code)) {
            htmlBlocks.push(code.trim());
            return '\n[インタラクティブ・ダッシュボード (HTML/SVG)]\n';
        }
        return full;
    });

    // コードブロックではなく生HTMLが直接格納されている場合のフォールバック
    if (htmlBlocks.length === 0 && (rawContent.trim().startsWith('<!DOCTYPE') || rawContent.trim().startsWith('<html') || rawContent.includes('cdn.tailwindcss.com'))) {
        htmlBlocks.push(rawContent.trim());
    }

    const primaryHtml = htmlBlocks.length > 0 ? htmlBlocks[0] : null;
    const allTabs = [];
    for (const block of htmlBlocks) {
        for (const tab of extractDashboardTabs(block)) {
            if (!allTabs.includes(tab)) allTabs.push(tab);
        }
    }

    return {
        htmlBlocks,
        primaryHtml,
        uiTabs: allTabs,
        markdownWithoutHtml
    };
}

/**
 * ナレッジ記事レコードから Gemini Live 向けのセマンティックコンテキストを生成
 * @param {Object} article - knowledge_articles レコード (または { id, title, content, tags })
 * @param {number} maxChars - 最大文字数 (デフォルト: 6000)
 * @returns {Object} { id, title, tags, rawHtml, uiTabs, formattedContext }
 */
function extractKnowledgeContext(article, maxChars = 6000) {
    if (!article) return null;

    const title = article.title || '無題のナレッジ記事';
    let tags = [];
    try {
        tags = typeof article.tags === 'string' ? JSON.parse(article.tags) : (article.tags || []);
    } catch (_) {
        tags = (article.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    }

    const rawContent = article.content || '';
    const { htmlBlocks, primaryHtml, uiTabs, markdownWithoutHtml } = parseDashboardBlocks(rawContent);

    // 各パートのテキスト化
    const markdownText = (primaryHtml === rawContent.trim())
        ? ''
        : markdownWithoutHtml.replace(/!\[.*?\]\(.*?\)/g, '').trim();

    const extractedHtmlText = htmlBlocks.map(html => sanitizeHtmlToText(html)).join('\n\n');

    // 統合テキスト構築
    let body = `${markdownText}\n\n${extractedHtmlText}`.trim();
    if (body.length > maxChars) {
        body = body.substring(0, maxChars) + '\n... (以降のデータは省略)';
    }

    const tabGuideSection = uiTabs.length > 0
        ? [
            '【画面上のインタラクティブ・タブ構成】',
            `このダッシュボード画面の上部には以下の ${uiTabs.length} 個の切り替えタブがあります:`,
            uiTabs.map((t, i) => `  ・タブ${i + 1}: 「${t}」${i === 0 ? '（※初期表示中）' : ''}`).join('\n'),
            '※解説する際は、「現在は〇〇タブが表示されています」「続いて画面上部の『△△』タブをクリックして開いてご覧ください」のように、ユーザーの画面操作を案内しながら各タブの内容を解説してください。'
        ].join('\n')
        : null;

    const formattedContext = [
        `【レポートタイトル】: ${title}`,
        tags.length > 0 ? `【タグ】: ${tags.join(', ')}` : null,
        article.created_at ? `【作成日時】: ${article.created_at}` : null,
        article.author_name ? `【作成者】: ${article.author_name}` : null,
        tabGuideSection ? '----------------------------------------\n' + tabGuideSection : null,
        '----------------------------------------',
        '【主要な分析内容・タブ別データ要約】',
        body
    ].filter(Boolean).join('\n');

    return {
        id: article.id || null,
        title,
        tags,
        pod_id: article.pod_id || null,
        created_at: article.created_at || null,
        rawHtml: primaryHtml,
        rawContent,
        uiTabs,
        formattedContext
    };
}

module.exports = {
    sanitizeHtmlToText,
    extractDashboardTabs,
    parseDashboardBlocks,
    extractKnowledgeContext
};
