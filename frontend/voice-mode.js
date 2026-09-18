// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE v4
// - Live word-by-word AI transcript (synced to audio)
// - Intro audio sequence (en → ka → orb)
// - Live call timer
// - Generation counter for reliable barge-in
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    const CONFIG = {
        VAD_SILENCE_MS: 1200,
        BARGE_IN_VOLUME: 25,
        BARGE_IN_CHECK_MS: 50,
        COMMIT_DELAY_MS: 700,
        TTS_SENTENCE_MIN_LEN: 4,
        AI_TEXT_WINDOW: 30,          // how many recent words to show
        INTRO_EN_PATH: '/static/intro-en.mp3',
        INTRO_KA_PATH: '/static/intro-ka.mp3',
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
    let generation = 0;

    let currentAiAudio = null;
    let aiSpeaking = false;

    let userInterimText = '';
    let userCommittedText = '';
    let commitTimeout = null;

    // TTS queue (sentence-chunked)
    let sentenceBuffer = '';
    let ttsQueue = [];
    let ttsProcessing = false;

    // Live AI word reveal
    let aiFullRevealedText = '';
    let currentSentenceWords = [];
    let currentSentenceRevealed = 0;

    // Timer
    let callStartTime = 0;
    let timerInterval = null;

    const $ = id => document.getElementById(id);

    // ─── STATE MACHINE ───
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

    // ─── TIMER ───
    function ensureTimerElement() {
        let el = document.getElementById('voice-timer');
        if (!el) {
            const overlay = $('voice-mode-overlay');
            if (!overlay) return null;
            el = document.createElement('div');
            el.id = 'voice-timer';
            el.className = 'voice-timer';
            el.textContent = '00:00';
            overlay.appendChild(el);
        }
        return el;
    }

    function startTimer() {
        const el = ensureTimerElement();
        if (!el) return;
        callStartTime = Date.now();
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            el.textContent = `${m}:${s}`;
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
    }

    // ─── INTRO SEQUENCE ───
    function playIntroFile(src) {
        return new Promise(resolve => {
            const audio = new Audio(src);
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            audio.onended = finish;
            audio.onerror = () => {
                console.warn('[Voice] Intro audio failed or missing:', src);
                finish();
            };
            audio.play().catch(() => finish());
            // Safety timeout in case the file is huge or broken
            setTimeout(finish, 15000);
        });
    }

    async function playIntros() {
        setStatus('Welcome to VEYRONIS');
        await playIntroFile(CONFIG.INTRO_EN_PATH);
        await playIntroFile(CONFIG.INTRO_KA_PATH);
    }

    // ─── ORB REVEAL ───
    function showOrb() {
        const wrap = document.querySelector('.voice-orb-wrap');
        if (wrap) {
            wrap.classList.remove('intro-hidden');
            wrap.classList.add('intro-visible');
        }
    }

    function hideOrb() {
        const wrap = document.querySelector('.voice-orb-wrap');
        if (wrap) {
            wrap.classList.remove('intro-visible');
            wrap.classList.add('intro-hidden');
        }
    }

    // ─── FETCH ELEVENLABS TOKEN ───
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

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        analyserData = new Uint8Array(analyser.frequencyBinCount);
        source.connect(analyser);

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

        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);

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

    // ─── BARGE-IN WATCHER ───
    function startBargeInWatcher() {
        if (bargeInInterval) clearInterval(bargeInInterval);
        bargeInInterval = setInterval(() => {
            if (!analyser || !aiSpeaking) return;
            analyser.getByteFrequencyData(analyserData);
            let sum = 0;
            for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
            const avg = sum / analyserData.length;
            if (avg > CONFIG.BARGE_IN_VOLUME) {
                console.log('[Voice] Barge-in (client VAD)');
                interruptAi();
            }
        }, CONFIG.BARGE_IN_CHECK_MS);
    }

    function interruptAi() {
        if (currentAiAudio) {
            try { currentAiAudio.pause(); currentAiAudio.currentTime = 0; } catch (e) {}
            currentAiAudio = null;
        }
        aiSpeaking = false;
        ttsQueue = [];
        sentenceBuffer = '';
        ttsProcessing = false;
        currentSentenceWords = [];
        currentSentenceRevealed = 0;
        setState('listening', 'Listening...');
        setStatus('Speak now');
    }

    // ─── ELEVENLABS STT ───
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

                if (data.message_type === 'partial_transcript') {
                    userInterimText = transcript;
                    if (transcript) {
                        setState('transcribing', 'Transcribing...');
                        showUserText(userCommittedText + (userCommittedText && transcript ? ' ' : '') + transcript);
                    }
                    return;
                }

                if (data.message_type === 'committed_transcript') {
                    if (transcript) {
                        userCommittedText += (userCommittedText ? ' ' : '') + transcript;
                        showUserText(userCommittedText);
                    }
                    userInterimText = '';

                    if (commitTimeout) clearTimeout(commitTimeout);
                    commitTimeout = setTimeout(() => {
                        const text = userCommittedText.trim();
                        if (text) {
                            userCommittedText = '';
                            console.log('[Voice] Final:', text);
                            fireUtterance(text);
                        }
                    }, CONFIG.COMMIT_DELAY_MS);
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

    // ─── UTTERANCE DISPATCH (with generation guard) ───
    function fireUtterance(text) {
        // Interrupt whatever's happening
        if (aiSpeaking) interruptAi();
        // Bump generation so any in-flight response is abandoned
        generation++;
        const myGen = generation;
        setState('thinking', 'Thinking...');
        setStatus('Processing...');
        processUserSpeech(text, myGen);
    }

    // ─── PROCESS USER SPEECH → GROQ ───
    async function processUserSpeech(text, myGen) {
        isProcessing = true;

        // Fresh response state
        showAiText('');
        aiFullRevealedText = '';
        sentenceBuffer = '';
        ttsQueue = [];
        ttsProcessing = false;
        currentSentenceWords = [];
        currentSentenceRevealed = 0;

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

            while (true) {
                if (generation !== myGen) {
                    try { reader.cancel(); } catch (e) {}
                    return;
                }

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
                            feedToken(data.content);
                        } else if (data.type === 'done') {
                            if (data.conversation_id && !state.conversationId) {
                                state.conversationId = data.conversation_id;
                            }
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
            if (generation === myGen) {
                console.error('[Voice] Process error:', err);
                setStatus('Error: ' + err.message);
                setState('error', 'Error');
                setTimeout(() => {
                    if (generation === myGen) {
                        setState('listening', 'Listening...');
                        setStatus('Speak now');
                    }
                }, 2000);
            }
        } finally {
            if (generation === myGen) isProcessing = false;
        }
    }

    // ─── SENTENCE CHUNKING ───
    function feedToken(token) {
        sentenceBuffer += token;
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
            if (!ttsProcessing) return;
            const sentence = ttsQueue.shift();
            await speakSentence(sentence);
            if (!ttsProcessing) return;
        }
        ttsProcessing = false;
        if (!aiSpeaking && connected) {
            setState('listening', 'Listening...');
            setStatus('Speak now');
        }
    }

    // ─── TTS + LIVE WORD REVEAL ───
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

                // Setup word reveal for this sentence
                currentSentenceWords = text.split(/\s+/).filter(Boolean);
                currentSentenceRevealed = 0;

                const revealNext = () => {
                    if (currentSentenceRevealed < currentSentenceWords.length) {
                        aiFullRevealedText += (aiFullRevealedText ? ' ' : '') + currentSentenceWords[currentSentenceRevealed];
                        currentSentenceRevealed++;
                        renderRollingAiText();
                    }
                };

                // Sync word reveal to audio progress
                audio.addEventListener('timeupdate', () => {
                    if (!audio.duration || audio.duration === 0) return;
                    const progress = audio.currentTime / audio.duration;
                    const target = Math.floor(progress * currentSentenceWords.length);
                    while (currentSentenceRevealed < target && currentSentenceRevealed < currentSentenceWords.length) {
                        revealNext();
                    }
                });

                const cleanup = () => {
                    // Force reveal any remaining words
                    while (currentSentenceRevealed < currentSentenceWords.length) {
                        revealNext();
                    }
                    URL.revokeObjectURL(audioUrl);
                    if (currentAiAudio === audio) currentAiAudio = null;
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

    function renderRollingAiText() {
        const words = aiFullRevealedText.split(/\s+/).filter(Boolean);
        const MAX = CONFIG.AI_TEXT_WINDOW;
        const display = words.length > MAX
            ? '… ' + words.slice(-MAX).join(' ')
            : words.join(' ');
        showAiText(display);
    }

    // ─── OPEN ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;

        // Ensure conversation
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

        // Reset display
        showUserText('');
        showAiText('');
        overlay.classList.remove('hidden');
        hideOrb();
        setState('idle', 'Starting...');

        try {
            // Phase 1: intros
            await playIntros();

            // Phase 2: reveal orb + timer
            showOrb();
            startTimer();
            setStatus('Connecting...');

            // Phase 3: connect
            const token = await fetchToken();
            await startAudioCapture();
            await connectElevenLabs(token);
        } catch (err) {
            console.error('[Voice] Open failed:', err);
            setStatus('Failed: ' + err.message);
            setState('error', 'Error');
            setTimeout(close, 2500);
        }
    }

    // ─── CLOSE ───
    function close() {
        if (bargeInInterval) {
            clearInterval(bargeInInterval);
            bargeInInterval = null;
        }
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
        analyser = null;
        analyserData = null;
        if (currentAiAudio) {
            try { currentAiAudio.pause(); } catch (e) {}
            currentAiAudio = null;
        }
        if (commitTimeout) {
            clearTimeout(commitTimeout);
            commitTimeout = null;
        }
        stopTimer();

        connected = false;
        muted = false;
        isProcessing = false;
        aiSpeaking = false;
        userInterimText = '';
        userCommittedText = '';
        sentenceBuffer = '';
        ttsQueue = [];
        ttsProcessing = false;
        aiFullRevealedText = '';
        currentSentenceWords = [];
        currentSentenceRevealed = 0;
        generation++;

        const btn = $('voice-mute-btn');
        if (btn) btn.classList.remove('muted');
        const overlay = $('voice-mode-overlay');
        if (overlay) overlay.classList.add('hidden');
        showOrb(); // reset for next open
    }

    function toggleMute() {
        muted = !muted;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.toggle('muted', muted);
        setStatus(muted ? 'Muted' : 'Speak now');
    }


    

    return { open, close, toggleMute };
})();