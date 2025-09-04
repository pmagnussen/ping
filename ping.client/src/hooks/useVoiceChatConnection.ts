import { useCallback, useEffect, useRef, useState } from 'react';
import * as signalR from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

export type Status = 'idle' | 'connecting' | 'connected' | 'recording';
export type ChatItem = {
    id: string;
    fromId: string;
    fromName: string;
    text: string;
    atIso: string;
};

// Hook options
export interface VoiceChatOptions {
    lazyInit?: boolean; // When true, delays mic initialization until needed
}

type PeerInfo = { ConnectionId: string; Name: string };

const HUB_URL = 'https://ping.vera.fo/api/voice';

// WebRTC ICE config
const DEFAULT_PUBLIC_STUNS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
const STUN_URLS = (import.meta as any).env?.VITE_STUN_URLS as string | undefined;
const STUN_SERVERS: RTCIceServer[] =
    STUN_URLS
        ? STUN_URLS.split(',').map(u => u.trim()).filter(Boolean).map(u => ({ urls: u }))
        : DEFAULT_PUBLIC_STUNS;

const TURN_URLS = (import.meta as any).env?.VITE_TURN_URLS as string | undefined;
const TURN_USERNAME = (import.meta as any).env?.VITE_TURN_USERNAME as string | undefined;
const TURN_CREDENTIAL = (import.meta as any).env?.VITE_TURN_CREDENTIAL as string | undefined;
const ICE_POLICY = ((import.meta as any).env?.VITE_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy) || 'all';

const TURN_SERVERS: RTCIceServer[] =
    TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL
        ? TURN_URLS.split(',').map(u => u.trim()).filter(Boolean).map(u => ({
            urls: u, username: TURN_USERNAME!, credential: TURN_CREDENTIAL!
        }))
        : [];

const RTC_CONFIG: RTCConfiguration = {
    iceServers: [...STUN_SERVERS, ...TURN_SERVERS],
    iceTransportPolicy: ICE_POLICY,
};

const newId = () => {
    try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2); }
};

const forcePrimeAllAudioConnections = () => {
    log('FORCE PRIMING ALL AUDIO CONNECTIONS');

    try {
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 440;
        gainNode.gain.value = 0.0001
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        oscillator.start();
        setTimeout(() => oscillator.stop(), 300);
        log('Played local priming tone');
    } catch (err) {
        logError('Failed to play local priming tone:', err);
    }

    const allAudioElements = document.querySelectorAll('audio');
    log(`Forcing play on ${allAudioElements.length} audio elements`);

    for (const el of allAudioElements) {
        el.muted = false;
        el.volume = 1.0;
        el.play().catch(() => { });
    }
};

// Add this utility function at the top level of your file
const cleanupMediaStream = (stream: MediaStream | null) => {
    if (!stream) return;

    try {
        const tracks = stream.getTracks();
        for (const track of tracks) {
            if (track.readyState !== 'ended') {
                track.stop();
            }
        }
    } catch (err) {
        console.warn('Error cleaning up media stream:', err);
    }
};

// Add these debugging helpers at the top
const DEBUG = true;
const log = (...args: any[]) => {
    if (DEBUG) console.log('[VoiceChat]', ...args);
};

const logError = (...args: any[]) => {
    console.error('[VoiceChat ERROR]', ...args);
};


// Create a test tone to verify audio output is working
const playTestTone = (audioContext?: AudioContext) => {
    try {
        const ctx = audioContext || new AudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = 440; // A4 note
        gainNode.gain.value = 0.1; // Quiet

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
            oscillator.disconnect();
            gainNode.disconnect();
        }, 200);

        return ctx;
    } catch (err) {
        logError('Failed to play test tone:', err);
        return null;
    }
};

// Add this helper function to directly test audio playback
const playDirectSound = () => {
    try {
        // Create a simple audio context for direct sound output
        const audioCtx = new AudioContext();

        // Create an oscillator for a clear, audible tone
        const oscillator = audioCtx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = 440 // A4 note

        // Create a gain node to control volume
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.2; // Not too loud

        // Connect the nodes
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        // Start the oscillator and stop after 1 second
        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
            oscillator.disconnect();
            gainNode.disconnect();
        }, 1000);

        return true;
    } catch (err) {
        logError('Error playing direct sound:', err);
        return false;
    }
};

export function useVoiceChatConnection(initialName = 'Gestur', options: VoiceChatOptions = {}) {
    const { lazyInit = false } = options;

    // Modify this part of the hook
    useEffect(() => {
        // We no longer check localStorage - we'll always initialize silently
        // but still show the join button on every page load
        try {
            const ctx = new AudioContext();
            ctx.resume().catch(() => { });
        } catch (err) {
            logError('Failed to initialize audio system:', err);
        }
    }, []);

    // Public state
    const [status, setStatus] = useState<Status>('idle');
    const [name, setNameState] = useState(initialName);
    const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
    const [chat, setChat] = useState<ChatItem[]>([]);
    const [typingNames, setTypingNames] = useState<string[]>([]);
    const audioContainerRef = useRef<HTMLDivElement | null>(null);
    const [micInitialized, setMicInitialized] = useState(false);

    // Add this new function after your other utility functions
    const primeAudioConnection = async (pc: RTCPeerConnection): Promise<void> => {
        log('Priming audio connection with brief silent audio');
        try {
            // Create a silent audio track to prime the connection
            const silentCtx = new AudioContext();
            const oscillator = silentCtx.createOscillator();
            const dst = silentCtx.createMediaStreamDestination();
            oscillator.connect(dst);
            oscillator.start();

            // Get the silent track
            const silentTrack = dst.stream.getAudioTracks()[0];
            silentTrack.enabled = true;

            // Add this track temporarily to wake up the connection
            const sender = pc.addTrack(silentTrack, dst.stream);

            // Wait a moment for it to be processed
            await new Promise(r => setTimeout(r, 500));

            // Remove the temporary track
            if (sender) {
                pc.removeTrack(sender);
            }

            // Clean up
            oscillator.stop();
            silentTrack.stop();

            log('Audio connection primed');
        } catch (err) {
            logError('Error priming audio connection:', err);
        }
    };


    // Internal refs
    const hubRef = useRef<signalR.HubConnection | null>(null);
    const startingRef = useRef(false);
    const nameRef = useRef(name);

    const debugAudioPipeline = useCallback(() => {
        log('=== AUDIO PIPELINE DEBUG ===');

        // Check for all audio elements
        log(`Audio elements: ${remoteAudiosRef.current.size}`);
        for (const [peerId, el] of remoteAudiosRef.current.entries()) {
            log(`Audio element for ${peerId}:`, {
                muted: el.muted,
                volume: el.volume,
                readyState: el.readyState,
                paused: el.paused,
                ended: el.ended,
                seeking: el.seeking,
                hasStream: !!el.srcObject,
                tracks: (el.srcObject as MediaStream)?.getTracks().length || 0
            });

            // Force unmute and full volume
            el.muted = false;
            el.volume = 1.0;

            // Try to play
            el.play().then(() => {
                log(`Successfully played audio for ${peerId}`);
            }).catch(err => {
                logError(`Failed to play audio for ${peerId}:`, err);
            });
        }

        // Check for all peer connections
        log(`Peer connections: ${pcsRef.current.size}`);
        for (const [peerId, pc] of pcsRef.current.entries()) {
            const senders = pc.getSenders();
            const receivers = pc.getReceivers();

            log(`Peer connection ${peerId}:`, {
                connectionState: pc.connectionState,
                iceConnectionState: pc.iceConnectionState,
                senderCount: senders.length,
                receiverCount: receivers.length,
                audioSenders: senders.filter(s => s.track?.kind === 'audio').length,
                audioReceivers: receivers.filter(r => r.track?.kind === 'audio').length
            });

            // Check track stats
            for (const receiver of receivers) {
                if (!receiver.track) continue;
                log(`Receiver track for ${peerId}:`, {
                    kind: receiver.track.kind,
                    enabled: receiver.track.enabled,
                    muted: receiver.track.muted,
                    readyState: receiver.track.readyState
                });

                // Force enable the track
                receiver.track.enabled = true;
            }
        }

        log('=== END DEBUG ===');
    }, []);


    // WebRTC
    const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
    const peerNamesRef = useRef<Map<string, string>>(new Map());
    const remoteAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const localStreamRef = useRef<MediaStream | null>(null);
    const localTrackRef = useRef<MediaStreamTrack | null>(null);
    const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
    const pcsPendingTrackRef = useRef<Set<string>>(new Set());

    // Indicators
    const activeSpeakerPeerRef = useRef<string | null>(null);

    // Typing map
    const typingMapRef = useRef<Map<string, { name: string; timer: number | null }>>(new Map());
    const typingSelfRef = useRef<{ active: boolean; timeoutId: number | null }>({ active: false, timeoutId: null });

    useEffect(() => { nameRef.current = name; }, [name]);

    // Add the new wake-up audio useEffect HERE
    useEffect(() => {
        // Wake up audio system on page load
        const wakeUpAudio = async () => {
            try {
                log('Waking up audio system on page load');

                // Play a silent sound to get user permission early
                const audioCtx = new AudioContext();
                await audioCtx.resume();

                // Create a brief silent sound
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                gainNode.gain.value = 0.001; // Nearly silent
                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                // Play briefly and clean up
                oscillator.start();
                setTimeout(() => {
                    oscillator.stop();
                    oscillator.disconnect();
                    gainNode.disconnect();
                    log('Audio system wake-up completed');
                }, 100);
            } catch (err) {
                logError('Error waking up audio system:', err);
            }
        };

        // Execute wake-up on page load
        wakeUpAudio();
    }, []);

    // Local mic initialization (now explicit)
    const initializeMic = useCallback(async (): Promise<boolean> => {
        if (localTrackRef.current && localStreamRef.current) {
            setMicInitialized(true);
            return true;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            localStreamRef.current = stream;
            const track = stream.getAudioTracks()[0];
            track.enabled = false; // Start disabled
            localTrackRef.current = track;

            // Add the track to any peer connections that were waiting
            const pendingPcs = Array.from(pcsPendingTrackRef.current);
            for (const peerId of pendingPcs) {
                const pc = pcsRef.current.get(peerId);
                if (pc) {
                    pc.addTrack(track, stream);
                    pcsPendingTrackRef.current.delete(peerId);
                }
            }

            setMicInitialized(true);
            return true;
        } catch (err) {
            console.error('Failed to initialize microphone:', err);
            return false;
        }
    }, []);

    const flushPendingIce = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
        const queued = pendingIceRef.current.get(peerId);
        if (!queued || queued.length === 0) return;
        for (const c of queued) {
            try { await pc.addIceCandidate(c); } catch { /* ignore */ }
        }
        pendingIceRef.current.delete(peerId);
    }, []);

    const createPc = useCallback((peerId: string) => {
        let pc = pcsRef.current.get(peerId);
        if (pc) return pc;

        log(`Creating new RTCPeerConnection for peer ${peerId}`);
        pc = new RTCPeerConnection(RTC_CONFIG);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const json = JSON.stringify(e.candidate.toJSON());
                log(`ICE candidate for peer ${peerId}:`, e.candidate.type);
                hubRef.current?.invoke('SendIce', peerId, json).catch((err) => {
                    logError(`Failed to send ICE to ${peerId}:`, err);
                });
            }
        };

        // Add more connection state monitoring
        pc.oniceconnectionstatechange = () => {
            log(`ICE connection state changed for ${peerId}:`, pc.iceConnectionState);

            // If we're stuck in checking for too long, we might need to restart ICE
            if (pc.iceConnectionState === 'checking') {
                setTimeout(() => {
                    if (pc.iceConnectionState === 'checking') {
                        log(`ICE still checking after timeout for ${peerId}, may need restart`);
                    }
                }, 10000);
            }
        };

        pc.onsignalingstatechange = () => {
            log(`Signaling state changed for ${peerId}:`, pc.signalingState);
        };

        pc.onconnectionstatechange = () => {
            log(`Connection state changed for ${peerId}:`, pc.connectionState);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                logError(`Connection to peer ${peerId} ${pc.connectionState}`);
                const el = remoteAudiosRef.current.get(peerId);
                if (el) {
                    try { el.srcObject = null; } catch { /* empty */ }
                    try { el.remove?.(); } catch { /* empty */ }
                    remoteAudiosRef.current.delete(peerId);
                }
            }

            // When connected, make sure tracks are properly configured
            if (pc.connectionState === 'connected') {
                const remoteStreams = pc.getReceivers()
                    .filter(r => r.track && r.track.kind === 'audio')
                    .map(r => r.track);
                log(`Connected to ${peerId}, remote tracks:`, remoteStreams.length);

                // Prime the audio connection when first connected
                primeAudioConnection(pc).catch(err =>
                    logError(`Failed to prime audio connection for ${peerId}:`, err)
                );
            }
        };

        // Update the ontrack handler to better handle audio activation
        pc.ontrack = (e) => {
            log(`Received track from ${peerId}:`, e.track.kind, e.track.id);
            const [ms] = e.streams;
            if (!ms) {
                logError(`No media stream received from ${peerId}`);
                return;
            }

            // Explicitly enable the track
            if (e.track.kind === 'audio') {
                e.track.enabled = true;
                log(`Explicitly enabled remote track from ${peerId}`);
            }

            // Create an invisible audio element
            let el = remoteAudiosRef.current.get(peerId);
            if (!el) {
                el = new Audio();
                el.id = `audio-${peerId}`;
                el.autoplay = true;
                // Remove controls to make it invisible
                el.controls = false;
                el.muted = false;
                el.volume = 1.0;

                // Make sure it's completely hidden
                el.style.display = 'none';
                el.style.width = '0';
                el.style.height = '0';

                el.setAttribute('autoplay', '');
                el.setAttribute('playsinline', '');

                el.onloadedmetadata = () => {
                    log(`Metadata loaded for audio from ${peerId}, trying autoplay`);
                    el!.play().catch(e => logError(`Autoplay failed for ${peerId}:`, e)); // Fixed: added ! operator
                };

                el.oncanplay = () => {
                    log(`Can play audio from ${peerId}, attempting play`);
                    el!.play().catch(e => logError(`Canplay event play failed for ${peerId}:`, e)); // Fixed: added ! operator
                };

                // Add audio to document but keep it hidden
                document.body.appendChild(el);
                log(`Created hidden audio element for ${peerId}`);

                // No longer creating the visual indicator

                remoteAudiosRef.current.set(peerId, el);
            }

            // Connect the stream to the element
            el.srcObject = ms;

            // Use multiple play attempts with different strategies
            const tryPlay = () => {
                el.play()
                    .then(() => {
                        log(`✅ Successfully playing audio from ${peerId}`);
                    })
                    .catch(err => {
                        logError(`❌ Failed to play audio from ${peerId}:`, err);
                    });
            };

            // Try multiple times with delays
            tryPlay();
            setTimeout(tryPlay, 500);
            setTimeout(tryPlay, 2000);

            // Update active speaker UI
            const peerName = peerNamesRef.current.get(peerId);
            if (peerName) {
                setActiveSpeaker(peerName);
            }
        };

        pcsRef.current.set(peerId, pc);
        return pc;
    }, []);

    const addLocalToPc = useCallback(async (pc: RTCPeerConnection, peerId: string) => {
        log(`Adding local track to PC for peer ${peerId}`);
        
        let track: MediaStreamTrack | null = null;
        let stream: MediaStream | null = null;
        
        // If we already have a real stream/track, use it
        if (localTrackRef.current && localStreamRef.current) {
            track = localTrackRef.current;
            stream = localStreamRef.current;
            log(`Using existing real track for peer ${peerId}`);
        } else if (lazyInit) {
            // For lazy init, create a proper silent placeholder track
            log(`Creating silent placeholder track for peer ${peerId}`);
            try {
                const silentCtx = new AudioContext();
                const oscillator = silentCtx.createOscillator();
                const gainNode = silentCtx.createGain();
                const destination = silentCtx.createMediaStreamDestination();
                
                gainNode.gain.value = 0.0001; // Nearly silent but not completely muted
                oscillator.frequency.value = 440;
                oscillator.type = 'sine';
                oscillator.connect(gainNode);
                gainNode.connect(destination);
                oscillator.start();
                
                // Get the silent track
                const silentTrack = destination.stream.getAudioTracks()[0];
                silentTrack.enabled = true; // Keep enabled so WebRTC doesn't optimize it away
                
                // Store this as a temporary placeholder
                track = silentTrack;
                stream = destination.stream;
                
                // Keep oscillator running briefly to ensure track is valid
                setTimeout(() => {
                    try {
                        oscillator.stop();
                        oscillator.disconnect();
                        gainNode.disconnect();
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                }, 1000);
            } catch (err) {
                logError(`Failed to create silent track for ${peerId}:`, err);
                return;
            }
        } else {
            // Non-lazy init: get real microphone
            const success = await initializeMic();
            if (!success) return;
            track = localTrackRef.current;
            stream = localStreamRef.current;
        }
        
        if (!track || !stream) {
            log(`No track available for peer ${peerId}`);
            return;
        }
        
        // Always add as new track (don't try to replace during initial setup)
        try {
            pc.addTrack(track, stream);
            log(`Added track to peer ${peerId}:`, track.kind, track.enabled);
        } catch (err) {
            logError(`Failed to add track to peer ${peerId}:`, err);
        }
    }, [lazyInit, initializeMic]);

    // Offer/Answer/ICE
    const makeOffer = useCallback(async (peerId: string) => {
        if (!peerId) return;
        log(`Making offer to peer ${peerId}`);

        const pc = createPc(peerId);
        await addLocalToPc(pc, peerId);

        try {
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                iceRestart: true // Always do fresh ICE gathering to improve connection chances
            });

            log(`Created offer for peer ${peerId}`);
            await pc.setLocalDescription(offer);
            log(`Set local description for peer ${peerId}`);

            await hubRef.current?.invoke('SendOffer', peerId, offer.sdp ?? '', nameRef.current);
            log(`Sent offer to peer ${peerId}`);
        } catch (err) {
            logError(`Failed to create or send offer to peer ${peerId}:`, err);
        }
    }, [addLocalToPc, createPc]);

    // Replace the makeAnswer function with this improved version:
    const makeAnswer = useCallback(async (peerId: string, sdp: string) => {
        log(`Making answer to peer ${peerId}`);
        const pc = createPc(peerId);

        try {
            await pc.setRemoteDescription({ type: 'offer', sdp });
            log(`Set remote description for peer ${peerId}`);

            await flushPendingIce(peerId, pc);
            log(`Flushed pending ICE candidates for peer ${peerId}`);

            // CRITICAL FIX: Always ensure we have a proper track when answering
            // This is the key issue - client B needs to have a real audio path ready
            let track: MediaStreamTrack | null = null;
            let stream: MediaStream | null = null;
            
            if (localTrackRef.current && localStreamRef.current) {
                track = localTrackRef.current;
                stream = localStreamRef.current;
            } else {
                // For lazy init, we need to create a proper placeholder that can be replaced
                log(`Creating enhanced placeholder track for answer to ${peerId}`);
                try {
                    const silentCtx = new AudioContext();
                    const oscillator = silentCtx.createOscillator();
                    const gainNode = silentCtx.createGain();
                    const destination = silentCtx.createMediaStreamDestination();
                    
                    gainNode.gain.value = 0.001; // Very quiet but audible to WebRTC
                    oscillator.frequency.value = 440;
                    oscillator.type = 'sine';
                    oscillator.connect(gainNode);
                    gainNode.connect(destination);
                    oscillator.start();
                    
                    const silentTrack = destination.stream.getAudioTracks()[0];
                    silentTrack.enabled = true; // Keep enabled
                    
                    track = silentTrack;
                    stream = destination.stream;
                    
                    // Keep oscillator running longer to establish proper connection
                    setTimeout(() => {
                        try {
                            oscillator.stop();
                            oscillator.disconnect();
                            gainNode.disconnect();
                        } catch (e) {
                            // Ignore cleanup errors
                        }
                    }, 2000); // Longer duration for better establishment
                } catch (err) {
                    logError(`Failed to create enhanced placeholder for ${peerId}:`, err);
                }
            }
            
            if (track && stream) {
                pc.addTrack(track, stream);
                log(`Added track to answer for peer ${peerId}:`, track.kind);
            }

            const answer = await pc.createAnswer();
            log(`Created answer for peer ${peerId}`);

            await pc.setLocalDescription(answer);
            log(`Set local description for peer ${peerId}`);

            await hubRef.current?.invoke('SendAnswer', peerId, answer.sdp ?? '');
            log(`Sent answer to peer ${peerId}`);
        } catch (err) {
            logError(`Failed in answer process for peer ${peerId}:`, err);
        }
    }, [createPc, flushPendingIce]);

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
        } catch { /* ignore */ }
    }, []);

    // Chat helpers
    const addChatItem = useCallback((item: ChatItem) => {
        setChat(prev => {
            const next = [...prev, item];
            if (next.length > 500) next.splice(0, next.length - 500);
            return next;
        });
    }, []);

    const notifyTypingSelf = useCallback((active: boolean) => {
        if (!hubRef.current) return;
        hubRef.current.invoke('SetTyping', active).catch(() => { });
    }, []);

    // Exposed: call on each input change to debounce typing notifications
    const notifyTypingOnInput = useCallback(() => {
        if (!typingSelfRef.current.active) {
            notifyTypingSelf(true);
            typingSelfRef.current.active = true;
        }
        if (typingSelfRef.current.timeoutId) {
            clearTimeout(typingSelfRef.current.timeoutId);
            typingSelfRef.current.timeoutId = null;
        }
        typingSelfRef.current.timeoutId = window.setTimeout(() => {
            notifyTypingSelf(false);
            typingSelfRef.current.active = false;
            typingSelfRef.current.timeoutId = null;
        }, 2000);
    }, [notifyTypingSelf]);

    const clearTypingForPeer = useCallback((peerId: string) => {
        const entry = typingMapRef.current.get(peerId);
        if (entry?.timer) window.clearTimeout(entry.timer);
        typingMapRef.current.delete(peerId);
        setTypingNames(Array.from(typingMapRef.current.values()).map(v => v.name));
    }, []);

    const setTypingForPeer = useCallback((peerId: string, peerName: string, typing: boolean) => {
        const current = typingMapRef.current.get(peerId);
        if (typing) {
            if (current?.timer) window.clearTimeout(current.timer);
            const timer = window.setTimeout(() => clearTypingForPeer(peerId), 2500);
            typingMapRef.current.set(peerId, { name: peerName || 'Gestur', timer });
        } else {
            if (current?.timer) window.clearTimeout(current.timer);
            typingMapRef.current.delete(peerId);
        }
        setTypingNames(Array.from(typingMapRef.current.values()).map(v => v.name));
    }, [clearTypingForPeer]);

    // Connection bootstrap + handlers
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
            pcsPendingTrackRef.current.delete(peerId);
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
            clearTypingForPeer(peerId);
        });
        hubRef.current.on('PeerRenamed', (peerId: string, newName: string) => {
            peerNamesRef.current.set(peerId, newName);
            if (typingMapRef.current.has(peerId)) setTypingForPeer(peerId, newName, true);
        });

        // Talking
        hubRef.current.on('PeerTalking', (peerId: string, peerName: string, talking: boolean) => {
            peerNamesRef.current.set(peerId, peerName || 'Gestur');
            if (talking) {
                activeSpeakerPeerRef.current = peerId;
                setActiveSpeaker(peerName || 'Gestur');
            } else if (activeSpeakerPeerRef.current === peerId) {
                activeSpeakerPeerRef.current = null;
                setActiveSpeaker(null);
            }
        });

        // Signaling
        hubRef.current.on('RtcOffer', async (fromId: string, fromName: string, sdp: string) => {
            peerNamesRef.current.set(fromId, fromName);
            
            // Check if this is a renegotiation (we already have a connection to this peer)
            const existingPc = pcsRef.current.get(fromId);
            if (existingPc && existingPc.connectionState === 'connected') {
                log(`Handling renegotiation offer from ${fromId}`);
                
                // For renegotiation, we need to be more careful about the state
                try {
                    await existingPc.setRemoteDescription({ type: 'offer', sdp });
                    
                    // Ensure we have proper local tracks for the renegotiation
                    if (localTrackRef.current && localStreamRef.current) {
                        const audioSenders = existingPc.getSenders().filter(s => s.track?.kind === 'audio');
                        if (audioSenders.length === 0) {
                            // Add our current track if we don't have one
                            existingPc.addTrack(localTrackRef.current, localStreamRef.current);
                            log(`Added current track to renegotiation with ${fromId}`);
                        }
                    }
                    
                    const answer = await existingPc.createAnswer();
                    await existingPc.setLocalDescription(answer);
                    await hubRef.current?.invoke('SendAnswer', fromId, answer.sdp ?? '');
                    log(`Handled renegotiation with ${fromId}`);
                } catch (err) {
                    logError(`Failed to handle renegotiation from ${fromId}:`, err);
                }
            } else {
                // This is a new connection
                await makeAnswer(fromId, sdp);
            }
        });
        hubRef.current.on('RtcAnswer', async (fromId: string, sdp: string) => {
            await applyAnswer(fromId, sdp);
        });
        hubRef.current.on('RtcIce', async (fromId: string, candidateJson: string) => {
            await applyIce(fromId, candidateJson);
        });

        // Chat
        hubRef.current.on('ChatMessage', (fromId: string, fromName: string, text: string, atIso: string) => {
            addChatItem({ id: newId(), fromId, fromName: fromName || 'Gestur', text: String(text ?? ''), atIso: atIso || new Date().toISOString() });
        });
        hubRef.current.on('Typing', (fromId: string, fromName: string, typing: boolean) => {
            setTypingForPeer(fromId, fromName || 'Gestur', !!typing);
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

                    log('CONNECTION ESTABLISHED - ACTIVATING AUDIO SYSTEM');
                    // Force play a sound immediately after connection to wake everything up
                    forcePrimeAllAudioConnections();
                    // Request microphone permissions early
                    navigator.mediaDevices.getUserMedia({ audio: true })
                        .then(stream => {
                            log('Got microphone permission early');
                            stream.getTracks().forEach(track => track.stop());
                        })
                        .catch(err => logError('Could not get early microphone permission:', err));

                    await hubRef.current.invoke('SetName', nameRef.current);
                    const peers = await hubRef.current.invoke<PeerInfo[]>('GetPeers');
                    for (const p of peers ?? []) {
                        const id = p?.ConnectionId;
                        const nm = p?.Name ?? 'Gestur';
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
                console.error('SignalR start failed', err);
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
                try { hub.invoke('SetTyping', false).catch(() => { }); } catch { /* empty */ }
                hub.stop().catch(() => { });
            }
            for (const [id, pc] of pcsRef.current) {
                try { pc.close(); } catch { /* empty */ }
                pcsRef.current.delete(id);
            }
            for (const el of remoteAudiosRef.current.values()) {
                try { el.srcObject = null; } catch { /* empty */ }
                try { el.remove?.(); } catch { /* empty */ }
            }
            remoteAudiosRef.current.clear();
            pendingIceRef.current.clear();
            pcsPendingTrackRef.current.clear();

            // Use our cleanup utility
            cleanupMediaStream(localStreamRef.current);
            localStreamRef.current = null;
            localTrackRef.current = null;

            for (const [, v] of typingMapRef.current) {
                if (v.timer) clearTimeout(v.timer);
            }
            typingMapRef.current.clear();
            setTypingNames([]);
        };
    }, [applyAnswer, applyIce, makeAnswer, makeOffer, addChatItem, setTypingForPeer, clearTypingForPeer]);

    // Exposed actions
    const setName = useCallback((value: string) => {
        setNameState(value);
        hubRef.current?.invoke('SetName', value).catch(() => { });
    }, []);


    const stopRecording = useCallback(async () => {
        // Update status immediately
        setStatus('connected');
        hubRef.current?.invoke('SetTalking', false).catch(() => { });

        // Get references to current media
        const track = localTrackRef.current;
        const stream = localStreamRef.current;

        // Disable the track but don't remove it from peers
        if (track) {
            track.enabled = false; // This stops audio transmission without breaking connections
        }

        // Store the sender-track mappings before modifying
        const trackMappings = new Map<RTCRtpSender, MediaStreamTrack | null>();

        // Just disable, don't remove from peer connections
        for (const peerId of pcsRef.current.keys()) {
            const pc = pcsRef.current.get(peerId);
            if (pc) {
                for (const sender of pc.getSenders()) {
                    if (sender.track && sender.track.kind === 'audio') {
                        // Save the reference and disable
                        trackMappings.set(sender, sender.track);
                        sender.track.enabled = false;
                    }
                }
            }
        }

        // Stop the track and release media resources to hide indicator
        if (track && track.readyState !== 'ended') { // Fixed: use readyState instead of stopped
            track.stop();
        }

        cleanupMediaStream(stream);

        // Clear our references
        localTrackRef.current = null;
        localStreamRef.current = null;
    }, []);

    // Replace the startRecording function with this simpler, more reliable version:
    const startRecording = useCallback(async () => {
        if (status !== 'connected') return;

        try {
            log('Starting recording with track replacement strategy');
            forcePrimeAllAudioConnections();

            // Clean up existing resources
            if (localTrackRef.current && localTrackRef.current.readyState !== 'ended') { // Fixed: use readyState instead of stopped
                localTrackRef.current.stop();
            }
            if (localStreamRef.current) {
                cleanupMediaStream(localStreamRef.current);
            }

            // Get fresh stream with optimal settings
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true },
                    autoGainControl: { ideal: true },
                    sampleRate: { ideal: 48000 },
                    channelCount: { ideal: 1 }
                }
            });

            const track = stream.getAudioTracks()[0];
            if (!track) throw new Error('No audio track available');

            track.enabled = true;
            log('New audio track enabled:', track.id);

            localStreamRef.current = stream;
            localTrackRef.current = track;
            setMicInitialized(true);

            // SIMPLIFIED APPROACH: Just replace tracks without full renegotiation
            for (const [peerId, pc] of pcsRef.current.entries()) {
                if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                    log(`Skipping peer ${peerId} - connection in invalid state: ${pc.connectionState}`);
                    continue;
                }

                try {
                    const audioSenders = pc.getSenders().filter(s => s.track?.kind === 'audio');
                    
                    if (audioSenders.length > 0) {
                        // Replace track in existing sender
                        log(`Replacing track for peer ${peerId}`);
                        await audioSenders[0].replaceTrack(track);
                    } else {
                        // Add new track if no audio sender exists
                        log(`Adding new track for peer ${peerId}`);
                        pc.addTrack(track, stream);
                        
                        // Only renegotiate when we actually add a new sender
                        const offer = await pc.createOffer({
                            offerToReceiveAudio: true,
                            iceRestart: false // Don't restart ICE unless necessary
                        });
                        
                        await pc.setLocalDescription(offer);
                        await hubRef.current?.invoke('SendOffer', peerId, offer.sdp ?? '', nameRef.current);
                        log(`Sent offer after adding track to peer ${peerId}`);
                    }
                } catch (err) {
                    logError(`Failed to handle audio for peer ${peerId}:`, err);
                }
            }

            // Set status and notify server
            setStatus('recording');
            hubRef.current?.invoke('SetTalking', true).catch(err => {
                logError('Failed to notify server about talking state:', err);
            });

            log('Recording started successfully');
        } catch (err) {
            logError('Failed to start recording:', err);
            alert('Neyðugt er við loyvi at brúka mikrofonina');
            setStatus('connected');
        }
    }, [status]);

    const sendChat = useCallback(async (textRaw: string) => {
        const text = textRaw.trim();
        if (!text) return;
        if (text.length > 4000) { alert('Message too long'); return; }

        const fromId = hubRef.current?.connectionId ?? 'local';
        const fromName = nameRef.current || 'Gestur';
        const atIso = new Date().toISOString();

        addChatItem({ id: newId(), fromId, fromName, text, atIso });
        try { await hubRef.current?.invoke('SendChat', text); } catch { }
    }, [addChatItem]);

    // Add this function after your useEffect for diagnostics
    const forceTestSound = useCallback(() => {
        log('Forcing test sound to all peers');

        // Create an oscillator directly in all audio elements
        for (const [peerId, el] of remoteAudiosRef.current.entries()) {
            try {
                // First try to play the element
                el.play().catch(err => log(`Couldn't play audio element for ${peerId}:`, err));

                // Then play a test tone
                playTestTone();
                log(`Played test tone for ${peerId}`);
            } catch (err) {
                logError(`Failed test sound for ${peerId}:`, err);
            }
        }
    }, []);

    // MOVE this useEffect AFTER defining forceTestSound
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            // Alt+Shift+D for diagnostics
            if (e.altKey && e.shiftKey && e.key === 'D') {
                (window as any).diagnosePTT?.();
                forceTestSound();
                debugAudioPipeline();
            }
        };

        window.addEventListener('keydown', handleKeyPress);
        return () => window.removeEventListener('keydown', handleKeyPress);
    }, [forceTestSound, debugAudioPipeline]);

    // Replace the createAudioActivationModal function with this:
    const activateAudioSystem = async (): Promise<boolean> => {
        try {
            // Play a silent sound to activate audio
            const ctx = new AudioContext();
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);
            gainNode.gain.value = 0.01; // Almost silent
            oscillator.start();

            // Wait a bit
            await new Promise(resolve => setTimeout(() => {
                oscillator.stop();
                resolve(null);
            }, 200));

            // Request microphone permission early
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                log('Microphone permission granted');
                // Stop tracks to release microphone
                stream.getTracks().forEach(track => track.stop());
            } catch (micErr) {
                logError('Microphone permission request failed:', micErr);
            }

            return true;
        } catch (err) {
            logError('Failed to activate audio system:', err);
            return false;
        }
    };

    return {
        // state
        status,
        name,
        activeSpeaker,
        chat,
        typingNames,
        audioContainerRef,
        micInitialized,
        // actions
        setName,
        startRecording,
        stopRecording,
        sendChat,
        notifyTypingOnInput,
        initializeMic,
        // Debug functions
        __debug_forceTestSound: forceTestSound,
        __debug_audioPipeline: debugAudioPipeline,
        __debug_playSound: playDirectSound,

        // Add these:
        needsAudioActivation: true,
        activateAudio: async () => {
            const success = await activateAudioSystem();
            if (success) {
                // Still save to localStorage (could be useful for analytics)
                localStorage.setItem('audioActivated', 'true');
            }
            return success;
        }
    };
}