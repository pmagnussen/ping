import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as signalR from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

type Status = 'idle' | 'connecting' | 'connected' | 'recording';

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

// PCM helpers
function float32ToInt16PCM(f32: Float32Array): Uint8Array {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return new Uint8Array(out.buffer);
}
function int16ToFloat32PCM(u8: Uint8Array): Float32Array {
    const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    return f32;
}
type PcmFormat = { bits: number, rate: number, channels: number };
function buildPcmMime(fmt: PcmFormat): string {
    return `audio/pcm;bits=${fmt.bits};rate=${fmt.rate};channels=${fmt.channels}`;
}
function parsePcmMime(m?: string): PcmFormat | null {
    if (!m) return null;
    const lm = m.toLowerCase();
    if (!lm.startsWith('audio/pcm')) return null;
    const parts = lm.split(';').slice(1).map(p => p.trim());
    const fmt: Partial<PcmFormat> = {};
    for (const p of parts) {
        const [k, v] = p.split('=').map(s => s.trim());
        if (k === 'bits') fmt.bits = Number(v);
        if (k === 'rate') fmt.rate = Number(v);
        if (k === 'channels') fmt.channels = Number(v);
    }
    const bits = fmt.bits ?? 16;
    const rate = fmt.rate ?? 48000;
    const channels = fmt.channels ?? 1;
    if (![8, 16].includes(bits) || !rate || !channels) return null;
    return { bits, rate, channels };
}

export default function VoiceChat() {
    const [status, setStatus] = useState<Status>('idle');
    const [name, setName] = useState('Guest');

    const connectionRef = useRef<signalR.HubConnection | null>(null);
    const startingRef = useRef(false);
    const nameRef = useRef(name);

    // WebAudio state (send + receive)
    const audioCtxRef = useRef<AudioContext | null>(null);

    // Sender nodes
    const sendStreamRef = useRef<MediaStream | null>(null);
    const sendSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const sendProcessorRef = useRef<ScriptProcessorNode | null>(null);

    // Receiver scheduling
    const nextStartTimeRef = useRef<number>(0);
    const scheduleChainRef = useRef<Promise<void>>(Promise.resolve());
    const lastChunkAtRef = useRef<number>(0);

    useEffect(() => { nameRef.current = name; }, [name]);

    useEffect(() => {
        navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { });
    }, []);

    const ensureAudioContext = useCallback(async () => {
        if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        if (audioCtxRef.current.state !== 'running') {
            try { await audioCtxRef.current.resume(); } catch { }
        }
        return audioCtxRef.current;
    }, []);

    const resetSchedulingIfIdle = useCallback(() => {
        const now = performance.now();
        if (now - lastChunkAtRef.current > 1500) {
            const ctx = audioCtxRef.current;
            nextStartTimeRef.current = ctx ? ctx.currentTime : 0;
        }
    }, []);

    const schedulePcm = useCallback(async (pcm: Float32Array, fmt: { bits: number, rate: number, channels: number }) => {
        const ctx = await ensureAudioContext();
        const buf = ctx.createBuffer(fmt.channels, pcm.length, fmt.rate);
        buf.copyToChannel(pcm, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const ahead = 0.03;
        const startAt = Math.max(nextStartTimeRef.current, ctx.currentTime + ahead);
        src.start(startAt);
        nextStartTimeRef.current = startAt + buf.duration;
        src.onended = () => {
            if (nextStartTimeRef.current < ctx.currentTime) nextStartTimeRef.current = ctx.currentTime;
        };
    }, [ensureAudioContext]);

    const enqueuePcm = useCallback((pcm: Float32Array, fmt: { bits: number, rate: number, channels: number }) => {
        lastChunkAtRef.current = performance.now();
        resetSchedulingIfIdle();
        scheduleChainRef.current = scheduleChainRef.current
            .then(() => schedulePcm(pcm, fmt))
            .catch(() => {
                const ctx = audioCtxRef.current;
                nextStartTimeRef.current = ctx ? ctx.currentTime : 0;
            });
    }, [schedulePcm, resetSchedulingIfIdle]);

    useEffect(() => {
        if (!connectionRef.current) {
            connectionRef.current = new signalR.HubConnectionBuilder()
                .withUrl(HUB_URL, {
                    transport: signalR.HttpTransportType.WebSockets,
                    skipNegotiation: true,
                    withCredentials: true,
                })
                .withHubProtocol(new MessagePackHubProtocol()) // <-- MessagePack
                .withAutomaticReconnect()
                .build();

            connectionRef.current.on('VoiceNote', async (data: unknown, mimeType: string) => {
                try {
                    const fmt = parsePcmMime(mimeType);
                    let u8: Uint8Array | undefined;

                    if (data instanceof Uint8Array) u8 = data;
                    else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
                    else if (Array.isArray(data)) u8 = new Uint8Array(data as number[]);
                    else if (typeof data === 'string') {
                        // Fallback: legacy JSON base64
                        const bin = atob(data);
                        const tmp = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) tmp[i] = bin.charCodeAt(i);
                        u8 = tmp;
                    }

                    if (!u8 || u8.length === 0 || !fmt || fmt.bits !== 16) return;

                    const f32 = int16ToFloat32PCM(u8);
                    enqueuePcm(f32, fmt);
                } catch (err) {
                    console.error('Failed to handle incoming audio', err);
                }
            });

            connectionRef.current.onreconnecting(() => setStatus('connecting'));
            connectionRef.current.onreconnected(() => {
                setStatus('connected');
                const ctx = audioCtxRef.current;
                nextStartTimeRef.current = ctx ? ctx.currentTime : 0;
            });
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
                if (msg.toLowerCase().includes('stopped during negotiation')) {
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

        setTimeout(() => start(), 0);

        return () => {
            disposed = true;
            const c = connectionRef.current;
            if (c && c.state !== signalR.HubConnectionState.Disconnected) {
                c.stop().catch(() => { });
            }
            try { audioCtxRef.current?.close(); } catch { }
            audioCtxRef.current = null;
            nextStartTimeRef.current = 0;
            scheduleChainRef.current = Promise.resolve();
        };
    }, [enqueuePcm]);

    const startRecording = useCallback(async () => {
        if (status !== 'connected') return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
            const ctx = await ensureAudioContext();

            const source = ctx.createMediaStreamSource(stream);
            const bufferSize = 2048;
            const channels = Math.min(source.channelCount || 1, 2);
            const processor = ctx.createScriptProcessor(bufferSize, channels, 1);
            source.connect(processor);
            processor.connect(ctx.destination);

            const fmt = { bits: 16, rate: ctx.sampleRate, channels: 1 as const };

            processor.onaudioprocess = (e) => {
                try {
                    const inCh0 = e.inputBuffer.getChannelData(0);
                    const len = inCh0.length;
                    let mono: Float32Array;

                    if (channels === 1) {
                        mono = new Float32Array(len);
                        mono.set(inCh0);
                    } else {
                        const inCh1 = e.inputBuffer.getChannelData(1);
                        mono = new Float32Array(len);
                        for (let i = 0; i < len; i++) mono[i] = (inCh0[i] + inCh1[i]) * 0.5;
                    }

                    const u8 = float32ToInt16PCM(mono);
                    // Send Uint8Array directly (MessagePack binary)
                    connectionRef.current?.invoke('SendVoiceNote', u8, buildPcmMime(fmt), nameRef.current)
                        .catch((err) => console.error('Failed to send PCM chunk', err));
                } catch (err) {
                    console.error('PCM capture/send failed', err);
                }
            };

            sendStreamRef.current = stream;
            sendSourceRef.current = source;
            sendProcessorRef.current = processor;

            setStatus('recording');
        } catch {
            alert('Microphone permission is required.');
        }
    }, [status, ensureAudioContext]);

    const stopRecording = useCallback(async () => {
        const proc = sendProcessorRef.current;
        const src = sendSourceRef.current;
        const stream = sendStreamRef.current;

        if (proc) { try { proc.disconnect(); } catch { } sendProcessorRef.current = null; }
        if (src) { try { src.disconnect(); } catch { } sendSourceRef.current = null; }
        if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch { } sendStreamRef.current = null; }

        setStatus('connected');
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'connected') startRecording();
    }, [status, startRecording]);

    const handlePointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'recording') stopRecording();
    }, [status, stopRecording]);

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
                {status === 'recording' ? 'Release to Stop'
                    : status === 'connecting' ? 'Connecting…'
                        : status === 'idle' ? 'Connect to Server…'
                            : 'Hold to Talk'}
            </button>

            <small style={{ color: '#666' }}>
                Streaming live while held. Sends PCM16 frames and schedules them for gapless playback.
            </small>
            {/* ... UI unchanged ... */}
        </div>
    );
}