import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import pkg from '../../package.json';

const MenuBar = ({ onLogout, onOpenSettings, notifications = [], onNotificationClick }) => {
    const [time, setTime] = useState(new Date());
    const [appleMenuOpen, setAppleMenuOpen] = useState(false);
    const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);

    useEffect(() => {
        const timer = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // Close menus when clicking outside
    useEffect(() => {
        const handleClickOutside = () => {
            setAppleMenuOpen(false);
            setNotificationMenuOpen(false);
        };
        if (appleMenuOpen || notificationMenuOpen) {
            window.addEventListener('click', handleClickOutside);
        }
        return () => window.removeEventListener('click', handleClickOutside);
    }, [appleMenuOpen, notificationMenuOpen]);

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            height: '28px',
            backgroundColor: 'rgba(255, 255, 255, 0.3)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 16px',
            fontSize: '13px',
            fontWeight: '500',
            color: '#fff',
            boxShadow: '0 1px 5px rgba(0,0,0,0.1)',
            zIndex: 9999,
            userSelect: 'none',
            whiteSpace: 'nowrap'
        }}>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', minWidth: 0 }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <button
                        type="button"
                        aria-label="Employee Agent Menu"
                        title="Employee Agent メニュー"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '5px',
                            cursor: 'pointer',
                            background: 'transparent',
                            border: 'none',
                            color: '#fff',
                            padding: '2px 4px',
                            borderRadius: '4px'
                        }}
                        className="hover:bg-white/20 transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            setNotificationMenuOpen(false);
                            setAppleMenuOpen(!appleMenuOpen);
                        }}
                    >
                        {/* Cross-platform Employee Agent (EA) SVG Emblem - prevents Windows U+F8FF garbling */}
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))' }}>
                            <path d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="rgba(255,255,255,0.15)" />
                            <path d="M12 6.5L13.6 10.4L17.5 12L13.6 13.6L12 17.5L10.4 13.6L6.5 12L10.4 10.4L12 6.5Z" fill="currentColor" />
                        </svg>
                        <span style={{ fontSize: '11px', fontWeight: '800', letterSpacing: '0.04em' }}>EA</span>
                    </button>
                    {appleMenuOpen && (
                        <div style={{
                            position: 'absolute',
                            top: '26px',
                            left: '-6px',
                            width: '220px',
                            backgroundColor: 'rgba(255, 255, 255, 0.92)',
                            backdropFilter: 'blur(20px)',
                            WebkitBackdropFilter: 'blur(20px)',
                            borderRadius: '6px',
                            boxShadow: '0 5px 15px rgba(0,0,0,0.2)',
                            padding: '4px',
                            display: 'flex',
                            flexDirection: 'column',
                            color: '#000'
                        }}>
                            <div className="px-4 py-1 hover:bg-blue-500 hover:text-white rounded cursor-default">About Employee Agent Core (v{pkg.version})</div>
                            <div className="h-[1px] bg-gray-300 my-1 mx-2"></div>
                            <div
                                className="px-4 py-1 hover:bg-blue-500 hover:text-white rounded cursor-pointer"
                                onClick={() => {
                                    setAppleMenuOpen(false);
                                    if (onOpenSettings) onOpenSettings();
                                }}
                            >
                                System Settings...
                            </div>
                            <div className="h-[1px] bg-gray-300 my-1 mx-2"></div>
                            <div
                                className="px-4 py-1 hover:bg-blue-500 hover:text-white rounded cursor-pointer"
                                onClick={onLogout}
                            >
                                Log Out...
                            </div>
                        </div>
                    )}
                </div>
                <span style={{ fontWeight: '700' }}>Finder</span>
                <div className="hidden sm:flex items-center gap-4">
                    <span>File</span>
                    <span>Edit</span>
                    <span>View</span>
                    <span>Go</span>
                    <span>Window</span>
                    <span>Help</span>
                </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <span>🔋 100%</span>
                <span>📶</span>

                {/* 🔔 Notification Center Icon */}
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <span
                        style={{ fontSize: '15px', cursor: 'pointer', position: 'relative' }}
                        onClick={(e) => {
                            e.stopPropagation();
                            setAppleMenuOpen(false);
                            setNotificationMenuOpen(!notificationMenuOpen);
                        }}
                        title="通知センター"
                    >
                        🔔
                        {notifications.length > 0 && (
                            <span 
                                style={{
                                    position: 'absolute',
                                    top: '-4px',
                                    right: '-5px',
                                    backgroundColor: '#ef4444',
                                    color: '#fff',
                                    fontSize: '9px',
                                    fontWeight: 'bold',
                                    borderRadius: '9999px',
                                    padding: '0 4px',
                                    height: '13px',
                                    minWidth: '13px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                                }}
                            >
                                {notifications.length}
                            </span>
                        )}
                    </span>

                    {/* Notification Dropdown Menu */}
                    {notificationMenuOpen && (
                        <div style={{
                            position: 'absolute',
                            top: '24px',
                            right: '-10px',
                            width: '280px',
                            backgroundColor: 'rgba(17, 24, 39, 0.88)',
                            backdropFilter: 'blur(25px)',
                            WebkitBackdropFilter: 'blur(25px)',
                            borderRadius: '10px',
                            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            padding: '10px',
                            display: 'flex',
                            flexDirection: 'column',
                            color: '#fff',
                            zIndex: 10000,
                            maxHeight: '350px',
                            overflowY: 'auto'
                        }}
                        onClick={(e) => e.stopPropagation()}
                        >
                            <div style={{ 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center', 
                                borderBottom: '1px solid rgba(255, 255, 255, 0.08)', 
                                paddingBottom: '6px', 
                                marginBottom: '8px' 
                            }}>
                                <span style={{ fontWeight: 'bold', fontSize: '11px', color: '#9ca3af' }}>通知センター</span>
                                {notifications.length > 0 && (
                                    <span style={{ fontSize: '9px', color: '#6366f1', fontWeight: 'bold' }}>
                                        未読 {notifications.length}件
                                    </span>
                                )}
                            </div>

                            {notifications.length === 0 ? (
                                <div style={{ 
                                    padding: '20px 0', 
                                    textAlign: 'center', 
                                    color: '#6b7280', 
                                    fontSize: '11px', 
                                    fontStyle: 'italic' 
                                }}>
                                    通知はありません
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {notifications.map(n => (
                                        <div
                                            key={n.id}
                                            onClick={() => {
                                                onNotificationClick(n.senderId, n.senderName, n.senderAvatar);
                                                setNotificationMenuOpen(false);
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'start',
                                                padding: '6px 8px',
                                                borderRadius: '6px',
                                                cursor: 'pointer',
                                                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                                                border: '1px solid rgba(255, 255, 255, 0.02)',
                                                transition: 'background-color 0.15s ease'
                                            }}
                                            className="hover:bg-white/10"
                                        >
                                            <img
                                                src={n.senderAvatar}
                                                alt={n.senderName}
                                                style={{
                                                    width: '26px',
                                                    height: '26px',
                                                    borderRadius: '6px',
                                                    objectFit: 'cover',
                                                    marginRight: '8px',
                                                    border: '1px solid rgba(255, 255, 255, 0.1)'
                                                }}
                                                onError={(e) => {
                                                    e.target.src = `https://api.dicebear.com/7.x/initials/svg?seed=${n.senderName}`;
                                                }}
                                            />
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1px' }}>
                                                    <span style={{ fontWeight: 'bold', fontSize: '11px', color: '#f3f4f6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {n.senderName}
                                                    </span>
                                                    <span style={{ fontSize: '8px', color: '#9ca3af' }}>現在</span>
                                                </div>
                                                <p style={{ 
                                                    margin: 0, 
                                                    fontSize: '10px', 
                                                    color: '#d1d5db', 
                                                    overflow: 'hidden', 
                                                    textOverflow: 'ellipsis', 
                                                    whiteSpace: 'nowrap' 
                                                }}>
                                                    {n.text}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <span>{format(time, 'EEE MMM d h:mm aa')}</span>
            </div>
        </div>
    );
};

export default MenuBar;
