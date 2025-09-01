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

type PeerInfo = { ConnectionId: string; Name: string };

const HUB_URL =
  (import.meta as any).env?.VITE_SIGNALR_HUB
  || (import.meta.env.PROD ? 'https://ping.vera.fo/api/voice' : 'https://localhost:7160/voice');

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

export function useVoiceChatConnection(initialName = 'Gestur') {
  // Public state
  const [status, setStatus] = useState<Status>('idle');
  const [name, setNameState] = useState(initialName);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const audioContainerRef = useRef<HTMLDivElement | null>(null);

  // Internal refs
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

  // Indicators
  const activeSpeakerTimerRef = useRef<number | null>(null);
  const activeSpeakerPeerRef = useRef<string | null>(null);

  // Typing map
  const typingMapRef = useRef<Map<string, { name: string; timer: number | null }>>(new Map());
  const typingSelfRef = useRef<{ active: boolean; timeoutId: number | null }>({ active: false, timeoutId: null });

  useEffect(() => { nameRef.current = name; }, [name]);

  // Local mic
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

  const addLocalToPc = useCallback(async (pc: RTCPeerConnection) => {
    const track = await ensureLocalTrack();
    const has = pc.getSenders().some(s => s.track && s.track.kind === 'audio');
    if (!has && localStreamRef.current) pc.addTrack(track, localStreamRef.current);
  }, [ensureLocalTrack]);

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

    pc = new RTCPeerConnection(RTC_CONFIG);

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
        el.setAttribute('playsinline', '');
        el.muted = false;
        if (audioContainerRef.current && !el.parentNode) audioContainerRef.current.appendChild(el);
        remoteAudiosRef.current.set(peerId, el);
      } else {
        el.muted = false;
      }
      el.srcObject = ms;
      el.play().catch(() => { /* user gesture required */ });

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

  // Offer/Answer/ICE
  const makeOffer = useCallback(async (peerId: string) => {
    if (!peerId) return;
    const pc = createPc(peerId);
    await addLocalToPc(pc);
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await hubRef.current?.invoke('SendOffer', peerId, offer.sdp ?? '', nameRef.current);
  }, [addLocalToPc, createPc]);

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
      await makeAnswer(fromId, sdp);
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
        try { hub.invoke('SetTyping', false).catch(() => { }); } catch { }
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

  const startRecording = useCallback(async () => {
    if (status !== 'connected') return;
    try {
      for (const el of remoteAudiosRef.current.values()) {
        try { await el.play(); } catch { /* ignore */ }
      }
      const track = await ensureLocalTrack();
      track.enabled = true;
      setStatus('recording');
      hubRef.current?.invoke('SetTalking', true).catch(() => { });
    } catch {
      alert('Neyðugt er við loyvi at brúka mikrofonina');
    }
  }, [ensureLocalTrack, status]);

  const stopRecording = useCallback(async () => {
    const track = localTrackRef.current;
    if (track) track.enabled = false;
    setStatus('connected');
    hubRef.current?.invoke('SetTalking', false).catch(() => { });
  }, []);

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

  return {
    // state
    status,
    name,
    activeSpeaker,
    chat,
    typingNames,
    audioContainerRef,
    // actions
    setName,
    startRecording,
    stopRecording,
    sendChat,
    notifyTypingOnInput,
  };
}