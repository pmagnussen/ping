import { useEffect, useState, useCallback } from 'react';

interface User {
    id: string;
    email: string;
    name: string;
}

interface AuthState {
    isAuthenticated: boolean;
    user: User | null;
    accessToken: string | null;
    isLoading: boolean;
}

interface AuthTokens {
    accessToken: string;
    idToken?: string;
    refreshToken?: string;
}

export function useAuth() {
    const [authState, setAuthState] = useState<AuthState>({
        isAuthenticated: false,
        user: null,
        accessToken: null,
        isLoading: true,
    });

    // Check for existing authentication on mount
    useEffect(() => {
        console.log('🔍 useAuth: Checking auth status on mount...');
        checkAuthStatus();
    }, []);

    const checkAuthStatus = useCallback(() => {
        try {
            console.log('🔍 checkAuthStatus: Starting auth check...');
            const accessToken = localStorage.getItem('access_token');
            const userInfo = localStorage.getItem('user_info');

            console.log('🔍 checkAuthStatus:', {
                hasAccessToken: !!accessToken,
                hasUserInfo: !!userInfo,
                accessTokenPreview: accessToken?.substring(0, 20) + '...'
            });

            if (accessToken && userInfo) {
                const user = JSON.parse(userInfo);
                
                // Validate token is not expired (skip JWT parsing for now)
                try {
                    const tokenPayload = parseJwt(accessToken);
                    const currentTime = Math.floor(Date.now() / 1000);
                    
                    console.log('🔍 Token validation:', {
                        hasExpiry: !!tokenPayload.exp,
                        expiry: tokenPayload.exp,
                        currentTime,
                        isValid: tokenPayload.exp ? tokenPayload.exp > currentTime : true
                    });
                    
                    if (!tokenPayload.exp || tokenPayload.exp > currentTime) {
                        console.log('✅ Token is valid, setting authenticated state');
                        setAuthState({
                            isAuthenticated: true,
                            user,
                            accessToken,
                            isLoading: false,
                        });
                        return;
                    } else {
                        console.log('❌ Token expired, clearing auth state');
                    }
                } catch (parseError) {
                    console.warn('JWT parsing failed, but assuming token is valid:', parseError);
                    // If JWT parsing fails, assume token is valid (server will validate)
                    console.log('✅ Setting authenticated state (JWT parse failed)');
                    setAuthState({
                        isAuthenticated: true,
                        user,
                        accessToken,
                        isLoading: false,
                    });
                    return;
                }
            }
            
            // No valid authentication found
            console.log('❌ No valid authentication found');
            clearAuthState();
        } catch (error) {
            console.error('Error checking auth status:', error);
            clearAuthState();
        }
    }, []);

    const clearAuthState = useCallback(() => {
        console.log('🧹 Clearing auth state...');
        localStorage.removeItem('access_token');
        localStorage.removeItem('id_token');
        localStorage.removeItem('user_info');
        localStorage.removeItem('refresh_token');
        
        setAuthState({
            isAuthenticated: false,
            user: null,
            accessToken: null,
            isLoading: false,
        });
    }, []);

    const signIn = useCallback(() => {
        console.log('🔄 Redirecting to sign-in...');
        // Change back to /auth/signin to match the controller routing
        const returnUrl = encodeURIComponent(window.location.href);
        window.location.href = `/auth/signin?returnUrl=${returnUrl}`;
    }, []);

    const signOut = useCallback(() => {
        console.log('👋 Signing out...');
        clearAuthState();
        // Optionally redirect to sign-in page
        signIn();
    }, [clearAuthState, signIn]);

    const handleAuthCallback = useCallback((tokens: AuthTokens, user: User) => {
        try {
            console.log('✅ handleAuthCallback called with:', {
                hasAccessToken: !!tokens.accessToken,
                hasIdToken: !!tokens.idToken,
                hasRefreshToken: !!tokens.refreshToken,
                user: user
            });

            // Store tokens
            localStorage.setItem('access_token', tokens.accessToken);
            if (tokens.idToken) {
                localStorage.setItem('id_token', tokens.idToken);
            }
            if (tokens.refreshToken) {
                localStorage.setItem('refresh_token', tokens.refreshToken);
            }
            localStorage.setItem('user_info', JSON.stringify(user));

            console.log('💾 Tokens stored, updating auth state...');
            setAuthState({
                isAuthenticated: true,
                user,
                accessToken: tokens.accessToken,
                isLoading: false,
            });

            console.log('✅ Auth state updated successfully');
        } catch (error) {
            console.error('Error handling auth callback:', error);
            clearAuthState();
        }
    }, [clearAuthState]);

    // Debug: Log state changes
    useEffect(() => {
        console.log('🔄 Auth state changed:', {
            isAuthenticated: authState.isAuthenticated,
            hasUser: !!authState.user,
            isLoading: authState.isLoading
        });
    }, [authState]);

    return {
        ...authState,
        signIn,
        signOut,
        handleAuthCallback,
        checkAuthStatus,
    };
}

// Helper function to parse JWT without verification (client-side only)
function parseJwt(token: string) {
    try {
        console.log('🔍 parseJwt: Analyzing token...');
        const parts = token.split('.');
        console.log('🔍 Token parts:', {
            partCount: parts.length,
            part0Preview: parts[0]?.substring(0, 20),
            part1Preview: parts[1]?.substring(0, 20),
            part2Preview: parts[2]?.substring(0, 20),
            part3Preview: parts[3]?.substring(0, 20),
            part4Preview: parts[4]?.substring(0, 20)
        });
        
        if (parts.length === 5) {
            // This is a JWE (JSON Web Encryption) - 5 parts
            console.log('🔍 Detected JWE (encrypted token) - cannot parse payload client-side');
            return { jwe: true }; // Return indicator that this is encrypted
        } else if (parts.length === 3) {
            // This is a JWS (JSON Web Signature) - 3 parts
            console.log('🔍 Detected JWS (signed token) - parsing payload...');
            const base64Url = parts[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            
            // Add padding if needed
            let paddedBase64 = base64;
            while (paddedBase64.length % 4) {
                paddedBase64 += '=';
            }
            
            const jsonPayload = atob(paddedBase64);
            return JSON.parse(jsonPayload);
        } else {
            console.error('Unknown JWT format - expected 3 (JWS) or 5 (JWE) parts, got:', parts.length);
            return {};
        }
    } catch (error) {
        console.error('Error parsing JWT:', error);
        return {};
    }
}