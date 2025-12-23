// ============================================================================
// CONFIGURATION
// ============================================================================
const API_BASE_URL = 'https://secrets-of-secrets.onrender.com/api';
const RATE_REFRESH_INTERVAL = 20000;
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Transaction limits
const TRANSACTION_LIMITS = {
    guest: { min: 1000, max: 350000 },
    authenticated: { min: 1000, max: 10000000 }
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let state = {
    sendAmount: 1000,
    sendCurrency: 'NGN',
    sendSymbol: '₦',
    receiveAmount: 0,
    receiveCurrency: 'INR',
    receiveSymbol: '₹',
    payMethod: 'bank',
    receiveMethod: 'upi',
    receiveTime: '5-10 minutes',
    exchangeRate: 15.96,
    sessionId: null,
    rateData: null,
    lastRateUpdate: null,
    qrStream: null,
    paymentDetails: null,
    lockedRate: null,
    lockedRateData: null,
    rateRefreshInterval: null,
    countdownInterval: null,
    countdownEndTime: null,
    user: null,
    isAuthenticated: false,
    userEmail: null,
    transactionLimit: TRANSACTION_LIMITS.guest
};

let auth, db;

// ============================================================================
// AUDIO MANAGEMENT
// ============================================================================
function playSuccessSound() {
    const ctx = audioContext;
    const now = ctx.currentTime;
  
    // ---------- MASTER GAIN ----------
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  
    // ---------- LAYER 1: Soft Bell (Instant Reward) ----------
    const bell = ctx.createOscillator();
    const bellGain = ctx.createGain();
  
    bell.type = 'sine';
    bell.frequency.setValueAtTime(1800, now);
    bell.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
  
    bellGain.gain.setValueAtTime(0.0001, now);
    bellGain.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
    bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
  
    bell.connect(bellGain);
    bellGain.connect(master);
  
    bell.start(now);
    bell.stop(now + 0.3);
  
    // ---------- LAYER 2: Ascending Major Confirmation ----------
    const notes = [659.25, 783.99]; // E5 → G5 (universally "positive")
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
  
      osc.type = 'triangle';
      osc.frequency.value = freq;
  
      const t = now + 0.12 + i * 0.1;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  
      osc.connect(gain);
      gain.connect(master);
  
      osc.start(t);
      osc.stop(t + 0.25);
    });
  
    // ---------- LAYER 3: Warm Low Resolve (Closure) ----------
    const resolve = ctx.createOscillator();
    const resolveGain = ctx.createGain();
  
    resolve.type = 'sine';
    resolve.frequency.setValueAtTime(220, now + 0.35); // A3
    resolve.frequency.exponentialRampToValueAtTime(196, now + 0.6); // G3
  
    resolveGain.gain.setValueAtTime(0.0001, now + 0.35);
    resolveGain.gain.exponentialRampToValueAtTime(0.18, now + 0.4);
    resolveGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
  
    resolve.connect(resolveGain);
    resolveGain.connect(master);
  
    resolve.start(now + 0.35);
    resolve.stop(now + 0.65);
}
// ============================================================================
// TERMS & CONDITIONS HANDLER
// ============================================================================

(function initTermsHandler() {
    const termsCheckbox = document.getElementById('termsCheckbox');
    const continueBtn = document.getElementById('continueBtn');
    const termsSection = document.querySelector('.terms-section');
    
    if (!termsCheckbox || !continueBtn) return;
    
    // Handle checkbox change
    termsCheckbox.addEventListener('change', function() {
        if (this.checked) {
            continueBtn.disabled = false;
            termsSection.classList.add('active');
            
            // Optional: Store acceptance in localStorage
            localStorage.setItem('termsAccepted', 'true');
            localStorage.setItem('termsAcceptedTimestamp', Date.now());
            
          
        } else {
            continueBtn.disabled = true;
            termsSection.classList.remove('active');
            localStorage.removeItem('termsAccepted');
            
           
        }
    });
    
    // Prevent form submission if terms not accepted
    continueBtn.addEventListener('click', function(e) {
        if (!termsCheckbox.checked) {
            e.preventDefault();
            e.stopPropagation();
            
            // Shake the terms section to draw attention
            termsSection.style.animation = 'shake 0.5s ease-in-out';
            setTimeout(() => {
                termsSection.style.animation = '';
            }, 500);
            
            // Optional: Scroll to terms checkbox
            termsSection.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center' 
            });
            
            return false;
        }
    });
    
    // Check if terms were previously accepted (within last 24 hours)
    const termsAccepted = localStorage.getItem('termsAccepted');
    const acceptedTimestamp = localStorage.getItem('termsAcceptedTimestamp');
    
    if (termsAccepted === 'true' && acceptedTimestamp) {
        const hoursSinceAcceptance = (Date.now() - parseInt(acceptedTimestamp)) / (1000 * 60 * 60);
        
        // Auto-check if accepted within last 24 hours
        if (hoursSinceAcceptance < 24) {
            termsCheckbox.checked = true;
            continueBtn.disabled = false;
            termsSection.classList.add('active');
            console.log('✅ Terms previously accepted (auto-checked)');
        }
    }
})();

// ============================================================================
// TOAST NOTIFICATION SYSTEM
// ============================================================================
function initToastContainer() {
    if (document.getElementById('toastContainer')) return;
    
    const container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 12px;
        pointer-events: none;
    `;
    document.body.appendChild(container);
    
    const style = document.createElement('style');
    style.innerHTML = `
        .toast {
            background: var(--surface, #ffffff);
            border: 1px solid var(--border, #e9ecef);
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            padding: 16px 20px;
            min-width: 320px;
            max-width: 400px;
            display: flex;
            align-items: flex-start;
            gap: 12px;
            pointer-events: all;
            animation: slideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            position: relative;
            overflow: hidden;
        }
        
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(100%); }
            to { opacity: 1; transform: translateX(0); }
        }
        
        .toast.removing {
            animation: slideOut 0.3s ease forwards;
        }
        
        @keyframes slideOut {
            to { opacity: 0; transform: translateX(100%); }
        }
        
        .toast-icon {
            width: 24px;
            height: 24px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            margin-top: 2px;
        }
        
        .toast-success .toast-icon { background: rgba(0, 212, 170, 0.15); }
        .toast-error .toast-icon { background: rgba(239, 68, 68, 0.15); }
        .toast-warning .toast-icon { background: rgba(255, 107, 53, 0.15); }
        .toast-info .toast-icon { background: rgba(107, 78, 246, 0.15); }
        
        .toast-icon svg { width: 16px; height: 16px; }
        
        .toast-content { flex: 1; min-width: 0; }
        
        .toast-title {
            font-size: 14px;
            font-weight: 700;
            color: #1a1a1a;
            margin-bottom: 2px;
            line-height: 1.4;
        }
        
        .toast-message {
            font-size: 13px;
            color: #6c757d;
            font-weight: 500;
            line-height: 1.5;
        }
        
        .toast-close {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
            background: none;
            border: none;
            color: #adb5bd;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s ease;
            padding: 0;
        }
        
        .toast-close:hover {
            background: #f8f9fa;
            color: #1a1a1a;
        }
        
        .toast-close svg { width: 14px; height: 14px; }
        
        .toast-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            background: currentColor;
            opacity: 0.3;
            animation: progress 5s linear forwards;
        }
        
        @keyframes progress {
            from { width: 100%; }
            to { width: 0%; }
        }
        
        .toast-success .toast-progress { color: #00d4aa; }
        .toast-error .toast-progress { color: #ef4444; }
        .toast-warning .toast-progress { color: #ff6b35; }
        .toast-info .toast-progress { color: #6b4ef6; }
        
        @media (max-width: 640px) {
            #toastContainer {
                top: 16px;
                right: 16px;
                left: 16px;
            }
            .toast {
                min-width: auto;
                max-width: none;
            }
        }
    `;
    document.head.appendChild(style);
}

function showToast(type = 'success', title, message, duration = 5000) {
    initToastContainer();
    
    const icons = {
        success: `<svg viewBox="0 0 24 24" fill="none" stroke="#00d4aa" stroke-width="2.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>`,
        error: `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>`,
        warning: `<svg viewBox="0 0 24 24" fill="none" stroke="#ff6b35" stroke-width="2.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>`,
        info: `<svg viewBox="0 0 24 24" fill="none" stroke="#6b4ef6" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>`
    };
    
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.classList.add('removing'); setTimeout(() => this.parentElement.remove(), 300)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
        <div class="toast-progress"></div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
// Close notice bar functionality with localStorage
const noticeBar = document.getElementById('noticeBar');
const closeBtn = noticeBar?.querySelector('.notice-close');

// Check if user previously closed the notice
if (localStorage.getItem('noticeBarClosed') === 'true') {
    noticeBar?.classList.add('hidden');
}

// Handle close button click
closeBtn?.addEventListener('click', () => {
    noticeBar.classList.add('hidden');
    localStorage.setItem('noticeBarClosed', 'true');
    
    // Optional: Set expiry (remove after 24 hours)
    setTimeout(() => {
        localStorage.removeItem('noticeBarClosed');
    }, 24 * 60 * 60 * 1000);
});

// ============================================================================
// FIREBASE AUTHENTICATION - OPTIMIZED FOR SPEED
// ============================================================================
async function initFirebase() {
    return new Promise((resolve) => {
        try {
            if (typeof firebase === 'undefined') {
                console.warn('Firebase not loaded, skipping authentication');
                resolve(false);
                return;
            }

            if (!window.firebaseConfig) {
                console.warn('Firebase config not found, skipping authentication');
                resolve(false);
                return;
            }

            if (!firebase.apps.length) {
                firebase.initializeApp(window.firebaseConfig);
            }
            
            auth = firebase.auth();
            db = firebase.database();
            
            // Set persistence for better UX
            auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
                .catch(err => console.warn('Persistence setting failed:', err));
            
            // ✅ FIXED: Wait for first auth state, then resolve
            const unsubscribe = auth.onAuthStateChanged((user) => {
                console.log('🔄 Auth state:', user ? user.email : 'Guest');
                
                if (user) {
                    state.user = user;
                    state.isAuthenticated = true;
                    state.userEmail = user.email;
                    state.transactionLimit = TRANSACTION_LIMITS.authenticated;
                    
                    // Hide email field
                    const emailField = document.getElementById('email');
                    const emailGroup = emailField?.closest('.form-group');
                    if (emailGroup) emailGroup.style.display = 'none';
                    
                    console.log('✅ User authenticated:', user.email);
                    
                    // ✅ Update CTA link
                    updateCTALink(true);
                    
                    // Show welcome toast (only once per session)
                    // Show welcome toast (only once per session)
if (!sessionStorage.getItem('welcomeShown')) {
    showToast('success', 'Welcome Back!', `Logged in as ${user.email}`);
    sessionStorage.setItem('welcomeShown', 'true');
}

                } else {
                    state.user = null;
                    state.isAuthenticated = false;
                    state.userEmail = null;
                    state.transactionLimit = TRANSACTION_LIMITS.guest;
                    
                    // Show email field
                    const emailField = document.getElementById('email');
                    const emailGroup = emailField?.closest('.form-group');
                    if (emailGroup) emailGroup.style.display = 'block';
                    
                    console.log('ℹ️ Guest user');
                    
                    // ✅ Update CTA link
                    updateCTALink(false);
                }
                
                updateTransactionLimitUI();
                
                // ✅ Resolve after first auth check (fast!)
                resolve(true);
                // Keep listening for auth changes (don't unsubscribe)
            });
            
        } catch (error) {
            console.error('Firebase init failed:', error);
            resolve(false);
        }
    });
}

// ============================================================================
// SHOW AUTH LOADING STATE ON CTA
// ============================================================================
function showAuthLoadingState() {
    const ctaLink = document.querySelector('.cta-link');
    if (ctaLink) {
        ctaLink.innerHTML = '<span style="opacity: 0.5;">Checking account...</span>';
        ctaLink.style.pointerEvents = 'none';
    }
}

function hideAuthLoadingState() {
    const ctaLink = document.querySelector('.cta-link');
    if (ctaLink) {
        ctaLink.style.pointerEvents = 'auto';
    }
}

// ============================================================================
// UPDATE CTA LINK BASED ON AUTH STATE
// ============================================================================
function updateCTALink(isAuthenticated) {
    const ctaLink = document.querySelector('.cta-link');
    
    if (ctaLink) {
        // ✅ ALWAYS re-enable clicks (in case auth loading disabled it)
        ctaLink.style.pointerEvents = 'auto';
        
        if (isAuthenticated) {
            // ✅ Logged-in users see reward offer
            ctaLink.innerHTML = 'Send & Receive a $50 Reward →';
            ctaLink.href = '../rewards/';
            ctaLink.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        } else {
            // ✅ Guests see sign-in prompt
            ctaLink.innerHTML = 'Sign in for better rates →';
            ctaLink.href = '../auth/';
            ctaLink.style.background = ''; // Reset to default
        }
    }
}



function updateTransactionLimitUI() {
    const limitText = document.querySelector('.transaction-limit-text');
    if (limitText) {
        const { min, max } = state.transactionLimit;
        limitText.textContent = `Transaction limit: ₦${min.toLocaleString()} - ₦${max.toLocaleString()}`;
        
        if (!state.isAuthenticated) {
            const existingPrompt = limitText.querySelector('small');
            if (existingPrompt) existingPrompt.remove();
            
            const signInPrompt = document.createElement('small');
            signInPrompt.style.cssText = 'display: block; color: #6b4ef6; margin-top: 4px; cursor: pointer;';
            signInPrompt.innerHTML = '🔓 Sign in to send up to ₦10,000,000';
            signInPrompt.onclick = () => {
                window.location.href = '../auth/';
            };
            limitText.appendChild(signInPrompt);
        }
    }
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
const validators = {
    email: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    upiId: (upiId) => /^[a-zA-Z0-9._-]+@[a-zA-Z]+$/.test(upiId),
    ifscCode: (ifsc) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase()),
    accountNumber: (acc) => /^\d{9,18}$/.test(acc),
    amount: (amount) => {
        const { min, max } = state.transactionLimit;
        return amount >= min && amount <= max;
    },
    name: (name) => name.trim().length >= 3 && /^[a-zA-Z\s.]+$/.test(name)
};

// ============================================================================
// QR CODE SCANNER
// ============================================================================
const QRScanner = {
    async init() {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('Camera access not supported');
            }
            return true;
        } catch (error) {
            console.error('QR Scanner init failed:', error);
            return false;
        }
    },

    async startScanning() {
        const modal = document.getElementById('qrModal');
        const video = document.getElementById('qr-video');
        
        if (!modal || !video) {
            showToast('error', 'QR Scanner Error', 'QR scanner elements not found');
            return;
        }
        
        try {
            modal.classList.add('active');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            
            video.srcObject = stream;
            state.qrStream = stream;
            await video.play();
            this.scanFrame(video);
        } catch (error) {
            console.error('Camera access error:', error);
            showToast('error', 'Camera Access Denied', 'Please enter UPI ID manually');
            this.stopScanning();
        }
    },

    scanFrame(video) {
        if (!video.srcObject) return;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const scan = () => {
            if (!video.srcObject) return;
            
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            
            if (typeof jsQR !== 'undefined') {
                const code = jsQR(imageData.data, imageData.width, imageData.height);
                if (code) {
                    this.handleQRCode(code.data);
                } else {
                    requestAnimationFrame(scan);
                }
            } else {
                console.error('jsQR library not loaded');
                this.stopScanning();
                showToast('error', 'QR Scanner Error', 'Scanner library not available');
            }
        };
        scan();
    },

    handleQRCode(data) {
        try {
            let upiId = null, name = null;
            
            if (data.startsWith('upi://pay')) {
                const params = new URLSearchParams(data.split('?')[1]);
                upiId = params.get('pa');
                name = params.get('pn');
            } else if (data.includes('@')) {
                upiId = data;
            } else if (data.includes('upi://')) {
                const match = data.match(/pa=([^&]+)/);
                if (match) upiId = match[1];
                const nameMatch = data.match(/pn=([^&]+)/);
                if (nameMatch) name = decodeURIComponent(nameMatch[1]);
            }
            
            if (upiId) {
                const upiInput = document.getElementById('upiId');
                if (upiInput) upiInput.value = upiId;
                
                if (name) {
                    const nameInput = document.getElementById('receiverName');
                    if (nameInput) nameInput.value = name;
                }
                
                showToast('success', 'QR Scanned!', 'UPI details extracted successfully');
                this.stopScanning();
            } else {
                showToast('error', 'Invalid QR', 'Could not extract UPI details');
            }
        } catch (error) {
            console.error('QR parsing error:', error);
            showToast('error', 'Parse Error', 'Failed to read QR code');
        }
    },

    stopScanning() {
        const modal = document.getElementById('qrModal');
        const video = document.getElementById('qr-video');
        
        if (state.qrStream) {
            state.qrStream.getTracks().forEach(track => track.stop());
            state.qrStream = null;
        }
        if (video) video.srcObject = null;
        if (modal) modal.classList.remove('active');
    }
};

// ============================================================================
// API FUNCTIONS
// ============================================================================
async function makeApiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`API call failed: ${endpoint}`, error);
        throw error;
    }
}

// ============================================================================
// UPDATED: FETCH EXCHANGE RATES WITH ERROR HANDLING
// ============================================================================
async function fetchExchangeRates() {
    try {
        const data = await makeApiCall('/rates');
        
        state.rateData = data;
        state.exchangeRate = data.rates.horizonPayRate;
        state.lastRateUpdate = new Date();
        
        if (!state.lockedRate) {
            updateExchangeRate();
            updateRateDisplay(data);
        }
        
        // ✅ Reset error states
        updateNoticeBarError(false);
        showFormContent(true);
        
    } catch (error) {
        console.error('Failed to fetch rates:', error);
        
        // ✅ Show error in notice bar
        updateNoticeBarError(true);
        
        // ✅ Show error state in form if no cached rates
        if (!state.rateData) {
            showFormContent(false);
            showToast('error', 'Connection Error', 'Unable to load exchange rates');
        } else {
            // ✅ Has cached rates, just show warning toast
            showToast('warning', 'Rate Update Failed', 'Using cached exchange rate');
        }
    }
}

// ============================================================================
// NEW: TOGGLE FORM CONTENT / ERROR STATE
// ============================================================================
function showFormContent(show) {
    const formContent = document.getElementById('formContent');
    const errorState = document.getElementById('errorState');
    
    if (!formContent || !errorState) return;
    
    if (show) {
        // ✅ Show form, hide error
        formContent.classList.remove('hidden');
        errorState.classList.add('hidden');
    } else {
        // ✅ Hide form, show error
        formContent.classList.add('hidden');
        errorState.classList.remove('hidden');
    }
}

// ============================================================================
// NEW: RETRY FETCHING RATES
// ============================================================================
async function retryFetchRates() {
    const retryButton = document.querySelector('.retry-button');
    
    if (retryButton) {
        retryButton.disabled = true;
        retryButton.textContent = 'Retrying...';
    }
    
    try {
        await fetchExchangeRates();
        
        if (state.rateData) {
            showToast('success', 'Connected!', 'Exchange rates loaded successfully');
        }
    } catch (error) {
        showToast('error', 'Still Unable to Connect', 'Please try again later');
    } finally {
        if (retryButton) {
            retryButton.disabled = false;
            retryButton.textContent = 'Try Again';
        }
    }
}

// ============================================================================
// UPDATED: NOTICE BAR ERROR STATE
// ============================================================================
function updateNoticeBarError(hasError) {
    const noticeBar = document.querySelector('.notice-bar');
    const rateBadge = document.querySelector('.notice-bar .rate-badge');
    
    if (!noticeBar || !rateBadge) return;
    
    if (hasError) {
        // ✅ Change entire notice-bar to orange gradient
        noticeBar.style.background = 'linear-gradient(90deg, #ff8c42 0%, #ff6b35 100%)';
        
        // ✅ Update rate badge content
        rateBadge.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Sorry, no rates available 😢 Check back later
        `;
    } else {
        // ✅ Reset to normal purple gradient
        noticeBar.style.background = 'linear-gradient(90deg, #6b4ef6 0%, #5a3dd9 100%)';
        
        // ✅ Reset to normal rate display
        const rate = state.lockedRate || state.exchangeRate;
        rateBadge.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            ${state.lockedRate ? '🔒 Locked Rate' : 'Live Rate'}: 1 ${state.receiveCurrency} = ${rate.toFixed(2)} ${state.sendCurrency}
        `;
    }
}




async function createConversion() {
    try {
        let email;
        if (state.isAuthenticated) {
            email = state.userEmail;
        } else {
            const emailInput = document.getElementById('email');
            if (!emailInput || !emailInput.value.trim()) {
                throw new Error('Please enter your email address');
            }
            email = emailInput.value.trim();
            if (!validators.email(email)) {
                throw new Error('Please enter a valid email address');
            }
        }

        let receiverName, receiverDetails;
        
        if (state.receiveMethod === 'upi') {
            const upiInput = document.getElementById('upiId');
            const nameInput = document.getElementById('receiverName');
            
            if (!upiInput || !nameInput) {
                throw new Error('Form fields not found');
            }
            
            const upiId = upiInput.value.trim();
            receiverName = nameInput.value.trim();
            
            if (!validators.upiId(upiId)) {
                throw new Error('Invalid UPI ID format');
            }
            if (!validators.name(receiverName)) {
                throw new Error('Invalid receiver name');
            }
            
            receiverDetails = {
                receiveMethod: 'UPI',
                upiId: upiId,
                receiverName: receiverName
            };
        } else {
            const accountInput = document.getElementById('accountNumber');
            const ifscInput = document.getElementById('ifscCode');
            const nameInput = document.getElementById('accountName');
            
            if (!accountInput || !ifscInput || !nameInput) {
                throw new Error('Form fields not found');
            }
            
            const accountNumber = accountInput.value.trim();
            const ifscCode = ifscInput.value.trim();
            receiverName = nameInput.value.trim();
            
            if (!validators.accountNumber(accountNumber)) {
                throw new Error('Invalid account number');
            }
            if (!validators.ifscCode(ifscCode)) {
                throw new Error('Invalid IFSC code');
            }
            if (!validators.name(receiverName)) {
                throw new Error('Invalid account holder name');
            }
            
            receiverDetails = {
                receiveMethod: 'Bank Transfer',
                accountNumber: accountNumber,
                ifscCode: ifscCode.toUpperCase(),
                accountName: receiverName
            };
        }

        state.paymentDetails = receiverDetails;

        showLoading(true, 'Creating transaction session...');

        const conversionData = {
            amount: state.sendAmount,
            from: state.sendCurrency,
            to: state.receiveCurrency,
            customerName: receiverName,
            email: email,
            receiveMethod: receiverDetails.receiveMethod,
    upiId: receiverDetails.upiId || null,
    accountNumber: receiverDetails.accountNumber || null,
    ifscCode: receiverDetails.ifscCode || null,
    accountName: receiverDetails.accountName || null,
    receiverName: receiverDetails.receiverName || null
        };

        const data = await makeApiCall('/convert', {
            method: 'POST',
            body: JSON.stringify(conversionData)
        });

        state.sessionId = data.sessionId;
        state.lockedRate = state.exchangeRate;
        state.lockedRateData = { ...state.rateData };
        
        if (state.rateRefreshInterval) {
            clearInterval(state.rateRefreshInterval);
            state.rateRefreshInterval = null;
            console.log('🔒 Rate locked at:', state.lockedRate);
        }

        console.log('✅ Conversion created:', data);
        return data;

    } catch (error) {
        console.error('Conversion failed:', error);
        throw error;
    } finally {
        showLoading(false);
    }
}
async function initializePayment(sessionId) {
    try {
        showLoading(true, 'Initializing payment gateway...');

        const paymentRequest = {
            sessionId: sessionId,
            email: state.userEmail || document.getElementById('email')?.value.trim(),
            customerName: state.paymentDetails.receiverName || state.paymentDetails.accountName,
            userDetails: state.paymentDetails
        };

        const data = await makeApiCall('/payment/initialize', {
            method: 'POST',
            body: JSON.stringify(paymentRequest)
        });

        console.log('✅ Payment initialized:', data);
        return data;

    } catch (error) {
        console.error('Payment initialization failed:', error);
        throw error;
    } finally {
        showLoading(false);
    }
}
// ============================================================================
// UPDATED: INITIALIZATION
// ============================================================================


function openPaystackPayment(paymentData) {
    try {
        if (!window.PaystackPop) {
            throw new Error('Paystack library not loaded');
        }

        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: state.userEmail || document.getElementById('email')?.value.trim(),
            amount: Math.round(state.sendAmount * 100),
            currency: 'NGN',
            ref: paymentData.payment.reference,
            metadata: {
                sessionId: state.sessionId,
                lockedRate: state.lockedRate,
                custom_fields: [
                    {
                        display_name: "Exchange Rate",
                        variable_name: "exchange_rate",
                        value: `₦${state.lockedRate.toFixed(2)} per ₹1`
                    }
                ]
            },
            // ✅ FIX: Remove 'async' keyword here
            callback: function(response) {
                console.log('✅ Paystack payment successful:', response);
                showToast('success', 'Payment Received', 'Verifying with backend...');
                
                // ✅ Call async verification (wrap in IIFE or separate function)
                (async () => {
                    try {
                        const verifyResponse = await fetch(`${API_BASE_URL}/payment/verify-manual`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                reference: response.reference,
                                sessionId: state.sessionId
                            })
                        });
                        
                        const verifyData = await verifyResponse.json();
                        
                        if (verifyData.success && verifyData.status === 'completed') {
                            console.log('✅ Backend verification successful:', verifyData);
                            showPaymentSuccess(verifyData);
                        } else {
                            throw new Error(verifyData.error || 'Verification failed');
                        }
                        
                    } catch (error) {
                        console.error('❌ Backend verification failed:', error);
                        showToast('warning', 'Verification Delayed', 'Checking status...');
                        pollPaymentStatus(state.sessionId, response.reference);
                    }
                })();
            },
            
            onClose: function() {
                console.log('⚠️ Payment window closed');
                showToast('warning', 'Payment Cancelled', 'You closed the payment window');
            }
        });
        
        handler.openIframe();
    } catch (error) {
        console.error('Payment popup error:', error);
        showToast('error', 'Payment Error', error.message);
    }
}


async function pollPaymentStatus(sessionId, paymentReference = null, maxAttempts = 30) {
    let attempts = 0;
    
    const checkStatus = async () => {
        try {
            const data = await makeApiCall(`/payment/status/${sessionId}`);
            
            if (data.status === 'completed') {
                clearInterval(statusInterval);
                showPaymentSuccess(data);
                return;
            } else if (data.status === 'failed') {
                clearInterval(statusInterval);
                showPaymentFailure(data);
                return;
            }
            
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(statusInterval);
                showToast('error', 'Verification Timeout', 'Please contact support with your reference');
            }
        } catch (error) {
            console.error('Status check error:', error);
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(statusInterval);
            }
        }
    };
    
    const statusInterval = setInterval(checkStatus, 2000);
    checkStatus();
}

// ============================================================================
// UI UPDATE FUNCTIONS
// ============================================================================
function safeSetText(elementId, text) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = text;
    }
}

function updateExchangeRate() {
    const rate = state.lockedRate || state.exchangeRate;
    
    safeSetText('exchangeRate', `1 ₹ = ₦${rate.toFixed(2)}`);
    
    const noticeBar = document.querySelector('.notice-bar .rate-badge');
    if (noticeBar) {
        const svg = noticeBar.querySelector('svg')?.outerHTML || '';
        noticeBar.innerHTML = `${svg} ${state.lockedRate ? '🔒 Locked Rate' : 'Live Rate'}: 1 ₹ = ₦${rate.toFixed(2)}`;
    }
    
    const sendAmountInput = document.getElementById('sendAmount');
    const receiveAmountInput = document.getElementById('receiveAmount');
    
    if (sendAmountInput && document.activeElement === sendAmountInput) {
        state.receiveAmount = state.sendAmount / rate;
        if (receiveAmountInput) {
            receiveAmountInput.value = state.receiveAmount.toFixed(2);
        }
    } else if (receiveAmountInput) {
        state.sendAmount = state.receiveAmount * rate;
        if (sendAmountInput) {
            sendAmountInput.value = state.sendAmount.toFixed(2);
        }
    }
}

function updateRateDisplay(data) {
    const existingInfo = document.querySelector('.rate-info');
    if (existingInfo) existingInfo.remove();
    
    const rateInfo = document.createElement('div');
    rateInfo.className = 'rate-info';
    rateInfo.style.cssText = 'margin-top: 10px; font-size: 12px; color: #10b981;';
    rateInfo.innerHTML = `<small>✓ Rate Updated: ${new Date().toLocaleTimeString()} | Source: ${data.rates.rateSource || 'Live Market'}</small>`;
    
    const exchangeDisplay = document.querySelector('.exchange-display');
    if (exchangeDisplay?.parentElement) {
        exchangeDisplay.parentElement.insertBefore(rateInfo, exchangeDisplay.nextSibling);
    }
}

function showLoading(show, message = 'Processing...') {
    let loader = document.getElementById('loadingOverlay');
    
    if (show && !loader) {
        loader = document.createElement('div');
        loader.id = 'loadingOverlay';
        loader.innerHTML = `
            <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 10000;">
                <div style="background: white; padding: 30px; border-radius: 10px; text-align: center;">
                    <div style="border: 4px solid #f3f3f3; border-top: 4px solid #6b4ef6; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px;"></div>
                    <p style="margin: 0; font-weight: 600; color: #1a1a1a;">${message}</p>
                </div>
            </div>
            <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
        `;
        document.body.appendChild(loader);
    } else if (!show && loader) {
        loader.remove();
    }
}

// ============================================================================
// COUNTDOWN TIMER
// ============================================================================
function startCountdown() {
    state.countdownEndTime = Date.now() + (5 * 60 * 1000);
    
    const updateCountdown = () => {
        const now = Date.now();
        const timeLeft = Math.max(0, Math.floor((state.countdownEndTime - now) / 1000));
        
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        
        const timerElement = document.getElementById('countdownTimer');
        if (timerElement) {
            timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }

        if (timeLeft <= 0) {
            clearInterval(state.countdownInterval);
            showToast('warning', 'Session Expired', 'Your rate lock has expired. Please start over.');
            const backBtn = document.getElementById('backBtn');
            if (backBtn) backBtn.click();
        }
    };
    
    updateCountdown();
    state.countdownInterval = setInterval(updateCountdown, 1000);
}

// ============================================================================
// PAYMENT SUCCESS SCREEN
// ============================================================================
function showPaymentSuccess(data) {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    playSuccessSound();
    
    const step2 = document.getElementById('step2');
    if (!step2) return;
    
    const transactionId = (state.sessionId || '').slice(-10).toUpperCase();
    
    const successHtml = `
        <div style="text-align: center; padding: 48px 40px;">
            <div style="width: 80px; height: 80px; margin: 0 auto 28px; background: #00d4aa; border-radius: 50%; display: flex; align-items: center; justify-content: center; animation: scaleIn 0.3s ease;">
                <svg width="42" height="42" viewBox="0 0 52 52" style="stroke: white; stroke-width: 3; fill: none;">
                    <path d="M14 27l10 10 20-20"/>
                </svg>
            </div>
            
            <h1 style="font-size: 28px; font-weight: 800; letter-spacing: -0.8px; margin-bottom: 8px;">Payment Successful</h1>
            <p style="font-size: 15px; color: #6c757d; font-weight: 500; margin-bottom: 36px;">Your funds are on the way Est.15minutes</p>
            
            <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; margin-bottom: 28px;">
                <div style="font-size: 13px; color: #6c757d; font-weight: 600; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Amount Paid</div>
                <div style="font-size: 36px; font-weight: 800; color: #1a1a1a; font-family: monospace; letter-spacing: -1px;">₦${state.sendAmount.toFixed(2)}</div>
            </div>
            
            <div style="text-align: left; margin-bottom: 32px;">
                <div style="display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="font-size: 14px; color: #6c757d; font-weight: 500;">Transaction ID</span>
                    <span style="font-size: 14px; color: #1a1a1a; font-weight: 600; font-family: monospace;">${transactionId}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="font-size: 14px; color: #6c757d; font-weight: 500;">Date & Time</span>
                    <span style="font-size: 14px; color: #1a1a1a; font-weight: 600; font-family: monospace;">${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true })}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="font-size: 14px; color: #6c757d; font-weight: 500;">Exchange Rate</span>
                    <span style="font-size: 14px; color: #1a1a1a; font-weight: 600;">₦${(state.lockedRate || state.exchangeRate).toFixed(2)} per ₹1</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="font-size: 14px; color: #6c757d; font-weight: 500;">Recipient</span>
                    <span style="font-size: 14px; color: #1a1a1a; font-weight: 600;">${state.paymentDetails?.receiverName || state.paymentDetails?.accountName || 'N/A'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 14px 0;">
                    <span style="font-size: 14px; color: #6c757d; font-weight: 500;">Status</span>
                    <span style="font-size: 14px; color: #d4aa00; font-weight: 600;">Processing</span>
                </div>
            </div>
            
            <div style="display: flex; gap: 12px; margin-bottom: 20px;">
                <button onclick="location.reload()" style="flex: 1; padding: 16px; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; border: none; background: #6b4ef6; color: white;">
                    New Transaction
                </button>
            </div>
            
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 28px; font-size: 12px; color: #adb5bd; font-weight: 500;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Secured by Paystack • 256-bit encryption
            </div>
        </div>
        
        <style>
            @keyframes scaleIn {
                from { transform: scale(0.8); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }
        </style>
    `;
    
    step2.innerHTML = successHtml;
    showToast('success', 'Payment Successful', `Transaction ${transactionId} completed`);
}

function showPaymentFailure(data) {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    showToast('error', 'Payment Failed', data.error || 'Transaction could not be completed');
    setTimeout(() => {
        const backBtn = document.getElementById('backBtn');
        if (backBtn) backBtn.click();
    }, 2000);
}

// ============================================================================
// DROPDOWN MANAGEMENT
// ============================================================================
function setupCurrencyDropdowns() {
    document.querySelectorAll('#sendCurrencyDropdown .select-option:not(.disabled)').forEach(option => {
        option.addEventListener('click', () => {
            state.sendCurrency = option.dataset.currency;
            state.sendSymbol = option.dataset.symbol;
            
            safeSetText('sendCurrencyCode', state.sendCurrency);
            safeSetText('sendSymbol', state.sendSymbol);
            
            const flagClass = option.dataset.flag;
            const flagElement = document.querySelector('#sendCurrencyTrigger .flag-icon');
            if (flagElement) flagElement.className = `${flagClass} flag-icon`;
            
            document.getElementById('sendCurrencyTrigger')?.classList.remove('active');
            document.getElementById('sendCurrencyDropdown')?.classList.remove('active');
            
            updateExchangeRate();
        });
    });
    
    document.querySelectorAll('#receiveCurrencyDropdown .select-option:not(.disabled)').forEach(option => {
        option.addEventListener('click', () => {
            state.receiveCurrency = option.dataset.currency;
            state.receiveSymbol = option.dataset.symbol;
            
            safeSetText('receiveCurrencyCode', state.receiveCurrency);
            safeSetText('receiveSymbol', state.receiveSymbol);
            
            const flagClass = option.dataset.flag;
            const flagElement = document.querySelector('#receiveCurrencyTrigger .flag-icon');
            if (flagElement) flagElement.className = `${flagClass} flag-icon`;
            
            document.getElementById('receiveCurrencyTrigger')?.classList.remove('active');
            document.getElementById('receiveCurrencyDropdown')?.classList.remove('active');
            
            updateExchangeRate();
        });
    });
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
function setupEventListeners() {
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const progress2 = document.getElementById('progress2');
    
    // Amount inputs
    const sendAmountInput = document.getElementById('sendAmount');
    const receiveAmountInput = document.getElementById('receiveAmount');
    
    if (sendAmountInput) {
        sendAmountInput.addEventListener('input', (e) => {
            state.sendAmount = parseFloat(e.target.value) || 0;
            
            if (state.sendAmount > state.transactionLimit.max) {
                if (!state.isAuthenticated) {
                    showToast('warning', 'Transaction Limit Exceeded', `Sign in to send up to ₦10,000,000. Guest limit: ₦${state.transactionLimit.max.toLocaleString()}`);
                    e.target.value = state.transactionLimit.max;
                    state.sendAmount = state.transactionLimit.max;
                }
            }
            
            updateExchangeRate();
        });
    }
    
    if (receiveAmountInput) {
        receiveAmountInput.addEventListener('input', (e) => {
            state.receiveAmount = parseFloat(e.target.value) || 0;
            updateExchangeRate();
        });
    }
    
    // Dropdown toggles
    const setupDropdownToggle = (triggerId, dropdownId, otherTriggers) => {
        const trigger = document.getElementById(triggerId);
        const dropdown = document.getElementById(dropdownId);
        
        if (trigger && dropdown) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                trigger.classList.toggle('active');
                dropdown.classList.toggle('active');
                otherTriggers.forEach(id => {
                    document.getElementById(id)?.classList.remove('active');
                    const dropdownId = id.replace('Trigger', 'Dropdown');
                    document.getElementById(dropdownId)?.classList.remove('active');
                });
            });
        }
    };
    
    setupDropdownToggle('sendCurrencyTrigger', 'sendCurrencyDropdown', 
        ['receiveCurrencyTrigger', 'payMethodTrigger', 'receiveMethodTrigger']);
    setupDropdownToggle('receiveCurrencyTrigger', 'receiveCurrencyDropdown', 
        ['sendCurrencyTrigger', 'payMethodTrigger', 'receiveMethodTrigger']);
    setupDropdownToggle('payMethodTrigger', 'payMethodDropdown', 
        ['sendCurrencyTrigger', 'receiveCurrencyTrigger', 'receiveMethodTrigger']);
    setupDropdownToggle('receiveMethodTrigger', 'receiveMethodDropdown', 
        ['sendCurrencyTrigger', 'receiveCurrencyTrigger', 'payMethodTrigger']);
    
    // Payment method selection
    document.querySelectorAll('#payMethodDropdown .payment-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('#payMethodDropdown .payment-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            state.payMethod = option.dataset.method;
            const methodName = option.querySelector('.payment-name');
            if (methodName) {
                safeSetText('payMethodName', methodName.textContent);
            }
            document.getElementById('payMethodTrigger')?.classList.remove('active');
            document.getElementById('payMethodDropdown')?.classList.remove('active');
        });
    });
    
    // Receive method selection
    document.querySelectorAll('#receiveMethodDropdown .payment-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('#receiveMethodDropdown .payment-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            state.receiveMethod = option.dataset.method;
            state.receiveTime = option.dataset.time;
            const methodName = option.querySelector('.payment-name');
            if (methodName) {
                safeSetText('receiveMethodName', methodName.textContent);
            }
            safeSetText('receiveMethodDesc', option.dataset.time);
            document.getElementById('receiveMethodTrigger')?.classList.remove('active');
            document.getElementById('receiveMethodDropdown')?.classList.remove('active');
            
            const upiDetails = document.getElementById('upiDetails');
            const bankDetails = document.getElementById('bankDetails');
            
            if (state.receiveMethod === 'upi') {
                upiDetails?.classList.remove('hidden');
                bankDetails?.classList.add('hidden');
            } else {
                upiDetails?.classList.add('hidden');
                bankDetails?.classList.remove('hidden');
            }
        });
    });
    
    // QR Scanner
    const scanQrBtn = document.getElementById('scanQrBtn');
    if (scanQrBtn) {
        scanQrBtn.addEventListener('click', async () => {
            const initialized = await QRScanner.init();
            if (initialized) {
                QRScanner.startScanning();
            } else {
                showToast('error', 'QR Scanner Error', 'Not available on this device');
            }
        });
    }
    
    const closeModal = document.getElementById('closeModal');
    if (closeModal) {
        closeModal.addEventListener('click', () => QRScanner.stopScanning());
    }
    
    const qrModal = document.getElementById('qrModal');
    if (qrModal) {
        qrModal.addEventListener('click', (e) => {
            if (e.target.id === 'qrModal') QRScanner.stopScanning();
        });
    }
    
    // Continue button
    const continueBtn = document.getElementById('continueBtn');
    if (continueBtn) {
        continueBtn.addEventListener('click', async () => {
            try {
                if (!validators.amount(state.sendAmount)) {
                    const { min, max } = state.transactionLimit;
                    if (state.sendAmount > max && !state.isAuthenticated) {
                        showToast('warning', 'Sign In Required', 'Sign in to send larger amounts');
                        return;
                    }
                    showToast('warning', 'Invalid Amount', `Amount must be between ₦${min.toLocaleString()} and ₦${max.toLocaleString()}`);
                    return;
                }
                
                if (state.receiveMethod === 'upi') {
                    const upiId = document.getElementById('upiId')?.value.trim();
                    const receiverName = document.getElementById('receiverName')?.value.trim();
                    
                    if (!upiId || !validators.upiId(upiId)) {
                        showToast('error', 'Invalid UPI ID', 'Please enter a valid UPI ID');
                        document.getElementById('upiId')?.focus();
                        return;
                    }
                    if (!receiverName || !validators.name(receiverName)) {
                        showToast('error', 'Invalid Name', 'Please enter receiver name (minimum 3 characters)');
                        document.getElementById('receiverName')?.focus();
                        return;
                    }
                } else {
                    const accountNumber = document.getElementById('accountNumber')?.value.trim();
                    const ifscCode = document.getElementById('ifscCode')?.value.trim();
                    const accountName = document.getElementById('accountName')?.value.trim();
                    
                    if (!accountNumber || !validators.accountNumber(accountNumber)) {
                        showToast('error', 'Invalid Account', 'Please enter a valid account number');
                        document.getElementById('accountNumber')?.focus();
                        return;
                    }
                    if (!ifscCode || !validators.ifscCode(ifscCode)) {
                        showToast('error', 'Invalid IFSC', 'Please enter a valid IFSC code');
                        document.getElementById('ifscCode')?.focus();
                        return;
                    }
                    if (!accountName || !validators.name(accountName)) {
                        showToast('error', 'Invalid Name', 'Please enter account holder name');
                        document.getElementById('accountName')?.focus();
                        return;
                    }
                }
                
                if (!state.isAuthenticated) {
                    const email = document.getElementById('email')?.value.trim();
                    if (!email || !validators.email(email)) {
                        showToast('error', 'Invalid Email', 'Please enter a valid email address');
                        document.getElementById('email')?.focus();
                        return;
                    }
                }
                
                const conversionData = await createConversion();
                
                step1?.classList.add('hidden');
                step2?.classList.remove('hidden');
                progress2?.classList.add('active');
                
                setTimeout(() => {
                    if (conversionData.success && conversionData.horizonPayOffer) {
                        const offer = conversionData.horizonPayOffer;
                        
                        const updates = {
                            'summaryYouSend': offer.youPay || `${state.sendCurrency} ${state.sendAmount.toFixed(2)}`,
                            'summaryRate': offer.exchangeRate || `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`,
                            'horizonRate': offer.exchangeRate || `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`,
                            'summaryFxFee': offer.feeCharged || `${state.sendCurrency} 0.00`,
                            'summaryTotal': offer.youPay || `${state.sendCurrency} ${state.sendAmount.toFixed(2)}`,
                            'summaryReceive': offer.youGet || `${state.receiveCurrency} ${state.receiveAmount.toFixed(2)}`
                        };
                        
                        Object.entries(updates).forEach(([id, value]) => {
                            const el = document.getElementById(id);
                            if (el) el.textContent = value;
                        });
                    }
                }, 100);
                
                window.scrollTo({ top: 0, behavior: 'smooth' });
                startCountdown();
                showToast('success', 'Session Created', 'Your rate has been locked for 5 minutes');
                
            } catch (error) {
                showToast('error', 'Error', error.message || 'Failed to create session');
            }
        });
    }
    
    // Pay button
    const payBtn = document.getElementById('payBtn');
    if (payBtn) {
        payBtn.addEventListener('click', async () => {
            try {
                if (!state.sessionId) {
                    throw new Error('No active session');
                }
                const paymentData = await initializePayment(state.sessionId);
                openPaystackPayment(paymentData);
            } catch (error) {
                showToast('error', 'Payment Error', error.message);
            }
        });
    }
    
    // Back button
    const backBtn = document.getElementById('backBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (state.countdownInterval) clearInterval(state.countdownInterval);
            
            state.lockedRate = null;
            state.lockedRateData = null;
            state.countdownEndTime = null;
            
            if (!state.rateRefreshInterval) {
                state.rateRefreshInterval = setInterval(fetchExchangeRates, RATE_REFRESH_INTERVAL);
            }
            
            step2?.classList.add('hidden');
            step1?.classList.remove('hidden');
            progress2?.classList.remove('active');
            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
    
    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        ['sendCurrencyTrigger', 'sendCurrencyDropdown', 'receiveCurrencyTrigger', 
         'receiveCurrencyDropdown', 'payMethodTrigger', 'payMethodDropdown',
         'receiveMethodTrigger', 'receiveMethodDropdown'].forEach(id => {
            document.getElementById(id)?.classList.remove('active');
        });
    });
    
    // Prevent dropdown close on dropdown click
    ['sendCurrencyDropdown', 'receiveCurrencyDropdown', 
     'payMethodDropdown', 'receiveMethodDropdown'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => e.stopPropagation());
    });
}

// ============================================================================
// INITIALIZATION - WAIT FOR AUTH FIRST
// ============================================================================
async function initializeApp() {
    const startTime = performance.now();
    console.log('🚀 HorizonPay initializing...');
    
    try {
        // ✅ STEP 1: Initialize Firebase and wait for auth
        console.log('🔐 Checking authentication...');
        showAuthLoadingState();
        await initFirebase();
        const authTime = performance.now() - startTime;
        console.log(`✅ Auth detected in ${authTime.toFixed(0)}ms`);
        
        // ✅ STEP 2: Fetch rates
        console.log('⏳ Loading exchange rates...');
        try {
            await fetchExchangeRates();
        } catch (error) {
            console.error('❌ Initial rate fetch failed:', error);
            // Error state already handled in fetchExchangeRates()
        }
        
        // ✅ STEP 3: Setup rate refresh
        state.rateRefreshInterval = setInterval(fetchExchangeRates, RATE_REFRESH_INTERVAL);
        
        // ✅ STEP 4: Initialize QR Scanner
        await QRScanner.init();
        
        // ✅ STEP 5: Setup UI
        setupCurrencyDropdowns();
        setupEventListeners();
        
        const totalTime = performance.now() - startTime;
        console.log(`✅ Initialized in ${totalTime.toFixed(0)}ms`);
        
    } catch (error) {
        console.error('Initialization error:', error);
        showToast('error', 'Initialization Failed', 'Some features may be limited');
    } finally {
        // Hide preloader
        const preloader = document.getElementById('preloader');
        if (preloader) {
            setTimeout(() => preloader.classList.add('hidden'), 1500);
        }
    }
}


// Start app
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}