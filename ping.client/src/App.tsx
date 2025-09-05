import { useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import VoiceChat from './components/VoiceChat';
import AuthCallback from './components/AuthCallback';

function App() {
    const { isAuthenticated, user, isLoading, signIn, signOut } = useAuth();
    const [isAuthCallback, setIsAuthCallback] = useState(false);

    // Check if this is an auth callback URL
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const hasAuthParams = urlParams.has('code') || urlParams.has('magic_token');
        
        // Debug logging
        console.log('🔍 URL Detection Debug:', {
            currentUrl: window.location.href,
            searchParams: window.location.search,
            hasCode: urlParams.has('code'),
            hasMagicToken: urlParams.has('magic_token'),
            magicTokenValue: urlParams.get('magic_token'),
            emailValue: urlParams.get('email'),
            hasAuthParams
        });
        
        setIsAuthCallback(hasAuthParams);
    }, []);

    // Handle auth callback
    if (isAuthCallback) {
        console.log('🚀 Showing AuthCallback component');
        return (
            <AuthCallback
                onSuccess={() => {
                    console.log('✅ AuthCallback success');
                    // Clear auth callback state after successful auth
                    setIsAuthCallback(false);
                    // Clean up URL params
                    window.history.replaceState({}, document.title, '/');
                }}
                onError={(error) => {
                    console.error('❌ AuthCallback error:', error);
                    setIsAuthCallback(false);
                }}
            />
        );
    }

    // Show loading state
    if (isLoading) {
        console.log('⏳ Showing loading state');
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '100vh',
                padding: '1rem'
            }}>
                <div style={{
                    textAlign: 'center'
                }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        border: '4px solid #e5e7eb',
                        borderTopColor: '#3b82f6',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                        margin: '0 auto 1rem'
                    }} />
                    <p>Loading...</p>
                </div>
                <style>
                    {`
                        @keyframes spin {
                            to { transform: rotate(360deg); }
                        }
                    `}
                </style>
            </div>
        );
    }

    // Redirect to sign-in if not authenticated
    if (!isAuthenticated) {
        console.log('🔐 Not authenticated, showing sign-in');
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '100vh',
                padding: '1rem',
                backgroundColor: '#f9fafb'
            }}>
                <div style={{
                    background: 'white',
                    borderRadius: '12px',
                    padding: '2rem',
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
                    width: '100%',
                    maxWidth: '400px',
                    textAlign: 'center'
                }}>
                    <h1 style={{
                        fontSize: '1.875rem',
                        fontWeight: '600',
                        marginBottom: '1rem',
                        color: '#111827'
                    }}>
                        Welcome to Ping
                    </h1>
                    <p style={{
                        color: '#6b7280',
                        marginBottom: '2rem'
                    }}>
                        Please sign in to continue to the voice chat.
                    </p>
                    <button
                        onClick={signIn}
                        style={{
                            width: '100%',
                            padding: '0.75rem 1.5rem',
                            background: '#111827',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            fontSize: '1rem',
                            fontWeight: '500',
                            cursor: 'pointer',
                            transition: 'background-color 0.2s'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = '#1f2937';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '#111827';
                        }}
                    >
                        Sign In
                    </button>
                </div>
            </div>
        );
    }

    // Show main app for authenticated users
    console.log('🎉 Authenticated, showing main app');
    return (
        <div style={{ padding: 24 }}>
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 24
            }}>
                <h1>Ping</h1>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16
                }}>
                    <span style={{ color: '#6b7280' }}>
                        Welcome, {user?.name || user?.email}
                    </span>
                    <button
                        onClick={signOut}
                        style={{
                            background: 'transparent',
                            color: '#6b7280',
                            border: '1px solid #d1d5db',
                            padding: '0.5rem 1rem',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '0.875rem'
                        }}
                    >
                        Sign Out
                    </button>
                </div>
            </div>
            <VoiceChat />
        </div>
    );
}

export default App;