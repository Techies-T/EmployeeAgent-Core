import React, { useState, useEffect, useRef } from 'react';
import MenuBar from './MenuBar';
import Dock from './Dock';
import WindowManager from './WindowManager';
import StickiesLayer from '../apps/Stickies';

const MENU_BAR_HEIGHT = 28;
const DOCK_RESERVE_HEIGHT = 82;

const clampWindowToViewport = (w) => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxAvailWidth = Math.max(300, vw - 16);
  const maxAvailHeight = Math.max(220, vh - MENU_BAR_HEIGHT - DOCK_RESERVE_HEIGHT);
  const width = Math.min(w.width || 600, maxAvailWidth);
  const height = Math.min(w.height || 400, maxAvailHeight);
  const maxX = Math.max(8, vw - width - 8);
  const maxY = Math.max(MENU_BAR_HEIGHT + 4, vh - DOCK_RESERVE_HEIGHT - height);
  const x = Math.min(Math.max(8, w.x ?? 80), maxX);
  const y = Math.min(Math.max(MENU_BAR_HEIGHT + 4, w.y ?? 48), maxY);
  return { ...w, x, y, width, height };
};

const Desktop = ({ user, onLogout, config }) => {
  const [windows, setWindows] = useState([]);
  const [customSkills, setCustomSkills] = useState([]);
  const saveTimeoutRef = useRef(null);
  const isInitialMount = useRef(true);
  const stickiesRef = useRef(null);

  const [notifications, setNotifications] = useState([]);
  const notifiedIdsRef = useRef(new Set());

  // 3秒ポーリングによる未読メッセージ監視
  useEffect(() => {
    let intervalId;

    const checkUnread = async () => {
      try {
        const res = await fetch('/api/dm/unread');
        if (res.ok) {
          const data = await res.json();
          const newUnreads = data.unread || [];

          let addedAny = false;
          const currentNewNotifications = [];

          newUnreads.forEach(msg => {
            if (!notifiedIdsRef.current.has(msg.id)) {
              notifiedIdsRef.current.add(msg.id);
              currentNewNotifications.push({
                id: msg.id,
                senderId: msg.sender_id,
                senderName: msg.sender_name,
                senderAvatar: msg.sender_avatar,
                text: msg.text,
                createdAt: msg.created_at
              });
              addedAny = true;
            }
          });

          if (addedAny) {
            setNotifications(prev => [...prev, ...currentNewNotifications]);
          }
        }
      } catch (err) {
        console.error("Failed to fetch unread notifications:", err);
      }
    };

    checkUnread();
    intervalId = setInterval(checkUnread, 3000);

    return () => clearInterval(intervalId);
  }, []);

  // 5秒後の自動フェードアウト
  useEffect(() => {
    if (notifications.length > 0) {
      const timer = setTimeout(() => {
        setNotifications(prev => prev.slice(1));
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [notifications]);

  // Load installed skills
  const fetchSkills = React.useCallback(async () => {
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        setCustomSkills(data);
      }
    } catch (err) {
      console.error('Failed to fetch skills:', err);
    }
  }, []);

  useEffect(() => {
    // Wrap in timeout to avoid "setState synchronously within an effect" warning
    const timer = setTimeout(() => {
      fetchSkills();
    }, 0);
    
    const handleUpdate = () => fetchSkills();
    window.addEventListener('skills-updated', handleUpdate);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('skills-updated', handleUpdate);
    };
  }, [fetchSkills]);

  // Load window state on mount
  useEffect(() => {
    const loadState = async () => {
      try {
        const res = await fetch('/api/user/preferences');
        if (res.ok) {
          const data = await res.json();
          if (data.windowState && Array.isArray(data.windowState)) {
            // Sanitize window positions & dimensions to ensure they fit the current viewport
            const sanitizedWindows = data.windowState.map(w => clampWindowToViewport(w));
            setWindows(sanitizedWindows);
          }
        }
      } catch (error) {
        console.error("Failed to load window state", error);
      }
    };
    loadState();
  }, []);

  // Re-clamp windows when browser viewport is resized
  useEffect(() => {
    const handleViewportResize = () => {
      setWindows(prev => prev.map(w => clampWindowToViewport(w)));
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  // Save window state on change (debounced)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch('/api/user/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowState: windows })
        });
      } catch (error) {
        console.error("Failed to save window state", error);
      }
    }, 1000); // Save after 1 second of inactivity

    return () => clearTimeout(saveTimeoutRef.current);
  }, [windows]);

  const openWindow = React.useCallback((id, type, title, props = {}) => {
    setWindows(prev => {
      // For app-monitor, always open a new window
      if (type === 'app-monitor') {
          id = `app-monitor-${Date.now()}`;
      } else {
          // If window already exists, bring to front and restore if minimized
          const existing = prev.find(w => w.id === id);
          if (existing) {
            const maxZ = Math.max(...prev.map(w => w.zIndex), 0);
            return prev.map(w => w.id === id ? { ...w, zIndex: maxZ + 1, minimized: false, props: { ...w.props, ...props } } : w);
          }
      }
      // Open new window
      const maxZ = Math.max(...prev.map(w => w.zIndex), 0);

      let width = 600;
      let height = 400;

      if (type === 'gemini') {
        width = 400;
        height = 650;
      } else if (type === 'deep-research') {
        width = 500;
        height = 700;
      } else if (type === 'browser') {
        width = 800;
        height = 600;
      } else if (type === 'html-editor') {
        width = 800;
        height = 600;
      } else if (type === 'mcp-chat') {
        width = 1000;
        height = 650;
      } else if (type === 'live-concierge') {
        width = 980;
        height = 700;
      } else if (type === 'knowledge-base') {
        width = 900;
        height = 650;
      } else if (type === 'virtual-office') {
        width = 750;
        height = 550;
      } else if (type === 'dm-chat') {
        width = 380;
        height = 500;
      }

      const newWin = clampWindowToViewport({
        id: id || Date.now(),
        type,
        title,
        x: 120 + (prev.length * 24) % 160,
        y: 44 + (prev.length * 20) % 100,
        width,
        height,
        zIndex: maxZ + 1,
        minimized: false,
        props
      });

      return [...prev, newWin];
    });
  }, []);

  const handleNotificationClick = (senderId, senderName, senderAvatar) => {
    openWindow(`dm-chat-${senderId}`, 'dm-chat', `Chat with ${senderName}`, {
      targetUser: { id: senderId, name: senderName, avatar_url: senderAvatar }
    });
    setNotifications(prev => prev.filter(n => n.senderId !== senderId));
  };

  const closeWindow = React.useCallback((id) => {
    console.log("Desktop: closeWindow", id);
    setWindows(prev => prev.filter(w => w.id !== id));
  }, []);

  const minimizeWindow = React.useCallback((id) => {
    console.log("Desktop: minimizeWindow", id);
    setWindows(prev => prev.map(w => w.id === id ? { ...w, minimized: true } : w));
  }, []);

  const bringToFront = React.useCallback((id) => {
    setWindows(prev => {
      const maxZ = Math.max(...prev.map(w => w.zIndex), 0);
      // Only update if not already at front to save renders
      const current = prev.find(w => w.id === id);
      if (current && current.zIndex === maxZ && prev.length > 1) return prev;

      return prev.map(w => w.id === id ? { ...w, zIndex: maxZ + 1 } : w);
    });
  }, []);

  const updateWindow = React.useCallback((id, updates) => {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
  }, []);

  return (
    <div
      className="desktop"
      onScroll={(e) => {
        if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
        if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
      }}
      style={{
        width: '100vw',
        height: '100dvh',
        backgroundImage: 'url(https://images.unsplash.com/photo-1490730141103-6cac27aaab94?q=80&w=2940&auto=format&fit=crop)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        position: 'relative',
        overflow: 'clip',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between'
      }}
    >
      <MenuBar 
        onLogout={onLogout} 
        onOpenSettings={() => openWindow('settings', 'settings', 'System Settings')}
        notifications={notifications} 
        onNotificationClick={handleNotificationClick} 
      />

      {/* MacOS-style Toast Notifications */}
      <div 
        style={{
          position: 'absolute',
          top: '45px',
          right: '20px',
          zIndex: 999999,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          maxWidth: '320px',
          width: '100%'
        }}
      >
        {notifications.map(n => (
          <div
            key={n.id}
            onClick={() => handleNotificationClick(n.senderId, n.senderName, n.senderAvatar)}
            className="flex items-start p-3 bg-gray-900/85 text-white rounded-xl border border-gray-800/80 shadow-2xl cursor-pointer hover:bg-gray-800/90 transition duration-200 select-none animate-slide-in"
            style={{
              backdropFilter: 'blur(16px)',
              boxShadow: '0 10px 30px -10px rgba(0, 0, 0, 0.5)',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}
          >
            <img 
              src={n.senderAvatar} 
              alt={n.senderName} 
              className="w-10 h-10 rounded-lg object-cover mr-3 border border-gray-700/80"
              onError={(e) => {
                e.target.src = `https://api.dicebear.com/7.x/initials/svg?seed=${n.senderName}`;
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-bold text-gray-100 truncate">{n.senderName}</span>
                <span className="text-[9px] text-gray-400">現在</span>
              </div>
              <p className="text-[11px] text-gray-300 line-clamp-2 leading-relaxed">
                {n.text}
              </p>
              <div className="flex justify-end mt-2">
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNotificationClick(n.senderId, n.senderName, n.senderAvatar);
                  }}
                  className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-[9px] font-semibold transition"
                >
                  返信する
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Stickies Layer - Below windows but above background */}
      <StickiesLayer ref={stickiesRef} />

      <WindowManager
        windows={windows}
        onFocus={bringToFront}
        onClose={closeWindow}
        onMinimize={minimizeWindow}
        onOpen={openWindow}
        onUpdate={updateWindow} // Pass update handler
        user={user}
        config={config}
      />
      <Dock
        windows={windows}
        user={user}
        config={config}
        customSkills={customSkills}
        onAppClick={(id) => {
          if (id === 'stickies') {
            if (stickiesRef.current) {
              stickiesRef.current.addNote();
            }
            return;
          }

          // Check if it's a dynamic custom skill
          const customSkill = customSkills.find(s => s.id === id);
          if (customSkill) {
             // 監査ログを記録
             fetch('/api/skills/log-access', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     id: customSkill.id,
                     name: customSkill.name,
                     entrypoint_url: customSkill.entrypoint_url
                 })
             }).catch(err => console.error('Failed to log skill access:', err));

             openWindow(id, 'external-skill', customSkill.name, { url: customSkill.entrypoint_url });
             return;
          }

          // Simple mapping for demo purposes
          const titleMap = {
            calculator: 'Calculator',
            notes: 'Notes',
            finder: 'Finder',
            gemini: 'Gemini AI',
            'knowledge-base': 'Knowledge Base',
            'deep-research': 'Deep Research',
            'mcp-chat': 'MCP Chat Client',
            'live-concierge': 'Live Concierge',
            'virtual-office': 'Virtual Office',
            settings: 'System Settings',
            browser: 'Safari',
            'html-editor': 'HTML Editor'
          };
          openWindow(id, id, titleMap[id]);
        }} />
    </div>
  );
};

export default Desktop;
