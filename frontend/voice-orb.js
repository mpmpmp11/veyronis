// ═══════════════════════════════════════════════════════
// VEYRONIS — Voice Orb controller
// Handles: drag gesture, spring return, drag-down threshold, amplitude reactivity
// ═══════════════════════════════════════════════════════

(function () {
    const OVERLAY_ID = 'voice-mode-overlay';
    const STAGE_ID = 'voice-orb-stage';
    const ORB_ID = 'voice-orb';
    const CHAT_SCROLL_ID = 'voice-chat-scroll';

    let overlay, stage, orb, chatScroll;
    let dragging = false;
    let startY = 0;
    let currentY = 0;
    let parkedAtBottom = false;
    let amplitudeRAF = null;
    let currentBoost = 1;
    let smoothAmp = 0;

    const PARK_THRESHOLD = 120; // px dragged down to trigger park
    const RETURN_THRESHOLD = 80; // px dragged up from parked to un-park

    function init() {
        overlay = document.getElementById(OVERLAY_ID);
        stage = document.getElementById(STAGE_ID);
        orb = document.getElementById(ORB_ID);
        chatScroll = document.getElementById(CHAT_SCROLL_ID);
        if (!overlay || !stage || !orb) return;

        // Pointer events (works for mouse + touch + pen)
        orb.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);

        // Watch when voice mode opens/closes
        const observer = new MutationObserver(() => {
            const isOpen = !overlay.classList.contains('hidden');
            if (isOpen) {
                startAmplitudeLoop();
                resetPosition();
            } else {
                stopAmplitudeLoop();
            }
        });
        observer.observe(overlay, { attributes: true, attributesFilter: ['class'] });

        // Chat content sync (mirror #messages whenever it changes)
        const messagesEl = document.getElementById('messages');
        if (messagesEl) {
            const chatObserver = new MutationObserver(() => syncChat());
            chatObserver.observe(messagesEl, { childList: true, subtree: true });
        }
    }

    function resetPosition() {
        parkedAtBottom = false;
        currentY = 0;
        overlay.dataset.orbPosition = 'center';
        overlay.style.removeProperty('--orb-offset-y');
    }

    function onPointerDown(e) {
        if (!orb.contains(e.target)) return;
        dragging = true;
        startY = e.clientY;
        overlay.classList.add('dragging');
        orb.setPointerCapture?.(e.pointerId);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        currentY = e.clientY - startY;
        // Prevent dragging above center
        if (currentY < 0) currentY = 0;
        overlay.style.setProperty('--orb-offset-y', `${currentY}px`);
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;
        overlay.classList.remove('dragging');

        if (!parkedAtBottom && currentY > PARK_THRESHOLD) {
            // Park at bottom
            parkedAtBottom = true;
            overlay.dataset.orbPosition = 'bottom';
            overlay.style.setProperty('--orb-offset-y', `calc(100vh - 300px)`);
            syncChat();
        } else if (parkedAtBottom && currentY < -RETURN_THRESHOLD) {
            // Return to center
            parkedAtBottom = false;
            overlay.dataset.orbPosition = 'center';
            overlay.style.removeProperty('--orb-offset-y');
        } else {
            // Snap to whichever position we're closer to
            if (parkedAtBottom) {
                overlay.style.setProperty('--orb-offset-y', `calc(100vh - 300px)`);
            } else {
                overlay.style.removeProperty('--orb-offset-y');
            }
        }
        currentY = parkedAtBottom ? PARK_THRESHOLD + 100 : 0;
    }

    function syncChat() {
        if (!chatScroll) return;
        const source = document.getElementById('messages');
        if (!source) return;
        chatScroll.innerHTML = source.innerHTML;
        chatScroll.scrollTop = chatScroll.scrollHeight;
    }

    function startAmplitudeLoop() {
        if (amplitudeRAF) return;
        const tick = () => {
            amplitudeRAF = requestAnimationFrame(tick);
            if (!overlay || overlay.classList.contains('hidden')) return;

            const amp = (typeof voiceMode !== 'undefined' && voiceMode.getAmplitude)
                ? voiceMode.getAmplitude()
                : 0;

            // Smooth it so the orb doesn't jitter
            smoothAmp = smoothAmp * 0.75 + amp * 0.25;

            // Scale boost 1.0 → 1.18 depending on amplitude
            const targetBoost = 1 + Math.min(0.18, smoothAmp * 0.5);
            currentBoost = currentBoost * 0.85 + targetBoost * 0.15;
            orb.style.setProperty('--orb-boost', currentBoost.toFixed(3));

            // Update mute visual
            overlay.classList.toggle('muted', document.getElementById('voice-mute-btn')?.classList.contains('muted'));
        };
        amplitudeRAF = requestAnimationFrame(tick);
    }

    function stopAmplitudeLoop() {
        if (amplitudeRAF) cancelAnimationFrame(amplitudeRAF);
        amplitudeRAF = null;
        smoothAmp = 0;
    }

    document.addEventListener('DOMContentLoaded', init);
})();