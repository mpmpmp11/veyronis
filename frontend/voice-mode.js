// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE v6
// - Intro audio (EN → KA → orb reveal)
// - Live call timer
// - Live AI text during streaming
// - One TTS call per response (reliable)
// - Word ticker during playback
// - Echo fix: mic muted while AI speaks + 900ms cooldown
// - Voice minute tracking (every 30s)
// - Barge-in support
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    const CONFIG = {
        VAD_SILENCE_MS: 1200,
        BARGE_IN_VOLUME: 25,
        BARGE_IN_CHECK_MS: 50,
        COMMIT_DELAY_MS: 700,
        AI_TEXT_WINDOW: 25,
        INTRO_EN_PATH: '/static/intro-en.mp3',
        INTRO_KA_PATH: '/static/intro-ka.mp3',
        ECHO_COOLDOWN_MS: 900,
        MINUTE_LOG_INTERVAL_MS: 30000,
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

    let aiFullResponse = '';

    let callStartTime = 0;
    let timerInterval = null;

    // Voice minutes tracking
    let voiceMinutesLogged = 0;
    let minuteLoggerInterval = null;

    const $ = id => document.getElementById(id);

    // ─── HELPERS ───
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
        let display = text;
        if (display.length > 400) {
            const cut = display.slice(0, 400);
            const lastPunct = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
            display = lastPunct > 0 ? cut.slice(0, lastPunct + 1) : cut + '…';
        }
        el.textContent = display;
        el.classList.toggle('visible', !!display);
    };

    // ─── CALL TIMER ───
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

    // ─── VOICE MINUTE LOGGER ───
    function startMinuteLogger() {
        voiceMinutesLogged = 0;
        if (minuteLoggerInterval) clearInterval(minuteLoggerInterval);
        minuteLoggerInterval = setInterval(async () => {
            voiceMinutesLogged += 0.5;
            try {
                const res = await authenticatedFetch('/api/voice/log-minutes', {
                    method: 'POST',
                    body: JSON.stringify({ minutes: 0.5 })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.remaining <= 0) {
                        console.log('[Voice] Minute limit reached:', data);
                        setStatus('Call limit reached. Upgrade for more.');
                        // Give the user a heads-up but don't cut the call — next log will kill it
                    }
                }
            } catch (e) {
                // Non-fatal
            }
        }, CONFIG.MINUTE_LOG_INTERVAL_MS);
    }

    function stopMinuteLogger() {
        if (minuteLoggerInterval) clearInterval(minuteLoggerInterval);
        minuteLoggerInterval = null;
        voiceMinutesLogged = 0;
    }

    // ─── INTRO AUDIO ───
    function playIntroFile(src) {
        return new Promise(resolve => {
            const audio = new Audio(src);
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            audio.onended = finish;
            audio.onerror = () => {
                console.warn('[Voice] Intro audio missing/failed:', src);
                finish();
            };
            audio.play().catch(() => finish());
            setTimeout(finish, 20000);
        });
    }

    async function playIntros() {
        setStatus('Welcome to VEYRONIS');
        console.log('[Voice] Playing English intro...');
        await playIntroFile(CONFIG.INTRO_EN_PATH);
        console.log('[Voice] Playing Georgian intro...');
        await playIntroFile(CONFIG.INTRO_KA_PATH);
        console.log('[Voice] Intros done');
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

    // ─── FETCH TOKEN ───
    async function fetchToken() {
        const res = await authenticatedFetch('/api/voice/streaming-token');
        if (!res.ok) throw new Error('Failed to get streaming token');
        const data = await res.json();
        return data.token;
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
            // Don't barge-in while we've deliberately muted the mic for AI speech
            if (muted) return;
            analyser.getByteFrequencyData(analyserData);
            let sum = 0;
            for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
            const avg = sum / analyserData.length;
            if (avg > CONFIG.BARGE_IN_VOLUME) {
                console.log('[Voice] Barge-in detected');
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

                // Skip everything if mic is muted (AI is speaking)
                if (muted) return;

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

    // ─── FIRE UTTERANCE ───
    function fireUtterance(text) {
        if (aiSpeaking) interruptAi();
        generation++;
        const myGen = generation;
        setState('thinking', 'Thinking...');
        setStatus('Processing...');
        processUserSpeech(text, myGen);
    }

    // ─── PROCESS USER SPEECH ───
    async function processUserSpeech(text, myGen) {
        isProcessing = true;

        aiFullResponse = '';
        showAiText('');

        console.log('[Voice] Sending to Groq:', text);

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
                    response_style: state.responseStyle,
                    voice_mode: true
                })
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`Chat failed ${res.status}: ${errText.slice(0, 100)}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let tokenCount = 0;

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
                            aiFullResponse += data.content;
                            tokenCount++;
                            showAiText(aiFullResponse);
                        } else if (data.type === 'done') {
                            if (data.conversation_id && !state.conversationId) {
                                state.conversationId = data.conversation_id;
                            }
                            console.log('[Voice] Stream done. Tokens:', tokenCount, 'Chars:', aiFullResponse.length);
                        } else if (data.type === 'error') {
                            throw new Error(data.content);
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                    }
                }
            }

            if (aiFullResponse.trim()) {
                await speakFullResponse(aiFullResponse, myGen);
            } else {
                setState('listening', 'Listening...');
                setStatus('Speak now');
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
                }, 3000);
            }
        } finally {
            if (generation === myGen) isProcessing = false;
        }
    }

    // ─── TTS + WORD REVEAL ───
    async function speakFullResponse(text, myGen) {
        console.log('[Voice] Requesting TTS for', text.length, 'chars');

        try {
            const res = await authenticatedFetch('/api/voice/tts-georgian', {
                method: 'POST',
                body: JSON.stringify({ text })
            });

            if (!res.ok) {
                console.warn('[Voice] TTS failed, showing text only');
                showAiText(text);
                setState('listening', 'Listening...');
                setStatus('Speak now');
                return;
            }

            const audioBlob = await res.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            await new Promise(resolve => {
                const audio = new Audio(audioUrl);
                currentAiAudio = audio;
                aiSpeaking = true;

                // ✅ ECHO FIX PART 1: mute the mic while AI is speaking
                muted = true;

                setState('speaking', 'Speaking...');
                setStatus('AI is responding...');

                const words = text.split(/\s+/).filter(Boolean);
                let lastRevealed = -1;
                let tickerRunning = true;

                const tick = () => {
                    if (!tickerRunning) return;
                    if (audio.duration && audio.duration > 0 && isFinite(audio.duration)) {
                        const progress = audio.currentTime / audio.duration;
                        const target = Math.min(
                            Math.floor(progress * words.length) + 1,
                            words.length
                        );
                        if (target !== lastRevealed) {
                            lastRevealed = target;
                            const start = Math.max(0, target - CONFIG.AI_TEXT_WINDOW);
                            const window = words.slice(start, target).join(' ');
                            const prefix = start > 0 ? '… ' : '';
                            showAiText(prefix + window);
                        }
                    }
                    if (!audio.ended) requestAnimationFrame(tick);
                };

                audio.addEventListener('play', () => {
                    requestAnimationFrame(tick);
                });

                const finish = () => {
                    tickerRunning = false;
                    URL.revokeObjectURL(audioUrl);
                    if (currentAiAudio === audio) currentAiAudio = null;
                    aiSpeaking = false;
                    showAiText(text);

                    // ✅ ECHO FIX PART 2: cooldown before unmuting
                    setTimeout(() => {
                        if (generation === myGen) {
                            muted = false;
                        }
                    }, CONFIG.ECHO_COOLDOWN_MS);

                    resolve();
                };

                audio.addEventListener('ended', finish);
                audio.addEventListener('error', () => {
                    console.warn('[Voice] Audio error');
                    finish();
                });

                audio.play().catch(err => {
                    console.error('[Voice] Play failed:', err);
                    finish();
                });
            });

            if (generation === myGen) {
                setState('listening', 'Listening...');
                setStatus('Speak now');
            }
        } catch (err) {
            console.error('[Voice] TTS exception:', err);
            showAiText(text);
            muted = false;
            setState('listening', 'Listening...');
            setStatus('Speak now');
        }
    }

    // ─── OPEN ───
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

        showUserText('');
        showAiText('');
        overlay.classList.remove('hidden');
        hideOrb();
        setState('idle', 'Starting...');
        setStatus('Welcome to VEYRONIS');

        try {
            await playIntros();
            console.log('[Voice] Intros complete, revealing orb');

            showOrb();
            startTimer();
            startMinuteLogger();
            setStatus('Connecting...');

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
        stopMinuteLogger();

        connected = false;
        muted = false;
        isProcessing = false;
        aiSpeaking = false;
        userInterimText = '';
        userCommittedText = '';
        aiFullResponse = '';
        generation++;

        const btn = $('voice-mute-btn');
        if (btn) btn.classList.remove('muted');
        const overlay = $('voice-mode-overlay');
        if (overlay) overlay.classList.add('hidden');
        showOrb();
    }

    function toggleMute() {
        muted = !muted;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.toggle('muted', muted);
        setStatus(muted ? 'Muted' : 'Speak now');
    }

    return { open, close, toggleMute };
})();