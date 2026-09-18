// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE — ElevenLabs Scribe + Groq + Edge-TTS
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    let sttWS = null;
    let audioContext = null;
    let mediaStream = null;
    let muted = false;
    let connected = false;
    let isProcessing = false;
    let currentAiAudio = null;
    let aiSpeaking = false;
    let accumulatedFinal = '';

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

    // ─── FETCH SINGLE-USE TOKEN FROM BACKEND ───
    async function fetchKeys() {
        const res = await authenticatedFetch('/api/voice/streaming-token');
        if (!res.ok) throw new Error('Failed to get streaming token');
        const data = await res.json();
        return { token: data.token };
    }

    // ─── AUDIO CAPTURE (16kHz mono PCM16) ───
    async function startAudioCapture() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        const source = audioContext.createMediaStreamSource(mediaStream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = e => {
            if (muted || !connected || !sttWS || sttWS.readyState !== WebSocket.OPEN) return;
            const input = e.inputBuffer.getChannelData(0);
            const pcm16 = floatTo16BitPCM(input);
            const b64 = arrayBufferToBase64(pcm16.buffer);
            try {
                // ElevenLabs expects JSON with input_audio_chunk
                sttWS.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: b64
                }));
            } catch (err) {}
        };

        source.connect(processor);
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

    // ─── ELEVENLABS WEBSOCKET ───
    async function connectElevenLabs(token) {
        // Build URL with all query params
        const params = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token: token,
            audio_format: 'pcm_16000',
            language_code: 'kat',       // Georgian ISO 639-3
            commit_strategy: 'vad',     // Auto-commit on silence (critical)
            vad_silence_threshold_secs: '2.5',
            include_language_detection: 'true'
        });
        const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;

        console.log('[Voice] Connecting to ElevenLabs Scribe...');

        return new Promise((resolve, reject) => {
            sttWS = new WebSocket(url);

            sttWS.onopen = () => {
                console.log('[Voice] ElevenLabs WS opened');
                connected = true;
                setState('listening', 'Listening...');
                setStatus('Speak now');
                resolve();
            };

            sttWS.onmessage = event => {
                let data;
                try { data = JSON.parse(event.data); } catch (e) { return; }

                // Session started
                if (data.message_type === 'session_started') {
                    console.log('[Voice] Session started');
                    return;
                }

                const transcript = data.text?.trim() || '';
                const isFinal = data.message_type === 'committed_transcript';

                // ─── BARGE-IN ───
                if (!isFinal && transcript.length > 0 && aiSpeaking && currentAiAudio) {
                    console.log('[Voice] Barge-in detected');
                    try {
                        currentAiAudio.pause();
                        currentAiAudio.currentTime = 0;
                    } catch (e) {}
                    currentAiAudio = null;
                    aiSpeaking = false;
                    setState('listening', 'Listening...');
                }

                if (data.message_type === 'partial_transcript') {
                    showTranscript('user', accumulatedFinal + (accumulatedFinal ? ' ' : '') + transcript);
                }

                if (data.message_type === 'committed_transcript') {
                    accumulatedFinal += (accumulatedFinal ? ' ' : '') + transcript;
                    showTranscript('user', accumulatedFinal);
                }

                // ElevenLabs doesn't send a separate "utterance_end" event like Deepgram
                // Instead, use VAD commit_strategy — the committed_transcript fires on silence
                // We trigger LLM after a short delay if nothing more comes
                if (data.message_type === 'committed_transcript' && accumulatedFinal.trim()) {
                    clearTimeout(window._elDelay);
                    window._elDelay = setTimeout(() => {
                        if (accumulatedFinal.trim()) {
                            const text = accumulatedFinal.trim();
                            accumulatedFinal = '';
                            console.log('[Voice] Final utterance:', text);
                            setState('thinking', 'Thinking...');
                            setStatus('Processing...');
                            processUserSpeech(text);
                        }
                    }, 800); // Wait 800ms for any trailing text
                }

                if (data.error || data.message_type === 'scribe_error') {
                    console.error('[Voice] ElevenLabs error:', data);
                    setStatus('STT error: ' + (data.error || 'unknown'));
                }
            };

            sttWS.onerror = err => {
                console.error('[Voice] ElevenLabs WS error:', err);
                reject(err);
            };

            sttWS.onclose = e => {
                console.log('[Voice] ElevenLabs closed:', e.code, e.reason);
                connected = false;
                if (e.code !== 1000) setStatus('Disconnected: ' + (e.reason || e.code));
            };
        });
    }

    // ─── PROCESS USER SPEECH THROUGH GROQ ───
    async function processUserSpeech(text) {
        if (isProcessing) return;
        isProcessing = true;

        try {
            const res = await authenticatedFetch('/chat/stream', {
                method: 'POST',
                body: JSON.stringify({
                    message: text,
                    user_id: state.userId || state.user?.email || '',
                    conversation_id: state.conversationId,
                    model_mode: 'instant',
                    ai_model: 'groq',
                    custom_instructions: state.customInstructions,
                    response_style: state.responseStyle
                })
            });

            if (!res.ok) throw new Error('Chat request failed');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullResponse = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr) continue;

                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.type === 'token') {
                            fullResponse += data.content;
                            // Don't display during streaming — wait for done
                        } else if (data.type === 'done') {
                            if (data.conversation_id && !state.conversationId) {
                                state.conversationId = data.conversation_id;
                            }
                            if (fullResponse.trim()) {
                                // Show the FULL response at once (ChatGPT-style)
                                showTranscript('ai', fullResponse);
                                setState('speaking', 'Speaking...');
                                setStatus('AI is responding...');
                                await speakText(fullResponse);
                            }
                            setState('listening', 'Listening...');
                            setStatus('Speak now');
                        } else if (data.type === 'error') {
                            throw new Error(data.content);
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                    }
                }
            }
        } catch (err) {
            console.error('[Voice] Process error:', err);
            setStatus('Error: ' + err.message);
            setState('listening', 'Listening...');
        } finally {
            isProcessing = false;
        }
    }

    // ─── TEXT-TO-SPEECH (edge-tts) ───
    async function speakText(text) {
        try {
            const res = await authenticatedFetch('/api/voice/tts-georgian', {
                method: 'POST',
                body: JSON.stringify({ text: text })
            });

            if (!res.ok) throw new Error('TTS request failed');

            const audioBlob = await res.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            return new Promise(resolve => {
                const audio = new Audio(audioUrl);
                currentAiAudio = audio;
                aiSpeaking = true;

                const cleanup = () => {
                    URL.revokeObjectURL(audioUrl);
                    if (currentAiAudio === audio) {
                        currentAiAudio = null;
                        aiSpeaking = false;
                    }
                    resolve();
                };

                audio.onended = cleanup;
                audio.onerror = cleanup;
                audio.play().catch(cleanup);
            });
        } catch (err) {
            console.error('[Voice] TTS error:', err);
            aiSpeaking = false;
            currentAiAudio = null;
        }
    }

    // ─── PUBLIC API ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;

        if (!state.conversationId) {
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
                const convRes = await fetch(`${state.apiUrl}/conversations`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ user_id: state.userId, title: 'Voice Chat' })
                });
                if (convRes.ok) {
                    const convData = await convRes.json();
                    state.conversationId = convData.id;
                    if (typeof loadConversations === 'function') loadConversations();
                }
            } catch (e) {
                console.warn('[Voice] Could not create conversation:', e);
            }
        }

        overlay.classList.remove('hidden');
        setState('idle', 'Starting...');
        setStatus('Requesting microphone...');

        try {
            const keys = await fetchKeys();
            setStatus('Connecting...');
            await startAudioCapture();
            await connectElevenLabs(keys.token);
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('idle', 'Error');
            setTimeout(close, 2500);
        }
    }

    function close() {
        if (sttWS && sttWS.readyState === WebSocket.OPEN) {
            try { sttWS.close(); } catch (e) {}
        }
        sttWS = null;
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        if (currentAiAudio) {
            try { currentAiAudio.pause(); } catch (e) {}
            currentAiAudio = null;
        }
        connected = false;
        muted = false;
        isProcessing = false;
        aiSpeaking = false;
        accumulatedFinal = '';
        clearTimeout(window._elDelay);
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