import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';

interface AuthCallbackProps {
    onSuccess?: () => void;
    onError?: (error: string) => void;
}

export default function AuthCallback({ onSuccess, onError }: AuthCallbackProps) {
    const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
    const [message, setMessage] = useState<string>('');
    const { handleAuthCallback } = useAuth();

    useEffect(() => {
        handleTokenExchange();
    }, []);

    const handleTokenExchange = async () => {
        try {
            console.log('🔄 Starting token exchange...');
            
            // Get URL parameters
            const urlParams = new URLSearchParams(window.location.search);
            const authCode = urlParams.get('code');
            const magicToken = urlParams.get('magic_token');
            const returnUrl = urlParams.get('returnUrl');

            console.log('📋 Token Exchange Parameters:', {
                authCode,
                magicToken,
                returnUrl,
                allParams: Object.fromEntries(urlParams.entries())
            });

            if (!authCode && !magicToken) {
                throw new Error('No authentication code or magic token found');
            }

            let tokenRequestBody;
            const headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + btoa('ping-voice-chat:ping-voice-chat-secret'), // 🎯 Keep this for client auth
            };

            // Different request bodies for different flows
            if (magicToken) {
                // 🎯 Magic token flow - use client_credentials with magic_token
                console.log('🔄 Using magic token flow...');
                tokenRequestBody = new URLSearchParams({
                    grant_type: 'client_credentials',
                    scope: 'openid email profile',
                    magic_token: magicToken  // 🎯 Only send magic_token, not client credentials
                });
            } else if (authCode) {
                // 🎯 Authorization code flow
                console.log('🔄 Using authorization code flow...');
                tokenRequestBody = new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: authCode,
                    scope: 'openid email profile'
                });
            } else {
                throw new Error('No valid authentication method found');
            }

            // Exchange for JWT tokens
            console.log('🔄 Making token request to /connect/token...');
            const tokenResponse = await fetch('/connect/token', {
                method: 'POST',
                headers,
                body: tokenRequestBody,
            });

            console.log('📤 Token Response:', {
                status: tokenResponse.status,
                statusText: tokenResponse.statusText,
                ok: tokenResponse.ok
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('❌ Token exchange failed:', errorText);
                throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
            }

            const tokens = await tokenResponse.json();
            console.log('🎫 Received tokens:', {
                hasAccessToken: !!tokens.access_token,
                hasIdToken: !!tokens.id_token,
                hasRefreshToken: !!tokens.refresh_token,
                tokenType: tokens.token_type
            });

            // Get user info
            console.log('👤 Getting user info...');
            const userInfoResponse = await fetch('/connect/userinfo', {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                },
            });

            console.log('📤 UserInfo Response:', {
                status: userInfoResponse.status,
                statusText: userInfoResponse.statusText,
                ok: userInfoResponse.ok
            });

            if (!userInfoResponse.ok) {
                const errorText = await userInfoResponse.text();
                console.error('❌ Failed to get user info:', errorText);
                throw new Error(`Failed to get user info: ${userInfoResponse.status} ${errorText}`);
            }

            const userInfo = await userInfoResponse.json();
            console.log('👤 User Info:', userInfo);

            // Handle successful authentication
            console.log('✅ Calling handleAuthCallback...');
            handleAuthCallback(
                {
                    accessToken: tokens.access_token,
                    idToken: tokens.id_token,
                    refreshToken: tokens.refresh_token,
                },
                {
                    id: userInfo.sub,
                    email: userInfo.email,
                    name: userInfo.name || userInfo.preferred_username,
                }
            );

            setStatus('success');
            setMessage('Sign-in successful! Redirecting...');

            // Redirect to original URL or home
            setTimeout(() => {
                window.location.href = returnUrl || '/';
            }, 1000);

            onSuccess?.();
        } catch (error) {
            console.error('💥 Authentication error:', error);
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'Authentication failed');
            onError?.(error instanceof Error ? error.message : 'Authentication failed');
        }
    };

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
                {status === 'processing' && (
                    <>
                        <div style={{
                            width: '40px',
                            height: '40px',
                            border: '4px solid #e5e7eb',
                            borderTopColor: '#3b82f6',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite',
                            margin: '0 auto 1rem'
                        }} />
                        <h2>Completing sign in...</h2>
                        <p>Please wait while we set up your session.</p>
                    </>
                )}

                {status === 'success' && (
                    <>
                        <div style={{ fontSize: '3rem', color: '#10b981', marginBottom: '1rem' }}>
                            ✅
                        </div>
                        <h2>Welcome!</h2>
                        <p>{message}</p>
                    </>
                )}

                {status === 'error' && (
                    <>
                        <div style={{ fontSize: '3rem', color: '#ef4444', marginBottom: '1rem' }}>
                            ❌
                        </div>
                        <h2>Sign-in failed</h2>
                        <p>{message}</p>
                        <button
                            onClick={() => window.location.href = '/auth/signin'}
                            style={{
                                background: '#111827',
                                color: 'white',
                                border: 'none',
                                padding: '0.75rem 1.5rem',
                                borderRadius: '8px',
                                cursor: 'pointer',
                                marginTop: '1rem'
                            }}
                        >
                            Try Again
                        </button>
                    </>
                )}
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