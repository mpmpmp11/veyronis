// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE — Gemini Live API Client
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    let ws = null;
    let audioContext = null;
    let mediaStream = null;
    let playbackContext = null;
    let playbackQueue = [];
    let isPlaying = false;
    let currentSource = null;
    let muted = false;
    let connected = false;
    let sessionToken = null;

    const TARGET_SAMPLE_RATE = 16000;
    const OUTPUT_SAMPLE_RATE = 24000;

    // ─── UI HELPERS ───
    const $ = id => document.getElementById(id);
    const setState = (state, label) => {
        const orb = $('voice-orb');
        if (orb) orb.className = 'voice-orb state-' + state;
        const labelEl = $('voice-state-label');
        if (labelEl) labelEl.textContent = label || state;
    };
    const setStatus = text => {
        const el = $('voice-status');
        if (el) el.textContent = text || '';
    };
    const showTranscript = (role, text) => {
        const el = role === 'user' ? $('voice-user-text') : $('voice-ai-text');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('visible', !!text);
    };

    // ─── AUDIO CAPTURE ───
    async function startAudioCapture() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: TARGET_SAMPLE_RATE
        });
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        const source = audioContext.createMediaStreamSource(mediaStream);
        const bufferSize = 4096;
        const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        processor.onaudioprocess = e => {
            if (muted || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
            const input = e.inputBuffer.getChannelData(0);
            const pcm16 = floatTo16BitPCM(input);
            const b64 = arrayBufferToBase64(pcm16.buffer);
            sendAudioChunk(b64);
        };
        source.connect(processor);
        processor.connect(audioContext.destination);
    }

    function floatTo16BitPCM(float32Array) {
        const buffer = new ArrayBuffer(float32Array.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return new Int16Array(buffer);
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // ─── WEBSOCKET ───
    function connectWebSocket() {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${sessionToken}`;
        ws = new WebSocket(url);

        ws.onopen = () => {
            setStatus('Connected. Sending setup...');
            sendSetupMessage();
        };

        ws.onmessage = async event => {
            try {
                const data = JSON.parse(event.data);
                handleServerMessage(data);
            } catch (e) {
                console.error('[Voice] Parse error:', e);
            }
        };

        ws.onerror = err => {
            console.error('[Voice] WebSocket error:', err);
            setStatus('Connection error');
        };

        ws.onclose = () => {
            connected = false;
            setStatus('Disconnected');
        };
    }

    function sendSetupMessage() {
        const setup = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: "Aoede" }
                        }
                    }
                },
                systemInstruction: {
                    parts: [{
                        text: `You are VEYRONIS, a friendly intelligent AI voice assistant for students.

CRITICAL LANGUAGE RULE:
- Detect the user's language on their first message.
- If they speak Georgian, respond ONLY in Georgian.
- If they speak English, respond ONLY in English.
- Never mix languages. Never translate.

STYLE:
- Brief, conversational, natural — like a smart friend.
- 1-3 short sentences unless asked for detail.
- Never use markdown, bullet points, or emojis — this is voice.
- Never say "as an AI" or "I am a language model".

PERSONALITY:
- Warm, encouraging, educational. Match the user's energy.`
                    }]
                }
            }
        };
        ws.send(JSON.stringify(setup));
    }

    function sendAudioChunk(base64Audio) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            realtimeInput: {
                audio: {
                    mimeType: "audio/pcm;rate=16000",
                    data: base64Audio
                }
            }
        }));
    }

    // ─── MESSAGE HANDLING ───
    function handleServerMessage(data) {
        if (data.setupComplete) {
            connected = true;
            setState('listening', 'Listening...');
            setStatus('Speak now');
            showTranscript('user', '');
            showTranscript('ai', '');
            return;
        }

        if (data.serverContent) {
            const sc = data.serverContent;

            if (sc.interrupted) {
                stopPlayback();
                playbackQueue = [];
                setState('listening', 'Listening...');
                setStatus('Interrupted');
                return;
            }

            if (sc.modelTurn && sc.modelTurn.parts) {
                for (const part of sc.modelTurn.parts) {
                    if (part.inlineData && part.inlineData.data) {
                        const mime = part.inlineData.mimeType || '';
                        if (mime.startsWith('audio/')) {
                            queueAudioChunk(part.inlineData.data);
                        }
                    }
                }
                if (!isPlaying) setState('speaking', 'Speaking...');
            }

            if (sc.inputTranscription && sc.inputTranscription.text) {
                const cur = $('voice-user-text')?.textContent || '';
                showTranscript('user', cur + sc.inputTranscription.text);
            }

            if (sc.outputTranscription && sc.outputTranscription.text) {
                const cur = $('voice-ai-text')?.textContent || '';
                showTranscript('ai', cur + sc.outputTranscription.text);
            }

            if (sc.turnComplete) {
                if (!isPlaying) {
                    setState('listening', 'Listening...');
                    setStatus('Speak now');
                }
            }
        }
    }

    // ─── AUDIO PLAYBACK ───
    function queueAudioChunk(base64Audio) {
        playbackQueue.push(base64Audio);
        if (!isPlaying) processPlaybackQueue();
    }

    async function processPlaybackQueue() {
        if (playbackQueue.length === 0) {
            isPlaying = false;
            setState('listening', 'Listening...');
            return;
        }
        isPlaying = true;
        const base64 = playbackQueue.shift();
        try {
            const arrayBuffer = base64ToArrayBuffer(base64);
            const pcm16 = new Int16Array(arrayBuffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768;
            }
            if (!playbackContext) {
                playbackContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: OUTPUT_SAMPLE_RATE
                });
            }
            if (playbackContext.state === 'suspended') {
                await playbackContext.resume();
            }
            const buffer = playbackContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
            buffer.getChannelData(0).set(float32);
            const source = playbackContext.createBufferSource();
            source.buffer = buffer;
            source.connect(playbackContext.destination);
            currentSource = source;
            source.onended = () => {
                currentSource = null;
                processPlaybackQueue();
            };
            source.start(0);
        } catch (e) {
            console.error('[Voice] Playback error:', e);
            processPlaybackQueue();
        }
    }

    function stopPlayback() {
        if (currentSource) {
            try { currentSource.stop(); } catch (e) {}
            currentSource = null;
        }
        playbackQueue = [];
        isPlaying = false;
    }

    // ─── PUBLIC API ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        setState('idle', 'Starting...');
        setStatus('Requesting microphone...');

        try {
            const res = await authenticatedFetch('/api/voice/session-token');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to get token');
            }
            const tokenData = await res.json();
            sessionToken = tokenData.token;
            setStatus('Connecting...');
            await startAudioCapture();
            connectWebSocket();
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('idle', 'Error');
            setTimeout(close, 2500);
        }
    }

    function close() {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        ws = null;
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        stopPlayback();
        if (playbackContext) {
            playbackContext.close().catch(() => {});
            playbackContext = null;
        }
        connected = false;
        muted = false;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.remove('muted');
        const overlay = $('voice-mode-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    function toggleMute() {
        muted = !muted;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.toggle('muted', muted);
        setStatus(muted ? 'Muted' : 'Speak now');
    }

    return { open, close, toggleMute };
})();