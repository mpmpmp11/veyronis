// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE — Deepgram + Groq + Edge-TTS
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

    async function fetchKeys() {
        const res = await authenticatedFetch('/api/voice/streaming-token');
        if (!res.ok) throw new Error('Failed to get streaming token');
        const data = await res.json();
        return { deepgram_key: data.token };
    }

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
            try { sttWS.send(pcm16.buffer); } catch (err) {}
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

    async function connectDeepgram(apiKey) {
        const url = `wss://api.deepgram.com/v1/listen?` +
            `model=nova-3` +
            `&language=ka` +
            `&encoding=linear16` +
            `&sample_rate=16000` +
            `&interim_results=true` +
            `&smart_format=true` +
            `&punctuate=true` +
            `&endpointing=2500` +
            `&utterance_end_ms=2500` +
            `&vad_events=true`;

        console.log('[Voice] Connecting to Deepgram...');

        return new Promise((resolve, reject) => {
            sttWS = new WebSocket(url, ['token', apiKey]);

            sttWS.onopen = () => {
                console.log('[Voice] Deepgram WS opened');
                connected = true;
                setState('listening', 'Listening...');
                setStatus('Speak now');
                resolve();
            };

            sttWS.onmessage = event => {
                let data;
                try { data = JSON.parse(event.data); } catch (e) { return; }

                if (data.type === 'SpeechStarted') {
                    setStatus('Listening...');
                    return;
                }

                if (data.type === 'UtteranceEnd') {
                    if (accumulatedFinal.trim()) {
                        const text = accumulatedFinal.trim();
                        accumulatedFinal = '';
                        console.log('[Voice] UtteranceEnd:', text);
                        showTranscript('user', text);
                        setState('thinking', 'Thinking...');
                        setStatus('Processing...');
                        processUserSpeech(text);
                    }
                    return;
                }

                const alt = data.channel?.alternatives?.[0];
                const transcript = alt?.transcript?.trim() || "";
                const isFinal = data.is_final;
                const speechFinal = data.speech_final;

                // Barge-in: user starts talking while AI is speaking
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

                if (!transcript) return;

                if (isFinal) {
                    accumulatedFinal += (accumulatedFinal ? ' ' : '') + transcript;
                    showTranscript('user', accumulatedFinal);

                    if (speechFinal && accumulatedFinal.trim()) {
                        const text = accumulatedFinal.trim();
                        accumulatedFinal = '';
                        console.log('[Voice] Final:', text);
                        setState('thinking', 'Thinking...');
                        setStatus('Processing...');
                        processUserSpeech(text);
                    }
                } else {
                    showTranscript('user', accumulatedFinal + (accumulatedFinal ? ' ' : '') + transcript);
                }
            };

            sttWS.onerror = err => {
                console.error('[Voice] Deepgram error:', err);
                reject(err);
            };

            sttWS.onclose = e => {
                console.log('[Voice] Deepgram closed:', e.code, e.reason);
                connected = false;
                if (e.code !== 1000) setStatus('Disconnected: ' + (e.reason || e.code));
            };
        });
    }

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
                            showTranscript('ai', fullResponse);
                        } else if (data.type === 'done') {
                            if (data.conversation_id && !state.conversationId) {
                                state.conversationId = data.conversation_id;
                            }
                            if (fullResponse.trim()) {
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
            await connectDeepgram(keys.deepgram_key);
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('idle', 'Error');
            setTimeout(close, 2500);
        }
    }

    function close() {
        if (sttWS && sttWS.readyState === WebSocket.OPEN) {
            try { sttWS.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
            sttWS.close();
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