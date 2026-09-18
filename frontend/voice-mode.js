// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE v3
// ElevenLabs Scribe (STT) + Groq (LLM) + Edge-TTS (TTS)
// Features: 7-state orb, live interim transcript, instant barge-in,
//           sentence-chunked TTS streaming, natural conversation flow
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    // ─── CONFIG (tweak these to taste) ───
    const CONFIG = {
        VAD_SILENCE_MS: 1200,           // how long of silence before finalizing
        BARGE_IN_VOLUME: 25,             // analyser threshold (0-255) for barge-in
        BARGE_IN_CHECK_MS: 50,           // how often to check for barge-in
        TTS_SENTENCE_MIN_LEN: 4,         // don't TTS fragments shorter than this
    };

    // ─── STATE ───
    let sttWS = null;
    let audioContext = null;
    let mediaStream = null;
    let analyser = null;
    let analyserData = null;
    let bargeInInterval = null;
    let muted = false;
    let connected = false;
    let isProcessing = false;

    let currentAiAudio = null;
    let aiSpeaking = false;

    let userInterimText = '';
    let userCommittedText = '';
    let commitTimeout = null;

    // TTS sentence queue
    let sentenceBuffer = '';
    let ttsQueue = [];
    let ttsProcessing = false;

    const $ = id => document.getElementById(id);

    // ─── ORB STATE MACHINE ───
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

    const showUserText = (text) => {
        const el = $('voice-user-text');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('visible', !!text);
    };

    const showAiText = (text) => {
        const el = $('voice-ai-text');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('visible', !!text);
    };

    // ─── FETCH SINGLE-USE ELEVENLABS TOKEN ───
    async function fetchToken() {
        const res = await authenticatedFetch('/api/voice/streaming-token');
        if (!res.ok) throw new Error('Failed to get streaming token');
        const data = await res.json();
        return data.token;
    }

    // ─── AUDIO CAPTURE + ANALYSER ───
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

        // AnalyserNode for instant barge-in detection (NOT for VAD end-of-speech)
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        analyserData = new Uint8Array(analyser.frequencyBinCount);
        source.connect(analyser);

        // Send audio chunks to ElevenLabs
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = e => {
            if (muted || !connected || !sttWS || sttWS.readyState !== WebSocket.OPEN) return;
            const input = e.inputBuffer.getChannelData(0);
            const pcm16 = floatTo16BitPCM(input);
            const b64 = arrayBufferToBase64(pcm16.buffer);
            try {
                sttWS.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: b64
                }));
            } catch (err) {}
        };
        source.connect(processor);

        // Silent gain keeps processor alive without mic feedback
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);

        // Start barge-in watcher
        startBargeInWatcher();
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

    // ─── BARGE-IN WATCHER (client-side, instant) ───
    function startBargeInWatcher() {
        if (bargeInInterval) clearInterval(bargeInInterval);
        bargeInInterval = setInterval(() => {
            if (!analyser || !aiSpeaking) return;
            analyser.getByteFrequencyData(analyserData);
            let sum = 0;
            for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
            const avg = sum / analyserData.length;
            if (avg > CONFIG.BARGE_IN_VOLUME) {
                console.log('[Voice] Barge-in (client VAD) — user interrupted');
                interruptAi();
            }
        }, CONFIG.BARGE_IN_CHECK_MS);
    }

    function interruptAi() {
        // Kill current AI audio instantly
        if (currentAiAudio) {
            try { currentAiAudio.pause(); currentAiAudio.currentTime = 0; } catch (e) {}
            currentAiAudio = null;
        }
        aiSpeaking = false;
        // Clear pending TTS queue — this response is dead
        ttsQueue = [];
        sentenceBuffer = '';
        ttsProcessing = false;
        setState('listening', 'Listening...');
        setStatus('Speak now');
    }

    // ─── ELEVENLABS STT WEBSOCKET ───
    async function connectElevenLabs(token) {
        const params = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token: token,
            audio_format: 'pcm_16000',
            language_code: 'kat',
            commit_strategy: 'vad',
            vad_silence_threshold_secs: String(CONFIG.VAD_SILENCE_MS / 1000),
            include_language_detection: 'true'
        });
        const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;

        console.log('[Voice] Connecting to ElevenLabs...');

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

                if (data.message_type === 'session_started') {
                    console.log('[Voice] Session started');
                    return;
                }

                const transcript = (data.text || '').trim();

                // ─── LIVE INTERIM TRANSCRIPT ───
                if (data.message_type === 'partial_transcript') {
                    userInterimText = transcript;
                    if (transcript) {
                        setState('transcribing', 'Transcribing...');
                        showUserText(userCommittedText + (userCommittedText && transcript ? ' ' : '') + transcript);
                    }
                    return;
                }

                // ─── FINAL CHUNK ───
                if (data.message_type === 'committed_transcript') {
                    if (transcript) {
                        userCommittedText += (userCommittedText ? ' ' : '') + transcript;
                        showUserText(userCommittedText);
                    }
                    userInterimText = '';

                    // Wait for possible additional chunks before firing LLM
                    if (commitTimeout) clearTimeout(commitTimeout);
                    commitTimeout = setTimeout(() => {
                        if (userCommittedText.trim()) {
                            const text = userCommittedText.trim();
                            userCommittedText = '';
                            console.log('[Voice] Final:', text);
                            setState('thinking', 'Thinking...');
                            setStatus('Processing...');
                            processUserSpeech(text);
                        }
                    }, 600);
                    return;
                }

                if (data.error || data.message_type === 'scribe_error') {
                    console.error('[Voice] ElevenLabs error:', data);
                    setStatus('STT error: ' + (data.error || 'unknown'));
                    setState('error', 'Error');
                }
            };

            sttWS.onerror = err => {
                console.error('[Voice] ElevenLabs WS error:', err);
                setState('error', 'Error');
                reject(err);
            };

            sttWS.onclose = e => {
                console.log('[Voice] ElevenLabs closed:', e.code, e.reason);
                connected = false;
                if (e.code !== 1000) {
                    setStatus('Disconnected: ' + (e.reason || e.code));
                    setState('error', 'Disconnected');
                }
            };
        });
    }

    // ─── PROCESS USER SPEECH → GROQ (sentence-streamed to TTS) ───
    async function processUserSpeech(text) {
        if (isProcessing) return;
        isProcessing = true;

        // Reset response state
        showAiText('');
        sentenceBuffer = '';
        ttsQueue = [];
        ttsProcessing = false;

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
                            showAiText(fullResponse);
                            // Feed token into sentence chunker → TTS
                            feedToken(data.content);
                        } else if (data.type === 'done') {
                            if (data.conversation_id && !state.conversationId) {
                                state.conversationId = data.conversation_id;
                            }
                            // Flush any remaining partial sentence
                            flushSentenceBuffer();
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
            setState('error', 'Error');
            setTimeout(() => {
                setState('listening', 'Listening...');
                setStatus('Speak now');
            }, 2000);
        } finally {
            isProcessing = false;
        }
    }

    // ─── SENTENCE CHUNKING (for low-latency TTS) ───
    function feedToken(token) {
        sentenceBuffer += token;

        // Match a sentence that ends in . ! ? or newline
        // Keep trailing quotes/brackets attached to the sentence
        const match = sentenceBuffer.match(/^([\s\S]*?[.!?]+["')\]]*[\s]*)/);
        if (match) {
            const sentence = match[1].trim();
            if (sentence.length >= CONFIG.TTS_SENTENCE_MIN_LEN) {
                enqueueTts(sentence);
            }
            sentenceBuffer = sentenceBuffer.slice(match[1].length);
        }
    }

    function flushSentenceBuffer() {
        const leftover = sentenceBuffer.trim();
        if (leftover.length >= CONFIG.TTS_SENTENCE_MIN_LEN) {
            enqueueTts(leftover);
        }
        sentenceBuffer = '';
    }

    function enqueueTts(sentence) {
        ttsQueue.push(sentence);
        if (!ttsProcessing) processTtsQueue();
    }

    async function processTtsQueue() {
        ttsProcessing = true;
        while (ttsQueue.length > 0) {
            if (!ttsProcessing) return; // interrupted
            const sentence = ttsQueue.shift();
            await speakSentence(sentence);
            if (!ttsProcessing) return;
        }
        ttsProcessing = false;
        // All audio done
        if (!aiSpeaking && connected) {
            setState('listening', 'Listening...');
            setStatus('Speak now');
        }
    }

    // ─── TTS ONE SENTENCE ───
    async function speakSentence(text) {
        try {
            const res = await authenticatedFetch('/api/voice/tts-georgian', {
                method: 'POST',
                body: JSON.stringify({ text })
            });

            if (!res.ok) throw new Error('TTS failed');

            const audioBlob = await res.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            setState('speaking', 'Speaking...');
            setStatus('AI is responding...');

            return new Promise(resolve => {
                const audio = new Audio(audioUrl);
                currentAiAudio = audio;
                aiSpeaking = true;

                const cleanup = () => {
                    URL.revokeObjectURL(audioUrl);
                    if (currentAiAudio === audio) {
                        currentAiAudio = null;
                    }
                    // aiSpeaking stays true until the whole queue drains
                    resolve();
                };

                audio.onended = cleanup;
                audio.onerror = cleanup;
                audio.play().catch(cleanup);
            });
        } catch (err) {
            console.error('[Voice] TTS error:', err);
        }
    }

    // ─── PUBLIC: OPEN ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;

        // Ensure we have a conversation to write into
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
        showUserText('');
        showAiText('');
        setState('idle', 'Starting...');
        setStatus('Requesting microphone...');

        try {
            const token = await fetchToken();
            setStatus('Connecting...');
            await startAudioCapture();
            await connectElevenLabs(token);
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('error', 'Error');
            setTimeout(close, 2500);
        }
    }

    // ─── PUBLIC: CLOSE ───
    function close() {
        // Stop watcher
        if (bargeInInterval) {
            clearInterval(bargeInInterval);
            bargeInInterval = null;
        }
        // Stop STT
        if (sttWS && sttWS.readyState === WebSocket.OPEN) {
            try { sttWS.close(); } catch (e) {}
        }
        sttWS = null;
        // Stop mic
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        analyser = null;
        analyserData = null;
        // Stop AI audio
        if (currentAiAudio) {
            try { currentAiAudio.pause(); } catch (e) {}
            currentAiAudio = null;
        }
        if (commitTimeout) {
            clearTimeout(commitTimeout);
            commitTimeout = null;
        }

        // Reset everything
        connected = false;
        muted = false;
        isProcessing = false;
        aiSpeaking = false;
        userInterimText = '';
        userCommittedText = '';
        sentenceBuffer = '';
        ttsQueue = [];
        ttsProcessing = false;

        const btn = $('voice-mute-btn');
        if (btn) btn.classList.remove('muted');
        const overlay = $('voice-mode-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    // ─── PUBLIC: MUTE ───
    function toggleMute() {
        muted = !muted;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.toggle('muted', muted);
        setStatus(muted ? 'Muted' : 'Speak now');
    }

    return { open, close, toggleMute };
})();