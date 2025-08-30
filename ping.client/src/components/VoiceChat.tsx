import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as signalR from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

type Status = 'idle' | 'connecting' | 'connected' | 'recording';
const HUB_URL =
    (import.meta as any).env?.VITE_SIGNALR_HUB
    || (import.meta.env.PROD ? 'https://ping.vera.fo/api/voice' : 'https://localhost:7160/voice');
// Note: PascalCase to match MessagePack payload from .NET (PeerInfo.ConnectionId/Name)
type PeerInfo = { ConnectionId: string; Name: string };

export default function VoiceChat() {
    const [status, setStatus] = useState<Status>('idle');
    const [name, setName] = useState('Guest');

    // SignalR (signaling only)
    const hubRef = useRef<signalR.HubConnection | null>(null);
    const startingRef = useRef(false);
    const nameRef = useRef(name);

    // WebRTC
    const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const peerNamesRef = useRef<Map<string, string>>(new Map());
    const remoteAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const localStreamRef = useRef<MediaStream | null>(null);
    const localTrackRef = useRef<MediaStreamTrack | null>(null);
    const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

    // UI: who is currently talking (basic indicator)
    const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
    const activeSpeakerTimerRef = useRef<number | null>(null);
    const activeSpeakerPeerRef = useRef<string | null>(null);

    // For Safari/iOS autoplay policies — keep audio elements in DOM
    const audioContainerRef = useRef<HTMLDivElement | null>(null);

    // PTT keyboard state
    const pttKeyDownRef = useRef(false);

    useEffect(() => { nameRef.current = name; }, [name]);

    // Ensure local mic track exists; disabled by default (PTT off)
    const ensureLocalTrack = useCallback(async (): Promise<MediaStreamTrack> => {
        if (localTrackRef.current && localStreamRef.current) return localTrackRef.current;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        localStreamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        track.enabled = false;
        localTrackRef.current = track;
        return track;
    }, []);

    // Add the local track to a peer connection (once)
    const addLocalToPc = useCallback(async (pc: RTCPeerConnection) => {
        const track = await ensureLocalTrack();
        const has = pc.getSenders().some(s => s.track && s.track.kind === 'audio');
        if (!has && localStreamRef.current) {
            pc.addTrack(track, localStreamRef.current);
        }
    }, [ensureLocalTrack]);

    const flushPendingIce = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
        const queued = pendingIceRef.current.get(peerId);
        if (!queued || queued.length === 0) return;
        for (const c of queued) {
            try { await pc.addIceCandidate(c); } catch { /* ignore */ }
        }
        pendingIceRef.current.delete(peerId);
    }, []);

    // Create a new RTCPeerConnection to a peer
    const createPc = useCallback((peerId: string) => {
        let pc = pcsRef.current.get(peerId);
        if (pc) return pc;

        pc = new RTCPeerConnection({
            iceServers: [
                { urls: ['stun:stun.l.google.com:19302'] }
                // To avoid direct P2P, configure TURN and set iceTransportPolicy: 'relay'
            ]
        });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const json = JSON.stringify(e.candidate.toJSON());
                hubRef.current?.invoke('SendIce', peerId, json).catch(() => { });
            }
        };

        pc.ontrack = (e) => {
            const [ms] = e.streams;
            let el = remoteAudiosRef.current.get(peerId);
            if (!el) {
                el = new Audio();
                el.autoplay = true;
                // playsInline is not on HTMLAudioElement; add attribute for iOS policies
                el.setAttribute('playsinline', '');
                el.muted = false; // ensure not muted
                // Keep element in DOM for Safari/iOS
                if (audioContainerRef.current && !el.parentNode) {
                    audioContainerRef.current.appendChild(el);
                }
                remoteAudiosRef.current.set(peerId, el);
            } else {
                el.muted = false;
            }
            el.srcObject = ms;
            el.play().catch(() => { /* will play after first user gesture */ });

            // Simple talking indicator: show name briefly when media becomes active
            const n = peerNamesRef.current.get(peerId);
            if (n) {
                setActiveSpeaker(n);
                if (activeSpeakerTimerRef.current) clearTimeout(activeSpeakerTimerRef.current);
                activeSpeakerTimerRef.current = window.setTimeout(() => setActiveSpeaker(null), 600);
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                const el = remoteAudiosRef.current.get(peerId);
                if (el) {
                    try { el.srcObject = null; } catch { }
                    try { el.remove?.(); } catch { }
                    remoteAudiosRef.current.delete(peerId);
                }
            }
        };

        pcsRef.current.set(peerId, pc);
        return pc;
    }, []);

    // Offer to a peer
    const makeOffer = useCallback(async (peerId: string) => {
        if (!peerId) return;
        const pc = createPc(peerId);
        await addLocalToPc(pc);
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        await hubRef.current?.invoke('SendOffer', peerId, offer.sdp ?? '', nameRef.current);
    }, [addLocalToPc, createPc]);

    // Answer to a peer
    const makeAnswer = useCallback(async (peerId: string, sdp: string) => {
        const pc = createPc(peerId);
        await addLocalToPc(pc);
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await flushPendingIce(peerId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await hubRef.current?.invoke('SendAnswer', peerId, answer.sdp ?? '');
    }, [addLocalToPc, createPc, flushPendingIce]);

    const applyAnswer = useCallback(async (peerId: string, sdp: string) => {
        const pc = pcsRef.current.get(peerId);
        if (!pc) return;
        if (!pc.currentRemoteDescription && !pc.remoteDescription) {
            await pc.setRemoteDescription({ type: 'answer', sdp });
        }
        await flushPendingIce(peerId, pc);
    }, [flushPendingIce]);

    const applyIce = useCallback(async (peerId: string, candidateJson: string) => {
        const pc = pcsRef.current.get(peerId);
        if (!pc || !candidateJson) return;
        try {
            const init = JSON.parse(candidateJson) as RTCIceCandidateInit;
            if (!pc.currentRemoteDescription && !pc.remoteDescription) {
                const q = pendingIceRef.current.get(peerId) ?? [];
                q.push(init);
                pendingIceRef.current.set(peerId, q);
                return;
            }
            await pc.addIceCandidate(init);
        } catch {
            // ignore malformed/dupe
        }
    }, []);

    // SignalR (signaling)
    useEffect(() => {
        if (hubRef.current) return;

        hubRef.current = new signalR.HubConnectionBuilder()
            .withUrl(HUB_URL, {
                transport: signalR.HttpTransportType.WebSockets,
                skipNegotiation: true,
                withCredentials: true,
            })
            .withHubProtocol(new MessagePackHubProtocol())
            .withAutomaticReconnect()
            .build();

        // Presence
        hubRef.current.on('PeerJoined', (peerId: string, peerName: string) => {
            peerNamesRef.current.set(peerId, peerName);
        });
        hubRef.current.on('PeerLeft', (peerId: string) => {
            peerNamesRef.current.delete(peerId);
            const pc = pcsRef.current.get(peerId);
            if (pc) { try { pc.close(); } catch { } pcsRef.current.delete(peerId); }
            const el = remoteAudiosRef.current.get(peerId);
            if (el) {
                try { el.srcObject = null; } catch { }
                try { el.remove?.(); } catch { }
                remoteAudiosRef.current.delete(peerId);
            }
            pendingIceRef.current.delete(peerId);
            if (activeSpeakerPeerRef.current === peerId) {
                activeSpeakerPeerRef.current = null;
                setActiveSpeaker(null);
            }
        });
        hubRef.current.on('PeerRenamed', (peerId: string, newName: string) => {
            peerNamesRef.current.set(peerId, newName);
        });

        // NEW: talking indicator broadcast
        hubRef.current.on('PeerTalking', (peerId: string, peerName: string, talking: boolean) => {
            peerNamesRef.current.set(peerId, peerName || 'Guest');
            if (talking) {
                activeSpeakerPeerRef.current = peerId;
                setActiveSpeaker(peerName || 'Guest');
            } else if (activeSpeakerPeerRef.current === peerId) {
                activeSpeakerPeerRef.current = null;
                setActiveSpeaker(null);
            }
        });

        // Signaling messages
        hubRef.current.on('RtcOffer', async (fromId: string, fromName: string, sdp: string) => {
            peerNamesRef.current.set(fromId, fromName);
            await makeAnswer(fromId, sdp);
        });
        hubRef.current.on('RtcAnswer', async (fromId: string, sdp: string) => {
            await applyAnswer(fromId, sdp);
        });
        hubRef.current.on('RtcIce', async (fromId: string, candidateJson: string) => {
            await applyIce(fromId, candidateJson);
        });

        let disposed = false;

        const isBenignAbort = (err: any) => {
            const msg = String(err?.message || '').toLowerCase();
            return err?.name === 'AbortError'
                || msg.includes('stopped during negotiation')
                || msg.includes('before stop');
        };

        const start = async (delayMs = 0) => {
            if (startingRef.current) return;
            startingRef.current = true;
            try {
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                if (disposed || !hubRef.current) return;

                if (hubRef.current.state === signalR.HubConnectionState.Disconnected) {
                    setStatus('connecting');
                    await hubRef.current.start();
                    if (disposed) return;
                    setStatus('connected');

                    await hubRef.current.invoke('SetName', nameRef.current);
                    const peers = await hubRef.current.invoke<PeerInfo[]>('GetPeers');
                    for (const p of peers ?? []) {
                        const id = p?.ConnectionId;
                        const nm = p?.Name ?? 'Guest';
                        if (!id) continue;
                        peerNamesRef.current.set(id, nm);
                        await makeOffer(id);
                    }
                } else {
                    setStatus('connected');
                }
            } catch (err) {
                if (!disposed && isBenignAbort(err)) {
                    startingRef.current = false;
                    setTimeout(() => start(150), 150);
                    return;
                }
                console.error('SignalR signaling start failed', err);
                if (!disposed) setStatus('idle');
            } finally {
                startingRef.current = false;
            }
        };

        const t = setTimeout(() => start(), 0);

        return () => {
            disposed = true;
            clearTimeout(t);
            const hub = hubRef.current;
            hubRef.current = null;
            if (hub && hub.state !== signalR.HubConnectionState.Disconnected) {
                hub.stop().catch(() => { });
            }
            for (const [id, pc] of pcsRef.current) {
                try { pc.close(); } catch { }
                pcsRef.current.delete(id);
            }
            for (const el of remoteAudiosRef.current.values()) {
                try { el.srcObject = null; } catch { }
                try { el.remove?.(); } catch { }
            }
            remoteAudiosRef.current.clear();
            pendingIceRef.current.clear();
            if (localStreamRef.current) {
                try { localStreamRef.current.getTracks().forEach(t => t.stop()); } catch { }
                localStreamRef.current = null;
                localTrackRef.current = null;
            }
        };
    }, [applyAnswer, applyIce, makeAnswer, makeOffer]);

    // PTT: toggle local track enabled + broadcast talking state
    const startRecording = useCallback(async () => {
        if (status !== 'connected') return;
        try {
            for (const el of remoteAudiosRef.current.values()) {
                try { await el.play(); } catch { /* ignore */ }
            }
            const track = await ensureLocalTrack();
            track.enabled = true;
            setStatus('recording');
            // announce start talking
            hubRef.current?.invoke('SetTalking', true).catch(() => { });
        } catch {
            alert('Microphone permission is required.');
        }
    }, [ensureLocalTrack, status]);

    const stopRecording = useCallback(async () => {
        const track = localTrackRef.current;
        if (track) track.enabled = false;
        setStatus('connected');
        // announce stop talking
        hubRef.current?.invoke('SetTalking', false).catch(() => { });
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'connected') startRecording();
    }, [status, startRecording]);

    const handlePointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'recording') stopRecording();
    }, [status, stopRecording]);

    // Keyboard PTT (ArrowDown)
    useEffect(() => {
        const isEditable = (el: Element | null) => {
            if (!el) return false;
            const tag = el.tagName;
            const editable = (el as HTMLElement).isContentEditable;
            return editable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'ArrowDown') return;
            if (isEditable(document.activeElement)) return;
            if (e.repeat) { e.preventDefault(); return; }
            e.preventDefault();
            if (!pttKeyDownRef.current) {
                pttKeyDownRef.current = true;
                if (status === 'connected') startRecording();
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key !== 'ArrowDown') return;
            e.preventDefault();
            pttKeyDownRef.current = false;
            if (status === 'recording') stopRecording();
        };
        const onBlurOrHide = () => {
            if (pttKeyDownRef.current) pttKeyDownRef.current = false;
            if (status === 'recording') stopRecording();
        };

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlurOrHide);
        document.addEventListener('visibilitychange', onBlurOrHide);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlurOrHide);
            document.removeEventListener('visibilitychange', onBlurOrHide);
        };
    }, [startRecording, status, stopRecording]);

    return (
        <div style={{ display: 'grid', gap: 12, maxWidth: 420, position: 'relative' }}>
            <h2>Push-to-Talk (WebRTC)</h2>

            {activeSpeaker && (
                <div role="status" aria-live="polite" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                    borderRadius: 999, background: '#eef6ff', color: '#0b5cab', width: 'fit-content'
                }}>
                    <span style={{
                        width: 8, height: 8, borderRadius: 999, background: '#2ecc71',
                        boxShadow: '0 0 0 3px rgba(46,204,113,0.25)'
                    }} />
                    <span>{activeSpeaker} is talking…</span>
                </div>
            )}

            <label style={{ display: 'grid', gap: 6 }}>
                <span>Your name</span>
                <input value={name} onChange={(e) => {
                    setName(e.target.value);
                    hubRef.current?.invoke('SetName', e.target.value).catch(() => { });
                }} placeholder="Guest" />
            </label>

            <button
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUpOrCancel}
                onPointerCancel={handlePointerUpOrCancel}
                onPointerLeave={(e) => { if (status === 'recording') handlePointerUpOrCancel(e); }}
                onSelect={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onDragStart={(e) => e.preventDefault()}
                disabled={status === 'connecting' || status === 'idle'}
                style={{
                    padding: '14px 18px',
                    fontSize: 16,
                    borderRadius: 12,
                    cursor: status === 'connecting' || status === 'idle' ? 'not-allowed' : 'pointer',
                    background: status === 'recording' ? 'black' : 'black',
                    color: 'white',
                    border: '1px solid',
                    // prevent text selection / touch callouts
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    msUserSelect: 'none',
                    MozUserSelect: 'none',
                    WebkitTouchCallout: 'none',
                    WebkitTapHighlightColor: 'transparent',
                }}
                aria-pressed={status === 'recording'}
            >
                {status === 'recording' ? 'Release to Stop'
                    : status === 'connecting' ? 'Connecting…'
                        : status === 'idle' ? 'Connect to Server…'
                            : 'Hold to Talk'}
            </button>

            <small style={{ color: '#666' }}>
                Tip: Hold ArrowDown or the button to talk. WebRTC carries audio; SignalR only signals.
            </small>

            {/* Hidden container to attach remote <audio> elements for iOS/Safari */}
            <div ref={audioContainerRef} aria-hidden="true" style={{ position: 'absolute', left: -99999, width: 1, height: 1, overflow: 'hidden' }} />
        </div>
    );
}