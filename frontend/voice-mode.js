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

        // Silent gain to prevent mic feedback while keeping the processor alive
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);
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
        // v1beta + BidiGenerateContentConstrained + access_token (ephemeral token format)
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${sessionToken}`;
        console.log('[Voice] Connecting to:', url.replace(sessionToken, '***'));
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('[Voice] WebSocket opened');
            setStatus('Connected. Sending setup...');
            sendSetupMessage();
        };

        ws.onmessage = async event => {
            try {
                const data = JSON.parse(event.data);
                console.log('[Voice] Server:', data);
                handleServerMessage(data);
            } catch (e) {
                console.error('[Voice] Parse error:', e, event.data);
            }
        };

        ws.onerror = err => {
            console.error('[Voice] WebSocket error:', err);
            setStatus('Connection error');
        };

        ws.onclose = (e) => {
            console.log('[Voice] WebSocket closed:', e.code, e.reason);
            connected = false;
            setStatus('Disconnected: ' + (e.reason || e.code));
        };
    }

       function sendSetupMessage() {
        const setup = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generation_config: {
                    response_modalities: ["AUDIO"],
                    speech_config: {
                        voice_config: {
                            prebuilt_voice_config: {
                                voice_name: "Aoede"
                            }
                        }
                    }
                },
                system_instruction: {
                    parts: [{
                        text: `You are VEYRONIS, a friendly intelligent AI voice assistant for students.

CRITICAL LANGUAGE RULE:
- Detect the user's language on their first message.
- If they speak Georgian, respond ONLY in Georgian.
- If they speak English, respond ONLY in English.
- Never mix languages. Never translate.

GREETING RULE:
- On the very first turn, greet the user warmly and briefly.
- Ask how you can help them today.

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
        console.log('[Voice] Sending setup (snake_case):', setup);
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
            console.log('[Voice] Setup complete');
            connected = true;
            setState('thinking', 'Greeting...');
            setStatus('Connecting...');
            showTranscript('user', '');
            showTranscript('ai', '');
            // ✅ Trigger AI greeting
            sendGreeting();
            return;
        }

        if (data.serverContent) {
            const sc = data.serverContent;

            // Interruption
            if (sc.interrupted) {
                console.log('[Voice] Interrupted');
                stopPlayback();
                playbackQueue = [];
                setState('listening', 'Listening...');
                setStatus('Interrupted');
                return;
            }

            // Model turn with audio
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

            // Input transcription
            if (sc.inputTranscription && sc.inputTranscription.text) {
                const cur = $('voice-user-text')?.textContent || '';
                showTranscript('user', cur + sc.inputTranscription.text);
            }

            // Output transcription
            if (sc.outputTranscription && sc.outputTranscription.text) {
                const cur = $('voice-ai-text')?.textContent || '';
                showTranscript('ai', cur + sc.outputTranscription.text);
            }

            // Turn complete
            if (sc.turnComplete) {
                console.log('[Voice] Turn complete');
                if (!isPlaying) {
                    setState('listening', 'Listening...');
                    setStatus('Speak now');
                }
            }
        }
    }

    // ─── AUDIO PLAYBACK QUEUE ───
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

        // Create a new Voice Chat conversation if not already in one
        if (!state.conversationId) {
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
                const convRes = await fetch(`${state.apiUrl}/conversations`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        user_id: state.userId,
                        title: 'Voice Chat'
                    })
                });
                if (convRes.ok) {
                    const convData = await convRes.json();
                    state.conversationId = convData.id;
                    if (typeof loadConversations === 'function') loadConversations();
                    console.log('[Voice] Created Voice Chat conversation:', convData.id);
                }
            } catch (e) {
                console.warn('[Voice] Could not create conversation:', e);
            }
        }

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
            console.log('[Voice] Got ephemeral token');
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