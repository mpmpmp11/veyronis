// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE — AssemblyAI + Groq + TTS.ai
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    let assemblyWS = null;
    let audioContext = null;
    let mediaStream = null;
    let muted = false;
    let connected = false;
    let isProcessing = false;

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

    // ─── FETCH KEYS FROM BACKEND ───
    async function fetchKeys() {
        const res = await authenticatedFetch('/api/voice/get-keys');
        if (!res.ok) throw new Error('Failed to fetch voice keys');
        return await res.json();
    }

    // ─── AUDIO CAPTURE ───
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
        const bufferSize = 4096;
        const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        processor.onaudioprocess = e => {
            if (muted || !connected || !assemblyWS || assemblyWS.readyState !== WebSocket.OPEN) return;
            const input = e.inputBuffer.getChannelData(0);
            const pcm16 = floatTo16BitPCM(input);
            const b64 = arrayBufferToBase64(pcm16.buffer);
            try {
                assemblyWS.send(JSON.stringify({ audio_data: b64 }));
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

    // ─── ASSEMBLYAI WEBSOCKET ───
    async function connectAssemblyAI(apiKey) {
        // ✅ Token in URL (browser WS can't send auth after open)
        const url = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&language_code=ka&token=${apiKey}`;
        console.log('[Voice] Connecting to AssemblyAI (Georgian)...');

        return new Promise((resolve, reject) => {
            assemblyWS = new WebSocket(url);

            assemblyWS.onopen = () => {
                console.log('[Voice] AssemblyAI WS opened');
                resolve();
            };

            assemblyWS.onmessage = event => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    return;
                }

                if (data.message_type === 'SessionBegins') {
                    console.log('[Voice] AssemblyAI session started');
                    connected = true;
                    setState('listening', 'Listening...');
                    setStatus('Speak now');
                }

                if (data.message_type === 'PartialTranscript' && data.text) {
                    showTranscript('user', data.text);
                }

                if (data.message_type === 'FinalTranscript' && data.text) {
                    const text = data.text.trim();
                    showTranscript('user', text);
                    console.log('[Voice] Final transcript:', text);
                    if (text) {
                        setState('thinking', 'Thinking...');
                        setStatus('Processing...');
                        processUserSpeech(text);
                    }
                }

                if (data.error) {
                    console.error('[Voice] AssemblyAI error:', data.error);
                    setStatus('STT error: ' + data.error);
                }
            };

            assemblyWS.onerror = err => {
                console.error('[Voice] AssemblyAI WS error:', err);
                reject(err);
            };

            assemblyWS.onclose = e => {
                console.log('[Voice] AssemblyAI closed:', e.code, e.reason);
                connected = false;
                if (e.code !== 1000) {
                    setStatus('Disconnected: ' + (e.reason || e.code));
                }
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

    // ─── TEXT-TO-SPEECH ───
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
                audio.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                    resolve();
                };
                audio.onerror = () => {
                    URL.revokeObjectURL(audioUrl);
                    resolve();
                };
                audio.play().catch(() => resolve());
            });
        } catch (err) {
            console.error('[Voice] TTS error:', err);
        }
    }

    // ─── PUBLIC API ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;

        // Create conversation if needed
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
            await connectAssemblyAI(keys.assemblyai_key);
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('idle', 'Error');
            setTimeout(close, 2500);
        }
    }

    function close() {
        if (assemblyWS && assemblyWS.readyState === WebSocket.OPEN) {
            try { assemblyWS.send(JSON.stringify({ terminate_session: true })); } catch (e) {}
            assemblyWS.close();
        }
        assemblyWS = null;
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        connected = false;
        muted = false;
        isProcessing = false;
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