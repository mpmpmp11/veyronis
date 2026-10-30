// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE v8 — WebSocket Streaming + Full UI
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    const CONFIG = {
        VAD_SILENCE_MS: 1200,
        BARGE_IN_VOLUME: 25,
        BARGE_IN_CHECK_MS: 50,
        COMMIT_DELAY_MS: 700,
        ECHO_COOLDOWN_MS: 900,
        MINUTE_LOG_INTERVAL_MS: 30000,
        INTERRUPT_BTN_DELAY_MS: 1500,
    };

    // ─── STATE ───
    let sttWS = null;
    let backendWS = null;
    let audioContext = null;
    let mediaStream = null;
    let analyser = null;
    let analyserData = null;
    let bargeInInterval = null;
    let muted = false;
    let connected = false;
    
    // Audio buffer for MediaSource
    let mediaSource = null;
    let sourceBuffer = null;
    let audioElement = null;
    let isPlaying = false;
    let audioQueue = [];
    
    let userCommittedText = '';
    let commitTimeout = null;

    let callStartTime = 0;
    let timerInterval = null;

    let voiceMinutesLogged = 0;
    let minuteLoggerInterval = null;
    let interruptBtnTimeout = null;

    const $ = id => document.getElementById(id);

    // ─── UI HELPERS ───
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

    // ─── INTERRUPT BUTTON ───
    function showInterruptButton() {
        if (interruptBtnTimeout) clearTimeout(interruptBtnTimeout);
        interruptBtnTimeout = setTimeout(() => {
            const btn = $('voice-interrupt-btn');
            if (btn) btn.classList.add('visible');
        }, CONFIG.INTERRUPT_BTN_DELAY_MS);
    }

    function hideInterruptButton() {
        if (interruptBtnTimeout) clearTimeout(interruptBtnTimeout);
        const btn = $('voice-interrupt-btn');
        if (btn) btn.classList.remove('visible');
    }

    function onInterruptTap() {
        console.log('[Voice] Interrupt tapped');
        interruptAi();
        hideInterruptButton();
        setStatus('Speak now');
        setState('listening', 'Listening...');
    }

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
                        setStatus('Call limit reached. Upgrade for more.');
                    }
                }
            } catch (e) {}
        }, CONFIG.MINUTE_LOG_INTERVAL_MS);
    }

    function stopMinuteLogger() {
        if (minuteLoggerInterval) clearInterval(minuteLoggerInterval);
        minuteLoggerInterval = null;
        voiceMinutesLogged = 0;
    }

    // ─── ORB REVEAL ───
    function showOrb() {
        const wrap = document.querySelector('.voice-orb-wrap');
        if (wrap) {
            wrap.classList.remove('intro-hidden');
            wrap.classList.add('intro-visible');
        }
    }

    // ─── MEDIA SOURCE PLAYBACK ───
    function setupMediaSource() {
        audioElement = new Audio();
        mediaSource = new MediaSource();
        audioElement.src = URL.createObjectURL(mediaSource);
        
        mediaSource.addEventListener('sourceopen', () => {
            sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
            sourceBuffer.addEventListener('updateend', processQueue);
        });
    }

    function processQueue() {
        if (!sourceBuffer || sourceBuffer.updating || audioQueue.length === 0) return;
        sourceBuffer.appendBuffer(audioQueue.shift());
        if (!isPlaying) {
            isPlaying = true;
            audioElement.play().catch(e => console.log('Play err:', e));
        }
    }

    // ─── WEBSOCKET BACKEND (AI -> TTS) ───
    function connectBackendWS() {
        const wsUrl = state.apiUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/voice';
        backendWS = new WebSocket(wsUrl);
        
        backendWS.onopen = () => console.log('[WS] Connected to Voice Backend');
        
        backendWS.onmessage = (event) => {
            if (event.data instanceof Blob) {
                audioQueue.push(event.data);
                processQueue();
            } else {
                const data = JSON.parse(event.data);
                if (data.type === 'start_speaking') {
                    setState('speaking', 'Speaking...');
                    // ECHO FIX: mute mic while AI speaks
                    muted = true;
                    showInterruptButton();
                } else if (data.type === 'stop_speaking') {
                    setState('listening', 'Listening...');
                    if (data.text) showAiText(data.text);
                    hideInterruptButton();
                    
                    // ECHO FIX: cooldown before unmuting
                    setTimeout(() => { muted = false; }, CONFIG.ECHO_COOLDOWN_MS);
                }
            }
        };
    }

    // ─── AUDIO CAPTURE & BARGE-IN ───
    async function startAudioCapture() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
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
                sttWS.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64 }));
            } catch (err) {}
        };
        source.connect(processor);

        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);

        startBargeInWatcher();
    }

    function startBargeInWatcher() {
        if (bargeInInterval) clearInterval(bargeInInterval);
        bargeInInterval = setInterval(() => {
            // If AI is speaking, check if user is talking to interrupt
            if (!analyser || !isPlaying) return;
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
        if (!backendWS || backendWS.readyState !== WebSocket.OPEN) return;
        backendWS.send(JSON.stringify({ type: "INTERRUPT" }));
        
        audioQueue = [];
        if (sourceBuffer && sourceBuffer.updating) sourceBuffer.abort();
        audioElement.pause();
        audioElement.currentTime = 0;
        isPlaying = false;
        
        hideInterruptButton();
        setState('listening', 'Listening...');
        setStatus('Speak now');
    }

    // ─── ELEVENLABS STT ───
    async function fetchToken() {
        const res = await authenticatedFetch('/api/voice/streaming-token');
        if (!res.ok) throw new Error('Failed to get streaming token');
        const data = await res.json();
        return data.token;
    }

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

        return new Promise((resolve, reject) => {
            sttWS = new WebSocket(url);

            sttWS.onopen = () => {
                connected = true;
                setState('listening', 'Listening...');
                setStatus('Speak now');
                resolve();
            };

            sttWS.onmessage = event => {
                let data;
                try { data = JSON.parse(event.data); } catch (e) { return; }
                if (data.message_type === 'session_started') return;

                const transcript = (data.text || '').trim();
                if (muted) return;

                if (data.message_type === 'partial_transcript') {
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
                    if (commitTimeout) clearTimeout(commitTimeout);
                    commitTimeout = setTimeout(() => {
                        const text = userCommittedText.trim();
                        if (text) {
                            userCommittedText = '';
                            fireUtterance(text);
                        }
                    }, CONFIG.COMMIT_DELAY_MS);
                    return;
                }
            };
            sttWS.onerror = err => { setState('error', 'Error'); reject(err); };
        });
    }

    // ─── FIRE UTTERANCE TO BACKEND ───
    function fireUtterance(text) {
        if (isPlaying) interruptAi(); // Stop AI if it's speaking
        hideInterruptButton();
        
        if (backendWS && backendWS.readyState === WebSocket.OPEN) {
            setState('thinking', 'Thinking...');
            setStatus('Processing...');
            backendWS.send(JSON.stringify({ 
                type: "text", 
                text: text, 
                user_id: state.userId || state.user?.email || '',
                conversation_id: state.conversationId 
            }));
        }
    }

    // ─── OPEN ───
    async function open() {
        const overlay = $('voice-mode-overlay');
        if (!overlay) return;

        overlay.classList.remove('hidden');
        overlay.dataset.orbPosition = 'center';
        overlay.style.removeProperty('--orb-offset-y');

        showUserText('');
        showAiText('');
        hideInterruptButton();
        setState('idle', 'Starting...');
        setStatus('Welcome to VEYRONIS');
        
        startTimer();
        startMinuteLogger();
        setupMediaSource();
        connectBackendWS();

        try {
            setStatus('Connecting...');
            const token = await fetchToken();
            setStatus('Requesting microphone...');
            await startAudioCapture();
            setStatus('Connecting to speech engine...');
            await connectElevenLabs(token);
            console.log('[Voice] Session fully online');
        } catch (err) {
            setStatus('Failed: ' + (err?.message || 'Unknown'));
            setState('error', 'Error');
        }
    }

    // ─── CLOSE ───
    function close() {
        if (bargeInInterval) clearInterval(bargeInInterval);
        if (sttWS && sttWS.readyState === WebSocket.OPEN) sttWS.close();
        if (backendWS && backendWS.readyState === WebSocket.OPEN) backendWS.close();
        
        if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
        if (audioContext) audioContext.close();
        if (commitTimeout) clearTimeout(commitTimeout);
        
        stopTimer();
        stopMinuteLogger();
        hideInterruptButton();
        
        audioQueue = [];
        if (audioElement) audioElement.pause();
        isPlaying = false;
        muted = false;
        
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.remove('muted');
        
        $('voice-mode-overlay').classList.add('hidden');
        showOrb();
    }

    function toggleMute() {
        muted = !muted;
        const btn = $('voice-mute-btn');
        if (btn) btn.classList.toggle('muted', muted);
        setStatus(muted ? 'Muted' : 'Speak now');
    }

    // ─── ORB AMPLITUDE (Used by voice-orb.js) ───
    function getAmplitude() {
        if (!analyser || !analyserData) return 0;
        analyser.getByteFrequencyData(analyserData);
        let sum = 0;
        for (let i = 0; i < analyserData.length; i++) sum += analyserData[i];
        return Math.min(1, (sum / analyserData.length) / 100);
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
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    return { open, close, toggleMute, onInterrupt: onInterruptTap, getAmplitude };
})();