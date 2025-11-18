// ============================================================================
// CONFIGURATION
// ============================================================================
const API_BASE_URL = 'http://localhost:3000/api';
const RATE_REFRESH_INTERVAL = 20000; // 20 seconds
const PAYSTACK_PUBLIC_KEY = 'pk_live_f96903b2fd3d000630ed00330120524503bea232';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let state = {
    sendAmount: 100,
    sendCurrency: 'NGN',
    sendSymbol: '₦',
    receiveAmount: 0,
    receiveCurrency: 'INR',
    receiveSymbol: '₹',
    payMethod: 'bank',
    receiveMethod: 'upi',
    receiveTime: '5-10 minutes',
    exchangeRate: 0,
    sessionId: null,
    rateData: null,
    lastRateUpdate: null,
    qrScanner: null,
    qrStream: null
};

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================
const validators = {
    email: (email) => {
        const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return re.test(email);
    },
    
    upiId: (upiId) => {
        // UPI ID format: username@bank or mobile@bank
        const re = /^[a-zA-Z0-9._-]+@[a-zA-Z]+$/;
        return re.test(upiId);
    },
    
    ifscCode: (ifsc) => {
        // IFSC format: ABCD0123456 (4 letters, 7 digits)
        const re = /^[A-Z]{4}0[A-Z0-9]{6}$/;
        return re.test(ifsc.toUpperCase());
    },
    
    accountNumber: (acc) => {
        // 9-18 digits
        const re = /^\d{9,18}$/;
        return re.test(acc);
    },
    
    amount: (amount, min = 1000, max = 10000000) => {
        return amount >= min && amount <= max;
    },
    
    name: (name) => {
        return name.trim().length >= 3 && /^[a-zA-Z\s]+$/.test(name);
    }
};

// ============================================================================
// QR CODE SCANNER
// ============================================================================
const QRScanner = {
    async init() {
        try {
            // Check for required APIs
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Camera access not supported');
            }

            // Import QR scanner library dynamically
            if (typeof window.jsQR === 'undefined') {
                await this.loadQRLibrary();
            }

            return true;
        } catch (error) {
            console.error('QR Scanner init failed:', error);
            return false;
        }
    },

    async loadQRLibrary() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    },

    async startScanning() {
        const modal = document.getElementById('qrModal');
        const video = document.getElementById('qr-video');
        
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
            showNotification('Camera access denied. Please enter UPI ID manually.', 'error');
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
            
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            
            if (code) {
                this.handleQRCode(code.data);
            } else {
                requestAnimationFrame(scan);
            }
        };
        
        scan();
    },

    handleQRCode(data) {
        console.log('QR Code detected:', data);
        
        try {
            // Parse different UPI QR formats
            let upiId = null;
            let name = null;
            
            // Format 1: upi://pay?pa=user@bank&pn=Name&...
            if (data.startsWith('upi://pay')) {
                const params = new URLSearchParams(data.split('?')[1]);
                upiId = params.get('pa');
                name = params.get('pn');
            }
            // Format 2: Plain UPI ID
            else if (data.includes('@')) {
                upiId = data;
            }
            // Format 3: Intent format
            else if (data.includes('upi://')) {
                const match = data.match(/pa=([^&]+)/);
                if (match) upiId = match[1];
                
                const nameMatch = data.match(/pn=([^&]+)/);
                if (nameMatch) name = decodeURIComponent(nameMatch[1]);
            }
            
            if (upiId) {
                document.getElementById('upiId').value = upiId;
                if (name) {
                    document.getElementById('receiverName').value = name;
                }
                showNotification('UPI details extracted successfully!', 'success');
                this.stopScanning();
            } else {
                showNotification('Invalid QR code format', 'error');
            }
            
        } catch (error) {
            console.error('QR parsing error:', error);
            showNotification('Failed to parse QR code', 'error');
        }
    },

    stopScanning() {
        const modal = document.getElementById('qrModal');
        const video = document.getElementById('qr-video');
        
        if (state.qrStream) {
            state.qrStream.getTracks().forEach(track => track.stop());
            state.qrStream = null;
        }
        
        video.srcObject = null;
        modal.classList.remove('active');
    }
};

// ============================================================================
// SOUND EFFECTS
// ============================================================================
function playSuccessSound() {
    try {
        const audio = new Audio('success.mp3');
        audio.volume = 0.5;
        audio.play().catch(err => console.log('Audio play failed:', err));
    } catch (error) {
        console.log('Audio not available:', error);
    }
}

// ============================================================================
// API FUNCTIONS WITH ERROR HANDLING
// ============================================================================

async function fetchExchangeRates() {
    try {
        const response = await fetch(`${API_BASE_URL}/rates`);
        if (!response.ok) throw new Error('Failed to fetch rates');
        
        const data = await response.json();
        state.rateData = data;
        
        // Correct rate: INR to NGN
        state.exchangeRate = data.rates.horizonPayRate; // NGN per INR
        state.lastRateUpdate = new Date();
        
        console.log('✅ Rates updated:', {
            rate: state.exchangeRate,
            timestamp: state.lastRateUpdate.toLocaleTimeString()
        });
        
        updateExchangeRate();
        updateRateDisplay(data);
        
    } catch (error) {
        console.error('❌ Failed to fetch rates:', error);
        showNotification('Failed to update exchange rates. Using cached rates.', 'warning');
    }
}

async function createConversion() {
    try {
        const customerName = document.getElementById('receiverName')?.value || 
                           document.getElementById('accountName')?.value || 
                           'Anonymous';
        
        // Validate name
        if (!validators.name(customerName)) {
            throw new Error('Please enter a valid name (minimum 3 characters, letters only)');
        }

        let userDetails = {
            amount: state.sendAmount,
            from: state.sendCurrency,
            to: state.receiveCurrency,
            customerName
        };

        // Validate and add method-specific details
        if (state.receiveMethod === 'upi') {
            const upiId = document.getElementById('upiId').value.trim();
            
            if (!validators.upiId(upiId)) {
                throw new Error('Invalid UPI ID format. Example: username@bank');
            }
            
            userDetails.upiId = upiId;
            userDetails.receiveMethod = 'UPI';
        } else {
            const accountNumber = document.getElementById('accountNumber').value.trim();
            const ifscCode = document.getElementById('ifscCode').value.trim();
            
            if (!validators.accountNumber(accountNumber)) {
                throw new Error('Invalid account number (must be 9-18 digits)');
            }
            
            if (!validators.ifscCode(ifscCode)) {
                throw new Error('Invalid IFSC code format (e.g., ABCD0123456)');
            }
            
            userDetails.bankAccount = accountNumber;
            userDetails.ifscCode = ifscCode.toUpperCase();
            userDetails.receiveMethod = 'Bank Transfer';
        }

        userDetails.paymentMethod = state.payMethod;

        showLoading(true, 'Creating conversion session...');

        const response = await fetch(`${API_BASE_URL}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(userDetails)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Conversion failed');
        }

        const data = await response.json();
        state.sessionId = data.sessionId;

        console.log('✅ Conversion created:', data);
        
        return data;

    } catch (error) {
        console.error('❌ Conversion failed:', error);
        throw error;
    } finally {
        showLoading(false);
    }
}

async function initializePayment(sessionId) {
    try {
        const customerName = document.getElementById('receiverName')?.value || 
                           document.getElementById('accountName')?.value || 
                           'Anonymous';
        
        let email = prompt('Enter your email for payment receipt:', '');
        
        if (!email) {
            throw new Error('Email is required for payment');
        }
        
        email = email.trim();
        
        if (!validators.email(email)) {
            throw new Error('Please enter a valid email address');
        }

        showLoading(true, 'Initializing payment gateway...');

        const response = await fetch(`${API_BASE_URL}/payment/initialize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sessionId,
                email,
                customerName
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Payment initialization failed');
        }

        const data = await response.json();
        
        console.log('✅ Payment initialized:', data);
        
        return data;

    } catch (error) {
        console.error('❌ Payment initialization failed:', error);
        throw error;
    } finally {
        showLoading(false);
    }
}

function openPaystackPayment(paymentData) {
    try {
        if (!window.PaystackPop) {
            throw new Error('Paystack library not loaded');
        }

        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: paymentData.email || 'customer@example.com',
            amount: Math.round(state.sendAmount * 100),
            currency: 'NGN',
            ref: paymentData.payment.reference,
            callback: function(response) {
                console.log('✅ Payment successful:', response);
                showNotification('Payment successful! Verifying...', 'success');
                playSuccessSound();
                pollPaymentStatus(state.sessionId, response.reference);
            },
            onClose: function() {
                console.log('Payment window closed');
                showNotification('Payment cancelled', 'warning');
            }
        });
        
        handler.openIframe();
    } catch (error) {
        console.error('Payment popup error:', error);
        showNotification('Failed to open payment window: ' + error.message, 'error');
    }
}

async function pollPaymentStatus(sessionId, paymentReference = null, maxAttempts = 30) {
    let attempts = 0;
    
    if (paymentReference) {
        console.log('🔍 Manually verifying payment with reference:', paymentReference);
        
        try {
            const verifyResponse = await fetch(`${API_BASE_URL}/payment/verify-manual`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    reference: paymentReference,
                    sessionId: sessionId 
                })
            });
            
            if (!verifyResponse.ok) {
                throw new Error('Verification request failed');
            }
            
            const verifyData = await verifyResponse.json();
            
            if (verifyData.success && verifyData.status === 'completed') {
                console.log('✅ Payment verified successfully!');
                showPaymentSuccess(verifyData);
                return;
            }
        } catch (error) {
            console.error('Manual verification failed, will poll:', error);
        }
    }
    
    const checkStatus = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/payment/status/${sessionId}`);
            
            if (!response.ok) {
                throw new Error('Status check failed');
            }
            
            const data = await response.json();
            
            console.log(`Checking payment status (${attempts + 1}/${maxAttempts}):`, data.status);
            
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
                showNotification('Payment verification timeout. Please contact support with your transaction reference.', 'error');
            }
            
        } catch (error) {
            console.error('Status check error:', error);
            attempts++;
            
            if (attempts >= maxAttempts) {
                clearInterval(statusInterval);
                showNotification('Unable to verify payment status. Please contact support.', 'error');
            }
        }
    };
    
    const statusInterval = setInterval(checkStatus, 2000);
    checkStatus();
}

// ============================================================================
// UI UPDATE FUNCTIONS
// ============================================================================

function updateExchangeRate() {
    const rateElement = document.getElementById('exchangeRate');
    if (rateElement) {
        // Display as 1 INR = X NGN
        rateElement.textContent = 
            `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`;
    }
    
    // Update notice bar
    const noticeBar = document.querySelector('.notice-bar');
    if (noticeBar) {
        const rateBadge = noticeBar.querySelector('.rate-badge');
        if (rateBadge) {
            const svg = rateBadge.querySelector('svg').outerHTML;
            rateBadge.innerHTML = `
                ${svg}
                Live Rate: 1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}
            `;
        }
    }
    
    // Recalculate amounts based on current input focus
    if (document.activeElement === document.getElementById('sendAmount')) {
        state.receiveAmount = state.sendAmount / state.exchangeRate;
        document.getElementById('receiveAmount').value = state.receiveAmount.toFixed(2);
    } else {
        state.sendAmount = state.receiveAmount * state.exchangeRate;
        document.getElementById('sendAmount').value = state.sendAmount.toFixed(2);
    }
}

function updateRateDisplay(data) {
    const rateInfo = document.createElement('div');
    rateInfo.className = 'rate-info';
    rateInfo.style.cssText = 'margin-top: 10px; font-size: 12px; color: #10b981;';
    rateInfo.innerHTML = `
        <small>
            ✓ Live Rate Updated: ${new Date().toLocaleTimeString()}
            | Margin: ${data.rates.profitMargin}
        </small>
    `;
    
    const existingInfo = document.querySelector('.rate-info');
    if (existingInfo) {
        existingInfo.replaceWith(rateInfo);
    } else {
        const exchangeDisplay = document.querySelector('.exchange-display');
        if (exchangeDisplay && exchangeDisplay.parentElement) {
            exchangeDisplay.parentElement.insertBefore(rateInfo, exchangeDisplay.nextSibling);
        }
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
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        `;
        document.body.appendChild(loader);
    } else if (!show && loader) {
        loader.remove();
    }
}

function showNotification(message, type = 'info') {
    const colors = {
        success: '#10b981',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };
    
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${colors[type]};
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10001;
        animation: slideIn 0.3s ease;
        max-width: 400px;
    `;
    notification.textContent = message;
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(400px); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

function createProcessingAnimation() {
    const steps = [
        { label: 'Fiat', icon: '₦', color: '#6b4ef6' },
        { label: 'USDT', icon: '₮', color: '#26a17b' },
        { label: 'UPI', icon: '₹', color: '#ff6b35' }
    ];
    
    const container = document.createElement('div');
    container.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 20px;
        margin: 30px 0;
    `;
    
    steps.forEach((step, index) => {
        const circle = document.createElement('div');
        circle.style.cssText = `
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: ${step.color};
            color: white;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            animation: pulse 1.5s ease-in-out ${index * 0.5}s infinite;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        `;
        
        circle.innerHTML = `
            <div style="font-size: 32px;">${step.icon}</div>
            <div style="font-size: 11px; margin-top: 4px;">${step.label}</div>
        `;
        
        container.appendChild(circle);
        
        if (index < steps.length - 1) {
            const arrow = document.createElement('div');
            arrow.style.cssText = `
                font-size: 24px;
                color: #cbd5e0;
                animation: slideRight 1s ease-in-out infinite;
            `;
            arrow.textContent = '→';
            container.appendChild(arrow);
        }
    });
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 0.8; }
            50% { transform: scale(1.1); opacity: 1; }
        }
        @keyframes slideRight {
            0%, 100% { transform: translateX(0); }
            50% { transform: translateX(5px); }
        }
    `;
    document.head.appendChild(style);
    
    return container;
}

function showPaymentSuccess(data) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    playSuccessSound();
    
    const processingAnim = createProcessingAnimation();
    
    const successHtml = `
        <div style="text-align: center; padding: 40px;">
            <div style="font-size: 80px; color: #10b981; margin-bottom: 20px; animation: checkmark 0.5s ease;">✓</div>
            <h2 style="color: #10b981; margin-bottom: 10px; font-size: 28px;">Payment Successful!</h2>
            <p style="color: #6b7280; font-size: 16px;">Your transaction has been completed successfully.</p>
            
            <div id="processingAnimation"></div>
            
            <div style="background: #f8f9fa; border-radius: 12px; padding: 20px; margin: 30px 0; text-align: left;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span style="color: #6b7280; font-size: 14px;">Session ID:</span>
                    <span style="font-weight: 600; font-size: 14px;">${data.sessionId}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                    <span style="color: #6b7280; font-size: 14px;">Status:</span>
                    <span style="font-weight: 600; color: #10b981; font-size: 14px; text-transform: capitalize;">${data.status}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #6b7280; font-size: 14px;">Verified:</span>
                    <span style="font-weight: 600; font-size: 14px;">${new Date(data.verifiedAt).toLocaleString()}</span>
                </div>
            </div>
            
            <button onclick="location.reload()" style="margin-top: 20px; padding: 15px 40px; background: #10b981; color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 16px; transition: all 0.2s;">
                Make Another Transaction
            </button>
        </div>
        
        <style>
            @keyframes checkmark {
                0% { transform: scale(0); opacity: 0; }
                50% { transform: scale(1.2); }
                100% { transform: scale(1); opacity: 1; }
            }
        </style>
    `;
    
    step2.innerHTML = successHtml;
    
    document.getElementById('processingAnimation').appendChild(processingAnim);
}

function showPaymentFailure(data) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    showNotification('Payment failed: ' + (data.error || 'Unknown error'), 'error');
    
    setTimeout(() => {
        backBtn.click();
    }, 2000);
}

// ============================================================================
// COUNTDOWN ANIMATION
// ============================================================================
let countdownInterval;

function startCountdown() {
    let timeLeft = 300; // 5 minutes
    const timerElement = document.getElementById('countdownTimer');
    const countdownBox = timerElement?.parentElement;

    countdownInterval = setInterval(() => {
        timeLeft--;

        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        
        if (timerElement) {
            timerElement.textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        // Warning colors
        if (countdownBox) {
            if (timeLeft <= 60) {
                countdownBox.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
                timerElement.style.animation = 'pulse 1s infinite';
            } else if (timeLeft <= 120) {
                countdownBox.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
            }
        }

        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            showNotification('Rate lock expired. Please review and continue again.', 'warning');
            backBtn.click();
        }
    }, 1000);
    
    // Add pulse animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
    `;
    document.head.appendChild(style);
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

// DOM elements
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const progress2 = document.getElementById('progress2');

const sendCurrencyTrigger = document.getElementById('sendCurrencyTrigger');
const sendCurrencyDropdown = document.getElementById('sendCurrencyDropdown');
const receiveCurrencyTrigger = document.getElementById('receiveCurrencyTrigger');
const receiveCurrencyDropdown = document.getElementById('receiveCurrencyDropdown');

const payMethodTrigger = document.getElementById('payMethodTrigger');
const payMethodDropdown = document.getElementById('payMethodDropdown');
const receiveMethodTrigger = document.getElementById('receiveMethodTrigger');
const receiveMethodDropdown = document.getElementById('receiveMethodDropdown');

const upiDetails = document.getElementById('upiDetails');
const bankDetails = document.getElementById('bankDetails');

const continueBtn = document.getElementById('continueBtn');
const backBtn = document.getElementById('backBtn');
const payBtn = document.getElementById('payBtn');

const sendAmountInput = document.getElementById('sendAmount');
const receiveAmountInput = document.getElementById('receiveAmount');

const scanQrBtn = document.getElementById('scanQrBtn');
const closeModalBtn = document.getElementById('closeModal');
const qrModal = document.getElementById('qrModal');

// Amount calculations
sendAmountInput.addEventListener('input', () => {
    state.sendAmount = parseFloat(sendAmountInput.value) || 0;
    state.receiveAmount = state.sendAmount / state.exchangeRate;
    receiveAmountInput.value = state.receiveAmount.toFixed(2);
});

receiveAmountInput.addEventListener('input', () => {
    state.receiveAmount = parseFloat(receiveAmountInput.value) || 0;
    state.sendAmount = state.receiveAmount * state.exchangeRate;
    sendAmountInput.value = state.sendAmount.toFixed(2);
});

// QR Scanner
scanQrBtn?.addEventListener('click', async () => {
    const initialized = await QRScanner.init();
    if (initialized) {
        QRScanner.startScanning();
    } else {
        showNotification('QR scanner not available on this device', 'error');
    }
});

closeModalBtn?.addEventListener('click', () => {
    QRScanner.stopScanning();
});

qrModal?.addEventListener('click', (e) => {
    if (e.target === qrModal) {
        QRScanner.stopScanning();
    }
});

// Dropdown toggles
sendCurrencyTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    sendCurrencyTrigger.classList.toggle('active');
    sendCurrencyDropdown.classList.toggle('active');
    receiveCurrencyTrigger.classList.remove('active');
    receiveCurrencyDropdown.classList.remove('active');
    payMethodTrigger.classList.remove('active');
    payMethodDropdown.classList.remove('active');
    receiveMethodTrigger.classList.remove('active');
    receiveMethodDropdown.classList.remove('active');
});

receiveCurrencyTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    receiveCurrencyTrigger.classList.toggle('active');
    receiveCurrencyDropdown.classList.toggle('active');
    sendCurrencyTrigger.classList.remove('active');
    sendCurrencyDropdown.classList.remove('active');
    payMethodTrigger.classList.remove('active');
    payMethodDropdown.classList.remove('active');
    receiveMethodTrigger.classList.remove('active');
    receiveMethodDropdown.classList.remove('active');
});

payMethodTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    payMethodTrigger.classList.toggle('active');
    payMethodDropdown.classList.toggle('active');
    sendCurrencyTrigger.classList.remove('active');
    sendCurrencyDropdown.classList.remove('active');
    receiveCurrencyTrigger.classList.remove('active');
    receiveCurrencyDropdown.classList.remove('active');
    receiveMethodTrigger.classList.remove('active');
    receiveMethodDropdown.classList.remove('active');
});

receiveMethodTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    receiveMethodTrigger.classList.toggle('active');
    receiveMethodDropdown.classList.toggle('active');
    sendCurrencyTrigger.classList.remove('active');
    sendCurrencyDropdown.classList.remove('active');
    receiveCurrencyTrigger.classList.remove('active');
    receiveCurrencyDropdown.classList.remove('active');
    payMethodTrigger.classList.remove('active');
    payMethodDropdown.classList.remove('active');
});

// Payment method selection
document.querySelectorAll('#payMethodDropdown .payment-option').forEach(option => {
    option.addEventListener('click', () => {
        document.querySelectorAll('#payMethodDropdown .payment-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        
        state.payMethod = option.dataset.method;
        document.getElementById('payMethodName').textContent = option.querySelector('.payment-name').textContent;
        
        payMethodDropdown.classList.remove('active');
        payMethodTrigger.classList.remove('active');
    });
});

// Receive method selection
document.querySelectorAll('#receiveMethodDropdown .payment-option').forEach(option => {
    option.addEventListener('click', () => {
        document.querySelectorAll('#receiveMethodDropdown .payment-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        
        state.receiveMethod = option.dataset.method;
        state.receiveTime = option.dataset.time;
        
        document.getElementById('receiveMethodName').textContent = option.querySelector('.payment-name').textContent;
        document.getElementById('receiveMethodDesc').textContent = option.dataset.time;
        
        receiveMethodDropdown.classList.remove('active');
        receiveMethodTrigger.classList.remove('active');

        if (state.receiveMethod === 'upi') {
            upiDetails.classList.remove('hidden');
            bankDetails.classList.add('hidden');
        } else {
            upiDetails.classList.add('hidden');
            bankDetails.classList.remove('hidden');
        }
    });
});

// Continue button - Creates conversion session
continueBtn.addEventListener('click', async () => {
    try {
        // Validate amount
        if (!validators.amount(state.sendAmount, 1000, 10000000)) {
            showNotification('Amount must be between ₦1,000 and ₦10,000,000', 'warning');
            return;
        }

        // Validate details based on receive method
        if (state.receiveMethod === 'upi') {
            const upiId = document.getElementById('upiId').value.trim();
            const receiverName = document.getElementById('receiverName').value.trim();
            
            if (!upiId) {
                showNotification('Please enter UPI ID', 'warning');
                document.getElementById('upiId').focus();
                return;
            }
            
            if (!validators.upiId(upiId)) {
                showNotification('Invalid UPI ID format (e.g., username@bank)', 'error');
                document.getElementById('upiId').focus();
                return;
            }
            
            if (!receiverName) {
                showNotification('Please enter receiver name', 'warning');
                document.getElementById('receiverName').focus();
                return;
            }
            
            if (!validators.name(receiverName)) {
                showNotification('Please enter a valid name (minimum 3 characters, letters only)', 'error');
                document.getElementById('receiverName').focus();
                return;
            }
        } else {
            const accountNumber = document.getElementById('accountNumber').value.trim();
            const ifscCode = document.getElementById('ifscCode').value.trim();
            const accountName = document.getElementById('accountName').value.trim();
            
            if (!accountNumber) {
                showNotification('Please enter account number', 'warning');
                document.getElementById('accountNumber').focus();
                return;
            }
            
            if (!validators.accountNumber(accountNumber)) {
                showNotification('Invalid account number (must be 9-18 digits)', 'error');
                document.getElementById('accountNumber').focus();
                return;
            }
            
            if (!ifscCode) {
                showNotification('Please enter IFSC code', 'warning');
                document.getElementById('ifscCode').focus();
                return;
            }
            
            if (!validators.ifscCode(ifscCode)) {
                showNotification('Invalid IFSC code format (e.g., ABCD0123456)', 'error');
                document.getElementById('ifscCode').focus();
                return;
            }
            
            if (!accountName) {
                showNotification('Please enter account holder name', 'warning');
                document.getElementById('accountName').focus();
                return;
            }
            
            if (!validators.name(accountName)) {
                showNotification('Please enter a valid name (minimum 3 characters, letters only)', 'error');
                document.getElementById('accountName').focus();
                return;
            }
        }

        // Create conversion
        const conversionData = await createConversion();
        
        // Update summary with real data
        if (conversionData.horizonPayOffer) {
            const offer = conversionData.horizonPayOffer;
            document.getElementById('summaryYouSend').textContent = offer.youPay || `${state.sendCurrency} ${state.sendAmount.toFixed(2)}`;
            document.getElementById('summaryRate').textContent = offer.exchangeRate || `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`;
            document.getElementById('horizonRate').textContent = offer.exchangeRate || `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`;
            document.getElementById('summaryFxFee').textContent = offer.feeCharged || `${state.sendCurrency} ${(state.sendAmount * 0.005).toFixed(2)}`;
            document.getElementById('summaryTotal').textContent = offer.youPay || `${state.sendCurrency} ${(state.sendAmount * 1.005).toFixed(2)}`;
            document.getElementById('summaryReceive').textContent = offer.youGet || `${state.receiveCurrency} ${state.receiveAmount.toFixed(2)}`;
        } else {
            // Fallback if backend doesn't return expected format
            const fxFee = state.sendAmount * 0.005;
            const total = state.sendAmount + fxFee;
            
            document.getElementById('summaryYouSend').textContent = `${state.sendCurrency} ${state.sendAmount.toFixed(2)}`;
            document.getElementById('summaryRate').textContent = `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`;
            document.getElementById('horizonRate').textContent = `1 ${state.receiveCurrency} = ${state.exchangeRate.toFixed(2)} ${state.sendCurrency}`;
            document.getElementById('summaryFxFee').textContent = `${state.sendCurrency} ${fxFee.toFixed(2)}`;
            document.getElementById('summaryTotal').textContent = `${state.sendCurrency} ${total.toFixed(2)}`;
            document.getElementById('summaryReceive').textContent = `${state.receiveCurrency} ${state.receiveAmount.toFixed(2)}`;
        }

        // Switch to step 2
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        progress2.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Start countdown
        startCountdown();
        
        showNotification('Conversion session created successfully!', 'success');

    } catch (error) {
        showNotification(error.message || 'Failed to create conversion', 'error');
        console.error('Continue button error:', error);
    }
});

// Pay button - Initialize Paystack payment
payBtn.addEventListener('click', async () => {
    try {
        if (!state.sessionId) {
            throw new Error('No session found. Please go back and try again.');
        }

        const paymentData = await initializePayment(state.sessionId);
        openPaystackPayment(paymentData);

    } catch (error) {
        showNotification(error.message || 'Payment initialization failed', 'error');
        console.error('Pay button error:', error);
    }
});

// Back button
backBtn.addEventListener('click', () => {
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
    
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
    progress2.classList.remove('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Close dropdowns on outside click
document.addEventListener('click', () => {
    sendCurrencyTrigger.classList.remove('active');
    sendCurrencyDropdown.classList.remove('active');
    receiveCurrencyTrigger.classList.remove('active');
    receiveCurrencyDropdown.classList.remove('active');
    payMethodTrigger.classList.remove('active');
    payMethodDropdown.classList.remove('active');
    receiveMethodTrigger.classList.remove('active');
    receiveMethodDropdown.classList.remove('active');
});

// Prevent dropdown close when clicking inside
[sendCurrencyDropdown, receiveCurrencyDropdown, payMethodDropdown, receiveMethodDropdown].forEach(dropdown => {
    dropdown?.addEventListener('click', (e) => {
        e.stopPropagation();
    });
});

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
    console.log('🚀 HorizonPay initialized');
    console.log(`📊 Auto-refreshing rates every ${RATE_REFRESH_INTERVAL / 1000} seconds`);
    
    try {
        // Fetch initial rates
        await fetchExchangeRates();
        
        // Auto-refresh rates
        setInterval(fetchExchangeRates, RATE_REFRESH_INTERVAL);
        
        // Initialize QR scanner library
        await QRScanner.init();
        
       
        
    } catch (error) {
        console.error('Initialization error:', error);
        showNotification('System initialized with limited features', 'warning');
    }
}

// Start app
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}