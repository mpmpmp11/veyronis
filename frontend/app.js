// ============================================================
// VEYRONIS — Full App (All functions with null checks)
// ============================================================

const state = {
    apiUrl: '', proCode: '',
    userId: localStorage.getItem('veyronis_uid') || genUid(),
    model: 'instant',
    aiModel: 'groq',
    isTyping: false, isListening: false,
    recognition: null, msgCount: 0, editingId: null,
    conversationId: null, isNewChat: false,
    pendingImageBase64: null,
    pendingImageDataUrl: null,
    pendingImageFilename: null,
    pendingDocContent: null,
    pendingDocFilename: null,
    abortController: null,
    ttsEnabled: localStorage.getItem('veyronis_tts') !== 'false',
    autoTts: localStorage.getItem('veyronis_auto_tts') === 'true',
    speakingId: null,
    citations: {},
    customInstructions: localStorage.getItem('veyronis_custom_instructions') || '',
    responseStyle: localStorage.getItem('veyronis_response_style') || 'balanced',
    isOnline: navigator.onLine,
    deferredPrompt: null,
    serverStatus: 'unknown',
    retryCount: 0,
    touchStartX: 0,
    touchStartY: 0
};

const THEMES = ['dark', 'light', 'veyronis'];
let currentTheme = localStorage.getItem('veyronis_theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

function genUid() {
    const id = 'u_' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('veyronis_uid', id);
    return id;
}

// ============================================================
// CONNECTION
// ============================================================

function connect() {
    const url = document.getElementById('api-url');
    const code = document.getElementById('pro-code');
    if (!url || !code) return toast('Setup elements missing', 'error');
    const urlVal = url.value.trim();
    const codeVal = code.value.trim();
    if (!urlVal) return toast('Enter server address', 'error');
    state.apiUrl = urlVal.replace(/\/$/, '');
    state.proCode = codeVal;
    console.log('[VEYRONIS] Connecting to:', state.apiUrl);
    fetch(state.apiUrl + '/health')
        .then(r => {
            if (!r.ok) throw new Error('Server error');
            return r.json();
        })
        .then(() => {
            const setup = document.getElementById('setup-screen');
            const app = document.getElementById('app');
            if (setup) setup.classList.add('hidden');
            if (app) app.classList.remove('hidden');
            initApp();
            updateConnStatus('online');
        })
        .catch(err => {
            console.error('[VEYRONIS] Connection error:', err);
            toast('Cannot connect. Is the server running?', 'error');
        });
}

// ============================================================
// CONNECTION STATUS (with null checks)
// ============================================================

function updateConnStatus(status) {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    const wrap = document.getElementById('conn-status-wrap');
    if (!dot || !label || !wrap) return;
    dot.classList.remove('online', 'offline', 'error', 'checking');
    wrap.classList.remove('online', 'offline', 'error', 'checking');
    if (status === 'online') {
        dot.classList.add('online');
        wrap.classList.add('online');
        label.textContent = 'Connected';
    } else if (status === 'offline') {
        dot.classList.add('offline');
        wrap.classList.add('offline');
        label.textContent = 'Offline';
    } else if (status === 'error') {
        dot.classList.add('error');
        wrap.classList.add('error');
        label.textContent = 'Server Error';
    } else {
        dot.classList.add('checking');
        wrap.classList.add('checking');
        label.textContent = 'Connecting...';
    }
}

function updateChartDefaults() {
    if (!window.Chart) return;
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    Chart.defaults.color = theme === 'light' ? '#555570' : '#9ca3af';
    Chart.defaults.borderColor = theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
}

// ============================================================
// INIT APP
// ============================================================

function initApp() {
    try { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); } catch(e) {}
    if (window.Chart) updateChartDefaults();
    loadConversations();
    initVoice();
    if (!state.recognition) {
        const micBtn = document.getElementById('mic-btn');
        if (micBtn) micBtn.style.display = 'none';
    }
    initScrollHeader();
    initSettings();
    initTextarea();
    initClickOutside();
    initDragDrop();
    initPaste();
    initConnectivity();
    initInstallPrompt();
    initSwipeSidebar();
    if (state.proCode) setProUi();
    setTimeout(() => {
        if (state.apiUrl) {
            updateConnStatus('checking');
            checkServerHealth();
        }
    }, 100);
}

// ============================================================
// SIDEBAR
// ============================================================

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('active');
    document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
}

function initSwipeSidebar() {
    const app = document.getElementById('app');
    if (!app) return;
    app.addEventListener('touchstart', function(e) {
        state.touchStartX = e.touches[0].clientX;
        state.touchStartY = e.touches[0].clientY;
    }, { passive: true });
    app.addEventListener('touchend', function(e) {
        const diffX = e.changedTouches[0].clientX - state.touchStartX;
        const diffY = e.changedTouches[0].clientY - state.touchStartY;
        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
            if (diffX > 0) toggleSidebar();
            else closeSidebar();
        }
    }, { passive: true });
}

function newChat() {
    state.conversationId = null;
    state.isNewChat = true;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.innerHTML = '';
    showEmpty(true);
    loadConversations();
    closeSidebar();
}

// ============================================================
// TOP BAR FUNCTIONS
// ============================================================

function toggleMoreMenu() {
    const menu = document.getElementById('more-menu');
    if (!menu) return;
    menu.classList.toggle('open');
    const btn = document.querySelector('.more-btn');
    if (btn) btn.classList.toggle('active');
}

function toggleSearch() { toast('🔍 Search coming soon!', 'info'); }

function renameCurrentConv() {
    if (!state.conversationId) { toast('No conversation to rename', 'error'); return; }
    const convItem = document.querySelector(`.conv-item[data-id="${state.conversationId}"]`);
    const title = convItem ? convItem.querySelector('.conv-title')?.textContent || 'New Chat' : 'New Chat';
    closeMoreMenu();
    renameConvPrompt(state.conversationId, title);
}

function archiveCurrentConv() {
    if (!state.conversationId) { toast('No conversation to archive', 'error'); return; }
    toast('📦 Archive coming soon!', 'info');
    closeMoreMenu();
}

function deleteCurrentConv() {
    if (!state.conversationId) { toast('No conversation to delete', 'error'); return; }
    closeMoreMenu();
    deleteConv(state.conversationId);
}

function closeMoreMenu() {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.remove('open');
    const btn = document.querySelector('.more-btn');
    if (btn) btn.classList.remove('active');
}

document.addEventListener('click', function(e) {
    const wrap = document.querySelector('.more-wrap');
    if (wrap && !wrap.contains(e.target)) closeMoreMenu();
});

// ============================================================
// CONVERSATIONS
// ============================================================

function loadConversations() {
    if (!state.apiUrl) return;
    fetch(state.apiUrl + '/conversations?user_id=' + state.userId)
        .then(r => r.json())
        .then(data => {
            const convs = data.conversations || [];
            const today = [], yesterday = [], week = [];
            const now = new Date();
            convs.forEach(c => {
                const d = new Date(c.updated_at);
                const diffDays = (now - d) / (1000 * 60 * 60 * 24);
                const html = makeConvItem(c);
                if (diffDays < 1) today.push(html);
                else if (diffDays < 2) yesterday.push(html);
                else if (diffDays < 8) week.push(html);
            });
            const todayEl = document.getElementById('conv-list-today');
            const yesterdayEl = document.getElementById('conv-list-yesterday');
            const weekEl = document.getElementById('conv-list-week');
            if (todayEl) todayEl.innerHTML = today.join('') || '<div style="padding:8px;color:var(--text-muted);font-size:12px;">No chats</div>';
            if (yesterdayEl) yesterdayEl.innerHTML = yesterday.join('') || '';
            if (weekEl) weekEl.innerHTML = week.join('') || '';
            if (convs.length && !state.conversationId && !state.isNewChat) switchConversation(convs[0].id);
            else if (!convs.length) showEmpty(true);
            state.isNewChat = false;
        })
        .catch(() => {});
}

function makeConvItem(c) {
    const isActive = state.conversationId === c.id ? 'active' : '';
    const safeTitle = escapeHtml(c.title).replace(/'/g, "\\'");
    return `<div class="conv-item ${isActive}" data-id="${c.id}" onclick="switchConversation(${c.id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="conv-title">${escapeHtml(c.title)}</span>
        <div class="conv-actions">
            <button class="conv-action" onclick="event.stopPropagation(); renameConvPrompt(${c.id}, '${safeTitle}')" title="Rename"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="conv-action" onclick="event.stopPropagation(); deleteConv(${c.id})" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
    </div>`;
}

function switchConversation(id) {
    state.conversationId = id;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.innerHTML = '';
    loadHistory();
    loadConversations();
    closeSidebar();
}

function renameConvPrompt(id, currentTitle) {
    const newTitle = prompt('Rename conversation:', currentTitle);
    if (!newTitle || newTitle.trim() === '' || newTitle.trim() === currentTitle) return;
    fetch(state.apiUrl + '/conversations/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle.trim() }) })
        .then(r => { if (r.ok) { toast('Renamed', 'success'); loadConversations(); } else toast('Failed to rename', 'error'); })
        .catch(() => toast('Failed to rename', 'error'));
}

function deleteConv(id) {
    if (!confirm('Delete this conversation?')) return;
    fetch(state.apiUrl + '/conversations/' + id, { method: 'DELETE' })
        .then(r => {
            if (r.ok) {
                toast('Deleted', 'success');
                if (state.conversationId === id) {
                    state.conversationId = null;
                    const msgs = document.getElementById('messages');
                    if (msgs) msgs.innerHTML = '';
                    showEmpty(true);
                }
                loadConversations();
            } else toast('Failed to delete', 'error');
        })
        .catch(() => toast('Failed to delete', 'error'));
}

// ============================================================
// MODEL MENUS
// ============================================================

function toggleModelMenu() {
    const menu = document.getElementById('model-menu');
    const toggle = document.getElementById('model-toggle');
    if (menu) menu.classList.toggle('open');
    if (toggle) toggle.classList.toggle('open');
}

function pickModel(id, label) {
    state.model = id;
    const labelEl = document.getElementById('model-label');
    if (labelEl) labelEl.textContent = label;
    document.querySelectorAll('.model-row').forEach(b => b.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
    toggleModelMenu();
    if (id === 'research') toast('Research mode activated', 'success');
}

function pickAiModel(id, label) {
    state.aiModel = id;
    const labelEl = document.getElementById('ai-model-label');
    if (labelEl) labelEl.textContent = label;
    document.querySelectorAll('.ai-model-row').forEach(b => b.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
    toggleAiModelMenu();
}

function toggleAiModelMenu() {
    const menu = document.getElementById('ai-model-menu');
    const toggle = document.getElementById('ai-model-toggle');
    if (menu) menu.classList.toggle('open');
    if (toggle) toggle.classList.toggle('open');
}

function toggleAttach() {
    const pop = document.getElementById('attach-pop');
    if (pop) pop.classList.toggle('open');
}

function toggleExportMenu() {
    const pop = document.getElementById('export-pop');
    if (pop) pop.classList.toggle('open');
}

function initClickOutside() {
    document.addEventListener('click', e => {
        if (!e.target.closest('.model-bar')) {
            const menu1 = document.getElementById('model-menu');
            const toggle1 = document.getElementById('model-toggle');
            if (menu1) menu1.classList.remove('open');
            if (toggle1) toggle1.classList.remove('open');
            const menu2 = document.getElementById('ai-model-menu');
            const toggle2 = document.getElementById('ai-model-toggle');
            if (menu2) menu2.classList.remove('open');
            if (toggle2) toggle2.classList.remove('open');
        }
        if (!e.target.closest('.attach') && !e.target.closest('.attach-pop')) {
            const pop = document.getElementById('attach-pop');
            if (pop) pop.classList.remove('open');
        }
        if (!e.target.closest('.export-wrap')) {
            const pop = document.getElementById('export-pop');
            if (pop) pop.classList.remove('open');
        }
        if (!e.target.closest('.more-wrap')) closeMoreMenu();
    });
}

function initTextarea() {
    const ta = document.getElementById('msg-input');
    if (!ta) return;
    ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
        updateSendButton();
    });
    ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
}

function updateSendButton() {
    const btn = document.getElementById('send-btn');
    if (!btn) return;
    if (state.isTyping && state.abortController) {
        btn.disabled = false;
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        btn.onclick = stopGeneration;
        btn.title = "Stop";
        btn.classList.add('stop-btn');
        return;
    }
    btn.classList.remove('stop-btn');
    btn.onclick = sendMessage;
    btn.title = "Send";
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    const ta = document.getElementById('msg-input');
    const hasText = ta ? !!ta.value.trim() : false;
    const hasImage = !!state.pendingImageBase64;
    btn.disabled = !hasText && !hasImage;
}

function stopGeneration() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
    }
    state.isTyping = false;
    updateSendButton();
}

function initScrollHeader() {
    const sc = document.getElementById('chat-scroll');
    const tb = document.querySelector('.top-bar');
    if (!sc || !tb) return;
    sc.addEventListener('scroll', () => tb.classList.toggle('scrolled', sc.scrollTop > 10));
}

function showEmpty(show) {
    const el = document.getElementById('empty-state');
    if (el) el.classList.toggle('hidden', !show);
}

function scrollBottom() {
    const sc = document.getElementById('chat-scroll');
    if (sc) sc.scrollTo({ top: 999999, behavior: 'smooth' });
}

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

// ============================================================
// THEME
// ============================================================

function cycleTheme() {
    const idx = THEMES.indexOf(currentTheme);
    currentTheme = THEMES[(idx + 1) % THEMES.length];
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('veyronis_theme', currentTheme);
    updateChartDefaults();
    toast(`Theme: ${currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1)}`, 'success');
}

// ============================================================
// IMAGE & DOCUMENT UPLOAD
// ============================================================

function triggerImageUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast('Image too large. Max 5MB.', 'error'); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
            state.pendingImageBase64 = ev.target.result.split(',')[1];
            state.pendingImageDataUrl = ev.target.result;
            state.pendingImageFilename = file.name;
            showImagePreview(file.name, ev.target.result);
            const pop = document.getElementById('attach-pop');
            if (pop) pop.classList.remove('open');
            updateSendButton();
        };
        reader.readAsDataURL(file);
    };
    input.click();
    setTimeout(() => { if (input.parentNode) input.parentNode.removeChild(input); }, 60000);
}

function showImagePreview(filename, dataUrl) {
    const existing = document.getElementById('img-preview');
    if (existing) existing.remove();
    const preview = document.createElement('div');
    preview.className = 'image-preview';
    preview.id = 'img-preview';
    preview.innerHTML = `<img src="${dataUrl}" alt="preview"><span>${escapeHtml(filename)}</span><button class="remove-img" onclick="removeImagePreview()">×</button>`;
    const glass = document.getElementById('input-glass');
    if (glass) glass.insertBefore(preview, glass.firstChild);
}

function removeImagePreview() {
    state.pendingImageBase64 = null;
    state.pendingImageDataUrl = null;
    state.pendingImageFilename = null;
    const existing = document.getElementById('img-preview');
    if (existing) existing.remove();
    updateSendButton();
}

function showDocPreview(filename) {
    const existing = document.getElementById('doc-preview');
    if (existing) existing.remove();
    const preview = document.createElement('div');
    preview.className = 'doc-preview';
    preview.id = 'doc-preview';
    preview.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg><span>${escapeHtml(filename)}</span><button class="remove-doc" onclick="removeDocPreview()">×</button>`;
    const glass = document.getElementById('input-glass');
    if (glass) glass.insertBefore(preview, glass.firstChild);
}

function removeDocPreview() {
    state.pendingDocContent = null;
    state.pendingDocFilename = null;
    const existing = document.getElementById('doc-preview');
    if (existing) existing.remove();
    updateSendButton();
}

function triggerDocumentUpload() {
    if (!state.userId || state.userId === 'null' || state.userId === 'undefined') state.userId = genUid();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md,.csv,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) { toast('File too large. Max 10MB.', 'error'); return; }
        if (!state.userId || state.userId === 'null' || state.userId === 'undefined') state.userId = genUid();
        const formData = new FormData();
        formData.append('file', file);
        formData.append('user_id', state.userId);
        if (state.conversationId) formData.append('conversation_id', state.conversationId);
        toast('Uploading document...', 'info');
        const pop = document.getElementById('attach-pop');
        if (pop) pop.classList.remove('open');
        try {
            const res = await fetch(state.apiUrl + '/upload', { method: 'POST', body: formData });
            const data = await res.json();
            if (res.ok) {
                toast(`Document ready: ${data.extracted_length} chars`, 'success');
                if (!state.conversationId && data.conversation_id) { state.conversationId = data.conversation_id; loadConversations(); }
                state.pendingDocContent = data.content || data.preview || '';
                state.pendingDocFilename = data.filename || file.name;
                showDocPreview(state.pendingDocFilename);
                updateSendButton();
            } else {
                toast(data.detail || 'Upload failed', 'error');
            }
        } catch (err) { toast('Upload failed', 'error'); }
    };
    input.click();
    setTimeout(() => { if (input.parentNode) input.parentNode.removeChild(input); }, 60000);
}

// ============================================================
// DRAG & DROP
// ============================================================

function initDragDrop() {
    const overlay = document.getElementById('drag-overlay');
    if (!overlay) return;
    let dragCounter = 0;
    document.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; overlay.classList.add('active'); });
    document.addEventListener('dragleave', e => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) overlay.classList.remove('active'); });
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
        e.preventDefault(); dragCounter = 0; overlay.classList.remove('active');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    state.pendingImageBase64 = ev.target.result.split(',')[1];
                    state.pendingImageDataUrl = ev.target.result;
                    state.pendingImageFilename = file.name;
                    showImagePreview(file.name, ev.target.result);
                    updateSendButton();
                };
                reader.readAsDataURL(file);
            } else if (file.name.match(/\.(pdf|docx|txt|md|csv|xlsx|xls)$/i)) {
                handleDroppedFile(file);
            } else toast('Use the attach menu for documents', 'info');
        }
    });
}

async function handleDroppedFile(file) {
    if (!state.userId || state.userId === 'null' || state.userId === 'undefined') state.userId = genUid();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_id', state.userId);
    if (state.conversationId) formData.append('conversation_id', state.conversationId);
    toast('Uploading document...', 'info');
    try {
        const res = await fetch(state.apiUrl + '/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
            toast(`Document ready: ${data.extracted_length} chars`, 'success');
            if (!state.conversationId && data.conversation_id) { state.conversationId = data.conversation_id; loadConversations(); }
            state.pendingDocContent = data.content || data.preview || '';
            state.pendingDocFilename = data.filename || file.name;
            showDocPreview(state.pendingDocFilename);
            updateSendButton();
        } else toast(data.detail || 'Upload failed', 'error');
    } catch (err) { toast('Upload failed', 'error'); }
}

function initPaste() {
    document.addEventListener('paste', e => {
        const items = e.clipboardData.items;
        for (let item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file) continue;
                if (file.size > 5 * 1024 * 1024) { toast('Pasted image too large. Max 5MB.', 'error'); continue; }
                const reader = new FileReader();
                reader.onload = (ev) => {
                    state.pendingImageBase64 = ev.target.result.split(',')[1];
                    state.pendingImageDataUrl = ev.target.result;
                    state.pendingImageFilename = file.name || 'pasted-image.png';
                    showImagePreview(state.pendingImageFilename, ev.target.result);
                    updateSendButton();
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });
}

// ============================================================
// MARKDOWN, CHARTS, MERMAID, FLASHCARDS, CODE
// ============================================================

function renderMarkdown(el, raw) {
    if (!el) return;
    if (!window.marked) { el.textContent = raw; return; }
    const mathPlaceholders = [];
    let processed = raw.replace(/\$\$([\s\S]*?)\$\$/g, (match) => { mathPlaceholders.push(match); return `%%MATHBLOCK${mathPlaceholders.length-1}%%`; });
    processed = processed.replace(/\$([^\$\n]+?)\$/g, (match) => { mathPlaceholders.push(match); return `%%MATHINLINE${mathPlaceholders.length-1}%%`; });
    el.innerHTML = marked.parse(processed, { breaks: true, gfm: true, headerIds: false });
    el.innerHTML = el.innerHTML.replace(/%%MATHBLOCK(\d+)%%/g, (_, i) => mathPlaceholders[i]);
    el.innerHTML = el.innerHTML.replace(/%%MATHINLINE(\d+)%%/g, (_, i) => mathPlaceholders[i]);
    el.querySelectorAll('pre code.language-mermaid').forEach(b => {
        const d = document.createElement('div');
        d.className = 'mermaid';
        d.textContent = b.textContent.trim();
        b.parentElement.replaceWith(d);
    });
    if (window.mermaid) mermaid.run({ querySelector: '.mermaid' }).catch(() => {});
    renderCharts(el);
    renderFlashcards(el);
    if (typeof hljs !== 'undefined') {
        el.querySelectorAll('pre code').forEach(b => {
            if (!b.classList.contains('language-mermaid') && !b.classList.contains('language-chart') && !b.classList.contains('language-flashcards'))
                hljs.highlightElement(b);
        });
    }
    injectRunButtons(el);
    el.querySelectorAll('img').forEach(img => {
        if (!img.closest('a')) {
            img.style.cursor = 'zoom-in';
            img.onclick = (e) => { e.stopPropagation(); openLightbox(img.src); };
        }
    });
    if (window.renderMathInElement) renderMathInElement(el, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
        ignoredTags: ['pre', 'code'], throwOnError: false, trust: false
    });
}

function renderCharts(el) {
    if (!window.Chart) return;
    const validTypes = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter', 'bubble'];
    el.querySelectorAll('pre code.language-chart, pre code.language-json').forEach(block => {
        try {
            const cfg = JSON.parse(block.textContent);
            if (!cfg.type || !validTypes.includes(cfg.type) || !cfg.data) return;
            const wrap = document.createElement('div');
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const chartBg = isLight ? '#f5f5f8' : '#0d0d12';
            const chartBorder = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
            wrap.style.cssText = `max-width:100%;margin:12px 0;padding:12px;background:${chartBg};border:1px solid ${chartBorder};border-radius:12px;`;
            const canvas = document.createElement('canvas');
            wrap.appendChild(canvas);
            block.parentElement.replaceWith(wrap);
            new Chart(canvas, cfg);
        } catch (e) {}
    });
}

function renderFlashcards(el) {
    el.querySelectorAll('pre code.language-flashcards').forEach(block => {
        try {
            const cards = JSON.parse(block.textContent);
            if (!Array.isArray(cards) || !cards.length) return;
            const wrap = document.createElement('div');
            wrap.className = 'flashcard-deck';
            cards.forEach((card, idx) => {
                const cardEl = document.createElement('div');
                cardEl.className = 'flashcard';
                cardEl.innerHTML = `<div class="flashcard-inner"><div class="flashcard-front"><div class="flashcard-num">${idx+1}/${cards.length}</div><div class="flashcard-q">${escapeHtml(card.q||'')}</div><div class="flashcard-hint">Tap to flip</div></div><div class="flashcard-back"><div class="flashcard-num">${idx+1}/${cards.length}</div><div class="flashcard-a">${escapeHtml(card.a||'')}</div></div></div>`;
                cardEl.onclick = () => cardEl.classList.toggle('flipped');
                wrap.appendChild(cardEl);
            });
            block.parentElement.replaceWith(wrap);
        } catch (e) {}
    });
}

function openLightbox(src) {
    const lb = document.getElementById('img-lightbox');
    const img = document.getElementById('lightbox-img');
    if (!lb || !img) return;
    img.src = src;
    lb.classList.remove('hidden');
}
function closeLightbox() {
    const lb = document.getElementById('img-lightbox');
    if (lb) lb.classList.add('hidden');
}

// ─── CODE EXECUTION ───

function injectRunButtons(el) {
    el.querySelectorAll('pre code.language-python, pre code.language-py').forEach(block => {
        const pre = block.parentElement;
        if (pre.querySelector('.run-code-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'run-code-btn';
        btn.innerHTML = '▶ Run';
        btn.onclick = () => runCodeBlock(block.textContent, pre);
        pre.appendChild(btn);
    });
}

async function runCodeBlock(code, preElement) {
    const container = preElement.parentElement;
    let outputDiv = container.querySelector('.code-output');
    if (!outputDiv) {
        outputDiv = document.createElement('div');
        outputDiv.className = 'code-output';
        outputDiv.innerHTML = '<div class="code-output-header">Terminal</div><div class="code-output-body">Running...</div>';
        container.insertBefore(outputDiv, preElement.nextSibling);
    } else {
        const body = outputDiv.querySelector('.code-output-body');
        if (body) { body.textContent = 'Running...'; body.className = 'code-output-body'; }
    }
    try {
        const res = await fetch(state.apiUrl + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        const body = outputDiv.querySelector('.code-output-body');
        if (!body) return;
        if (data.success) {
            body.textContent = data.output || '(no output)';
            body.classList.add('success');
        } else {
            body.textContent = data.error || 'Execution failed';
            body.classList.add('error');
        }
    } catch (e) {
        const body = outputDiv.querySelector('.code-output-body');
        if (body) { body.textContent = 'Network error: ' + e.message; body.classList.add('error'); }
    }
}

// ─── CITATIONS ───

function convertCitationsInElement(el, maxIndex) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const nodesToReplace = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && node.parentElement.closest('pre, code, a, .sources-box')) continue;
        if (/\[\d+\]/.test(node.textContent)) {
            nodesToReplace.push(node);
        }
    }
    nodesToReplace.forEach(node => {
        const span = document.createElement('span');
        span.innerHTML = node.textContent.replace(/\[(\d+)\]/g, (match, num) => {
            const n = parseInt(num);
            if (n <= maxIndex) return `<sup class="citation-sup" title="Source ${num}">${num}</sup>`;
            return match;
        });
        node.parentNode.replaceChild(span, node);
    });
}

function renderCitations(aiId, citations) {
    if (!citations || !citations.length) return;
    state.citations[aiId] = citations;
    const textEl = document.getElementById('text-' + aiId);
    const msgBody = textEl ? textEl.closest('.msg-body') : null;
    if (!msgBody) return;
    if (textEl) convertCitationsInElement(textEl, citations.length);
    if (msgBody.querySelector('.sources-box')) return;
    const sourcesBox = document.createElement('div');
    sourcesBox.className = 'sources-box';
    sourcesBox.innerHTML = `
        <div class="sources-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            <span>${citations.length} source${citations.length > 1 ? 's' : ''}</span>
        </div>
        <div class="sources-list">
            ${citations.map(c => `
                <a class="source-chip" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">
                    <span class="source-num">${c.index}</span>
                    <span class="source-title">${escapeHtml(c.title)}</span>
                </a>
            `).join('')}
        </div>
    `;
    msgBody.appendChild(sourcesBox);
}

// ─── RESEARCH PROGRESS ───

function updateResearchProgress(aiId, stepData) {
    const thinkEl = document.getElementById('think-text-' + aiId);
    const thinkBlock = document.getElementById('think-' + aiId);
    if (!thinkEl || !thinkBlock) return;
    thinkBlock.classList.add('expanded');
    thinkBlock.classList.add('research-mode');
    const phases = {
        planning: { icon: '📋', label: 'Planning', step: 1 },
        planned: { icon: '✅', label: 'Planned', step: 1 },
        searching: { icon: '🔍', label: 'Searching', step: 2 },
        synthesizing: { icon: '🧠', label: 'Synthesizing', step: 3 },
    };
    const cfg = phases[stepData.phase] || { icon: '⏳', label: 'Working', step: 0 };
    let progressHtml = `<div class="research-progress">`;
    progressHtml += `<div class="research-step ${stepData.phase === 'planning' || stepData.phase === 'planned' ? 'active' : 'done'}"><span class="rs-num">1</span><span class="rs-label">Plan</span></div>`;
    progressHtml += `<div class="research-step ${stepData.phase === 'searching' ? 'active' : stepData.phase === 'synthesizing' ? 'done' : ''}"><span class="rs-num">2</span><span class="rs-label">Search</span></div>`;
    progressHtml += `<div class="research-step ${stepData.phase === 'synthesizing' ? 'active' : ''}"><span class="rs-num">3</span><span class="rs-label">Synthesize</span></div>`;
    progressHtml += `</div>`;
    let msg = stepData.message || '';
    if (stepData.phase === 'searching' && stepData.current && stepData.total) {
        msg += ` (${stepData.current}/${stepData.total})`;
    }
    thinkEl.innerHTML = `${progressHtml}<div class="research-status">${cfg.icon} ${msg}</div>`;
}

function hideResearchProgress(aiId) {
    const thinkBlock = document.getElementById('think-' + aiId);
    if (thinkBlock) {
        thinkBlock.classList.remove('research-mode');
        setTimeout(() => thinkBlock.classList.remove('expanded'), 1200);
    }
}

// ============================================================
// MESSAGE FUNCTIONS
// ============================================================

function addUserMsg(text, id = null) {
    showEmpty(false);
    const mid = id || 'um_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble">${escapeHtml(text)}</div><div class="msg-actions"><button class="msg-action-btn" onclick="editMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Edit</span></button><button class="msg-action-btn" onclick="copyMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button><button class="msg-action-btn" onclick="delMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span></button><button class="msg-action-btn" onclick="shareMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg><span>Share</span></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return mid;
}

function addUserImageMsg(text, dataUrl, filename, id = null) {
    showEmpty(false);
    const mid = id || 'uimg_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    const textHtml = text ? `<div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(text)}</div>` : '';
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble" style="padding:10px;max-width:320px;"><img src="${dataUrl}" style="max-width:100%;border-radius:8px;display:block;cursor:zoom-in;" onclick="openLightbox('${dataUrl}')"><div style="font-size:11px;opacity:0.6;text-align:right;margin-top:4px;">${escapeHtml(filename)}</div>${textHtml}</div><div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button><button class="msg-action-btn" onclick="delMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return mid;
}

function addHistoricalImageMsg(text, dataUrl, id = null) {
    showEmpty(false);
    const mid = id || 'uimg_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    const isPlaceholder = !text || text === '[Image upload]';
    const textHtml = !isPlaceholder ? `<div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(text)}</div>` : '';
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble" style="padding:10px;max-width:320px;"><img src="${dataUrl}" style="max-width:100%;border-radius:8px;display:block;cursor:zoom-in;" onclick="openLightbox('${dataUrl}')" onerror="this.style.display='none';this.nextElementSibling.style.display='block';"><div style="display:none;font-size:12px;color:var(--text-muted);padding:8px;">Image unavailable</div>${textHtml}</div><div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button><button class="msg-action-btn" onclick="delMsg('${mid}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return mid;
}

function addAiShell() {
    showEmpty(false);
    const id = 'ai_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg ai';
    div.id = id;
    div.innerHTML = `<div class="msg-avatar">V</div><div class="msg-body"><div class="think-block expanded" id="think-${id}"><div class="think-header" onclick="toggleThink('think-${id}')"><div class="think-title"><span class="think-icon">💡</span><span>Think</span></div><svg class="think-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></div></div><div class="think-body"><div class="think-inner"><div class="think-content" id="think-text-${id}">Analyzing...</div></div></div></div><div class="msg-text" id="text-${id}"></div><div class="msg-actions bot-actions"><button class="msg-action-btn" onclick="speakMsg('${id}')" title="Read aloud"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg><span>Speak</span></button><button class="msg-action-btn" onclick="regenerateMsg('${id}')" title="Regenerate"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg><span>Regenerate</span></button><button class="msg-action-btn" onclick="copyAiMsg('${id}')" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button><button class="msg-action-btn" onclick="shareAiMsg('${id}')" title="Share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg><span>Share</span></button><button class="msg-action-btn thumb-up" id="up-${id}" onclick="thumbUp('${id}')" title="Helpful"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg><span>Helpful</span></button><button class="msg-action-btn thumb-down" id="down-${id}" onclick="thumbDown('${id}')" title="Not helpful"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg><span>Not helpful</span></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return id;
}

function addAiText(id, text) {
    const el = document.getElementById('text-' + id);
    if (el) renderMarkdown(el, text);
}
function toggleThink(id) {
    const block = document.getElementById(id);
    if (block) block.classList.toggle('expanded');
}

function editMsg(id) {
    const bubble = document.querySelector('#' + id + ' .msg-bubble');
    if (!bubble) return;
    const input = document.getElementById('msg-input');
    if (!input) return;
    input.value = bubble.textContent;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    input.focus();
    state.editingId = id;
    toast('Message loaded for editing. Press Enter to send.', 'info');
}

function copyMsg(id) {
    const bubble = document.querySelector('#' + id + ' .msg-bubble');
    if (!bubble) return;
    navigator.clipboard.writeText(bubble.textContent).then(() => toast('Copied', 'success'));
}
function delMsg(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.opacity = '0';
        setTimeout(() => {
            el.remove();
            const msgs = document.getElementById('messages');
            if (msgs && !msgs.children.length) showEmpty(true);
        }, 200);
    }
}
function shareMsg(id) {
    const text = document.querySelector('#' + id + ' .msg-bubble')?.textContent || '';
    if (navigator.share) navigator.share({ text });
    else navigator.clipboard.writeText(text).then(() => toast('Copied to share', 'success'));
}
function copyAiMsg(id) {
    const el = document.getElementById('text-' + id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent || el.innerText).then(() => toast('Copied response', 'success'));
}
function shareAiMsg(id) {
    const el = document.getElementById('text-' + id);
    if (!el) return;
    const text = el.textContent || el.innerText;
    if (navigator.share) navigator.share({ text });
    else navigator.clipboard.writeText(text).then(() => toast('Copied to share', 'success'));
}

function speakMsg(id) {
    if (!state.ttsEnabled) { toast('Text-to-speech is muted', 'info'); return; }
    const el = document.getElementById('text-' + id);
    if (!el) return;
    const text = el.textContent || el.innerText;
    if (!text) return;
    window.speechSynthesis.cancel();
    state.speakingId = id;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.pitch = 1;
    utterance.onend = () => { state.speakingId = null; };
    utterance.onerror = () => { state.speakingId = null; };
    window.speechSynthesis.speak(utterance);
}

function regenerateMsg(aiId) {
    const aiMsg = document.getElementById(aiId);
    if (!aiMsg) return;
    let userMsg = aiMsg.previousElementSibling;
    while (userMsg && !userMsg.classList.contains('user')) {
        userMsg = userMsg.previousElementSibling;
    }
    if (!userMsg) { toast('No user message found', 'error'); return; }
    const bubble = userMsg.querySelector('.msg-bubble');
    const text = bubble ? bubble.textContent : '';
    const textEl = document.getElementById('text-' + aiId);
    const thinkEl = document.getElementById('think-text-' + aiId);
    if (textEl) textEl.textContent = '';
    if (thinkEl) thinkEl.textContent = 'Regenerating...';
    const thinkBlock = document.getElementById('think-' + aiId);
    if (thinkBlock) thinkBlock.classList.add('expanded');
    state.isTyping = true;
    updateSendButton();
    const controller = new AbortController();
    state.abortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    fetch(state.apiUrl + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
            message: text || '',
            pro_code: state.proCode || '',
            user_id: state.userId || '',
            conversation_id: state.conversationId,
            image: state.pendingImageBase64 || null,
            model_mode: state.model,
            ai_model: state.aiModel,
            custom_instructions: state.customInstructions,
            response_style: state.responseStyle
        })
    }).then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Server error');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullResponse = '';
        function read() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    state.isTyping = false;
                    state.abortController = null;
                    updateSendButton();
                    if (thinkBlock) setTimeout(() => thinkBlock.classList.remove('expanded'), 600);
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr) continue;
                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.type === 'reasoning' && thinkEl && state.model !== 'research') thinkEl.textContent = data.content;
                        else if (data.type === 'token') {
                            if (textEl) textEl.textContent += data.content;
                            fullResponse += data.content;
                            scrollBottom();
                        } else if (data.type === 'citations') {
                            state.citations[aiId] = data.content;
                        } else if (data.type === 'research_step') {
                            updateResearchProgress(aiId, data.content);
                        } else if (data.type === 'done') {
                            state.isTyping = false;
                            state.abortController = null;
                            hideResearchProgress(aiId);
                            if (textEl) {
                                renderMarkdown(textEl, fullResponse);
                                renderCitations(aiId, state.citations[aiId]);
                            }
                            updateSendButton();
                            if (state.autoTts && state.ttsEnabled) speakMsg(aiId);
                            if (thinkBlock) setTimeout(() => thinkBlock.classList.remove('expanded'), 600);
                        } else if (data.type === 'error') throw new Error(data.content);
                    } catch (e) { if (e instanceof SyntaxError) continue; }
                }
                read();
            }).catch(err => {
                state.isTyping = false;
                state.abortController = null;
                updateSendButton();
                if (err.name !== 'AbortError' && textEl) textEl.textContent = 'Error: ' + err.message;
            });
        }
        read();
    }).catch(err => {
        state.isTyping = false;
        state.abortController = null;
        updateSendButton();
        if (textEl) textEl.textContent = err.name === 'AbortError' ? 'Generation stopped.' : 'Error: ' + err.message;
    });
}

function thumbUp(id) {
    const btn = document.getElementById('up-' + id);
    const downBtn = document.getElementById('down-' + id);
    if (!btn) return;
    btn.classList.toggle('active');
    if (downBtn) downBtn.classList.remove('active');
    toast('Thanks for the feedback!', 'success');
}
function thumbDown(id) {
    const btn = document.getElementById('down-' + id);
    const upBtn = document.getElementById('up-' + id);
    if (!btn) return;
    btn.classList.toggle('active');
    if (upBtn) upBtn.classList.remove('active');
    toast('Thanks for the feedback!', 'success');
}
function shareChat() { toast('Share link copied', 'success'); }
function quickSend(text) {
    const input = document.getElementById('msg-input');
    if (input) input.value = text;
    sendMessage();
}

// ============================================================
// EXPORT CHAT
// ============================================================

function exportChat(format) {
    if (!state.conversationId) { toast('No conversation to export', 'error'); return; }
    fetch(`${state.apiUrl}/export/${state.conversationId}?format=${format}&user_id=${state.userId}`)
        .then(r => { if (!r.ok) throw new Error('Export failed'); return r.json(); })
        .then(data => {
            if (format === 'json') {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `veyronis_chat_${state.conversationId}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast('Chat exported as JSON', 'success');
            } else {
                const blob = new Blob([data.content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.filename;
                a.click();
                URL.revokeObjectURL(url);
                toast('Chat exported as TXT', 'success');
            }
        })
        .catch(() => toast('Export failed', 'error'));
    const pop = document.getElementById('export-pop');
    if (pop) pop.classList.remove('open');
}

// ============================================================
// SEND MESSAGE (Streaming)
// ============================================================

async function sendMessage() {
    if (state.isTyping) return;
    const input = document.getElementById('msg-input');
    if (!input) return;
    let text = input.value.trim();
    const hasImage = !!state.pendingImageBase64;
    const hasDoc = !!state.pendingDocContent;
    if (!state.editingId && !text && !hasImage && !hasDoc) return;
    if (hasDoc && !state.editingId) {
        const docHeader = `Document: "${state.pendingDocFilename}"`;
        text = text ? `${docHeader}\n\n${state.pendingDocContent}\n\n${text}` : `${docHeader}\n\n${state.pendingDocContent}`;
    }
    const imageBase64 = state.pendingImageBase64;
    const imageDataUrl = state.pendingImageDataUrl;
    const imageFilename = state.pendingImageFilename;

    if (state.editingId) {
        const bubble = document.querySelector('#' + state.editingId + ' .msg-bubble');
        if (bubble) bubble.textContent = text;
        const editedMsg = document.getElementById(state.editingId);
        let next = editedMsg.nextElementSibling;
        while (next) {
            const toRemove = next;
            next = next.nextElementSibling;
            toRemove.remove();
        }
        state.editingId = null;
        input.value = '';
        input.style.height = 'auto';
        toast('Message updated. Regenerating response...', 'info');
    } else {
        if (hasImage && imageDataUrl) {
            addUserImageMsg(input.value.trim(), imageDataUrl, imageFilename || 'image.png');
            removeImagePreview();
        }
        if (text && !hasImage) addUserMsg(text);
        if (hasDoc) removeDocPreview();
    }
    input.value = '';
    input.style.height = 'auto';
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;
    const aiId = addAiShell();
    const textEl = document.getElementById('text-' + aiId);
    const thinkEl = document.getElementById('think-text-' + aiId);
    const thinkBlock = document.getElementById('think-' + aiId);
    if (state.model === 'research') {
        if (thinkEl) thinkEl.innerHTML = '<div class="research-progress"><div class="research-step active"><span class="rs-num">1</span><span class="rs-label">Plan</span></div><div class="research-step"><span class="rs-num">2</span><span class="rs-label">Search</span></div><div class="research-step"><span class="rs-num">3</span><span class="rs-label">Synthesize</span></div></div><div class="research-status">🔬 Research mode active. Planning investigation...</div>';
        if (thinkBlock) { thinkBlock.classList.add('expanded'); thinkBlock.classList.add('research-mode'); }
    }
    if (textEl) textEl.textContent = '';
    state.isTyping = true;
    state.abortController = new AbortController();
    const controller = state.abortController;
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    updateSendButton();

    try {
        const requestBody = {
            message: text || '',
            pro_code: state.proCode || '',
            user_id: state.userId || '',
            conversation_id: state.conversationId,
            image: imageBase64 || null,
            model_mode: state.model,
            ai_model: state.aiModel,
            custom_instructions: state.customInstructions,
            response_style: state.responseStyle
        };
        const response = await fetch(state.apiUrl + '/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(requestBody)
        });
        clearTimeout(timeoutId);
        if (!response.ok) { const errData = await response.json().catch(() => ({})); throw new Error(errData.detail || 'Server error'); }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullResponse = '';
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
                    if (data.type === 'reasoning' && state.model !== 'research' && thinkEl) thinkEl.textContent = data.content;
                    else if (data.type === 'token') {
                        if (textEl) textEl.textContent += data.content;
                        fullResponse += data.content;
                        scrollBottom();
                    } else if (data.type === 'citations') {
                        state.citations[aiId] = data.content;
                    } else if (data.type === 'research_step') {
                        updateResearchProgress(aiId, data.content);
                    } else if (data.type === 'done') {
                        state.isTyping = false;
                        if (sendBtn) sendBtn.disabled = false;
                        if (textEl) {
                            renderMarkdown(textEl, fullResponse);
                            renderCitations(aiId, state.citations[aiId]);
                        }
                        hideResearchProgress(aiId);
                        if (data.conversation_id && !state.conversationId) { state.conversationId = data.conversation_id; loadConversations(); }
                        if (data.tier === 'pro') setProUi();
                        else { state.msgCount++; const disclaimer = document.querySelector('.input-disclaimer'); if (disclaimer) disclaimer.textContent = `Free: ${state.msgCount}/20 today · VEYRONIS can make mistakes`; }
                        if (thinkBlock) setTimeout(() => thinkBlock.classList.remove('expanded'), 600);
                    } else if (data.type === 'error') throw new Error(data.content);
                } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
            }
        }
    } catch (err) {
        state.isTyping = false;
        state.abortController = null;
        if (sendBtn) sendBtn.disabled = false;
        if (err.name === 'AbortError') {
            if (textEl) textEl.textContent = textEl.textContent || 'Generation stopped.';
        } else if (!navigator.onLine) {
            if (textEl) textEl.textContent = '💾 Message queued. Will send when you are back online.';
            if (thinkBlock) thinkBlock.classList.remove('expanded');
        } else if (err.message && err.message.includes('429')) {
            if (textEl) textEl.textContent = '⏳ Rate limited. Retrying...';
            if (thinkBlock) thinkBlock.classList.remove('expanded');
            setTimeout(() => sendMessage(), 3000);
        } else if (err.message && err.message.includes('502')) {
            if (textEl) textEl.textContent = '🔧 Server unavailable. Retrying...';
            if (thinkBlock) thinkBlock.classList.remove('expanded');
            setTimeout(() => sendMessage(), 5000);
        } else {
            if (textEl) textEl.textContent = 'Error: ' + err.message;
            if (thinkBlock) thinkBlock.classList.remove('expanded');
        }
    }
    updateSendButton();
}

function clearChat() {
    if (!confirm('Clear all messages?')) return;
    fetch(state.apiUrl + '/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: state.userId, conversation_id: state.conversationId }) })
        .then(() => { 
            const msgs = document.getElementById('messages'); 
            if (msgs) msgs.innerHTML = '';
            showEmpty(true);
        })
        .catch(() => toast('Failed to clear chat', 'error'));
}

function loadHistory() {
    if (!state.apiUrl) return;
    let url = state.apiUrl + '/history?user_id=' + state.userId;
    if (state.conversationId) url += '&conversation_id=' + state.conversationId;
    fetch(url).then(r => r.json()).then(data => {
        const msgs = data.messages || [];
        if (!msgs.length) { showEmpty(true); if (state.proCode) setProUi(); } else {
            showEmpty(false);
            msgs.forEach(m => {
                if (m.role === 'user') {
                    if (m.image_data) {
                        addHistoricalImageMsg(m.content, m.image_data);
                    } else {
                        addUserMsg(m.content);
                    }
                } else {
                    const id = addAiShell();
                    const thinkBlock = document.getElementById('think-' + id);
                    const thinkText = document.getElementById('think-text-' + id);
                    if (thinkBlock) thinkBlock.classList.remove('expanded');
                    if (thinkText) thinkText.textContent = 'Loaded from history';
                    const textEl = document.getElementById('text-' + id);
                    if (textEl) renderMarkdown(textEl, m.content);
                }
            });
            if (!state.proCode) { 
                state.msgCount = msgs.filter(m => m.role === 'user').length; 
                const disclaimer = document.querySelector('.input-disclaimer');
                if (disclaimer) disclaimer.textContent = `Free: ${state.msgCount}/20 today · VEYRONIS can make mistakes`;
            }
        }
        scrollBottom();
    }).catch(() => showEmpty(true));
}

// ============================================================
// PRO UI (with null checks)
// ============================================================

function setProUi() {
    const disclaimer = document.querySelector('.input-disclaimer');
    if (disclaimer) {
        disclaimer.innerHTML = 'PRO MODE <span style="color:#fbbf24">★</span> · Unlimited messages';
    }
    const tierBadge = document.getElementById('tier-badge');
    if (tierBadge) {
        tierBadge.textContent = 'PRO';
        tierBadge.classList.add('pro');
    }
    const sidebarTier = document.getElementById('sidebar-tier');
    if (sidebarTier) {
        sidebarTier.textContent = 'PRO';
        sidebarTier.classList.add('pro');
    }
}

// ============================================================
// VOICE INPUT
// ============================================================

function initVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        const btn = document.getElementById('mic-btn');
        if (btn) btn.style.display = 'none';
        return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SpeechRecognition();
    state.recognition.continuous = false;
    state.recognition.interimResults = true;
    state.recognition.lang = 'en-US';
    let finalTranscript = '';
    state.recognition.onstart = () => {
        state.isListening = true;
        finalTranscript = '';
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.add('listening');
            btn.innerHTML = '<div class="voice-wave"><div></div><div></div><div></div></div>';
        }
        const ta = document.getElementById('msg-input');
        if (ta) { ta.placeholder = 'Listening... Speak now'; ta.value = ''; ta.style.height = 'auto'; }
        updateSendButton();
    };
    state.recognition.onend = () => {
        state.isListening = false;
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.remove('listening');
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
        }
        const ta = document.getElementById('msg-input');
        if (ta) { ta.placeholder = 'Message VEYRONIS...'; if (finalTranscript.trim()) { ta.value = finalTranscript.trim(); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; updateSendButton(); setTimeout(() => sendMessage(), 400); } }
    };
    state.recognition.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const transcript = e.results[i][0].transcript;
            if (e.results[i].isFinal) { finalTranscript += transcript; } else { interim += transcript; }
        }
        const ta = document.getElementById('msg-input');
        if (ta) { ta.value = finalTranscript + interim; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; updateSendButton(); }
    };
    state.recognition.onerror = (e) => {
        state.isListening = false;
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.remove('listening');
            btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
        }
        const ta = document.getElementById('msg-input');
        if (ta) ta.placeholder = 'Message VEYRONIS...';
        if (e.error === 'no-speech') { toast('No speech detected', 'info'); } else if (e.error === 'audio-capture') { toast('No microphone found', 'error'); } else if (e.error === 'not-allowed') { toast('Microphone access denied', 'error'); } else if (e.error === 'network') { toast('Network error with voice', 'error'); } else if (e.error !== 'aborted') { toast('Voice failed: ' + e.error, 'error'); }
    };
}

function toggleMic() {
    if (!state.recognition) { initVoice(); if (!state.recognition) { toast('Voice not supported', 'error'); return; } }
    if (state.isListening) { state.recognition.stop(); } else { try { state.recognition.start(); } catch (err) { toast('Could not start mic: ' + err.message, 'error'); } }
}

// ============================================================
// SETTINGS
// ============================================================

function initSettings() {
    const ta = document.getElementById('custom-instructions');
    if (ta) ta.value = state.customInstructions;
    document.querySelectorAll('.style-chip').forEach(chip => {
        if (chip) chip.classList.toggle('active', chip.dataset.style === state.responseStyle);
    });
    const autoTtsToggle = document.getElementById('auto-tts-toggle');
    if (autoTtsToggle) autoTtsToggle.checked = state.autoTts;
}

function openSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    const main = document.getElementById('settings-main');
    if (main) main.style.display = 'flex';
    document.querySelectorAll('.settings-sub').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
    syncSettingsValues();
    closeSidebar();
}

function closeSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    if (panel) panel.classList.add('hidden');
}

function syncSettingsValues() {
    const tier = state.proCode ? 'Pro' : 'Free';
    const tierEl = document.getElementById('settings-tier-value');
    if (tierEl) tierEl.textContent = tier;
    const profilePlan = document.getElementById('profile-plan-value');
    if (profilePlan) profilePlan.textContent = tier;
    const profileUserId = document.getElementById('profile-user-id');
    if (profileUserId) profileUserId.textContent = state.userId || '';
    const profileIdVal = document.getElementById('profile-id-value');
    if (profileIdVal) profileIdVal.textContent = state.userId || '';
    const themeNames = { dark: 'Dark', light: 'Light', veyronis: 'Veyronis' };
    const themeVal = document.getElementById('settings-theme-value');
    if (themeVal) themeVal.textContent = themeNames[currentTheme] || 'Dark';
    const voiceVal = document.getElementById('settings-voice-value');
    if (voiceVal) voiceVal.textContent = state.ttsEnabled ? 'On' : 'Off';
    const ci = document.getElementById('settings-custom-instructions');
    if (ci) ci.value = state.customInstructions || '';
    document.querySelectorAll('.style-chip').forEach(chip => {
        if (chip) chip.classList.toggle('active', chip.dataset.style === state.responseStyle);
    });
    document.querySelectorAll('.radio-circle').forEach(r => r.classList.remove('checked'));
    const activeRadio = document.getElementById('radio-' + currentTheme);
    if (activeRadio) activeRadio.classList.add('checked');
    const proBtn = document.getElementById('plan-btn-pro');
    const proCard = document.getElementById('plan-card-pro');
    if (state.proCode) {
        if (proBtn) { proBtn.textContent = 'Active'; proBtn.disabled = true; }
        if (proCard) proCard.style.borderColor = '#22c55e';
    }
}

function openSettingsSub(id) {
    const sub = document.getElementById('settings-sub-' + id);
    if (!sub) return;
    sub.classList.remove('hidden');
    void sub.offsetWidth;
    sub.classList.add('active');
    if (id === 'chat-prefs') {
        const ci = document.getElementById('settings-custom-instructions');
        if (ci) ci.value = state.customInstructions || '';
        document.querySelectorAll('.style-chip').forEach(chip => {
            if (chip) chip.classList.toggle('active', chip.dataset.style === state.responseStyle);
        });
    }
    if (id === 'theme') {
        document.querySelectorAll('.radio-circle').forEach(r => r.classList.remove('checked'));
        const activeRadio = document.getElementById('radio-' + currentTheme);
        if (activeRadio) activeRadio.classList.add('checked');
    }
}

function closeSettingsSub() {
    document.querySelectorAll('.settings-sub.active').forEach(s => {
        s.classList.remove('active');
        setTimeout(() => s.classList.add('hidden'), 300);
    });
}

function setTheme(theme) {
    if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = prefersDark ? 'dark' : 'light';
    } else { currentTheme = theme; }
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('veyronis_theme', currentTheme);
    updateChartDefaults();
    document.querySelectorAll('.radio-circle').forEach(r => r.classList.remove('checked'));
    const activeRadio = document.getElementById('radio-' + theme);
    if (activeRadio) activeRadio.classList.add('checked');
    const themeVal = document.getElementById('settings-theme-value');
    if (themeVal) { themeVal.textContent = theme === 'system' ? 'Follow System' : (theme.charAt(0).toUpperCase() + theme.slice(1)); }
    toast(`Theme: ${theme === 'system' ? 'Follow System' : theme.charAt(0).toUpperCase() + theme.slice(1)}`, 'success');
}

function toggleSettingsVoice() {
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem('veyronis_tts', state.ttsEnabled);
    const voiceVal = document.getElementById('settings-voice-value');
    if (voiceVal) voiceVal.textContent = state.ttsEnabled ? 'On' : 'Off';
    toast(state.ttsEnabled ? 'Voice ON' : 'Voice OFF', 'success');
}

function saveChatPreferences() {
    const ci = document.getElementById('settings-custom-instructions');
    state.customInstructions = ci ? ci.value.trim() : '';
    localStorage.setItem('veyronis_custom_instructions', state.customInstructions);
    closeSettingsSub();
    toast('Chat preferences saved', 'success');
}

function pickStyle(style) {
    state.responseStyle = style;
    localStorage.setItem('veyronis_response_style', style);
    document.querySelectorAll('.style-chip').forEach(chip => {
        if (chip) chip.classList.toggle('active', chip.dataset.style === style);
    });
    toast('Style: ' + style.charAt(0).toUpperCase() + style.slice(1), 'success');
}

function submitFeedback() {
    const fb = document.getElementById('feedback-text');
    const text = fb ? fb.value.trim() : '';
    if (!text) { toast('Please enter your feedback', 'error'); return; }
    console.log('[VEYRONIS] Feedback:', text);
    fb.value = '';
    closeSettingsSub();
    toast('Thank you for your feedback!', 'success');
}

function activateProPlan() {
    closeSettingsPanel();
    setTimeout(() => {
        const code = prompt('Enter Pro activation code:');
        if (code && code.trim()) {
            state.proCode = code.trim();
            fetch(state.apiUrl + '/health')
                .then(r => r.json())
                .then(() => { setProUi(); toast('Pro activated!', 'success'); })
                .catch(() => toast('Cannot verify Pro code', 'error'));
        }
    }, 300);
}

function logout() {
    if (!confirm('Log out?')) return;
    localStorage.removeItem('veyronis_uid');
    localStorage.removeItem('veyronis_custom_instructions');
    localStorage.removeItem('veyronis_response_style');
    localStorage.removeItem('veyronis_auto_tts');
    state.userId = genUid();
    state.conversationId = null;
    state.customInstructions = '';
    state.responseStyle = 'balanced';
    state.autoTts = false;
    state.proCode = '';
    const msgs = document.getElementById('messages');
    if (msgs) msgs.innerHTML = '';
    showEmpty(true);
    closeSettingsPanel();
    loadConversations();
    toast('Logged out', 'success');
}

// ============================================================
// CANVAS
// ============================================================

let canvasState = {
    isDrawing: false,
    lastX: 0,
    lastY: 0,
    tool: 'pen',
    color: '#a78bfa',
    size: 3,
    history: [],
    historyIndex: -1,
    isPro: false
};

function openCanvas() {
    if (!state.proCode && state.proCode !== 'DEV-MODE-2026') { toast('Canvas is Pro feature', 'info'); return; }
    canvasState.isPro = true;
    let overlay = document.getElementById('canvas-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'canvas-overlay';
        overlay.className = 'canvas-overlay hidden';
        overlay.innerHTML = `
            <div class="canvas-header">
                <div class="canvas-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                        <path d="M2 17l10 5 10-5"/>
                        <path d="M2 12l10 5 10-5"/>
                    </svg>
                    <span>Whiteboard</span>
                    <span class="canvas-pro-tag">PRO</span>
                </div>
                <div class="canvas-header-actions">
                    <button class="canvas-header-btn" onclick="undoCanvas()" title="Undo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
                    <button class="canvas-header-btn" onclick="redoCanvas()" title="Redo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg></button>
                    <button class="canvas-header-btn" onclick="clearCanvas()" title="Clear"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                    <button class="canvas-header-btn close" onclick="closeCanvas()" title="Close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
            </div>
            <div class="canvas-body">
                <canvas id="whiteboard" class="whiteboard"></canvas>
                <div class="canvas-toolbar">
                    <button class="canvas-tool active" data-tool="pen" onclick="setCanvasTool('pen')" title="Pen"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg></button>
                    <button class="canvas-tool" data-tool="eraser" onclick="setCanvasTool('eraser')" title="Eraser"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7l-5-5 8-8 10 10-5 5z"/><path d="M6.5 13.5l8-8"/></svg></button>
                    <div class="canvas-tool-sep"></div>
                    <button class="canvas-tool" onclick="pickCanvasColor()" title="Color"><div class="color-swatch" id="canvas-color-swatch" style="background:#a78bfa;"></div></button>
                    <button class="canvas-tool" onclick="cycleCanvasSize()" title="Size"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" opacity="0.4"/></svg></button>
                </div>
            </div>
            <div class="canvas-prompt-bar">
                <input id="canvas-prompt" placeholder="Describe what you want to draw..." />
                <button class="canvas-send" onclick="generateCanvasDrawing()" title="Generate"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => initCanvas());
}

function closeCanvas() {
    const overlay = document.getElementById('canvas-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function initCanvas() {
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvasState.history = [];
    canvasState.historyIndex = -1;
    saveCanvasState();
    canvas.removeEventListener('mousedown', startDraw);
    canvas.removeEventListener('mousemove', draw);
    canvas.removeEventListener('mouseup', endDraw);
    canvas.removeEventListener('mouseleave', endDraw);
    canvas.removeEventListener('touchstart', handleTouchStart);
    canvas.removeEventListener('touchmove', handleTouchMove);
    canvas.removeEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', endDraw);
    canvas.addEventListener('mouseleave', endDraw);
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
}

function saveCanvasState() {
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const dataUrl = canvas.toDataURL();
    canvasState.history = canvasState.history.slice(0, canvasState.historyIndex + 1);
    canvasState.history.push(dataUrl);
    canvasState.historyIndex = canvasState.history.length - 1;
}

function restoreCanvasState(index) {
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0); };
    img.src = canvasState.history[index];
}

function startDraw(e) {
    canvasState.isDrawing = true;
    const rect = e.target.getBoundingClientRect();
    canvasState.lastX = e.clientX - rect.left;
    canvasState.lastY = e.clientY - rect.top;
}
function draw(e) {
    if (!canvasState.isDrawing) return;
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(canvasState.lastX, canvasState.lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = canvasState.tool === 'eraser' ? '#ffffff' : canvasState.color;
    ctx.lineWidth = canvasState.tool === 'eraser' ? canvasState.size * 3 : canvasState.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    canvasState.lastX = x;
    canvasState.lastY = y;
}
function endDraw() {
    if (canvasState.isDrawing) { canvasState.isDrawing = false; saveCanvasState(); }
}
function handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvasState.isDrawing = true;
    canvasState.lastX = touch.clientX - rect.left;
    canvasState.lastY = touch.clientY - rect.top;
}
function handleTouchMove(e) {
    e.preventDefault();
    if (!canvasState.isDrawing) return;
    const touch = e.touches[0];
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(canvasState.lastX, canvasState.lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = canvasState.tool === 'eraser' ? '#ffffff' : canvasState.color;
    ctx.lineWidth = canvasState.tool === 'eraser' ? canvasState.size * 3 : canvasState.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    canvasState.lastX = x;
    canvasState.lastY = y;
}
function handleTouchEnd(e) {
    e.preventDefault();
    if (canvasState.isDrawing) { canvasState.isDrawing = false; saveCanvasState(); }
}

function setCanvasTool(tool) {
    canvasState.tool = tool;
    document.querySelectorAll('.canvas-tool[data-tool]').forEach(el => {
        if (el) el.classList.toggle('active', el.dataset.tool === tool);
    });
    const canvas = document.getElementById('whiteboard');
    if (canvas) canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}
function pickCanvasColor() {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = canvasState.color;
    input.onchange = (e) => {
        canvasState.color = e.target.value;
        const swatch = document.getElementById('canvas-color-swatch');
        if (swatch) swatch.style.background = canvasState.color;
        if (canvasState.tool === 'eraser') setCanvasTool('pen');
    };
    input.click();
}
function cycleCanvasSize() {
    const sizes = [2, 4, 6, 10, 16];
    const current = sizes.indexOf(canvasState.size);
    const next = (current + 1) % sizes.length;
    canvasState.size = sizes[next];
    toast('Size: ' + canvasState.size + 'px', 'info');
}
function undoCanvas() {
    if (canvasState.historyIndex > 0) { canvasState.historyIndex--; restoreCanvasState(canvasState.historyIndex); }
}
function redoCanvas() {
    if (canvasState.historyIndex < canvasState.history.length - 1) { canvasState.historyIndex++; restoreCanvasState(canvasState.historyIndex); }
}
function clearCanvas() {
    if (!confirm('Clear the whiteboard?')) return;
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    saveCanvasState();
}
async function generateCanvasDrawing() {
    const input = document.getElementById('canvas-prompt');
    if (!input) return;
    const prompt = input.value.trim();
    if (!prompt) { toast('Describe what to draw', 'info'); return; }
    toast('Generating...', 'info');
    input.disabled = true;
    const sendBtn = document.querySelector('.canvas-send');
    if (sendBtn) sendBtn.disabled = true;
    try {
        const response = await fetch(state.apiUrl + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: prompt,
                pro_code: state.proCode || '',
                user_id: state.userId || '',
                mode: 'canvas',
                model_mode: state.model,
                ai_model: state.aiModel
            })
        });
        const data = await response.json();
        if (data.response) { showCanvasInstructions(data.response); } else { toast('No response', 'error'); }
    } catch (err) { toast('Generation failed: ' + err.message, 'error'); }
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    input.value = '';
}
function showCanvasInstructions(text) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-backdrop" onclick="this.parentElement.remove()"></div>
        <div class="modal-card" style="max-width:600px;">
            <div class="modal-header">
                <div class="modal-title">🎨 Drawing Instructions</div>
                <button class="modal-close" onclick="this.closest('.modal').remove()">✕</button>
            </div>
            <div class="modal-body" style="max-height:60vh;overflow-y:auto;white-space:pre-wrap;font-size:14px;line-height:1.8;">${escapeHtml(text)}</div>
            <div class="modal-footer">
                <button class="modal-btn primary" onclick="this.closest('.modal').remove()">Got it</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// ============================================================
// CONNECTIVITY & PWA
// ============================================================

function initConnectivity() {
    window.addEventListener('online', () => {
        state.isOnline = true;
        document.body.classList.remove('offline');
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.add('hidden');
        toast('Back online', 'success');
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage('flush-queue');
        }
        if (state.apiUrl) checkServerHealth();
    });
    window.addEventListener('offline', () => {
        state.isOnline = false;
        document.body.classList.add('offline');
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.remove('hidden');
        toast('You are offline', 'error');
    });
    if (!navigator.onLine) {
        document.body.classList.add('offline');
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.remove('hidden');
    }
}

function retryConnection() {
    toast('Checking connection...', 'info');
    if (navigator.onLine && state.apiUrl) { checkServerHealth(); } else if (!navigator.onLine) { toast('Still offline', 'error'); }
}

function checkServerHealth() {
    updateConnStatus('checking');
    if (!state.apiUrl) return;
    fetch(state.apiUrl + '/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        .then(r => { if (!r.ok) throw new Error('Server error'); return r.json(); })
        .then(data => {
            if (data.status && data.status.includes('online')) {
                state.isOnline = true;
                state.serverStatus = 'online';
                state.retryCount = 0;
                document.body.classList.remove('offline');
                const banner = document.getElementById('offline-banner');
                if (banner) banner.classList.add('hidden');
                updateConnStatus('online');
            } else { updateConnStatus('error'); }
        })
        .catch(() => {
            state.serverStatus = 'error';
            updateConnStatus('error');
            if (state.retryCount === 0) toast('Server unreachable. Retrying...', 'error');
            state.retryCount++;
        });
}

function initInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        state.deferredPrompt = e;
        setTimeout(() => {
            if (!localStorage.getItem('veyronis_install_dismissed')) {
                const promptEl = document.getElementById('install-prompt');
                if (promptEl) promptEl.classList.remove('hidden');
            }
        }, 30000);
    });
    window.addEventListener('appinstalled', () => {
        state.deferredPrompt = null;
        const promptEl = document.getElementById('install-prompt');
        if (promptEl) promptEl.classList.add('hidden');
        toast('VEYRONIS installed! 🎉', 'success');
    });
}

function installPwa() {
    if (!state.deferredPrompt) { toast('Install not available', 'info'); return; }
    state.deferredPrompt.prompt();
    state.deferredPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') toast('Installing...', 'success');
        state.deferredPrompt = null;
        const promptEl = document.getElementById('install-prompt');
        if (promptEl) promptEl.classList.add('hidden');
    });
}

function dismissInstall() {
    localStorage.setItem('veyronis_install_dismissed', 'true');
    const promptEl = document.getElementById('install-prompt');
    if (promptEl) promptEl.classList.add('hidden');
}

function toast(msg, type) {
    const box = document.getElementById('toast-box');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    if (type === 'error') div.style.borderColor = 'rgba(239,68,68,0.4)';
    if (type === 'success') div.style.borderColor = 'rgba(34,197,94,0.4)';
    box.appendChild(div);
    setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateY(-10px)';
        setTimeout(() => div.remove(), 300);
    }, 3000);
}