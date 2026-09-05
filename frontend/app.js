// ============================================================
// VEYRONIS — FULL APPLICATION (v2.0 COMPLETE)
// All fixes: Chat loading, Profile, Custom IDs, Feedback, etc.
// ============================================================

const state = {
    apiUrl: (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:8000' : 'https://veyronis.onrender.com',
    token: localStorage.getItem('veyronis_token') || null,
    user: JSON.parse(localStorage.getItem('veyronis_user') || 'null'),
    userId: '',
    displayId: '',
    model: 'instant',
    aiModel: 'groq',
    isTyping: false,
    isListening: false,
    recognition: null,
    msgCount: 0,
    editingId: null,
    conversationId: null,
    isNewChat: false,
    pendingImageBase64: null,
    pendingImageDataUrl: null,
    pendingImageFilename: null,
    pendingDocContent: null,
    pendingDocFilename: null,
    abortController: null,
    ttsEnabled: localStorage.getItem('veyronis_tts') !== 'false',
    autoTts: localStorage.getItem('veyronis_auto_tts') === 'true',
    speakingId: null,
    isSpeaking: false,
    currentUtterance: null,
    citations: {},
    customInstructions: localStorage.getItem('veyronis_custom_instructions') || '',
    responseStyle: localStorage.getItem('veyronis_response_style') || 'balanced',
    isOnline: navigator.onLine,
    deferredPrompt: null,
    serverStatus: 'unknown',
    retryCount: 0,
    isAuthenticated: false,
    simulationMode: false,
    simulationCount: parseInt(localStorage.getItem('veyronis_sim_count') || '0'),
    simulationDate: localStorage.getItem('veyronis_sim_date') || '',
    adminUsers: []
};

const THEMES = ['dark', 'light', 'veyronis'];
let currentTheme = localStorage.getItem('veyronis_theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

// ─── TOAST ───
function toast(message, type = 'info') {
    const container = document.getElementById('toast-box');
    if (!container) return;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toastEl = document.createElement('div');
    toastEl.className = `toast ${type}`;
    toastEl.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-message">${message}</span>`;
    container.appendChild(toastEl);
    setTimeout(() => {
        toastEl.style.opacity = '0';
        toastEl.style.transform = 'translateY(-10px)';
        setTimeout(() => toastEl.remove(), 300);
    }, 3000);
}

// ─── MODAL SYSTEM ───
function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('hidden');
        // Remove any inline display override so CSS can take over
        modal.style.display = '';
        // Force reflow to paint immediately
        modal.offsetHeight;
    }
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = '';
    }
    document.body.style.overflow = '';
}
    document.body.style.overflow = '';

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(modal => {
            closeModal(modal.id);
        });
    }
});

// ─── CUSTOM CONFIRM ───
let confirmCallback = null;
function showConfirm(title, message) {
    return new Promise((resolve) => {
        document.getElementById('confirm-title').textContent = title || 'Confirm';
        document.getElementById('confirm-message').textContent = message || 'Are you sure?';
        confirmCallback = resolve;
        openModal('modal-confirm');
    });
}
function resolveConfirm(result) {
    closeModal('modal-confirm');
    if (confirmCallback) { confirmCallback(result); confirmCallback = null; }
}
window.confirm = function(message) { return showConfirm('Confirm', message); };

// ─── CUSTOM PROMPT ───
let promptCallback = null;
function showPrompt(title, message, defaultValue = '') {
    return new Promise((resolve) => {
        document.getElementById('prompt-title').textContent = title || 'Enter value';
        document.getElementById('prompt-message').textContent = message || '';
        document.getElementById('prompt-input').value = defaultValue || '';
        promptCallback = resolve;
        openModal('modal-prompt');
        setTimeout(() => document.getElementById('prompt-input').focus(), 100);
    });
}
function resolvePrompt(result) {
    closeModal('modal-prompt');
    if (promptCallback) { promptCallback(result); promptCallback = null; }
}
window.prompt = function(message, defaultValue) { return showPrompt('Enter value', message, defaultValue); };
document.getElementById('prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') resolvePrompt(document.getElementById('prompt-input').value.trim());
});

// ─── ERROR HANDLER ───
function handleError(error, context = '') {
    console.error(`[ERROR] ${context}:`, error);
    if (!navigator.onLine || error.message === 'Failed to fetch') {
        toast('📡 You\'re offline. Please check your connection.', 'error');
        return;
    }
    if (error.status === 500 || error.status === 502 || error.status === 503) {
        toast('🔧 Something went wrong. Please try again in a few minutes.', 'error');
        return;
    }
    if (error.status === 429) {
        toast('⏳ You\'re moving too fast! Please wait a moment.', 'error');
        return;
    }
    if (error.status === 401) {
        toast('🔒 Please log in again to continue.', 'error');
        return;
    }
    toast('😕 Something unexpected happened. Please try again.', 'error');
}

// ─── UPDATE USAGE ───
function updateUsageDisplay() {
    const disclaimer = document.getElementById('input-disclaimer');
    if (!disclaimer) return;
    if (state.user?.is_pro) {
        disclaimer.innerHTML = 'PRO MODE <span style="color:#fbbf24">★</span> · Unlimited messages';
    } else {
        const remaining = state.user?.remaining !== undefined ? state.user.remaining : 20;
        disclaimer.textContent = `Free: ${20 - remaining}/${20} today · VEYRONIS can make mistakes`;
    }
}

function showLoading(message = 'Loading...') {
    const existing = document.getElementById('loading-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
        <div style="text-align:center;">
            <div class="loading-spinner"></div>
            <div style="margin-top:16px;color:var(--text-secondary);font-size:14px;">${message}</div>
        </div>
    `;
    document.body.appendChild(overlay);
}
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.remove();
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollBottom() {
    const sc = document.getElementById('chat-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
}

// ─── AUTH FUNCTIONS ───
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(el => el.classList.remove('active'));
    document.querySelector(`.auth-tab[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`auth-${tab}`).classList.add('active');
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
}

async function handleLogin() {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value.trim();
    const errorEl = document.getElementById('login-error');
    if (!email || !password) { errorEl.textContent = '📝 Please enter email and password'; return; }
    showLoading('Logging in...');
    try {
        const res = await fetch(`${state.apiUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        hideLoading();
        if (!res.ok) { const err = new Error(data.detail || 'Login failed'); err.status = res.status; throw err; }
        state.token = data.access_token;
        state.user = data.user;
        state.userId = data.user.email;
        state.displayId = data.user.display_id || 'N/A';
        localStorage.setItem('veyronis_token', state.token);
        localStorage.setItem('veyronis_user', JSON.stringify(state.user));
        state.isAuthenticated = true;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        initApp();
        toast('🎉 Welcome back, ' + data.user.email + '!', 'success');
        setTimeout(checkAdminStatus, 500);
    } catch (err) {
        hideLoading();
        handleError(err, 'Login');
        if (err.message && err.message.includes('Invalid credentials')) {
            errorEl.textContent = '🔐 Invalid email or password. Please try again.';
        } else {
            errorEl.textContent = '😕 Login failed. Please try again.';
            setTimeout(() => {
    refreshUserInfo();
    updateUsageDisplay(); // ✅ force update
}, 300);
        }
    }
}



async function handleRegister() {
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value.trim();
    const errorEl = document.getElementById('register-error');
    if (!email || !password) { errorEl.textContent = '📝 Please enter email and password'; return; }
    if (password.length < 6) { errorEl.textContent = '🔑 Password must be at least 6 characters'; return; }
    if (!email.includes('@') || !email.includes('.')) { errorEl.textContent = '📧 Please enter a valid email address'; return; }
    showLoading('Creating account...');
    try {
        const res = await fetch(`${state.apiUrl}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        hideLoading();
        if (!res.ok) { const err = new Error(data.detail || 'Registration failed'); err.status = res.status; throw err; }
        state.token = data.access_token;
        state.user = data.user;
        state.userId = data.user.email;
        state.displayId = data.user.display_id || 'N/A';
        localStorage.setItem('veyronis_token', state.token);
        localStorage.setItem('veyronis_user', JSON.stringify(state.user));
        state.isAuthenticated = true;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        initApp();
        toast('🎉 Account created! Welcome to VEYRONIS!', 'success');
        setTimeout(checkAdminStatus, 500);
        // Force refresh user info after registration
setTimeout(() => {
    refreshUserInfo();
}, 300); updateUsageDisplay();

    } catch (err) {
        hideLoading();
        handleError(err, 'Register');
        if (err.message && err.message.includes('already registered')) {
            errorEl.textContent = '📧 This email is already registered. Please log in.';
        } else {
            errorEl.textContent = '😕 Registration failed. Please try again.';
        }
    }
}

function checkAuth() {
    const token = localStorage.getItem('veyronis_token');
    const user = JSON.parse(localStorage.getItem('veyronis_user') || 'null');
    if (token && user) {
        state.token = token;
        state.user = user;
        state.userId = user.email;
        state.displayId = user.display_id || 'N/A';
        state.isAuthenticated = true;
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        initApp();
        setTimeout(checkAdminStatus, 500);
        return true;
    }
    return false;
}

function handleLogout() {
    showConfirm('Logout', 'Are you sure you want to logout?').then(confirmed => {
        if (confirmed) {
            localStorage.removeItem('veyronis_token');
            localStorage.removeItem('veyronis_user');
            state.token = null;
            state.user = null;
            state.userId = '';
            state.displayId = '';
            state.isAuthenticated = false;
            document.getElementById('app').classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
            toast('👋 Logged out', 'info');
            document.getElementById('messages').innerHTML = '';
            showEmpty(true);
        }
    });
}

function handleGoogleLogin() {
    window.location.href = `${state.apiUrl}/auth/google`;
}

function handleGoogleCallback() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('auth=')) return;
    const params = new URLSearchParams(hash.substring(1));
    const status = params.get('auth');
    if (status === 'success') {
        const token = params.get('token');
        const email = params.get('user');
        const isPro = params.get('is_pro') === 'true';
        const name = params.get('name') || email?.split('@')[0] || 'User';
        const avatar = params.get('avatar') || null;
        if (token && email) {
            state.token = token;
            state.user = { email, is_pro: isPro, name, avatar_url: avatar, auth_method: 'google' };
            state.userId = email;
            state.isAuthenticated = true;
            localStorage.setItem('veyronis_token', token);
            localStorage.setItem('veyronis_user', JSON.stringify(state.user));
            window.history.replaceState({}, document.title, window.location.pathname);
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            initApp();
            toast('🎉 Welcome ' + name + '! Logged in with Google!', 'success');
            setTimeout(checkAdminStatus, 500);
        }
    } else if (status === 'error') {
        const message = params.get('message') || 'Google login failed';
        toast('😕 Google login failed: ' + decodeURIComponent(message), 'error');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function showForgotPassword() {
    openModal('modal-forgot');
    document.getElementById('reset-email').value = '';
    document.getElementById('reset-error').classList.add('hidden');
}
function closeForgotPassword() { closeModal('modal-forgot'); }

async function sendResetLink() {
    const email = document.getElementById('reset-email').value.trim();
    const errorEl = document.getElementById('reset-error');
    if (!email) {
        errorEl.textContent = '📝 Please enter your email';
        errorEl.classList.remove('hidden');
        return;
    }
    errorEl.classList.add('hidden');

    // Disable button during request
    const btn = document.querySelector('#modal-forgot .modal-btn.primary');
    const originalText = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
        const res = await fetch(`${state.apiUrl}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Failed to send reset link');
        }
        toast('📧 Reset link sent! Check your email.', 'success');
        closeModal('modal-forgot');
        document.getElementById('reset-email').value = '';
    } catch (err) {
        handleError(err, 'Forgot Password');
        errorEl.textContent = err.message || 'Something went wrong. Please try again.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

function handleResetPasswordHash() {
    const hash = window.location.hash;
    if (hash && hash.includes('reset-password')) {
        const params = new URLSearchParams(hash.replace('#reset-password?', ''));
        const token = params.get('token');
        if (token) {
            document.getElementById('reset-token-input').value = token;
            openModal('modal-reset');
        }
    }
}

// ─── EMAIL VERIFICATION HANDLER ───
function handleEmailVerificationHash() {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith('#email-verified')) return;

    const params = new URLSearchParams(hash.replace('#email-verified?', ''));
    const token = params.get('token');

    if (!token) {
        toast('❌ Invalid verification link.', 'error');
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
    }

    showLoading('Verifying your email...');

    fetch(`${state.apiUrl}/api/verify-email?token=${encodeURIComponent(token)}`)
        .then(async response => {
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.detail || 'Verification failed');
            }
            return response.json();
        })
        .then(data => {
            hideLoading();
            toast(`✅ Email verified for ${data.email}!`, 'success');
            window.history.replaceState({}, document.title, window.location.pathname);
            if (state.isAuthenticated) {
                refreshUserInfo();
            } else {
                switchAuthTab('login');
            }
        })
        .catch(err => {
            hideLoading();
            toast('❌ Verification failed: ' + err.message, 'error');
            window.history.replaceState({}, document.title, window.location.pathname);
        });
}

async function submitResetPassword() {
    const token = document.getElementById('reset-token-input').value;
    const newPass = document.getElementById('new-password').value.trim();
    const confirmPass = document.getElementById('confirm-password').value.trim();
    const errorEl = document.getElementById('reset-error2');
    if (!token) { errorEl.textContent = '🔗 Invalid reset link'; errorEl.classList.remove('hidden'); return; }
    if (!newPass || newPass.length < 6) { errorEl.textContent = '🔑 Password must be at least 6 characters'; errorEl.classList.remove('hidden'); return; }
    if (newPass !== confirmPass) { errorEl.textContent = '🔑 Passwords do not match'; errorEl.classList.remove('hidden'); return; }
    errorEl.classList.add('hidden');
    try {
        const res = await fetch(`${state.apiUrl}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, new_password: newPass })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Failed to reset password');
        toast('✅ Password reset successfully! Please log in.', 'success');
        closeModal('modal-reset');
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        document.getElementById('app').classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');
        switchAuthTab('login');
    } catch (err) {
        handleError(err, 'Reset Password');
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
    }
}

// ─── API HELPER ───
async function authenticatedFetch(endpoint, options = {}) {
    const headers = { ...options.headers };
    
    // Don't set Content-Type for FormData – browser will set it with boundary
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    
    if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }
    
    const res = await fetch(`${state.apiUrl}${endpoint}`, { 
        ...options, 
        headers 
    });
    return res;
}

// ─── CONNECTION STATUS ───
function updateConnStatus(status) {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    const wrap = document.getElementById('conn-status-wrap');
    if (!dot || !label || !wrap) return;
    dot.classList.remove('online', 'offline', 'error', 'checking');
    wrap.classList.remove('online', 'offline', 'error', 'checking');
    if (status === 'online') {
        dot.classList.add('online'); wrap.classList.add('online'); label.textContent = 'Connected';
    } else if (status === 'offline') {
        dot.classList.add('offline'); wrap.classList.add('offline'); label.textContent = 'Offline';
    } else if (status === 'error') {
        dot.classList.add('error'); wrap.classList.add('error'); label.textContent = 'Server Error';
    } else {
        dot.classList.add('checking'); wrap.classList.add('checking'); label.textContent = 'Connecting...';
    }
}

function checkServerHealth() {
    updateConnStatus('checking');
    if (!state.apiUrl) return;
    fetch(`${state.apiUrl}/health`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
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
            if (state.retryCount === 0) toast('🔧 Server unreachable. Retrying...', 'error');
            state.retryCount++;
        });
}

function retryConnection() {
    toast('🔄 Checking connection...', 'info');
    if (navigator.onLine && state.apiUrl) checkServerHealth();
    else if (!navigator.onLine) toast('📡 Still offline', 'error');
}

// ─── SIDEBAR ───
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) { closeSidebar(); }
    else { sidebar.classList.add('open'); if (backdrop) backdrop.classList.add('active'); document.body.style.overflow = 'hidden'; }
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
    document.body.style.overflow = '';
}

function loadConversations() {
    if (!state.apiUrl || !state.userId) return;
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    fetch(`${state.apiUrl}/conversations?user_id=${encodeURIComponent(state.userId)}`, { headers })
        .then(r => { if (!r.ok) throw new Error('Failed to load conversations'); return r.json(); })
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
            document.getElementById('conv-list-today').innerHTML = today.join('') || '<div class="conv-empty">No chats today</div>';
            document.getElementById('conv-list-yesterday').innerHTML = yesterday.join('') || '';
            document.getElementById('conv-list-week').innerHTML = week.join('') || '';
            if (convs.length && !state.conversationId && !state.isNewChat) {
                switchConversation(convs[0].id);
            } else if (!convs.length) { showEmpty(true); }
            state.isNewChat = false;
        })
        .catch(err => {
            console.error('[Sidebar] Error loading conversations:', err);
            document.getElementById('conv-list-today').innerHTML = '<div class="conv-error">⚠️ Could not load chats</div>';
        });
}

function makeConvItem(c) {
    const isActive = state.conversationId === c.id ? 'active' : '';
    const isArchived = c.is_archived ? 'archived' : '';
    const safeTitle = escapeHtml(c.title || 'New Chat').replace(/'/g, "\\'");
    return `<div class="conv-item ${isActive} ${isArchived}" data-id="${c.id}" onclick="switchConversation(${c.id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="conv-title">${safeTitle}</span>
        <div class="conv-actions">
            <button class="conv-action" onclick="event.stopPropagation(); renameConvPrompt(${c.id}, '${safeTitle}')" title="Rename">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
            </button>
            <button class="conv-action" onclick="event.stopPropagation(); deleteConv(${c.id})" title="Delete">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>
    </div>`;
}

function switchConversation(id) {
    // Check if archived
    const convItem = document.querySelector(`.conv-item[data-id="${id}"]`);
    if (convItem && convItem.classList.contains('archived')) {
        toast('📂 This chat is archived. Please restore it to access.', 'info');
        return;
    }

    state.conversationId = parseInt(id);
    // Show skeleton
    document.getElementById('messages').innerHTML = `
        <div class="skeleton"><div class="skeleton-line"></div><div class="skeleton-line medium"></div></div>
        <div class="skeleton"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
    `;
    loadHistory();
    loadConversations(); // highlight
    closeSidebar();
}

async function renameConvPrompt(id, currentTitle) {
    const newTitle = await showPrompt('Rename Conversation', 'Enter new title:', currentTitle);
    if (newTitle === null || newTitle === undefined || newTitle.trim() === '' || newTitle.trim() === currentTitle) return;
    try {
        const res = await authenticatedFetch(`/conversations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ title: newTitle.trim() })
        });
        if (res.ok) { toast('✅ Renamed', 'success'); loadConversations(); }
        else { const err = await res.json(); toast('❌ ' + (err.detail || 'Failed to rename'), 'error'); }
    } catch (err) { handleError(err, 'Rename'); }
}

async function deleteConv(id) {
    const confirmed = await showConfirm('Delete Conversation', 'Are you sure you want to delete this conversation?');
    if (!confirmed) return;
    try {
        const res = await authenticatedFetch(`/conversations/${id}`, { method: 'DELETE' });
        if (res.ok) {
            toast('🗑️ Deleted', 'success');
            if (state.conversationId === id) {
                state.conversationId = null;
                document.getElementById('messages').innerHTML = '';
                showEmpty(true);
            }
            loadConversations();
        } else { const err = await res.json(); toast('❌ ' + (err.detail || 'Failed to delete'), 'error'); }
    } catch (err) { handleError(err, 'Delete'); }
}

function toggleArchived() {
    const list = document.getElementById('archived-list');
    const chevron = document.getElementById('archived-chevron');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    list.style.display = isHidden ? 'block' : 'none';
    if (chevron) chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    if (isHidden) loadArchivedConversations();
}

function loadArchivedConversations() {
    if (!state.userId) return;
    authenticatedFetch('/conversations/archived')
        .then(r => { if (!r.ok) throw new Error('Failed to load archived'); return r.json(); })
        .then(data => {
            const convs = data.conversations || [];
            const list = document.getElementById('archived-list');
            if (!list) return;
            if (convs.length === 0) { list.innerHTML = '<div class="conv-empty">📦 No archived chats</div>'; return; }
            list.innerHTML = convs.map(c => makeArchivedConvItem(c)).join('');
        })
        .catch(err => console.error('[Archived] Error:', err));
}

function makeArchivedConvItem(c) {
    const safeTitle = escapeHtml(c.title || 'New Chat').replace(/'/g, "\\'");
    return `<div class="conv-item archived" data-id="${c.id}" style="opacity: 0.7;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span class="conv-title">${safeTitle}</span>
        <div class="conv-actions">
            <button class="conv-action" onclick="event.stopPropagation(); unarchiveConv(${c.id})" title="Unarchive">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="1 4 1 10 7 10"/>
                    <polyline points="23 20 23 14 17 14"/>
                    <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                </svg>
            </button>
            <button class="conv-action" onclick="event.stopPropagation(); deleteConv(${c.id})" title="Delete">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
            </button>
        </div>
    </div>`;
}

async function unarchiveConv(id) {
    try {
        const res = await authenticatedFetch(`/conversations/${id}/unarchive`, { method: 'PATCH' });
        if (res.ok) { toast('📂 Conversation restored', 'success'); loadConversations(); loadArchivedConversations(); }
        else { const err = await res.json(); toast('❌ ' + (err.detail || 'Failed to unarchive'), 'error'); }
    } catch (err) { handleError(err, 'Unarchive'); }
}

function newChat() {
    state.conversationId = null;
    state.isNewChat = true;
    document.getElementById('messages').innerHTML = '';
    showEmpty(true);
    loadConversations();
    closeSidebar();
}

// ─── MORE MENU ───
function toggleMoreMenu() {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.toggle('open');
}
function closeMoreMenu() {
    const menu = document.getElementById('more-menu');
    if (menu) menu.classList.remove('open');
}
function renameCurrentConv() {
    if (!state.conversationId) { toast('📝 No conversation to rename', 'error'); return; }
    const convItem = document.querySelector(`.conv-item[data-id="${state.conversationId}"]`);
    const title = convItem ? convItem.querySelector('.conv-title')?.textContent || 'New Chat' : 'New Chat';
    closeMoreMenu();
    renameConvPrompt(state.conversationId, title);
}
function archiveCurrentConv() {
    if (!state.conversationId) { toast('📝 No conversation to archive', 'error'); return; }
    closeMoreMenu();
    showConfirm('Archive Conversation', 'Archive this conversation?').then(async confirmed => {
        if (!confirmed) return;
        try {
            const res = await authenticatedFetch(`/conversations/${state.conversationId}/archive`, { method: 'PATCH' });
            if (res.ok) {
                toast('📦 Conversation archived', 'success');
                state.conversationId = null;
                document.getElementById('messages').innerHTML = '';
                showEmpty(true);
                loadConversations();
                const archivedList = document.getElementById('archived-list');
                if (archivedList && archivedList.style.display !== 'none') loadArchivedConversations();
            } else { const err = await res.json(); toast('❌ ' + (err.detail || 'Failed to archive'), 'error'); }
        } catch (err) { handleError(err, 'Archive'); }
    });
}
function deleteCurrentConv() {
    if (!state.conversationId) { toast('📝 No conversation to delete', 'error'); return; }
    closeMoreMenu();
    deleteConv(state.conversationId);
}
function shareCurrentConv() {
    if (!state.conversationId) { toast('📝 No conversation to share', 'error'); return; }
    closeMoreMenu();
    openExportModal();
}

// ─── SEARCH ───
function openSearchModal() {
    openModal('modal-search');
    document.getElementById('search-input').value = '';
    document.getElementById('search-input').focus();
    document.getElementById('search-results').innerHTML = '<p class="search-empty">Enter a keyword to search</p>';
}
function closeSearchModal() { closeModal('modal-search'); }

async function performSearch() {
    const input = document.getElementById('search-input');
    const results = document.getElementById('search-results');
    const query = input?.value.trim();
    if (!query || query.length < 2) {
        results.innerHTML = '<p class="search-empty">Please enter at least 2 characters</p>';
        return;
    }
    results.innerHTML = '<p class="search-empty">Searching...</p>';
    try {
        const res = await authenticatedFetch(`/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Search failed');
        const conversations = data.results || [];
        if (conversations.length === 0) {
            results.innerHTML = '<p class="search-empty">No results found</p>';
            return;
        }
        let html = '';
        conversations.forEach(conv => {
            html += `
                <div class="search-result-group" onclick="switchConversation(${conv.conversation_id}); closeModal('modal-search');">
                    <div class="search-result-title">
                        <span>${escapeHtml(conv.title || 'New Chat')}</span>
                        <span class="search-result-count">${conv.messages.length} results</span>
                    </div>
                    <div class="search-result-list">
            `;
            conv.messages.forEach(msg => {
                html += `
                    <div class="search-result-item">
                        <div class="search-result-snippet">${msg.snippet || msg.content.substring(0, 150) + '...'}</div>
                        <div class="search-result-time">${msg.created_at ? new Date(msg.created_at).toLocaleString() : ''}</div>
                    </div>
                `;
            });
            html += `
                    </div>
                </div>
            `;
        });
        results.innerHTML = html;
    } catch (err) {
        results.innerHTML = `<p class="search-empty error">❌ ${escapeHtml(err.message)}</p>`;
    }
}

// ─── EXPORT ───
function openExportModal() { openModal('modal-export'); }
function closeExportModal() { closeModal('modal-export'); }

function exportWithFormat(format) {
    closeModal('modal-export');
    if (!state.conversationId) { toast('📝 No conversation to export', 'error'); return; }
    authenticatedFetch(`/export/${state.conversationId}?format=${format}&user_id=${state.userId}`)
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
                toast('📥 Chat exported as JSON', 'success');
            } else {
                const blob = new Blob([data.content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.filename || `veyronis_chat_${state.conversationId}.txt`;
                a.click();
                URL.revokeObjectURL(url);
                toast('📥 Chat exported as TXT', 'success');
            }
        })
        .catch(err => handleError(err, 'Export'));
}

// ─── ATTACHMENTS ───
function openAttachmentsModal() { openModal('modal-attachments'); loadAttachments(); }
function closeAttachmentsModal() { closeModal('modal-attachments'); }
function openAttachmentsModal() {
    if (!state.conversationId) {
        toast('📝 No active conversation to view attachments.', 'error');
        return;
    }
    openModal('modal-attachments');
    loadAttachments();
}

async function loadAttachments() {
    const container = document.getElementById('attachments-list');
    if (!container) return;

    if (!state.conversationId) {
        console.log('[Attachments] No conversation ID');
        container.innerHTML = '<p class="modal-empty">No conversation selected</p>';
        return;
    }

    console.log('[Attachments] Loading for conv:', state.conversationId);
    container.innerHTML = '<p class="modal-empty">Loading...</p>';

    try {
        const res = await authenticatedFetch(`/attachments?conversation_id=${state.conversationId}`);
        const data = await res.json();
        console.log('[Attachments] Response:', data);

        if (!res.ok) {
            throw new Error(data.detail || 'Failed to load attachments');
        }

        const attachments = data.attachments || [];
        console.log('[Attachments] Count:', attachments.length);

        if (attachments.length === 0) {
            container.innerHTML = '<p class="modal-empty">No attachments in this conversation</p>';
            return;
        }

        container.innerHTML = renderAttachmentGrid(attachments);
    } catch (err) {
        handleError(err, 'Attachments');
        container.innerHTML = `<p class="modal-empty error">❌ ${escapeHtml(err.message)}</p>`;
    }
}

function renderAttachmentGrid(attachments) {
    let html = '<div class="attachment-grid">';
    
    attachments.forEach(att => {
        const url = att.cloudinary_url || '#';
        const isImage = att.file_type === 'image' || att.mime_type?.startsWith('image/');
        
        let thumbUrl = url;
        if (url !== '#' && url.includes('cloudinary')) {
            thumbUrl = url.replace('/upload/', '/upload/w_150,h_150,c_fill/');
        }
        
        const icon = isImage ? '' : '📄';
        const label = att.filename.length > 20 ? att.filename.slice(0, 18) + '…' : att.filename;
        
        html += `
            <div class="attachment-thumb" onclick="openPreview(${att.id}, '${escapeHtml(att.filename)}', '${escapeHtml(url)}', '${att.mime_type || ''}')">
                ${isImage && url !== '#' ? 
                    `<img src="${thumbUrl}" alt="${escapeHtml(att.filename)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">` : 
                    `<div class="attachment-doc-icon">📄</div>`
                }
                <div class="attachment-thumb-label">${escapeHtml(label)}</div>
                ${isImage ? `<div class="attachment-thumb-badge">🖼️</div>` : `<div class="attachment-thumb-badge">📄</div>`}
            </div>
        `;
    });
    
    html += '</div>';
    return html;
}


// ─── PRO UPGRADE ───
function openUpgradeModal() { openModal('modal-upgrade'); }
function closeUpgradeModal() { closeModal('modal-upgrade'); }
function activateProPlan() { toast('⭐ Upgrade to PRO — Coming soon with Google Play Billing!', 'info'); }

// ─── ADMIN PANEL ───
function openAdminPanel() { openModal('modal-admin'); loadAdminData(); }
function closeAdminPanel() { closeModal('modal-admin'); }

async function loadAdminData() {
    try {
        const res = await authenticatedFetch('/admin/users');
        if (res.ok) {
            const data = await res.json();
            state.adminUsers = data.users || [];
            renderUserList(state.adminUsers);
        } else {
            toast('❌ Failed to load admin data', 'error');
        }
    } catch (err) {
        toast('❌ Error loading admin data', 'error');
    }
}

function renderUserList(users) {
    const container = document.getElementById('users-list');
    if (!container) return;
    if (!users || !users.length) {
        container.innerHTML = '<div class="admin-empty">No users found</div>';
        return;
    }
    container.innerHTML = users.map(user => `
        <div class="admin-user-item ${user.is_banned ? 'banned' : ''}">
            <div class="admin-user-info">
                <span class="admin-user-email">${escapeHtml(user.email)}</span>
                <span class="admin-user-badge ${user.is_pro ? 'pro' : 'free'}">
                    ${user.is_pro ? '⭐ PRO' : 'Free'}
                </span>
                ${user.is_banned ? '<span class="admin-user-badge banned">🚫 Banned</span>' : ''}
                <span class="admin-user-meta">${user.message_count || 0} msgs</span>
                <span class="admin-user-meta">${new Date(user.created_at).toLocaleDateString()}</span>
                <span class="admin-user-meta">ID: ${user.display_id || 'N/A'}</span>
            </div>
            <div class="admin-user-actions">
                ${!user.is_banned ? `
                    <button onclick="banUser('${user.id}')" class="admin-btn danger">Ban</button>
                ` : `
                    <button onclick="unbanUser('${user.id}')" class="admin-btn success">Unban</button>
                `}
            </div>
        </div>
    `).join('');
}

function filterAdminUsers() {
    const query = document.getElementById('admin-search').value.toLowerCase();
    const filtered = state.adminUsers.filter(u => u.email.toLowerCase().includes(query) || (u.display_id && u.display_id.toLowerCase().includes(query)));
    renderUserList(filtered);
}

async function banUser(userId) {
    const reason = await showPrompt('Ban User', 'Reason for ban:', 'Violation of terms');
    if (reason === null || reason === undefined || reason === '') return;
    const duration = await showPrompt('Ban User', 'Ban duration in days:', '30');
    if (duration === null || duration === undefined || duration === '') return;
    try {
        const res = await authenticatedFetch(`/admin/users/${userId}/ban`, {
            method: 'POST',
            body: JSON.stringify({ reason, duration_days: parseInt(duration) || 30 })
        });
        if (res.ok) {
            toast('✅ User banned successfully', 'success');
            await loadAdminData();
        } else {
            const err = await res.json();
            toast('❌ ' + (err.detail || 'Failed to ban user'), 'error');
        }
    } catch (err) {
        toast('❌ Error banning user', 'error');
    }
}

async function unbanUser(userId) {
    const confirmed = await showConfirm('Unban User', 'Are you sure you want to unban this user?');
    if (!confirmed) return;
    try {
        const res = await authenticatedFetch(`/admin/users/${userId}/unban`, {
            method: 'POST'
        });
        if (res.ok) {
            toast('✅ User unbanned successfully', 'success');
            await loadAdminData();
        } else {
            const err = await res.json();
            toast('❌ ' + (err.detail || 'Failed to unban user'), 'error');
        }
    } catch (err) {
        toast('❌ Error unbanning user', 'error');
    }
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
    document.getElementById('admin-users').style.display = tab === 'users' ? 'block' : 'none';
    document.getElementById('admin-reports').style.display = tab === 'reports' ? 'block' : 'none';
}

async function checkAdminStatus() {
    const toggle = document.getElementById('adminToggle');
    if (!toggle) return;

    try {
        const res = await authenticatedFetch('/admin/users');
        if (res.ok) {
            toggle.style.display = 'flex';
        } else {
            toggle.style.display = 'none';
            toggle.style.removeProperty('display');
        }
    } catch (e) {
        toggle.style.display = 'none';
        toggle.style.removeProperty('display');
    }
}

// ─── CHAT HISTORY ───
async function loadHistory() {
    if (!state.userId || !state.conversationId) return;
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const url = `${state.apiUrl}/history?user_id=${encodeURIComponent(state.userId)}&conversation_id=${state.conversationId}`;
    try {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const msgs = data.messages || [];
        const container = document.getElementById('messages');
        container.innerHTML = '';
        if (!msgs.length) { showEmpty(true); return; }
        showEmpty(false);
        msgs.forEach(m => {
            if (m.role === 'user') {
                if (m.image_data) addHistoricalImageMsg(m.content, m.image_data);
                else addUserMsg(m.content);
            } else {
                const id = addAiShell();
                document.getElementById('thinking-' + id).style.display = 'none';
                const textEl = document.getElementById('text-' + id);
                if (textEl) renderMarkdown(textEl, m.content);
            }
        });
        scrollBottom();
    } catch (err) {
        console.error('[History] Error:', err);
        document.getElementById('messages').innerHTML = `<div class="conv-error">⚠️ Failed to load chat.</div>`;
        showEmpty(true);
    }
}

function showEmpty(show) {
    const container = document.getElementById('messages');
    let emptyState = document.getElementById('empty-state');
    if (show) {
        if (!emptyState) {
            const el = document.createElement('div');
            el.id = 'empty-state';
            el.className = 'empty-state';
            el.innerHTML = `
                <div class="empty-brand">VEYRONIS</div>
                <div class="empty-hint">How can I help you today?</div>
                <div class="chips">
                    <button class="chip glass-chip" onclick="quickSend('Explain quantum physics like I am 15')">🔬 Quantum Physics</button>
                    <button class="chip glass-chip" onclick="quickSend('Help me outline an essay about climate change')">📝 Essay Outline</button>
                    <button class="chip glass-chip" onclick="quickSend('Solve step by step: 2x² + 5x - 3 = 0')">🧮 Math Solver</button>
                    <button class="chip glass-chip" onclick="quickSend('Write a Python script that fetches weather data')">💻 Python Code</button>
                    <button class="chip glass-chip" onclick="quickSend('Create flashcards about the French Revolution')">📇 Flashcards</button>
                    <button class="chip glass-chip" onclick="quickSend('Draw me a majestic dragon')">🎨 Image Gen</button>
                    <button class="chip glass-chip" onclick="quickSend('What happens if I procrastinate on my final project until the last week?')">🔮 Hindsight</button>
                </div>
            `;
            container.insertBefore(el, container.firstChild);
        } else { emptyState.style.display = 'flex'; }
    } else { if (emptyState) emptyState.remove(); }
}

function quickSend(text) {
    const input = document.getElementById('msg-input');
    if (input) input.value = text;
    sendMessage();
}

// ─── MESSAGE FUNCTIONS ───
function addUserMsg(text, id) {
    showEmpty(false);
    const mid = id || 'um_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble">${escapeHtml(text)}</div><div class="msg-actions"><button class="msg-action-btn" onclick="editMsg('${mid}')" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="msg-action-btn" onclick="copyMsg('${mid}')" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="msg-action-btn" onclick="delMsg('${mid}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button><button class="msg-action-btn" onclick="shareMsg('${mid}')" title="Share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return mid;
}

function addUserImageMsg(text, dataUrl, filename, id) {
    showEmpty(false);
    const mid = id || 'uimg_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    const textHtml = text ? `<div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(text)}</div>` : '';
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble" style="padding:10px;max-width:320px;"><img src="${dataUrl}" style="max-width:100%;border-radius:8px;display:block;cursor:zoom-in;" onclick="openLightbox('${dataUrl}')"><div style="font-size:11px;opacity:0.6;text-align:right;margin-top:4px;">${escapeHtml(filename)}</div>${textHtml}</div><div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg('${mid}')" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="msg-action-btn" onclick="delMsg('${mid}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return mid;
}

function addHistoricalImageMsg(text, dataUrl, id) {
    showEmpty(false);
    const mid = id || 'uimg_' + Date.now();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.id = mid;
    const isPlaceholder = !text || text === '[Image upload]';
    const textHtml = !isPlaceholder ? `<div style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(text)}</div>` : '';
    div.innerHTML = `<div class="msg-body"><div class="msg-bubble" style="padding:10px;max-width:320px;"><img src="${dataUrl}" style="max-width:100%;border-radius:8px;display:block;cursor:zoom-in;" onclick="openLightbox('${dataUrl}')" onerror="this.style.display='none';this.nextElementSibling.style.display='block';"><div style="display:none;font-size:12px;color:var(--text-muted);padding:8px;">Image unavailable</div>${textHtml}</div><div class="msg-actions"><button class="msg-action-btn" onclick="copyMsg('${mid}')" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button><button class="msg-action-btn" onclick="delMsg('${mid}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div></div>`;
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
    div.innerHTML = `<div class="msg-avatar">V</div><div class="msg-body">
        <div class="thinking-indicator" id="thinking-${id}">
            <span class="thinking-text">VEYRONIS is thinking</span>
            <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
        <div class="msg-text" id="text-${id}"></div>
        <div class="msg-actions bot-actions">
            <button class="msg-action-btn speak-btn" id="speak-${id}" onclick="toggleSpeak('${id}')" title="Read aloud">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
            <button class="msg-action-btn" onclick="regenerateMsg('${id}')" title="Regenerate">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
            </button>
            <button class="msg-action-btn" onclick="copyAiMsg('${id}')" title="Copy">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="msg-action-btn" onclick="shareAiMsg('${id}')" title="Share">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
            <button class="msg-action-btn thumb-up" id="up-${id}" onclick="thumbUp('${id}')" title="Helpful">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
            </button>
            <button class="msg-action-btn thumb-down" id="down-${id}" onclick="thumbDown('${id}')" title="Not helpful">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg>
            </button>
        </div>
    </div>`;
    const msgs = document.getElementById('messages');
    if (msgs) msgs.appendChild(div);
    scrollBottom();
    return id;
}

function addAiText(id, text) {
    const el = document.getElementById('text-' + id);
    if (el) renderMarkdown(el, text);
    const thinkingEl = document.getElementById('thinking-' + id);
    if (thinkingEl) thinkingEl.style.display = 'none';
}

// ─── MESSAGE ACTIONS ───
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
    toast('✏️ Message loaded for editing. Press Enter to send.', 'info');
}
function copyMsg(id) {
    const bubble = document.querySelector('#' + id + ' .msg-bubble');
    if (!bubble) return;
    navigator.clipboard.writeText(bubble.textContent).then(() => toast('📋 Copied', 'success'));
}
function delMsg(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.opacity = '0';
        setTimeout(() => { el.remove(); const msgs = document.getElementById('messages'); if (msgs && !msgs.children.length) showEmpty(true); }, 200);
    }
}
function shareMsg(id) {
    const text = document.querySelector('#' + id + ' .msg-bubble')?.textContent || '';
    if (navigator.share) navigator.share({ text });
    else navigator.clipboard.writeText(text).then(() => toast('📋 Copied to share', 'success'));
}
function copyAiMsg(id) {
    const el = document.getElementById('text-' + id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent || el.innerText).then(() => toast('📋 Copied response', 'success'));
}
function shareAiMsg(id) {
    const el = document.getElementById('text-' + id);
    if (!el) return;
    const text = el.textContent || el.innerText;
    if (navigator.share) navigator.share({ text });
    else navigator.clipboard.writeText(text).then(() => toast('📋 Copied to share', 'success'));
}
function thumbUp(id) {
    const btn = document.getElementById('up-' + id);
    const downBtn = document.getElementById('down-' + id);
    if (!btn) return;
    btn.classList.toggle('active');
    if (downBtn) downBtn.classList.remove('active');
    toast('👍 Thanks for the feedback!', 'success');
}
function thumbDown(id) {
    const btn = document.getElementById('down-' + id);
    const upBtn = document.getElementById('up-' + id);
    if (!btn) return;
    btn.classList.toggle('active');
    if (upBtn) upBtn.classList.remove('active');
    toast('👎 Thanks for the feedback!', 'success');
}

// ─── SPEAK (TTS) ───
function stopSpeaking() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    state.isSpeaking = false;
    state.speakingId = null;
    state.currentUtterance = null;
    document.querySelectorAll('.speak-btn').forEach(btn => {
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
        btn.classList.remove('speaking');
    });
}
function toggleSpeak(id) {
    const btn = document.getElementById('speak-' + id);
    if (!btn) return;
    if (state.isSpeaking && state.speakingId === id) { stopSpeaking(); return; }
    if (state.isSpeaking) stopSpeaking();
    const el = document.getElementById('text-' + id);
    if (!el) return;
    const text = el.textContent || el.innerText;
    if (!text) return;
    state.speakingId = id;
    state.isSpeaking = true;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    btn.classList.add('speaking');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;
    utterance.onend = () => { state.isSpeaking = false; state.speakingId = null; if (btn) { btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`; btn.classList.remove('speaking'); } };
    utterance.onerror = () => { state.isSpeaking = false; state.speakingId = null; if (btn) { btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`; btn.classList.remove('speaking'); } };
    state.currentUtterance = utterance;
    window.speechSynthesis.speak(utterance);
}

// ─── SEND MESSAGE ───
async function sendMessage() {
    if (state.isTyping) return;
    const input = document.getElementById('msg-input');
    if (!input) return;
    let text = input.value.trim();
    const hasImage = !!state.pendingImageBase64;
    const hasDoc = !!state.pendingDocContent;
    if (!state.editingId && !text && !hasImage && !hasDoc) return;

    if (state.simulationMode && text && !hasImage && !hasDoc) {
        await runHindsightSimulation(text);
        input.value = '';
        input.style.height = 'auto';
        return;
    }

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
        while (next) { const toRemove = next; next = next.nextElementSibling; toRemove.remove(); }
        state.editingId = null;
        input.value = '';
        input.style.height = 'auto';
        toast('✏️ Message updated. Regenerating response...', 'info');
    } else {
        if (hasImage && imageDataUrl) { addUserImageMsg(input.value.trim(), imageDataUrl, imageFilename || 'image.png'); removeImagePreview(); }
        if (text && !hasImage) addUserMsg(text);
        if (hasDoc) removeDocPreview();
    }
    input.value = '';
    input.style.height = 'auto';
    function updateChatPadding() {
    // ─── Fixed gap – no dynamic change ───
    // const messages = document.getElementById('messages');
    // const inputShell = document.querySelector('.input-shell');
    // if (!messages || !inputShell) return;
    // const inputHeight = inputShell.offsetHeight;
    // const paddingBottom = Math.max(inputHeight + 24, 120);
    // messages.style.paddingBottom = paddingBottom + 'px';
}
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;
    const aiId = addAiShell();
    const textEl = document.getElementById('text-' + aiId);
    const thinkingEl = document.getElementById('thinking-' + aiId);
    if (state.model === 'research' && thinkingEl) {
        thinkingEl.innerHTML = `
            <div class="thinking-text">🔬 Research mode active</div>
            <div class="research-progress">
                <div class="research-step active">1. Plan</div>
                <div class="research-step">2. Search</div>
                <div class="research-step">3. Synthesize</div>
            </div>
            <div class="research-status">Planning investigation...</div>
        `;
        thinkingEl.classList.add('research-mode');
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
            pro_code: '',
            user_id: state.userId || state.user?.email || '',
            conversation_id: state.conversationId,
            image: imageBase64 || null,
            model_mode: state.model,
            ai_model: state.aiModel,
            custom_instructions: state.customInstructions,
            response_style: state.responseStyle
        };
        const response = await fetch(`${state.apiUrl}/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(requestBody)
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const err = new Error(errData.detail || 'Server error');
            err.status = response.status;
            throw err;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullResponse = '';
        let firstToken = true;
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
                        if (firstToken) { firstToken = false; if (thinkingEl) thinkingEl.style.display = 'none'; }
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
                        if (thinkingEl) thinkingEl.style.display = 'none';
                        if (textEl) { renderMarkdown(textEl, fullResponse); renderCitations(aiId, state.citations[aiId]); }
                        if (data.conversation_id && !state.conversationId) { state.conversationId = data.conversation_id; loadConversations(); }
                        if (data.tier === 'pro') setProUi();
                        else { state.msgCount++; const disclaimer = document.getElementById('input-disclaimer'); if (disclaimer) disclaimer.textContent = `Free: ${state.msgCount}/20 today · VEYRONIS can make mistakes`; }
                        if (state.autoTts && state.ttsEnabled) { setTimeout(() => { const speakBtn = document.getElementById('speak-' + aiId); if (speakBtn) toggleSpeak(aiId); }, 400); }
                        refreshUserInfo();
                    } else if (data.type === 'error') throw new Error(data.content);
                } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
            }
        }
    } catch (err) {
        state.isTyping = false;
        state.abortController = null;
        if (sendBtn) sendBtn.disabled = false;
        if (err.name === 'AbortError') {
            if (textEl) textEl.textContent = textEl.textContent || '⏹️ Generation stopped.';
        } else if (!navigator.onLine) {
            if (textEl) textEl.textContent = '💾 Message queued. Will send when you are back online.';
            if (thinkingEl) thinkingEl.style.display = 'none';
        } else if (err.message && err.message.includes('429')) {
            if (textEl) textEl.textContent = '⏳ Rate limited. Retrying...';
            if (thinkingEl) thinkingEl.style.display = 'none';
            setTimeout(() => sendMessage(), 3000);
        } else if (err.message && err.message.includes('502')) {
            if (textEl) textEl.textContent = '🔧 Server unavailable. Retrying...';
            if (thinkingEl) thinkingEl.style.display = 'none';
            setTimeout(() => sendMessage(), 5000);
        } else {
            handleError(err, 'Chat');
            if (textEl) textEl.textContent = '❌ ' + (err.message || 'Something went wrong');
            if (thinkingEl) thinkingEl.style.display = 'none';
        }
    }
    updateSendButton();
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
    if (state.abortController) { state.abortController.abort(); state.abortController = null; }
    state.isTyping = false;
    updateSendButton();
}

function regenerateMsg(aiId) {
    stopSpeaking();
    const aiMsg = document.getElementById(aiId);
    if (!aiMsg) return;
    let userMsg = aiMsg.previousElementSibling;
    while (userMsg && !userMsg.classList.contains('user')) { userMsg = userMsg.previousElementSibling; }
    if (!userMsg) { toast('❌ No user message found', 'error'); return; }
    const bubble = userMsg.querySelector('.msg-bubble');
    const text = bubble ? bubble.textContent : '';
    const textEl = document.getElementById('text-' + aiId);
    const thinkingEl = document.getElementById('thinking-' + aiId);
    if (textEl) textEl.textContent = '';
    if (thinkingEl) { thinkingEl.style.display = 'flex'; thinkingEl.innerHTML = `<span class="thinking-text">Regenerating...</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>`; thinkingEl.classList.remove('research-mode'); }
    state.isTyping = true;
    updateSendButton();
    const controller = new AbortController();
    state.abortController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    fetch(`${state.apiUrl}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
            message: text || '',
            pro_code: '',
            user_id: state.userId || state.user?.email || '',
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
        let firstToken = true;
        function read() {
            reader.read().then(({ done, value }) => {
                if (done) { state.isTyping = false; state.abortController = null; updateSendButton(); if (thinkingEl) thinkingEl.style.display = 'none'; return; }
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
                            if (firstToken) { firstToken = false; if (thinkingEl) thinkingEl.style.display = 'none'; }
                            if (textEl) textEl.textContent += data.content;
                            fullResponse += data.content;
                            scrollBottom();
                        } else if (data.type === 'citations') { state.citations[aiId] = data.content; }
                        else if (data.type === 'research_step') { updateResearchProgress(aiId, data.content); }
                        else if (data.type === 'done') {
                            state.isTyping = false; state.abortController = null;
                            if (thinkingEl) thinkingEl.style.display = 'none';
                            if (textEl) { renderMarkdown(textEl, fullResponse); renderCitations(aiId, state.citations[aiId]); }
                            updateSendButton();
                            if (state.autoTts && state.ttsEnabled) { setTimeout(() => { const speakBtn = document.getElementById('speak-' + aiId); if (speakBtn) toggleSpeak(aiId); }, 300); }
                            refreshUserInfo(); hideLoading();
                        } else if (data.type === 'error') throw new Error(data.content);
                    } catch (e) { if (e instanceof SyntaxError) continue; }
                }
                read();
            }).catch(err => { state.isTyping = false; state.abortController = null; updateSendButton(); hideLoading(); if (err.name !== 'AbortError' && textEl) textEl.textContent = 'Error: ' + err.message; });
        }
        read();
    }).catch(err => { state.isTyping = false; state.abortController = null; updateSendButton(); hideLoading(); if (textEl) textEl.textContent = err.name === 'AbortError' ? '⏹️ Generation stopped.' : 'Error: ' + err.message; });
}

function updateResearchProgress(aiId, stepData) {
    const thinkingEl = document.getElementById('thinking-' + aiId);
    if (!thinkingEl) return;
    thinkingEl.classList.add('research-mode');
    const phases = {
        planning: { icon: '📋', label: 'Planning' },
        planned: { icon: '✅', label: 'Planned' },
        searching: { icon: '🔍', label: 'Searching' },
        synthesizing: { icon: '🧠', label: 'Synthesizing' },
    };
    const cfg = phases[stepData.phase] || { icon: '⏳', label: 'Working' };
    let progressHtml = `<div class="research-progress">`;
    progressHtml += `<div class="research-step ${stepData.phase === 'planning' || stepData.phase === 'planned' ? 'active' : 'done'}">1. Plan</div>`;
    progressHtml += `<div class="research-step ${stepData.phase === 'searching' ? 'active' : stepData.phase === 'synthesizing' ? 'done' : ''}">2. Search</div>`;
    progressHtml += `<div class="research-step ${stepData.phase === 'synthesizing' ? 'active' : ''}">3. Synthesize</div>`;
    progressHtml += `</div>`;
    let msg = stepData.message || '';
    if (stepData.phase === 'searching' && stepData.current && stepData.total) { msg += ` (${stepData.current}/${stepData.total})`; }
    thinkingEl.innerHTML = `
        <div class="thinking-text">${cfg.icon} ${cfg.label}</div>
        ${progressHtml}
        <div class="research-status">${msg}</div>
    `;
}

// ─── RENDER MARKDOWN ───
function renderMarkdown(el, raw) {
    if (!el) return;
    if (!window.marked) { el.textContent = raw; return; }
    const mathPlaceholders = [];
    let processed = raw.replace(/\$\$([\s\S]*?)\$\$/g, (match) => { mathPlaceholders.push(match); return `%%MATHBLOCK${mathPlaceholders.length-1}%%`; });
    processed = processed.replace(/\$([^\$\n]+?)\$/g, (match) => { mathPlaceholders.push(match); return `%%MATHINLINE${mathPlaceholders.length-1}%%`; });
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (match) => { mathPlaceholders.push(match); return `%%MATHINLINE${mathPlaceholders.length-1}%%`; });
    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (match) => { mathPlaceholders.push(match); return `%%MATHBLOCK${mathPlaceholders.length-1}%%`; });
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
        delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false},
            {left: '\\(', right: '\\)', display: false},
            {left: '\\[', right: '\\]', display: true}
        ],
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
        const res = await fetch(`${state.apiUrl}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) { const err = new Error(data.error || 'Execution failed'); err.status = res.status; throw err; }
        const body = outputDiv.querySelector('.code-output-body');
        if (!body) return;
        if (data.success) { body.textContent = data.output || '(no output)'; body.classList.add('success'); }
        else { body.textContent = data.error || 'Execution failed'; body.classList.add('error'); }
    } catch (err) {
        handleError(err, 'Code Execution');
        const body = outputDiv.querySelector('.code-output-body');
        if (body) { body.textContent = '❌ ' + (err.message || 'Execution failed'); body.classList.add('error'); }
    }
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

function convertCitationsInElement(el, maxIndex) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    const nodesToReplace = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && node.parentElement.closest('pre, code, a, .sources-box')) continue;
        if (/\[\d+\]/.test(node.textContent)) { nodesToReplace.push(node); }
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

// ─── HINDSIGHT ───
async function runHindsightSimulation(scenario) {
    const isPro = state.user?.is_pro || false;
    const today = new Date().toDateString();
    if (state.simulationDate !== today) { state.simulationCount = 0; state.simulationDate = today; }
    const limit = isPro ? 20 : 1;
    if (state.simulationCount >= limit) {
        toast(isPro ? '⏳ PRO daily limit reached (20/day)' : '⏳ Free tier: 1 simulation/day. Upgrade to PRO!', 'error');
        return;
    }
    addUserMsg('🔮 ' + scenario);
    const aiId = addAiShell();
    const textEl = document.getElementById('text-' + aiId);
    const thinkingEl = document.getElementById('thinking-' + aiId);
    if (thinkingEl) { thinkingEl.innerHTML = `<span class="thinking-text">🔮 Simulating timeline...</span><span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>`; }
    state.isTyping = true;
    updateSendButton();
    try {
        const res = await fetch(`${state.apiUrl}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: scenario, pro_code: '',
                user_id: state.userId || state.user?.email || '',
                conversation_id: state.conversationId,
                mode: 'simulation',
                model_mode: state.model, ai_model: state.aiModel,
                custom_instructions: state.customInstructions,
                response_style: state.responseStyle
            })
        });
        const data = await res.json();
        if (!res.ok) { const err = new Error(data.detail || 'Simulation failed'); err.status = res.status; throw err; }
        if (thinkingEl) thinkingEl.style.display = 'none';
        if (textEl) renderHindsightTimeline(textEl, data.response);
        state.simulationCount++;
        localStorage.setItem('veyronis_sim_count', String(state.simulationCount));
        if (data.conversation_id && !state.conversationId) { state.conversationId = data.conversation_id; loadConversations(); }
        refreshUserInfo();
    } catch (err) {
        handleError(err, 'Hindsight');
        if (thinkingEl) thinkingEl.style.display = 'none';
        if (textEl) textEl.innerHTML = `<div class="sim-rate-limit"><span class="sim-rate-icon">⚠️</span>${escapeHtml(err.message)}</div>`;
    }
    state.isTyping = false;
    updateSendButton();
}

function renderHindsightTimeline(container, jsonString) {
    let data;
    try { data = JSON.parse(jsonString); } catch (e) { container.innerHTML = '<div style="color:#ef4444;font-size:13px;">⚠️ Failed to parse simulation result</div>'; return; }
    const timeline = data.timeline || [];
    const butterfly = data.butterfly_effect || '';
    const advice = data.hindsight_advice || '';
    const scenario = data.initial_scenario || '';
    let html = '<div class="hindsight-container">';
    html += `<div class="hindsight-header"><div class="hindsight-icon">🔮</div><div><div class="hindsight-title">VEYRONIS HINDSIGHT</div><div class="hindsight-subtitle">Simulate the consequences before you commit</div></div></div>`;
    if (scenario) html += `<div class="hindsight-scenario"><strong>Scenario:</strong> ${escapeHtml(scenario)}</div>`;
    if (timeline.length > 0) {
        html += '<div class="hindsight-timeline">';
        timeline.forEach((step, idx) => {
            const conf = step.confidence || 0.5;
            const confClass = conf >= 0.7 ? 'high' : (conf >= 0.4 ? 'medium' : 'low');
            const confPct = Math.round(conf * 100);
            html += `<div class="timeline-step">`;
            html += `<div class="timeline-step-header"><span class="timeline-step-num">STEP ${step.step_number || idx + 1}</span><span class="timeline-step-title">${escapeHtml(step.title || `Phase ${idx + 1}`)}</span><div class="timeline-confidence"><div class="timeline-confidence-bar"><div class="timeline-confidence-fill ${confClass}" style="width:${confPct}%"></div></div><span>${confPct}%</span></div></div>`;
            html += `<div class="timeline-state">${escapeHtml(step.state || '')}</div>`;
            if (step.consequences && step.consequences.length > 0) {
                html += `<div class="timeline-consequences"><div class="timeline-consequences-label">Consequences</div>`;
                step.consequences.forEach(c => { html += `<div class="timeline-consequence-item">${escapeHtml(c)}</div>`; });
                html += `</div>`;
            }
            if (step.assumptions && step.assumptions.length > 0) {
                html += `<div class="timeline-assumptions"><div class="timeline-assumptions-label">Assumptions</div>`;
                step.assumptions.forEach(a => { html += `<div class="timeline-assumption-item">${escapeHtml(a)}</div>`; });
                html += `</div>`;
            }
            html += `</div>`;
        });
        html += '</div>';
    }
    if (butterfly) html += `<div class="hindsight-butterfly"><div class="hindsight-butterfly-label">Butterfly Effect</div><div class="hindsight-butterfly-text">${escapeHtml(butterfly)}</div></div>`;
    if (advice) html += `<div class="hindsight-advice"><div class="hindsight-advice-label">Hindsight Advice</div><div class="hindsight-advice-text">${escapeHtml(advice)}</div></div>`;
    html += '</div>';
    container.innerHTML = html;
    scrollBottom();
}

function toggleSimulationMode() {
    state.simulationMode = !state.simulationMode;
    const toggle = document.getElementById('sim-toggle');
    if (toggle) toggle.classList.toggle('active', state.simulationMode);
    toast(state.simulationMode ? '🔮 Hindsight mode ON' : '🔮 Hindsight mode OFF', state.simulationMode ? 'success' : 'info');
}

// ─── THEME ───
function cycleTheme() {
    const idx = THEMES.indexOf(currentTheme);
    currentTheme = THEMES[(idx + 1) % THEMES.length];
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('veyronis_theme', currentTheme);
    toast(`🎨 Theme: ${currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1)}`, 'success');
}

// ─── SETTINGS ───
function openSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    if (panel) panel.classList.remove('hidden');
    syncSettingsValues();
    closeSidebar();
}
function closeSettingsPanel() { const panel = document.getElementById('settings-panel'); if (panel) panel.classList.add('hidden'); }

function syncSettingsValues() {
    // Ensure we have user data
    if (!state.user || !state.user.email) {
        const stored = JSON.parse(localStorage.getItem('veyronis_user') || 'null');
        if (stored) state.user = stored;
    }

    const tier = state.user?.is_pro ? 'Pro' : 'Free';
    const email = state.user?.email || 'Not logged in';
    const displayId = state.user?.display_id || state.displayId || 'N/A';

    document.getElementById('settings-tier-value').textContent = tier;
    document.getElementById('profile-plan-value').textContent = tier;
    document.getElementById('profile-user-id').textContent = email;
    document.getElementById('profile-id-value').textContent = email;
    // Update display ID if element exists
    const displayEl = document.getElementById('profile-display-id');
    if (displayEl) displayEl.textContent = displayId;

    document.getElementById('settings-voice-value').textContent = state.ttsEnabled ? 'On' : 'Off';
    const ci = document.getElementById('settings-custom-instructions');
    if (ci) ci.value = state.customInstructions || '';

    // Update plan badge in subscription sub
    const planVal = document.getElementById('profile-plan-value-sub');
    if (planVal) planVal.textContent = tier;
    const planBadge = document.getElementById('sidebar-pro-badge');
    if (planBadge) {
        planBadge.textContent = state.user?.is_pro ? '⭐ PRO' : 'FREE';
        planBadge.className = 'sidebar-pro-badge' + (state.user?.is_pro ? ' pro' : '');
    }

    document.querySelectorAll('.radio-circle').forEach(r => r.classList.remove('checked'));
    const activeRadio = document.getElementById('radio-' + currentTheme);
    if (activeRadio) activeRadio.classList.add('checked');

    updateUsageDisplay();
}

function openSettingsSub(id) {
    document.querySelectorAll('.settings-sub').forEach(s => s.classList.add('hidden'));
    const sub = document.getElementById('settings-sub-' + id);
    if (sub) sub.classList.remove('hidden');
}
function closeSettingsSub() { document.querySelectorAll('.settings-sub').forEach(s => s.classList.add('hidden')); }

function setTheme(theme) {
    if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = prefersDark ? 'dark' : 'light';
    } else { currentTheme = theme; }
    document.documentElement.setAttribute('data-theme', currentTheme);
    localStorage.setItem('veyronis_theme', currentTheme);
    document.querySelectorAll('.radio-circle').forEach(r => r.classList.remove('checked'));
    const activeRadio = document.getElementById('radio-' + theme);
    if (activeRadio) activeRadio.classList.add('checked');
    toast(`🎨 Theme: ${currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1)}`, 'success');
}

function toggleSettingsVoice() {
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem('veyronis_tts', state.ttsEnabled ? 'true' : 'false');
    document.getElementById('settings-voice-value').textContent = state.ttsEnabled ? 'On' : 'Off';
    toast(state.ttsEnabled ? '🔊 Voice ON' : '🔇 Voice OFF', 'success');
}

function saveChatPreferences() {
    const ci = document.getElementById('settings-custom-instructions');
    state.customInstructions = ci ? ci.value.trim() : '';
    localStorage.setItem('veyronis_custom_instructions', state.customInstructions);
    toast('✅ Chat preferences saved', 'success');
    closeSettingsSub();
}

function pickStyle(style) {
    state.responseStyle = style;
    localStorage.setItem('veyronis_response_style', style);
    document.querySelectorAll('.style-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.style === style);
    });
    toast('🎨 Style: ' + style.charAt(0).toUpperCase() + style.slice(1), 'success');
}

// ─── FEEDBACK ───
async function submitFeedback() {
    const fb = document.getElementById('feedback-text');
    const text = fb ? fb.value.trim() : '';
    if (!text) { toast('📝 Please enter your feedback', 'error'); return; }
    try {
        const res = await authenticatedFetch('/feedback', {
            method: 'POST',
            body: JSON.stringify({ message: text })
        });
        if (res.ok) {
            toast('💬 Thank you for your feedback!', 'success');
            fb.value = '';
            closeSettingsSub();
        } else {
            const err = await res.json();
            toast('❌ ' + (err.detail || 'Failed to send feedback'), 'error');
        }
    } catch (err) {
        handleError(err, 'Feedback');
    }
}

async function deleteAccount() {
    const confirmed = await showConfirm('Delete Account', '⚠️ Are you sure you want to permanently delete your account? This cannot be undone!');
    if (!confirmed) return;
    const confirmed2 = await showConfirm('Delete Account', 'All your conversations and data will be permanently removed. Proceed?');
    if (!confirmed2) return;
    showLoading('Deleting account...');
    try {
        const res = await authenticatedFetch('/account', { method: 'DELETE' });
        hideLoading();
        if (res.ok) {
            toast('🗑️ Account deleted successfully.', 'success');
            localStorage.removeItem('veyronis_token');
            localStorage.removeItem('veyronis_user');
            state.token = null;
            state.user = null;
            state.isAuthenticated = false;
            document.getElementById('app').classList.add('hidden');
            document.getElementById('auth-screen').classList.remove('hidden');
        } else {
            const err = await res.json();
            toast('❌ ' + (err.detail || 'Failed to delete account'), 'error');
        }
    } catch (err) { hideLoading(); handleError(err, 'Delete Account'); }
}

// ─── MODEL MENUS ───
function toggleModelMenu() {
    const menu = document.getElementById('model-menu');
    const toggle = document.getElementById('model-toggle');
    if (menu) menu.classList.toggle('open');
    if (toggle) toggle.classList.toggle('open');
}
function pickModel(event, id, label) {
    state.model = id;
    document.getElementById('model-label').textContent = label;
    document.querySelectorAll('.model-row').forEach(b => b.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
    toggleModelMenu();
    if (id === 'research') toast('🔬 Research mode activated', 'success');
}

// ─── ATTACH / UPLOAD ───
function toggleAttach() {
    const pop = document.getElementById('attach-pop');
    if (pop) pop.classList.toggle('open');
}
function triggerImageUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { toast('📎 Image too large. Max 5MB.', 'error'); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
            state.pendingImageBase64 = ev.target.result.split(',')[1];
            state.pendingImageDataUrl = ev.target.result;
            state.pendingImageFilename = file.name;
            showImagePreview(file.name, ev.target.result);
            document.getElementById('attach-pop').classList.remove('open');
            updateSendButton();
        };
        reader.readAsDataURL(file);
    };
    input.click();
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

function triggerDocumentUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md,.csv,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 10 * 1024 * 1024) {
            toast('📎 File too large. Max 10MB.', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        // ─── Send conversation_id if we already have one ───
        if (state.conversationId) {
            formData.append('conversation_id', state.conversationId);
        }

        toast('📤 Uploading document...', 'info');
        document.getElementById('attach-pop')?.classList.remove('open');

        try {
            // ✅ Use authenticatedFetch to send token
            const res = await authenticatedFetch('/upload', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();

            if (!res.ok) {
                const err = new Error(data.detail || 'Upload failed');
                err.status = res.status;
                throw err;
            }

            console.log('[Upload] Success:', data);
            console.log('[Upload] conversation_id:', data.conversation_id);
            console.log('[Upload] attachment_id:', data.attachment_id);

            toast(`📄 Document ready: ${data.extracted_length} chars`, 'success');

            // ─── Handle conversation ───
            if (data.conversation_id) {
                if (!state.conversationId) {
                    // No conversation existed → switch to the new one
                    state.conversationId = data.conversation_id;
                    loadConversations();
                    loadHistory();
                    showEmpty(false);
                    console.log('[Upload] New conversation created:', data.conversation_id);
                } else {
                    // We already have a conversation – the file is now attached to it.
                    console.log('[Upload] File attached to conversation:', state.conversationId);
                }
            }

            // ─── Store document content for the message ───
            state.pendingDocContent = data.content || data.preview || '';
            state.pendingDocFilename = data.filename || file.name;
            showDocPreview(state.pendingDocFilename);
            updateSendButton();

        } catch (err) {
            handleError(err, 'Upload');
        }
    };

    input.click();
    setTimeout(() => {
        if (input.parentNode) input.parentNode.removeChild(input);
    }, 60000);
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
function toggleMic() {
    if (!state.recognition) {
        initVoice();
        if (!state.recognition) {
            toast('🎤 Voice not supported in this browser.', 'error');
            return;
        }
    }
    if (state.isListening) {
        state.recognition.stop();
    } else {
        try {
            state.recognition.start();
        } catch (err) {
            console.error('[Voice] Start error:', err);
            toast('🎤 Could not start mic: ' + err.message, 'error');
        }
    }
}

function initVoice() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        console.warn('[Voice] Speech recognition not supported');
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
        console.log('[Voice] Started');
        state.isListening = true;
        finalTranscript = '';
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.add('listening');
            btn.innerHTML = '<div class="voice-wave"><div></div><div></div><div></div></div>';
        }
        const ta = document.getElementById('msg-input');
        if (ta) {
            ta.placeholder = '🎤 Listening... Speak now';
            ta.value = '';
            ta.style.height = 'auto';
        }
        updateSendButton();
    };

    state.recognition.onend = () => {
        console.log('[Voice] Ended');
        state.isListening = false;
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.remove('listening');
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>`;
        }
        const ta = document.getElementById('msg-input');
        if (ta) {
            ta.placeholder = 'Message VEYRONIS...';
            if (finalTranscript.trim()) {
                ta.value = finalTranscript.trim();
                ta.style.height = 'auto';
                ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
                updateSendButton();
                setTimeout(() => sendMessage(), 400);
            }
        }
    };

    state.recognition.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const transcript = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interim += transcript;
            }
        }
        const ta = document.getElementById('msg-input');
        if (ta) {
            ta.value = finalTranscript + interim;
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
            updateSendButton();
        }
    };

    state.recognition.onerror = (e) => {
        console.error('[Voice] Error:', e);
        state.isListening = false;
        const btn = document.getElementById('mic-btn');
        if (btn) {
            btn.classList.remove('listening');
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>`;
        }
        const ta = document.getElementById('msg-input');
        if (ta) ta.placeholder = 'Message VEYRONIS...';
        if (e.error === 'no-speech') {
            toast('🎤 No speech detected', 'info');
        } else if (e.error === 'audio-capture') {
            toast('🎤 No microphone found', 'error');
        } else if (e.error === 'not-allowed') {
            toast('🎤 Microphone access denied', 'error');
        } else if (e.error === 'network') {
            toast('🎤 Network error with voice', 'error');
        } else if (e.error !== 'aborted') {
            toast('🎤 Voice failed: ' + e.error, 'error');
        }
    };
}
// ─── LIGHTBOX ───
function openLightbox(src, filename = '') {
    const lb = document.getElementById('img-lightbox');
    const img = document.getElementById('lightbox-img');
    const nameEl = document.getElementById('lightbox-filename');
    if (!lb || !img) return;
    
    img.src = src;
    if (nameEl) nameEl.textContent = filename || '';
    lb.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lb = document.getElementById('img-lightbox');
    if (lb) lb.classList.add('hidden');
    document.body.style.overflow = '';
}

// ─── PWA ───
function installPwa() {
    if (!state.deferredPrompt) { toast('📱 Install not available', 'info'); return; }
    state.deferredPrompt.prompt();
    state.deferredPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') toast('📱 Installing...', 'success');
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

// ─── PRO UI ───
function setProUi() {
    const disclaimer = document.getElementById('input-disclaimer');
    if (disclaimer) { disclaimer.innerHTML = 'PRO MODE <span style="color:#fbbf24">★</span> · Unlimited messages'; }
    const proBadge = document.getElementById('sidebar-pro-badge');
    if (proBadge) { proBadge.textContent = '⭐ PRO'; proBadge.className = 'sidebar-pro-badge pro'; }
    const sidebarTier = document.getElementById('sidebar-tier');
    if (sidebarTier) { sidebarTier.textContent = 'PRO'; sidebarTier.classList.add('pro'); }
}
function refreshUserInfo() {
    const headers = {};
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    
    fetch(`${state.apiUrl}/me`, { headers })
        .then(r => {
            if (!r.ok) throw new Error('Failed to fetch user info');
            return r.json();
        })
        .then(data => {
            if (!data.user) return;
            
            // ─── Update state ───
            state.user = { ...state.user, ...data.user };
            state.userId = state.user.email;
            state.displayId = data.user.display_id || state.displayId || 'N/A';
            
            // ─── Save to localStorage ───
            localStorage.setItem('veyronis_user', JSON.stringify(state.user));
            
            // ─── Update usage display ───
            updateUsageDisplay();
            
            // ─── Update PRO UI ───
            if (state.user.is_pro) setProUi();
            
            // ─── Update Settings panel (if open) ───
            syncSettingsValues();
            
            // ─── Update Sidebar ───
            const nameEl = document.getElementById('sidebar-name');
            const emailEl = document.getElementById('sidebar-email');
            const proBadge = document.getElementById('sidebar-pro-badge');
            const tierEl = document.getElementById('sidebar-tier');
            
            if (nameEl) nameEl.textContent = state.user.email.split('@')[0] || 'You';
            if (emailEl) emailEl.textContent = state.user.email;
            if (proBadge) {
                proBadge.textContent = state.user.is_pro ? '⭐ PRO' : 'FREE';
                proBadge.className = 'sidebar-pro-badge' + (state.user.is_pro ? ' pro' : '');
            }
            if (tierEl) {
                tierEl.textContent = state.user.is_pro ? 'PRO' : 'Free';
                tierEl.className = 'sidebar-tier' + (state.user.is_pro ? ' pro' : '');
            }
            
            // ─── Update Profile panel (if open) ───
            const profileName = document.getElementById('profile-name');
            const profileId = document.getElementById('profile-user-id');
            const profilePlan = document.getElementById('profile-plan-value');
            const profilePlanSub = document.getElementById('profile-plan-value-sub');
            const profileIdSub = document.getElementById('profile-id-value');
            const profileDisplayId = document.getElementById('profile-display-id');
            
            if (profileName) profileName.textContent = state.user.email.split('@')[0] || 'You';
            if (profileId) profileId.textContent = state.user.email;
            if (profilePlan) profilePlan.textContent = state.user.is_pro ? 'Pro' : 'Free';
            if (profilePlanSub) profilePlanSub.textContent = state.user.is_pro ? 'Pro' : 'Free';
            if (profileIdSub) profileIdSub.textContent = state.user.email;
            if (profileDisplayId) profileDisplayId.textContent = state.displayId;
            
            // ─── Update Settings main values ───
            const settingsTier = document.getElementById('settings-tier-value');
            if (settingsTier) settingsTier.textContent = state.user.is_pro ? 'Pro' : 'Free';
            
            // ─── Update admin status (shield icon) ───
            checkAdminStatus();
            
            // ─── Reload conversations (if needed) ───
            // Only if the user changed, refresh the conversation list
            if (state.isAuthenticated) {
                loadConversations();
            }
        })
        .catch(err => {
            console.warn('[refreshUserInfo] Failed:', err);
            // Silently fail – user info will still be available from localStorage
        });
}

// ─── INIT ───
function initApp() {
    const nameEl = document.getElementById('sidebar-name');
    const emailEl = document.getElementById('sidebar-email');
    const proBadge = document.getElementById('sidebar-pro-badge');
    if (state.user) {
        if (nameEl) nameEl.textContent = state.user.email.split('@')[0];
        if (emailEl) emailEl.textContent = state.user.email;
        if (proBadge) {
            proBadge.textContent = state.user.is_pro ? '⭐ PRO' : 'FREE';
            proBadge.className = 'sidebar-pro-badge' + (state.user.is_pro ? ' pro' : '');
        }
    }
    if (!state.userId && state.user) state.userId = state.user.email;
    // Hide localhost hint on render
    if (state.apiUrl.includes('onrender.com') || window.location.hostname !== 'localhost') {
        const hint = document.getElementById('auth-hint');
        if (hint) hint.style.display = 'none';
    }
    updateUsageDisplay();
    try { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' }); } catch(e) {}
    if (window.Chart) updateChartDefaults();
    loadConversations();
    const micBtn = document.getElementById('mic-btn');
if (micBtn) micBtn.style.display = 'flex';
    initScrollHeader();
    initSettings();
    initTextarea();
    initClickOutside();
    initDragDrop();
    initPaste();
    initConnectivity();
    initInstallPrompt();
    initSwipeSidebar();
    initSimulationToggle();
    initKeyboardHandler();
    if (state.user && state.user.is_pro) setProUi();
    setTimeout(() => { if (state.apiUrl) { updateConnStatus('checking'); checkServerHealth(); } }, 100);
}

function initScrollHeader() {
    const sc = document.getElementById('chat-scroll');
    const tb = document.querySelector('.top-bar');
    if (!sc || !tb) return;
    sc.addEventListener('scroll', () => tb.classList.toggle('scrolled', sc.scrollTop > 10));
}
function initSettings() {
    const ta = document.getElementById('settings-custom-instructions');
    if (ta) ta.value = state.customInstructions;
    document.querySelectorAll('.style-chip').forEach(chip => {
        if (chip) chip.classList.toggle('active', chip.dataset.style === state.responseStyle);
    });
    const autoTtsToggle = document.getElementById('auto-tts-toggle');
    if (autoTtsToggle) autoTtsToggle.checked = state.autoTts;
}
function initTextarea() {
    const ta = document.getElementById('msg-input');
    if (!ta) return;
    ta.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 200) + 'px';
        updateSendButton();
        updateChatPadding(); // ensure spacing
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });
    ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
}
function initClickOutside() {
    document.addEventListener('click', e => {
        const modelToggle = document.getElementById('model-toggle');
        const modelMenu = document.getElementById('model-menu');
        if (modelToggle && modelMenu) {
            if (!modelToggle.contains(e.target) && !modelMenu.contains(e.target)) {
                modelMenu.classList.remove('open');
                modelToggle.classList.remove('open');
            }
        }
        const attachBtn = document.querySelector('.attach-btn');
        const attachPop = document.getElementById('attach-pop');
        if (attachBtn && attachPop) {
            if (!attachBtn.contains(e.target) && !attachPop.contains(e.target)) {
                attachPop.classList.remove('open');
            }
        }
        const moreWrap = document.querySelector('.more-wrap');
        if (moreWrap && !moreWrap.contains(e.target)) { closeMoreMenu(); }
    });
}
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
            } else toast('📎 Use the attach menu for documents', 'info');
        }
    });
}
async function handleDroppedFile(file) {
    if (!state.userId || state.userId === 'null' || state.userId === 'undefined') {
        state.userId = state.user?.email || 'u_' + Date.now();
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('user_id', state.userId);
    if (state.conversationId) formData.append('conversation_id', state.conversationId);
    toast('📤 Uploading document...', 'info');
    try {
        const res = await fetch(`${state.apiUrl}/upload`, { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) { const err = new Error(data.detail || 'Upload failed'); err.status = res.status; throw err; }
        toast(`📄 Document ready: ${data.extracted_length} chars`, 'success');
        if (!state.conversationId && data.conversation_id) {
            state.conversationId = data.conversation_id;
            loadConversations();
        }
        state.pendingDocContent = data.content || data.preview || '';
        state.pendingDocFilename = data.filename || file.name;
        showDocPreview(state.pendingDocFilename);
        updateSendButton();
    } catch (err) { handleError(err, 'Upload (Dropped)'); }
}
function initPaste() {
    document.addEventListener('paste', e => {
        const items = e.clipboardData.items;
        for (let item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file) continue;
                if (file.size > 5 * 1024 * 1024) { toast('📎 Pasted image too large. Max 5MB.', 'error'); continue; }
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
function initSwipeSidebar() {
    const app = document.getElementById('app');
    if (!app) return;
    let startX = 0, startY = 0;
    app.addEventListener('touchstart', function(e) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });
    app.addEventListener('touchend', function(e) {
        const diffX = e.changedTouches[0].clientX - startX;
        const diffY = e.changedTouches[0].clientY - startY;
        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
            if (diffX > 0) { toggleSidebar(); } else { closeSidebar(); }
        }
    }, { passive: true });
}
function initKeyboardHandler() {
    const input = document.getElementById('msg-input');
    const inputShell = document.querySelector('.input-shell');
    const chatScroll = document.getElementById('chat-scroll');
    if (!input || !inputShell) return;
    if ('visualViewport' in window) {
        let lastHeight = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', () => {
            const currentHeight = window.visualViewport.height;
            const isKeyboardOpen = currentHeight < lastHeight - 150;
            if (isKeyboardOpen) {
                inputShell.classList.add('keyboard-open');
                if (chatScroll) chatScroll.classList.add('keyboard-open');
                setTimeout(scrollBottom, 100);
            } else {
                inputShell.classList.remove('keyboard-open');
                if (chatScroll) chatScroll.classList.remove('keyboard-open');
            }
            lastHeight = currentHeight;
        });
    }
}
function initSimulationToggle() {
    let toggle = document.getElementById('sim-toggle');
    if (!toggle) {
        const modelBar = document.querySelector('.composer-model-row');
        if (!modelBar) return;
        toggle = document.createElement('button');
        toggle.className = 'simulation-toggle glass-toggle';
        toggle.id = 'sim-toggle';
        toggle.innerHTML = '<span class="sim-icon">🔮</span><span>Hindsight</span><span class="sim-limit-badge" id="sim-badge">1/1</span>';
        toggle.onclick = toggleSimulationMode;
        toggle.title = 'Toggle VEYRONIS HINDSIGHT simulation mode';
        modelBar.appendChild(toggle);
    }
    updateSimBadge();
}
function updateSimBadge() {
    const toggle = document.getElementById('sim-toggle');
    if (!toggle) return;
    const oldBadge = toggle.querySelector('.sim-limit-badge');
    if (oldBadge) oldBadge.remove();
    const isPro = state.user?.is_pro || false;
    const today = new Date().toDateString();
    if (state.simulationDate !== today) {
        state.simulationCount = 0;
        state.simulationDate = today;
        localStorage.setItem('veyronis_sim_date', today);
        localStorage.setItem('veyronis_sim_count', '0');
    }
    const limit = isPro ? 20 : 1;
    const remaining = Math.max(0, limit - state.simulationCount);
    const badge = document.createElement('span');
    badge.className = 'sim-limit-badge' + (isPro ? ' pro' : '');
    badge.textContent = isPro ? `${remaining}/20` : `${remaining}/1`;
    toggle.appendChild(badge);
}
function updateChatPadding() {
    const messages = document.getElementById('messages');
    const inputShell = document.querySelector('.input-shell');
    if (!messages || !inputShell) return;
    const inputHeight = inputShell.offsetHeight;
    const paddingBottom = Math.max(inputHeight + 24, 120);
    messages.style.paddingBottom = paddingBottom + 'px';
}
function updateChartDefaults() {
    if (!window.Chart) return;
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    Chart.defaults.color = theme === 'light' ? '#555570' : '#9ca3af';
    Chart.defaults.borderColor = theme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
}
function initConnectivity() {
    window.addEventListener('online', () => {
        state.isOnline = true;
        document.body.classList.remove('offline');
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.add('hidden');
        toast('🌐 Back online', 'success');
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
        toast('📡 You are offline', 'error');
    });
    if (!navigator.onLine) {
        document.body.classList.add('offline');
        const banner = document.getElementById('offline-banner');
        if (banner) banner.classList.remove('hidden');
    }
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
        toast('📱 VEYRONIS installed! 🎉', 'success');
    });
}

// ─── DOM READY ───
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash && window.location.hash.includes('auth=')) { handleGoogleCallback(); }
    const loggedIn = checkAuth();
    if (!loggedIn) {
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
    }
handleEmailVerificationHash();
    // Forgot password – event listener already set, but ensure no duplicate
    // We'll remove inline onclick in HTML and use this.
    const forgotBtn = document.getElementById('forgot-password-btn');
    if (forgotBtn) {
        // Remove any inline onclick
        forgotBtn.removeAttribute('onclick');
        forgotBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showForgotPassword();
        });
    }
    document.getElementById('search-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch();
    });
    handleResetPasswordHash();
    setTimeout(updateChatPadding, 300);
});

// ─── ADMIN STATUS CHECK (already in init) ───

// ─── PREVIEW STATE ───
let previewAttachment = null;
let previewUrl = null;
let previewFilename = '';

// ─── OPEN PREVIEW ───
async function openPreview(attachmentId, filename, cloudinaryUrl, mimeType) {
    previewAttachment = attachmentId;
    previewFilename = filename;
    previewUrl = cloudinaryUrl;
    
    const modal = document.getElementById('modal-preview');
    const title = document.getElementById('preview-filename');
    const content = document.getElementById('preview-content');
    
    if (!modal || !content) return;
    
    title.textContent = filename;
    content.innerHTML = '<div class="preview-loading"><div class="spinner"></div><span>Loading preview...</span></div>';
    
    openModal('modal-preview');
    
    const ext = filename.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
    const isPDF = ext === 'pdf';
    const isText = ['txt', 'md', 'json', 'xml', 'css', 'js', 'py', 'html', 'csv'].includes(ext);
    
    try {
        if (isImage && cloudinaryUrl && cloudinaryUrl !== '#') {
            content.innerHTML = `<img src="${cloudinaryUrl}" alt="${filename}" onerror="this.style.display='none'">`;
        } else if (isPDF && cloudinaryUrl && cloudinaryUrl !== '#') {
            if (typeof pdfjsLib !== 'undefined') {
                await renderPDF(cloudinaryUrl, content);
            } else {
                content.innerHTML = `<iframe src="${cloudinaryUrl}" style="width:100%;height:70vh;border:none;border-radius:8px;"></iframe>`;
            }
        } else if (isText && cloudinaryUrl && cloudinaryUrl !== '#') {
            await renderTextFile(cloudinaryUrl, content);
        } else {
            // Fallback – no preview available, show informational message only
            content.innerHTML = `
                <div style="text-align:center;padding:40px;">
                    <div style="font-size:48px;margin-bottom:16px;">📄</div>
                    <h3 style="color:var(--text);">${escapeHtml(filename)}</h3>
                    <p style="color:var(--text-muted);margin:8px 0;">Preview not available for this file type.</p>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">You can download this file from the attachments modal.</p>
                </div>
            `;
        }
    } catch (err) {
        console.error('[Preview] Error:', err);
        content.innerHTML = `
            <div style="text-align:center;padding:40px;color:#ef4444;">
                <div style="font-size:48px;">⚠️</div>
                <p>Could not load preview: ${escapeHtml(err.message)}</p>
                <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">You can download this file from the attachments modal.</p>
            </div>
        `;
    }
}

// ─── RENDER PDF ───
async function renderPDF(url, container) {
    try {
        const pdfjsLib = window.pdfjsLib;
        if (!pdfjsLib) {
            container.innerHTML = `<iframe src="${url}" style="width:100%;height:70vh;border:none;border-radius:8px;"></iframe>`;
            return;
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.js';
        
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;
        
        let html = '<div class="pdf-page-container">';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            html += `<canvas height="${viewport.height}" width="${viewport.width}" style="max-width:100%;height:auto;"></canvas>`;
        }
        html += '</div>';
        container.innerHTML = html;
    } catch (err) {
        console.error('[PDF Render] Error:', err);
        container.innerHTML = `
            <div style="text-align:center;padding:40px;color:#ef4444;">
                <div style="font-size:48px;">📄</div>
                <p>Could not render PDF: ${escapeHtml(err.message)}</p>
                <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">You can download this file from the attachments modal.</p>
            </div>
        `;
    }
}

// ─── RENDER TEXT FILE ───
async function renderTextFile(url, container) {
    try {
        const response = await fetch(url);
        const text = await response.text();
        
        // If we got HTML, fallback
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
            container.innerHTML = `
                <div style="text-align:center;padding:40px;">
                    <div style="font-size:48px;margin-bottom:16px;">📄</div>
                    <h3 style="color:var(--text);">${escapeHtml(previewFilename)}</h3>
                    <p style="color:var(--text-muted);margin:8px 0;">Cannot preview this file directly.</p>
                    <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">You can download this file from the attachments modal.</p>
                </div>
            `;
            return;
        }
        
        // Truncate if too long
        let displayText = text;
        if (text.length > 500000) {
            displayText = text.slice(0, 500000) + '\n\n... (file truncated, download to view full content)';
        }
        
        container.innerHTML = `<pre>${escapeHtml(displayText)}</pre>`;
    } catch (err) {
        console.error('[Preview] Text load error:', err);
        container.innerHTML = `
            <div style="text-align:center;padding:40px;color:#ef4444;">
                <div style="font-size:48px;">⚠️</div>
                <p>Could not load text file: ${escapeHtml(err.message)}</p>
                <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">You can download this file from the attachments modal.</p>
            </div>
        `;
    }
}

// ─── CLOSE PREVIEW ───
function closePreview() {
    closeModal('modal-preview');
    previewAttachment = null;
    previewUrl = null;
    previewFilename = '';
}

// ─── DOWNLOAD PREVIEW (kept but not used) ───
function downloadPreview() {
    if (!previewUrl || previewUrl === '#') {
        toast('❌ No downloadable file available', 'error');
        return;
    }
    const downloadUrl = previewUrl.includes('?') 
        ? previewUrl + '&fl_attachment' 
        : previewUrl + '?fl_attachment';
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = previewFilename || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ─── CLOSE PREVIEW ───
function closePreview() {
    closeModal('modal-preview');
    previewAttachment = null;
    previewUrl = null;
    previewFilename = '';
}