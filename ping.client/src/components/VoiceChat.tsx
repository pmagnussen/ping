import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useVoiceChatConnection } from '../hooks/useVoiceChatConnection';

export default function VoiceChat() {
    // Track whether user has initiated PTT to defer mic initialization
    const [micInitialized, setMicInitialized] = useState(false);

    const {
        status,
        name,
        setName,
        activeSpeaker,
        chat,
        typingNames,
        audioContainerRef,
        startRecording,
        stopRecording,
        sendChat,
        notifyTypingOnInput,
        initializeMic, // We'll need to add this to the hook
    } = useVoiceChatConnection('Gestur', { lazyInit: true }); // Add option to defer mic initialization

    // PTT keyboard state
    const pttKeyDownRef = useRef(false);

    // Chat input (UI local state)
    const [chatInput, setChatInput] = useState('');

    // Initialize mic only when user first attempts PTT
    const initMicIfNeeded = useCallback(() => {
        if (!micInitialized) {
            setMicInitialized(true);
            return initializeMic(); // Should return a promise
        }
        return Promise.resolve();
    }, [micInitialized, initializeMic]);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'connected') {
            initMicIfNeeded().then(() => startRecording());
        }
    }, [status, startRecording, initMicIfNeeded]);

    const handlePointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (status === 'recording') stopRecording();
    }, [status, stopRecording]);

    // Keyboard PTT (ArrowDown) - modified to initialize mic when needed
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
                if (status === 'connected') {
                    initMicIfNeeded().then(() => startRecording());
                }
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
    }, [startRecording, status, stopRecording, initMicIfNeeded]);

    // Chat handlers
    const onChatInputChanged = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setChatInput(e.target.value);
        notifyTypingOnInput();
    }, [notifyTypingOnInput]);

    const onChatKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (status === 'connected' || status === 'recording') {
                const text = chatInput;
                setChatInput('');
                sendChat(text);
            }
        }
    }, [status, chatInput, sendChat]);

    return (
        <div style={{ display: 'grid', gap: 12, width: '100%', maxWidth: 'none', position: 'relative' }}>
            <h2>Trýst og tosa</h2>

            {activeSpeaker && (
                <div role="status" aria-live="polite" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                    borderRadius: 999, background: '#eef6ff', color: '#0b5cab', width: 'fit-content'
                }}>
                    <span style={{
                        width: 8, height: 8, borderRadius: 999, background: '#2ecc71',
                        boxShadow: '0 0 0 3px rgba(46,204,113,0.25)'
                    }} />
                    <span>{activeSpeaker} tosar…</span>
                </div>
            )}

            <label style={{ display: 'grid', gap: 6 }}>
                <span>Mítt navn</span>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Gestur"
                />
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
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    msUserSelect: 'none',
                    MozUserSelect: 'none',
                    WebkitTouchCallout: 'none',
                    WebkitTapHighlightColor: 'transparent',
                    touchAction: 'manipulation',
                }}
                aria-pressed={status === 'recording'}
            >
                {status === 'recording' ? 'Slepp fyri at steðga'
                    : status === 'connecting' ? 'Sambindar…'
                        : status === 'idle' ? 'Sambinda…'
                            : 'Trýst og tosa'}
            </button>

            <small style={{ color: '#666' }}>
                Tip: Trýst á píl niður fyri at tosa.
            </small>

            {/* Chat UI */}
            <div style={{
                display: 'grid',
                gridTemplateRows: 'minmax(240px, 1fr) auto auto',
                gap: 8,
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                padding: 12,
                background: '#fafafa',
                width: '100%'
            }}>
                <div role="log" aria-live="polite" style={{ overflowY: 'auto', maxHeight: 320, paddingRight: 4 }}>
                    <div>
                        {chat.map(m => {
                            const mine = m.fromId && (m.fromId === (undefined as any)); // UI does not need connectionId; style all uniformly
                            return (
                                <div key={m.id} style={{
                                    display: 'grid',
                                    justifyItems: mine ? 'end' : 'start',
                                    marginBottom: 8
                                }}>
                                    <div style={{
                                        maxWidth: '100%',
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        background: mine ? '#111827' : '#ffffff',
                                        color: mine ? 'white' : 'black',
                                        border: '1px solid #e5e7eb',
                                        borderRadius: 10,
                                        padding: '8px 10px',
                                    }}>
                                        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                                            {m.fromName} · {new Date(m.atIso).toLocaleTimeString()}
                                        </div>
                                        <div>{m.text}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {typingNames.length > 0 && (
                    <div style={{ fontSize: 12, color: '#6b7280' }}>
                        {typingNames.length === 1
                            ? `${typingNames[0]} skrivar…`
                            : `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ` and ${typingNames.length - 2} others` : ''} skriva…`}
                    </div>
                )}

                <div style={{ display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                            onClick={() => { /* client-only clear */ }}
                            type="button"
                            style={{ background: 'transparent', border: '1px solid #e5e7eb', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }}
                        >
                            Clear
                        </button>
                        <button
                            onClick={() => { const t = chatInput; setChatInput(''); sendChat(t); }}
                            disabled={(status !== 'connected' && status !== 'recording') || chatInput.trim().length === 0}
                            style={{ background: '#111827', color: 'white', border: '1px solid #111827', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }}
                        >
                            Send
                        </button>
                    </div>
                    <textarea
                        value={chatInput}
                        onChange={onChatInputChanged}
                        onKeyDown={onChatKeyDown}
                        placeholder={status === 'connected' || status === 'recording' ? 'Skriva…' : 'Sambinda við kjattið'}
                        disabled={status === 'idle' || status === 'connecting'}
                        rows={2}
                        style={{
                            resize: 'none',
                            padding: 10,
                            borderRadius: 8,
                            border: '1px solid #e5e7eb',
                            fontFamily: 'inherit',
                            marginLeft: '5px',
                            marginRight: '5px',
                            outline: 'none'
                        }}
                        onBlur={() => {
                            // Best-effort stop typing on blur
                            // The hook auto-stops after debounce; no explicit call needed
                        }}
                    />
                </div>
            </div>

            {/* Hidden container to attach remote <audio> elements for iOS/Safari */}
            <div ref={audioContainerRef} aria-hidden="true" style={{ position: 'absolute', left: -99999, width: 1, height: 1, overflow: 'hidden' }} />
        </div>
    );
}