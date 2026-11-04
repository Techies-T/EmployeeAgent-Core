import React, { useState, useEffect } from 'react';
import { useGoogleLogin } from '@react-oauth/google';

const LoginScreen = ({ onLogin, authNotice = '', onClearNotice }) => {
    const [currentTime, setCurrentTime] = useState(new Date());
    const [isLoading, setIsLoading] = useState(false);
    const [loginError, setLoginError] = useState('');
    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    const login = useGoogleLogin({
        onSuccess: async (codeResponse) => {
            setIsLoading(true);
            setLoginError('');
            if (onClearNotice) onClearNotice();
            try {
                const response = await fetch('/api/auth/google', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ code: codeResponse.code }),
                });

                if (response.ok) {
                    const data = await response.json();
                    onLogin(data.user);
                } else {
                    const errData = await response.json().catch(() => ({}));
                    setLoginError(errData.error || 'ログインに失敗しました。権限を確認してください。');
                    console.error('Login failed on server');
                }
            } catch (error) {
                setLoginError('サーバーとの通信に失敗しました。');
                console.error('Login error:', error);
            } finally {
                setIsLoading(false);
            }
        },
        onError: (err) => {
            console.error('Google OAuth Error:', err);
            setLoginError(`Google認証エラーが発生しました (${err?.error_description || err?.error || 'OAuth popup failed'})。URLが http://localhost:8080 であるかご確認ください。`);
        },
        onNonOAuthError: (nonOAuthErr) => {
            console.warn('Google Non-OAuth Error:', nonOAuthErr);
            if (nonOAuthErr?.type === 'popup_failed_to_open') {
                setLoginError('Googleログインのポップアップがブラウザにブロックされました。ポップアップを許可してください。');
            } else if (nonOAuthErr?.type === 'popup_closed') {
                setLoginError('Googleログインのウィンドウが閉じられました。');
            }
        },
        flow: 'auth-code',
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar',
        prompt: 'consent' // ALWAYS request consent to ensure we get a refresh_token even on the staging DB
    });

    const handleLocalDevLogin = async () => {
        setIsLoading(true);
        setLoginError('');
        if (onClearNotice) onClearNotice();
        try {
            const response = await fetch('/api/auth/local-dev-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                const data = await response.json();
                onLogin(data.user);
            } else {
                const errData = await response.json().catch(() => ({}));
                setLoginError(errData.error || 'ローカル管理者ログインに失敗しました。');
            }
        } catch (error) {
            setLoginError('サーバーとの通信に失敗しました。');
        } finally {
            setIsLoading(false);
        }
    };

    const displayMessage = loginError || authNotice;

    return (
        <div className="w-full h-screen bg-cover bg-center flex flex-col items-center justify-center text-white relative overflow-hidden"
            style={{
                height: '100dvh',
                background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #311042 100%)',
                backgroundImage: 'url("https://images.unsplash.com/photo-1477346611705-65d1883cee1e?q=80&w=2070&auto=format&fit=crop")'
            }}>

            {/* Backdrop Blur */}
            <div className="absolute inset-0 backdrop-blur-md bg-black/30"></div>

            {/* Date and Time */}
            <div className="absolute top-10 sm:top-16 flex flex-col items-center z-10">
                <div className="text-5xl sm:text-6xl font-thin tracking-wider">
                    {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })}
                </div>
                <div className="text-lg sm:text-xl font-medium mt-2">
                    {currentTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </div>
            </div>

            {/* Login Container */}
            <div className="z-10 flex flex-col items-center mt-16 sm:mt-20 px-4 max-w-md w-full">
                {displayMessage && (
                    <div className="mb-6 px-4 py-3 rounded-xl bg-amber-500/20 border border-amber-400/40 backdrop-blur-xl text-amber-100 text-xs sm:text-sm text-center shadow-lg">
                        ⚠️ {displayMessage}
                    </div>
                )}

                {/* Avatar (Inline SVG fallback so it never breaks offline or behind blockers) */}
                <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-gradient-to-br from-indigo-500 via-purple-600 to-pink-500 mb-4 sm:mb-6 overflow-hidden shadow-2xl border-2 border-white/30 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-11 h-11 text-white/95">
                        <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
                        <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z" />
                    </svg>
                </div>

                {/* User Name */}
                <div className="text-xl sm:text-2xl font-semibold mb-1 text-shadow-sm">Employee Agent Core</div>
                <div className="text-xs text-white/60 mb-6 sm:mb-8">Microkernel & ZTA Workspace</div>

                {/* Google Login Button */}
                <div className="flex flex-col items-center gap-3">
                    <button
                        type="button"
                        onClick={() => login()}
                        disabled={isLoading}
                        className="bg-white text-black px-6 py-2.5 rounded-full font-medium flex items-center gap-2.5 hover:bg-gray-100 transition-all transform hover:scale-105 disabled:opacity-50 shadow-lg cursor-pointer"
                    >
                        {isLoading ? (
                            <span>Signing in...</span>
                        ) : (
                            <>
                                <svg className="w-4 h-4" viewBox="0 0 24 24">
                                    <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z" />
                                    <path fill="#34A853" d="M12 24c3.3 0 6.08-1.09 8.1-2.96l-3.88-3.05c-1.08.72-2.45 1.16-4.22 1.16-3.24 0-5.98-2.19-6.96-5.14H1.05v3.14C3.06 21.14 7.21 24 12 24z" />
                                    <path fill="#FBBC05" d="M5.04 14.01c-.25-.72-.38-1.49-.38-2.28s.13-1.56.38-2.28V6.31H1.05C.38 7.64 0 9.14 0 11.73s.38 4.09 1.05 5.42l3.99-3.14z" />
                                    <path fill="#EA4335" d="M12 4.75c1.79 0 3.41.62 4.68 1.82l3.51-3.51C18.07 1.19 15.3 0 12 0 7.21 0 3.06 2.86 1.05 6.85l3.99 3.14c.98-2.95 3.72-5.24 6.96-5.24z" />
                                </svg>
                                <span>Sign in with Google</span>
                            </>
                        )}
                    </button>

                    {isLocalhost && (
                        <button
                            type="button"
                            onClick={handleLocalDevLogin}
                            disabled={isLoading}
                            className="px-5 py-2 rounded-full text-xs font-medium bg-indigo-500/30 hover:bg-indigo-500/50 border border-indigo-300/40 text-indigo-100 backdrop-blur-md transition cursor-pointer shadow-sm"
                        >
                            ⚡ ローカル管理者として即時ログイン (Local Test)
                        </button>
                    )}
                </div>
            </div>

            {/* Bottom Controls (Visual only) */}
            <div className="absolute bottom-6 sm:bottom-10 flex flex-col items-center text-white/50 text-xs z-10">
                <div className="mb-2">Zero Trust Security Enforced</div>
            </div>
        </div>
    );
};

export default LoginScreen;
