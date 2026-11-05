import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const Dock = ({ onAppClick, windows = [], user, config, customSkills = [] }) => {
    const [hoveredAppId, setHoveredAppId] = useState(null);
    const apps = [
        {
            id: 'finder', name: 'Finder', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#0963ec' }}>
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
                </svg>
            )
        },
        {
            id: 'browser', name: 'ブラウザ', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#2563eb' }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
            )
        },
        {
            id: 'settings', name: 'システム設定', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#4b5563' }}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
            )
        },
        {
            id: 'calculator', name: '計算機', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#ea580c' }}>
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                    <line x1="8" y1="6" x2="16" y2="6" />
                    <line x1="16" y1="14" x2="16" y2="18" />
                    <path d="M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01" strokeWidth="2" />
                </svg>
            )
        },
        {
            id: 'stickies', name: '付箋', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#ef4444' }}>
                    <path d="M15 4.5l-4 4L7 8.5l-1.5 1.5 4 4L4 19l5-5.5 4 4 1.5-1.5-1-4 4-4z" />
                    <line x1="15" y1="4.5" x2="19.5" y2="9" />
                </svg>
            )
        },
        {
            id: 'notes', name: 'メモ', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#d97706' }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                </svg>
            )
        },
        {
            id: 'html-editor', name: 'HTMLエディタ', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#059669' }}>
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                    <line x1="14" y1="4" x2="10" y2="20" />
                </svg>
            )
        },
        {
            id: 'calendar', name: 'カレンダー', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#dc2626' }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                    <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" strokeWidth="2" />
                </svg>
            )
        },
        {
            id: 'knowledge-base', name: 'ナレッジベース', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#7c3aed' }}>
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
            )
        },
        {
            id: 'gemini', name: 'Gemini チャット', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#8b5cf6' }}>
                    <path d="M12 2v20M2 12h20M17 7l-10 10M7 7l10 10" />
                </svg>
            )
        },
        {
            id: 'mcp-chat', name: 'MCPチャット', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#4f46e5' }}>
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    <line x1="9" y1="9" x2="15" y2="9" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                </svg>
            )
        },
        {
            id: 'deep-research', name: 'DeepResearch', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#6366f1' }}>
                    <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="1" x2="9" y2="4" />
                    <line x1="15" y1="1" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="23" />
                    <line x1="15" y1="20" x2="15" y2="23" />
                    <line x1="20" y1="9" x2="23" y2="9" />
                    <line x1="20" y1="14" x2="23" y2="14" />
                    <line x1="1" y1="9" x2="4" y2="9" />
                    <line x1="1" y1="14" x2="4" y2="14" />
                </svg>
            )
        },
        {
            id: 'live-concierge', name: 'Live Concierge', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#ec4899' }}>
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <circle cx="12" cy="7" r="1" fill="currentColor" />
                    <path d="M8 22h8" />
                </svg>
            )
        },
        {
            id: 'virtual-office', name: 'バーチャルオフィス', icon: (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '28px', height: '28px', color: '#06b6d4' }}>
                    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                    <line x1="9" y1="22" x2="9" y2="16" />
                    <line x1="15" y1="22" x2="15" y2="16" />
                    <line x1="9" y1="16" x2="15" y2="16" />
                    <path d="M8 6h.01" />
                    <path d="M16 6h.01" />
                    <path d="M8 10h.01" />
                    <path d="M16 10h.01" />
                    <path d="M12 6h.01" />
                    <path d="M12 10h.01" />
                </svg>
            )
        },
    ];

    const handleAppClick = (appId) => {
        console.log("Dock: handleAppClick", appId);
        if (onAppClick) {
            onAppClick(appId);
        }
    };

    const allowedWidgets = user?.allowed_widgets || [];
    const widgetLevels = user?.widget_levels || {};
    const installedWidgetsList = Array.isArray(config?.installedWidgets) && config.installedWidgets.length > 0
        ? config.installedWidgets
        : ['gemini', 'mcp-chat', 'knowledge-base'];
    const installedIdsSet = new Set(installedWidgetsList.map(w => typeof w === 'string' ? w : w.id));

    const dynamicApps = customSkills.map(skill => ({
        id: skill.id,
        name: skill.name,
        icon: skill.icon_url && (skill.icon_url.startsWith('http') || skill.icon_url.startsWith('data:image')) 
              ? <img src={skill.icon_url} alt={skill.name} style={{ width: '36px', height: '36px', objectFit: 'contain' }} /> 
              : (skill.icon_url || '🧩'),
        isCustom: true
    }));

    const allApps = [...apps, ...dynamicApps];

    const visibleApps = allApps.filter(app => {
        if (app.id === 'settings') return true; // Settings is universally available
        if (app.isCustom) return true;
        // 1. Check if widget is installed in EmployeeAgent-Core plugin manager
        if (installedIdsSet && !installedIdsSet.has(app.id)) {
            return false;
        }
        // 2. Check ZTA PDP permission level
        if (widgetLevels[app.id] === 'none') {
            return false;
        }
        const prefix = 'app:';
        return allowedWidgets.includes('*') || allowedWidgets.includes(`${prefix}${app.id}`);
    });

    return (
        <div style={{
            position: 'fixed',
            bottom: '10px',
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 9999,
            padding: '0 10px'
        }}>
            <div style={{
                pointerEvents: 'auto',
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                padding: '8px 10px',
                borderRadius: '20px',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '10px',
                maxWidth: 'calc(100vw - 20px)',
                boxShadow: '0 4px 30px rgba(0, 0, 0, 0.15)',
                border: '1px solid rgba(255, 255, 255, 0.15)'
            }}>
                {visibleApps.map((app) => {
                    const isOpen = windows.some(w => w.type === app.id);
                    return (
                        <div 
                            key={app.id} 
                            style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}
                            onMouseEnter={() => setHoveredAppId(app.id)}
                            onMouseLeave={() => setHoveredAppId(null)}
                        >
                            {/* macOS Style Dock Label Tooltip */}
                            <AnimatePresence>
                                {hoveredAppId === app.id && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 6, scale: 0.92 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: 4, scale: 0.95 }}
                                        transition={{ duration: 0.12, ease: "easeOut" }}
                                        style={{
                                            position: 'absolute',
                                            bottom: '68px',
                                            pointerEvents: 'none',
                                            whiteSpace: 'nowrap',
                                            zIndex: 10000,
                                            backgroundColor: 'rgba(20, 20, 25, 0.8)',
                                            backdropFilter: 'blur(16px)',
                                            WebkitBackdropFilter: 'blur(16px)',
                                            color: '#ffffff',
                                            fontSize: '11px',
                                            fontWeight: '500',
                                            padding: '3px 9px',
                                            borderRadius: '6px',
                                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
                                            border: '1px solid rgba(255, 255, 255, 0.18)',
                                            userSelect: 'none'
                                        }}
                                    >
                                        {app.name}
                                        {/* Tooltip Arrow */}
                                        <div style={{
                                            position: 'absolute',
                                            bottom: '-4px',
                                            left: '50%',
                                            transform: 'translateX(-50%)',
                                            width: 0,
                                            height: 0,
                                            borderLeft: '4px solid transparent',
                                            borderRight: '4px solid transparent',
                                            borderTop: '4px solid rgba(20, 20, 25, 0.8)'
                                        }} />
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            <motion.div
                                whileHover={{ scale: 1.2, translateY: -10 }}
                                tabIndex={0}
                                onFocus={() => setHoveredAppId(app.id)}
                                onBlur={() => setHoveredAppId(null)}
                                style={{
                                    width: '50px',
                                    height: '50px',
                                    backgroundColor: '#fff',
                                    borderRadius: '12px',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    fontSize: '30px',
                                    cursor: 'pointer',
                                    boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                                    outline: 'none'
                                }}
                                onClick={() => handleAppClick(app.id)}
                            >
                                {app.icon}
                            </motion.div>
                            <div style={{
                                width: '4px',
                                height: '4px',
                                borderRadius: '50%',
                                backgroundColor: isOpen ? '#333' : 'transparent',
                                opacity: 0.8
                            }}></div>
                        </div>
                    );
                })}

                {/* Minimized Windows Section */}
                {windows.filter(w => w.minimized && w.type === 'browser').length > 0 && (
                    <>
                        <div style={{ width: '1px', backgroundColor: 'rgba(255, 255, 255, 0.3)', margin: '0 8px' }}></div>
                        {windows.filter(w => w.minimized && w.type === 'browser').map(win => (
                            <div 
                                key={win.id} 
                                style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}
                                onMouseEnter={() => setHoveredAppId(win.id)}
                                onMouseLeave={() => setHoveredAppId(null)}
                            >
                                <AnimatePresence>
                                    {hoveredAppId === win.id && (
                                        <motion.div
                                            initial={{ opacity: 0, y: 6, scale: 0.92 }}
                                            animate={{ opacity: 1, y: 0, scale: 1 }}
                                            exit={{ opacity: 0, y: 4, scale: 0.95 }}
                                            transition={{ duration: 0.12, ease: "easeOut" }}
                                            style={{
                                                position: 'absolute',
                                                bottom: '68px',
                                                pointerEvents: 'none',
                                                whiteSpace: 'nowrap',
                                                zIndex: 10000,
                                                backgroundColor: 'rgba(20, 20, 25, 0.8)',
                                                backdropFilter: 'blur(16px)',
                                                WebkitBackdropFilter: 'blur(16px)',
                                                color: '#ffffff',
                                                fontSize: '11px',
                                                fontWeight: '500',
                                                padding: '3px 9px',
                                                borderRadius: '6px',
                                                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
                                                border: '1px solid rgba(255, 255, 255, 0.18)',
                                                userSelect: 'none'
                                            }}
                                        >
                                            {win.title || "ブラウザ"}
                                            <div style={{
                                                position: 'absolute',
                                                bottom: '-4px',
                                                left: '50%',
                                                transform: 'translateX(-50%)',
                                                width: 0,
                                                height: 0,
                                                borderLeft: '4px solid transparent',
                                                borderRight: '4px solid transparent',
                                                borderTop: '4px solid rgba(20, 20, 25, 0.8)'
                                            }} />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                                <motion.div
                                    whileHover={{ scale: 1.2, translateY: -10 }}
                                    tabIndex={0}
                                    onFocus={() => setHoveredAppId(win.id)}
                                    onBlur={() => setHoveredAppId(null)}
                                    style={{
                                        width: '50px',
                                        height: '50px',
                                        backgroundColor: '#fff',
                                        borderRadius: '12px',
                                        display: 'flex',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        fontSize: '24px',
                                        cursor: 'pointer',
                                        boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
                                        overflow: 'hidden',
                                        position: 'relative',
                                        outline: 'none'
                                    }}
                                    onClick={() => onAppClick(win.id)}
                                >
                                    <div style={{ position: 'absolute', top: 2, right: 2, fontSize: '10px' }}>🌐</div>
                                    <div style={{ fontSize: '12px', color: '#333', textAlign: 'center', lineHeight: '1', padding: '2px' }}>
                                        {win.title?.substring(0, 6) || "Web"}...
                                    </div>
                                </motion.div>
                                <div style={{
                                    width: '4px',
                                    height: '4px',
                                    borderRadius: '50%',
                                    backgroundColor: 'transparent', // No dot for minimized? Or yes? Mac usually has diamond?
                                    opacity: 0.8
                                }}></div>
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
};

export default Dock;
