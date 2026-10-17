// ═══════════════════════════════════════════════════════
// VEYRONIS — Voice Orb controller (2D Drag + Texture)
// ═══════════════════════════════════════════════════════

(function () {
    const OVERLAY_ID = 'voice-mode-overlay';
    const STAGE_ID = 'voice-orb-stage';
    const ORB_ID = 'voice-orb';

    let overlay, stage, orb;
    let dragging = false;
    let startX = 0, startY = 0;
    let currentX = 0, currentY = 0;
    let parkedAtBottom = false;
    let amplitudeRAF = null;
    let currentBoost = 1;
    let smoothAmp = 0;

    const PARK_THRESHOLD = 120; 

    function init() {
        overlay = document.getElementById(OVERLAY_ID);
        stage = document.getElementById(STAGE_ID);
        orb = document.getElementById(ORB_ID);
        if (!overlay || !stage || !orb) return;

        orb.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);

        let lastIsOpen = !overlay.classList.contains('hidden');
        const observer = new MutationObserver(() => {
            const isOpen = !overlay.classList.contains('hidden');
            if (isOpen === lastIsOpen) return;
            lastIsOpen = isOpen;
            if (isOpen) {
                startAmplitudeLoop();
                resetPosition();
            } else {
                stopAmplitudeLoop();
            }
        });
        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    function resetPosition() {
        parkedAtBottom = false;
        currentX = 0; 
        currentY = 0;
        overlay.dataset.orbPosition = 'center';
        overlay.style.setProperty('--orb-offset-x', `0px`);
        overlay.style.setProperty('--orb-offset-y', `0px`);
    }

    function onPointerDown(e) {
        if (!orb.contains(e.target)) return;
        dragging = true;
        startX = e.clientX - currentX;
        startY = e.clientY - currentY;
        overlay.classList.add('dragging');
        orb.setPointerCapture?.(e.pointerId);
    }

    function onPointerMove(e) {
        if (!dragging) return;
        currentX = e.clientX - startX;
        currentY = e.clientY - startY;

        // Prevent dragging too far up
        if (currentY < -50) currentY = -50;

        overlay.style.setProperty('--orb-offset-x', `${currentX}px`);
        overlay.style.setProperty('--orb-offset-y', `${currentY}px`);
    }

    function onPointerUp() {
        if (!dragging) return;
        dragging = false;
        overlay.classList.remove('dragging');

        // Check if we dragged down enough to park
        if (!parkedAtBottom && currentY > PARK_THRESHOLD) {
            parkedAtBottom = true;
            overlay.dataset.orbPosition = 'bottom';
            // Smoothly snap to bottom center
            currentX = 0; 
            currentY = window.innerHeight * 0.35; // approximate park height
            overlay.style.setProperty('--orb-offset-x', `0px`);
            overlay.style.setProperty('--orb-offset-y', `${currentY}px`);
        } 
        // Check if we dragged up enough to unpark
        else if (parkedAtBottom && currentY < (window.innerHeight * 0.35) - 80) {
            parkedAtBottom = false;
            overlay.dataset.orbPosition = 'center';
            currentX = 0;
            currentY = 0;
            overlay.style.setProperty('--orb-offset-x', `0px`);
            overlay.style.setProperty('--orb-offset-y', `0px`);
        } 
        // Otherwise, spring back to nearest state
        else {
            if (!parkedAtBottom) {
                currentX = 0;
                currentY = 0;
                overlay.style.setProperty('--orb-offset-x', `0px`);
                overlay.style.setProperty('--orb-offset-y', `0px`);
            } else {
                currentX = 0;
                currentY = window.innerHeight * 0.35;
                overlay.style.setProperty('--orb-offset-x', `0px`);
                overlay.style.setProperty('--orb-offset-y', `${currentY}px`);
            }
        }
    }

    function startAmplitudeLoop() {
        if (amplitudeRAF) return;
        const tick = () => {
            amplitudeRAF = requestAnimationFrame(tick);
            if (!overlay || overlay.classList.contains('hidden')) return;

            const amp = (typeof voiceMode !== 'undefined' && voiceMode.getAmplitude) ? voiceMode.getAmplitude() : 0;
            smoothAmp = smoothAmp * 0.75 + amp * 0.25;
            const targetBoost = 1 + Math.min(0.18, smoothAmp * 0.5);
            currentBoost = currentBoost * 0.85 + targetBoost * 0.15;
            
            orb.style.setProperty('--orb-boost', currentBoost.toFixed(3));
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