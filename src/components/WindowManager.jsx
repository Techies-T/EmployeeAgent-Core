import React from 'react';
import Window from './Window';
import ErrorBoundary from './ErrorBoundary';
import Calculator from '../apps/Calculator';
import Notes from '../apps/Notes';
import Finder from '../apps/Finder';
import Gemini from '../apps/Gemini';
import Calendar from '../apps/Calendar';
import SystemSettings from '../apps/SystemSettings';
import Browser from '../apps/Browser';
import HtmlEditor from '../apps/HtmlEditor';
import DeepResearch from '../apps/DeepResearch';
import KnowledgeBase from '../apps/KnowledgeBase';
import ExternalWidget from '../apps/ExternalWidget';
import McpChat from '../apps/McpChat';
import LiveConcierge from '../apps/LiveConcierge';
import PluginHostFrame from './PluginHostFrame';


const WindowManager = ({ windows, onFocus, onClose, onMinimize, onOpen, onUpdate, user, config }) => {
    const capabilities = config?.capabilities || [];
    const renderApp = (win) => {
        const type = win.type;
        console.log("WindowManager: renderApp", type);

        // 1. サブビュー形式のプラグインウィンドウ (例: plugin-subview:virtual-office:dm-chat)
        if (type && type.startsWith('plugin-subview:')) {
            const parts = type.split(':');
            const widgetId = parts[1];
            const subView = parts.slice(2).join(':');
            return (
                <PluginHostFrame
                    widgetId={widgetId}
                    subView={subView}
                    title={win.title}
                    pluginParams={win.props}
                    user={user}
                    capabilities={capabilities}
                    onOpen={onOpen}
                />
            );
        }

        // 2. 外部プラグインまたは動的インストールされたウィジェット
        const installedWidgets = config?.installedWidgets || [];
        const installedPlugin = installedWidgets.find(w => (typeof w === 'string' ? w : w.id) === type);
        if (installedPlugin?.isExternalPlugin || win.isExternalPlugin || type === 'virtual-office') {
            return (
                <PluginHostFrame
                    widgetId={type}
                    title={win.title}
                    pluginMeta={installedPlugin}
                    pluginParams={win.props}
                    user={user}
                    capabilities={capabilities}
                    onOpen={onOpen}
                />
            );
        }

        switch (type) {
            case 'calculator': return <Calculator />;
            case 'notes': return <Notes />;
            case 'finder': return <Finder user={user} onOpen={onOpen} />;
            case 'gemini': return <Gemini user={user} capabilities={capabilities} onOpen={onOpen} {...win.props} />;
            case 'calendar': return <Calendar />;
            case 'settings': return <SystemSettings user={user} />;
            case 'browser': return <Browser {...win.props} />;
            case 'html-editor': return <HtmlEditor onOpen={onOpen} {...win.props} />;
            case 'deep-research': return <DeepResearch onOpen={onOpen} capabilities={capabilities} />;
            case 'knowledge-base': return <KnowledgeBase user={user} onOpen={onOpen} capabilities={capabilities} {...win.props} />;
            case 'mcp-chat': return <McpChat user={user} capabilities={capabilities} onOpen={onOpen} {...win.props} />;
            case 'live-concierge': return <LiveConcierge onOpen={onOpen} user={user} {...win.props} />;
            case 'external-skill': return <ExternalWidget url={win.props.url} title={win.title} widgetId={win.id || 'external-skill'} />;
            default: return null;
        }
    };

    return (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {windows.map(win => (
                <Window
                    key={win.id}
                    id={win.id}
                    title={win.title}
                    initialX={win.x}
                    initialY={win.y}
                    initialWidth={win.width}
                    initialHeight={win.height}
                    zIndex={win.zIndex}
                    onFocus={onFocus}
                    onClose={onClose}
                    onMinimize={onMinimize}
                    onUpdate={onUpdate}
                    minimized={win.minimized}
                >
                    <ErrorBoundary>
                        {renderApp(win)}
                    </ErrorBoundary>
                </Window>
            ))}
        </div>
    );
};

export default WindowManager;
