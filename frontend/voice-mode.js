// ═══════════════════════════════════════════════════════
// VEYRONIS VOICE MODE — WebSocket Streaming
// ═══════════════════════════════════════════════════════

const voiceMode = (() => {
    let ws = null;
    let mediaSource = null;
    let sourceBuffer = null;
    let audioElement = null;
    let isPlaying = false;
    let audioQueue = [];
    
    // Existing STT setup
    let sttWS = null;
    let audioContext = null;
    let mediaStream = null;
    let isAiSpeaking = false;
    
    const $ = id => document.getElementById(id);

    async function open() {
        const overlay = $('voice-mode-overlay');
        overlay.classList.remove('hidden');
        
        setupMediaSource();
        connectBackendWS();
        startSTT();
    }

    function close() {
        if (ws) ws.close();
        if (sttWS) sttWS.close();
        if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
        if (audioContext) audioContext.close();
        $('voice-mode-overlay').classList.add('hidden');
    }

    // --- 1. MEDIA SOURCE PLAYBACK ---
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
        
        const chunk = audioQueue.shift();
        sourceBuffer.appendBuffer(chunk);
        
        if (!isPlaying) {
            isPlaying = true;
            audioElement.play();
        }
    }

    // --- 2. BACKEND WEBSOCKET (TEXT -> TTS) ---
    function connectBackendWS() {
        const wsUrl = state.apiUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/voice';
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => console.log('[WS] Connected to Voice Backend');
        
        ws.onmessage = (event) => {
            if (event.data instanceof Blob) {
                audioQueue.push(event.data);
                processQueue();
            } else {
                const data = JSON.parse(event.data);
                if (data.type === 'start_speaking') {
                    isAiSpeaking = true;
                    setState('speaking', 'Speaking...');
                } else if (data.type === 'stop_speaking') {
                    isAiSpeaking = false;
                    setState('listening', 'Listening...');
                }
            }
        };
    }

    // --- 3. STT & BARGE-IN (BROWSER -> ELEVENLABS STT) ---
    function fireUtterance(text) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
                type: "text", 
                text: text, 
                user_id: state.userId 
            }));
        }
    }

    function interruptAi() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        
        // 1. Send interrupt to backend to kill TTS
        ws.send(JSON.stringify({ type: "INTERRUPT" }));
        
        // 2. Flush the local audio buffer instantly
        audioQueue = [];
        if (sourceBuffer && sourceBuffer.updating) {
            sourceBuffer.abort();
        }
        
        // 3. Stop the audio element
        audioElement.pause();
        audioElement.currentTime = 0;
        isPlaying = false;
        isAiSpeaking = false;
        
        setState('listening', 'Listening...');
    }

    // --- 4. STT LOGIC (Keep your existing ElevenLabs STT connection) ---
    // Note: You can keep your existing STT setup (startSTT, connectElevenLabs, etc.)
    // Just make sure that when a final transcript is ready, it calls `fireUtterance(text)`.
    // And add this barge-in check inside your audio analyser loop:
    
    function startBargeInWatcher() {
        setInterval(() => {
            if (!isAiSpeaking) return;
            // Check mic volume (replace with your actual analyser logic)
            const volume = getMicVolume(); 
            if (volume > 25) { 
                interruptAi();
            }
        }, 100);
    }

    const setState = (stateStr, label) => {
        const orb = $('voice-orb');
        if (orb) orb.className = 'voice-orb state-' + stateStr;
    };

    return { open, close, interruptAi };
})();