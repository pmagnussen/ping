import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as signalR from '@microsoft/signalr';

type Status = 'idle' | 'connecting' | 'connected' | 'recording';

// Use relative URL to work with both backend hosting and Vite proxy
const HUB_URL = 'https://localhost:7160/voice';

// Helpers for base64 <-> Uint8Array (JSON protocol encodes byte[] as base64)
function u8ToBase64(u8: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
        const sub = u8.subarray(i, i + chunk);
        binary += String.fromCharCode(...(sub as unknown as number[]));
    }
    return btoa(binary);
}
function base64ToU8(b64: string): Uint8Array {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

export default function VoiceChat() {
    const [status, setStatus] = useState<Status>('idle');
    const [name, setName] = useState('Guest');

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const connectionRef = useRef<signalR.HubConnection | null>(null);
    const startingRef = useRef(false);

    useEffect(() => {
        navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { });
    }, []);

    useEffect(() => {
        if (!connectionRef.current) {
            connectionRef.current = new signalR.HubConnectionBuilder()
                .withUrl(HUB_URL, {
                    // Dev-friendly: avoid negotiation entirely
                    transport: signalR.HttpTransportType.WebSockets,
                    skipNegotiation: true,
                    withCredentials: true,
                })
                .withAutomaticReconnect()
                .build();

            // Incoming audio (server sends base64 for byte[] under JSON)
            connectionRef.current.on('VoiceNote', (data: unknown, mimeType: string) => {
                try {
                    let u8: Uint8Array | undefined;
                    if (typeof data === 'string') u8 = base64ToU8(data);
                    else if (Array.isArray(data)) u8 = new Uint8Array(data as number[]);
                    else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
                    if (!u8) return;

                    const blob = new Blob([u8], { type: mimeType || 'audio/webm' });
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.play().finally(() => URL.revokeObjectURL(url));
                } catch (err) {
                    console.error('Failed to play incoming audio', err);
                }
            });

            connectionRef.current.onreconnecting(() => setStatus('connecting'));
            connectionRef.current.onreconnected(() => setStatus('connected'));
            connectionRef.current.onclose(() => setStatus('idle'));
        }

        let disposed = false;

        const start = async (delayMs = 0) => {
            if (startingRef.current) return;
            startingRef.current = true;
            try {
                if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
                if (disposed || !connectionRef.current) return;
                if (connectionRef.current.state === signalR.HubConnectionState.Disconnected) {
                    setStatus('connecting');
                    await connectionRef.current.start();
                    if (!disposed) setStatus('connected');
                } else if (connectionRef.current.state === signalR.HubConnectionState.Connected) {
                    setStatus('connected');
                }
            } catch (err: any) {
                const msg = String(err?.message || err);
                // Ignore aborts from StrictMode first mount
                if (msg.toLowerCase().includes('stopped during negotiation')) {
                    // Retry shortly
                    startingRef.current = false;
                    if (!disposed) start(200);
                    return;
                }
                console.error('SignalR connect failed', err);
                if (!disposed) setStatus('idle');
            } finally {
                startingRef.current = false;
            }
        };

        // Defer start to avoid StrictMode first-pass cleanup races
        setTimeout(() => start(), 0);

        return () => {
            disposed = true;
            // Stop only if actually connected/connecting
            const c = connectionRef.current;
            if (c && c.state !== signalR.HubConnectionState.Disconnected) {
                c.stop().catch(() => { });
            }
        };
    }, []);

    const startRecording = useCallback(async () => {
        if (status !== 'connected') return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            const preferred = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/ogg',
            ];
            const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

            const mr = new MediaRecorder(stream, {
                ...(mimeType ? { mimeType } : {}),
                audioBitsPerSecond: 64000,
            });

            chunksRef.current = [];
            mr.ondataavailable = (e) => e.data && e.data.size > 0 && chunksRef.current.push(e.data);
            mr.onstop = () => {
                try {
                    stream.getTracks().forEach((t) => t.stop());
                } catch { }
            };

            mr.start();
            mediaRecorderRef.current = mr;
            setStatus('recording');
        } catch {
            alert('Microphone permission is required.');
        }
    }, [status]);

    const stopAndSend = useCallback(async () => {
        const mr = mediaRecorderRef.current;
        if (!mr) return;

        await new Promise<void>((resolve) => {
            const done = () => resolve();
            mr.addEventListener('stop', done, { once: true });
            try {
                mr.stop();
            } catch {
                resolve();
            }
        });

        const mime = mr.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mime });

        mediaRecorderRef.current = null;
        chunksRef.current = [];

        if (blob.size > 2 * 1024 * 1024) {
            alert('Clip too large (>2 MB). Try a shorter press.');
            setStatus('connected');
            return;
        }

        try {
            const u8 = new Uint8Array(await blob.arrayBuffer());
            const b64 = u8ToBase64(u8); // JSON: send base64 so server binds to byte[]
            await connectionRef.current?.invoke('SendVoiceNote', b64, blob.type, name);
        } catch (err) {
            console.error('Failed to send voice note', err);
            alert('Failed to send voice note.');
        } finally {
            setStatus('connected');
        }
    }, [name]);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'connected') startRecording();
    }, [status, startRecording]);

    const handlePointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'recording') stopAndSend();
    }, [status, stopAndSend]);

    return (
        <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <h2>Push-to-Talk (PoC)</h2>

            <label style={{ display: 'grid', gap: 6 }}>
                <span>Your name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest" />
            </label>

            <button
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUpOrCancel}
                onPointerCancel={handlePointerUpOrCancel}
                onPointerLeave={(e) => { if (status === 'recording') handlePointerUpOrCancel(e); }}
                disabled={status === 'connecting' || status === 'idle'}
                style={{
                    padding: '14px 18px',
                    fontSize: 16,
                    borderRadius: 12,
                    cursor: status === 'connecting' || status === 'idle' ? 'not-allowed' : 'pointer',
                    background: status === 'recording' ? 'black' : 'black',
                    border: '1px solid',
                }}
                aria-pressed={status === 'recording'}
            >
                {status === 'recording' ? 'Release to Send'
                    : status === 'connecting' ? 'Connecting…'
                        : status === 'idle' ? 'Connect to Server…'
                            : 'Hold to Talk'}
            </button>

            <small style={{ color: '#666' }}>
                Clips are sent to the server and broadcast to all connected clients. No storage, no auth.
            </small>
        </div>
    );
}