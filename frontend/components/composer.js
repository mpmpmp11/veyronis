/* ═══════════════════════════════════════════════════════
   COMPOSER — 3-state input bar
   Handles: drag-drop (State 2), inline voice recording (State 3),
   dynamic send button (call / send / stop)
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const composer = document.getElementById('composer');
  if (!composer) {
    console.warn('[composer] #composer not found — module skipped');
    return;
  }

  // ─── STATE MANAGER ───
  function setState(name) {
    composer.dataset.state = name;
    // Notify other modules
    window.dispatchEvent(new CustomEvent('composer:state', { detail: { state: name } }));
  }
  function getState() { return composer.dataset.state || 'default'; }

  // ─── DRAG-DROP (State 2) ───
  let dragDepth = 0;

  function isFileDrag(e) {
    if (!e.dataTransfer) return false;
    const types = Array.from(e.dataTransfer.types || []);
    return types.includes('Files');
  }

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (getState() === 'default') setState('drop');
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && getState() === 'drop') setState('default');
  });

  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (getState() === 'drop') setState('default');

    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;

    // Route to existing upload handlers if they exist
    if (typeof handleFileDrop === 'function') {
      try { handleFileDrop(file); return; } catch (_) {}
    }
    // Fallback: synthesize an <input type=file> event
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.createElement('input');
    input.type = 'file';
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // ─── RECORDING (State 3) ───
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const composerRecording = {
  recognition: null,
  transcript: '',
  startedAt: 0,
  pausedAt: 0,
  totalPaused: 0,
  timerId: null,
  isPaused: false,

  isSupported() { return !!SpeechRecognition; },

  start() {
    if (!this.isSupported()) {
      if (typeof showToast === 'function') {
        showToast('Voice recording not supported in this browser. Try Chrome or Edge.');
      } else {
        alert('Voice recording needs Chrome or Edge.');
      }
      return;
    }

    this.transcript = '';
    this.startedAt = Date.now();
    this.pausedAt = 0;
    this.totalPaused = 0;
    this.isPaused = false;

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (e) => {
      if (this.isPaused) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          this.transcript += e.results[i][0].transcript + ' ';
        }
      }
    };

    rec.onerror = (e) => {
      console.warn('[composer] speech error:', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.cancel();
      }
    };

    rec.onend = () => {
      if (composer.dataset.state === 'recording' && this.recognition) {
        try { rec.start(); } catch (_) {}
      }
    };

    try { rec.start(); } catch (err) {
      console.warn('[composer] start failed:', err);
      return;
    }
    this.recognition = rec;

    const timer = document.getElementById('rec-timer');
    const dot = document.getElementById('rec-dot');
    const hint = document.querySelector('.composer__rec-hint');
    if (timer) timer.textContent = '0:00';
    if (dot) dot.classList.remove('is-paused');
    if (hint) hint.textContent = 'Go ahead, record a quick note';

    this.tick();
    this.timerId = setInterval(() => this.tick(), 1000);
    setState('recording');
  },

  tick() {
    if (this.isPaused) return;
    const elapsed = Math.floor((Date.now() - this.startedAt - this.totalPaused) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const timer = document.getElementById('rec-timer');
    if (timer) timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  },

  togglePause() {
    this.isPaused = !this.isPaused;
    const dot = document.getElementById('rec-dot');
    const pauseBtn = document.getElementById('rec-pause');
    const hint = document.querySelector('.composer__rec-hint');

    if (this.isPaused) {
      this.pausedAt = Date.now();
      if (dot) dot.classList.add('is-paused');
      if (pauseBtn) {
        pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        pauseBtn.title = 'Resume';
      }
      if (hint) hint.textContent = 'Paused — tap play to continue';
    } else {
      if (this.pausedAt) {
        this.totalPaused += Date.now() - this.pausedAt;
        this.pausedAt = 0;
      }
      if (dot) dot.classList.remove('is-paused');
      if (pauseBtn) {
        pauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        pauseBtn.title = 'Pause';
      }
      if (hint) hint.textContent = 'Go ahead, record a quick note';
    }
  },

  confirm() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
      this.recognition = null;
    }
    clearInterval(this.timerId);
    this.timerId = null;

    const text = this.transcript.trim();
    setState('default');

    if (text) {
      const ta = document.getElementById('msg-input');
      if (ta) {
        ta.value = (ta.value ? ta.value + ' ' : '') + text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      }
    } else {
      if (typeof showToast === 'function') showToast('No speech detected.');
    }
  },

  cancel() {
    if (this.recognition) {
      try { this.recognition.abort(); } catch (_) {}
      this.recognition = null;
    }
    clearInterval(this.timerId);
    this.timerId = null;
    this.transcript = '';
    this.isPaused = false;
    setState('default');
  }
};

  window.composerRecording = composerRecording;

  // ─── DYNAMIC SEND BUTTON ───
  // Keep sendMessage() from app.js. Only swap the icon based on state.
  function updateSendIcon() {
    const btn = document.getElementById('send-btn');
    const ta = document.getElementById('msg-input');
    if (!btn) return;

    const hasText = ta && ta.value.trim().length > 0;

    if (hasText) {
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
      btn.title = 'Send';
    } else {
      // Default: call waveform icon
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
      btn.title = 'Start voice call';
    }
  }

  const ta = document.getElementById('msg-input');
  if (ta) {
    ta.addEventListener('input', () => {
      updateSendIcon();
      // Auto-expand
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    });
    // Initial
    updateSendIcon();
  }

  // ─── ESCAPE: exit drop state ───
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getState() !== 'default') {
      if (getState() === 'recording') composerRecording.cancel();
      else setState('default');
    }
  });

  console.log('[composer] ready — 3-state input bar loaded');
})();