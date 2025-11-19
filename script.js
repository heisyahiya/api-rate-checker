require('dotenv').config();

// ============================================================================
// STEP 2: REQUIRE DEPENDENCIES
// ============================================================================
const express = require("express");
const https = require("https");
const zlib = require("zlib");
const winston = require("winston");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const CryptoJS = require("crypto-js");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");



// ============================================================================
// STEP 3: CREATE LOGS DIRECTORY (before logger)
// ============================================================================
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ============================================================================
// STEP 4: INITIALIZE LOGGER (before anything that uses it)
// ============================================================================
const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "currency-exchange-api" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 10485760,
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, "combined.log"),
      maxsize: 10485760,
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, "transactions.log"),
      level: "info",
      maxsize: 52428800,
      maxFiles: 10
    })
  ]
});

// ============================================================================
// STEP 5: GLOBAL ERROR HANDLERS (after logger)
// ============================================================================
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection", { reason, promise });
});

// ============================================================================
// STEP 6: CONFIGURATION (after logger)
// ============================================================================
const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  api: {
    timeout: parseInt(process.env.API_TIMEOUT) || 10000,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
    retryDelay: parseInt(process.env.RETRY_DELAY) || 2000,
  },
  cache: {
    ttl: parseInt(process.env.CACHE_TTL) || 1800,
    checkPeriod: parseInt(process.env.CACHE_CHECK_PERIOD) || 60,
  },
  pricing: {
    minProfitMargin: parseFloat(process.env.MIN_PROFIT_MARGIN) || 0.8,
    ngnMarkup: parseFloat(process.env.NGN_MARKUP) || 20,
    localRateMin: 16.2,
    localRateMax: 16.5,
    discountRangeMin: 15.85,
    discountRangeMax: 15.98,
    targetProfitMargin: 2.5,
  },
  fees: {
    tiers: [
      { max: 10000, percent: 2.5 },
      { max: 50000, percent: 2.0 },
      { max: 100000, percent: 1.5 },
      { max: 500000, percent: 1.0 },
      { max: Infinity, percent: 0.75 }
    ]
  },
  filters: {
    strict: {
      minTrades: 300,
      minCompletion: 90,
      minQty: 500,
      minPrice: 70,
      maxPrice: 120,
    },
    relaxed: {
      minTrades: 100,
      minCompletion: 85,
      minQty: 100,
      minPrice: 70,
      maxPrice: 120,
    }
  },
  security: {
    adminApiKey: process.env.ADMIN_API_KEY || "change-this-key",
    corsOrigin: process.env.CORS_ORIGIN || "*",
    trustProxy: process.env.TRUST_PROXY !== "false",
    encryptionKey: process.env.ENCRYPTION_KEY || "change-this-encryption-key",
    sessionTTL: 5 * 60 * 1000,
  },
  fallback: {
    ngnRate: parseFloat(process.env.FALLBACK_NGN_RATE) || 1650,
  },
  limits: {
    minTransaction: 1000,
    maxTransaction: 5000000,
    dailyLimit: 10000000,
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    publicKey: process.env.PAYSTACK_PUBLIC_KEY,
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || 'http://api-rate-checker.onrender.com/api/payment/verify'
  }
};
// const paystack = new Paystack(config.paystack.secretKey);
// ============================================================================
// STEP 7: INITIALIZE FIREBASE (after logger and config)
// ============================================================================
let db;

try {
  const admin = require("firebase-admin");

  // Check required env vars
  if (!process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_PRIVATE_KEY ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_DATABASE_URL) {
    logger.error("Missing Firebase ENV variables");
    process.exit(1);
  }

  // Initialize Firebase
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });

  db = admin.database();

  logger.info("Firebase initialized successfully", {
    projectId: process.env.FIREBASE_PROJECT_ID,
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });

} catch (error) {
  logger.error("Firebase initialization failed", {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
}

module.exports = db;
// ============================================================================
// STEP 7B: PAYSTACK API HELPER (Direct API - No Package)
// ============================================================================

const paystackAPI = {
  secretKey: config.paystack.secretKey,
  
  async initializeTransaction(data) {
    const https = require('https');
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path: '/transaction/initialize',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (error) {
            reject(new Error('Failed to parse Paystack response'));
          }
        });
      });
      req.on('error', (error) => { reject(error); });
      req.write(postData);
      req.end();
    });
  },
  
  async verifyTransaction(reference) {
    const https = require('https');
    
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path: `/transaction/verify/${reference}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json'
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (error) {
            reject(new Error('Failed to parse Paystack response'));
          }
        });
      });
      req.on('error', (error) => { reject(error); });
      req.end();
    });
  }
};

logger.info("✅ Paystack API helper initialized", {
  keyType: config.paystack.secretKey?.startsWith('sk_live_') ? 'LIVE' : 'TEST'
});
// ============================================================================
// STEP 8: CONTINUE WITH REST OF YOUR CODE
// ============================================================================
function encryptData(data) {
  try {
    const jsonString = JSON.stringify(data);
    const encrypted = CryptoJS.AES.encrypt(jsonString, config.security.encryptionKey).toString();
    return encrypted;
  } catch (error) {
    logger.error("Encryption failed", { error: error.message });
    throw new Error("Data encryption failed");
  }
}

function decryptData(encryptedData) {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedData, config.security.encryptionKey);
    const jsonString = decrypted.toString(CryptoJS.enc.Utf8);
    return JSON.parse(jsonString);
  } catch (error) {
    logger.error("Decryption failed", { error: error.message });
    throw new Error("Data decryption failed");
  }
}

// ✅ ADD THIS FUNCTION
function sanitizeForLog(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }
  
  const sanitized = { ...data };
  const sensitiveFields = ['accountNumber', 'phone', 'email', 'bankAccount', 'upiId', 'password'];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      const value = String(sanitized[field]);
      if (value.length > 6) {
        sanitized[field] = value.slice(0, 3) + '***' + value.slice(-3);
      } else {
        sanitized[field] = '***';
      }
    }
  });
  
  return sanitized;
}

// Cache
const cache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: config.cache.checkPeriod,
  useClones: false
});

// Metrics
const metrics = {
  requests: { total: 0, success: 0, errors: 0 },
  api: {
    binanceSpot: { calls: 0, failures: 0, avgLatency: 0 },
    coinGecko: { calls: 0, failures: 0, avgLatency: 0 },
    binanceP2P: { calls: 0, failures: 0, avgLatency: 0 }
  },
  cache: { hits: 0, misses: 0 },
  transactions: { total: 0, pending: 0, completed: 0, failed: 0 },
  fallbacks: { coinGeckoUsed: 0, totalFallbacks: 0 }
};

// Custom Errors
class APIError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = "APIError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

class ValidationError extends APIError {
  constructor(message, details = {}) {
    super(message, 400, details);
    this.name = "ValidationError";
  }
}

class ExternalAPIError extends APIError {
  constructor(message, details = {}) {
    super(message, 503, details);
    this.name = "ExternalAPIError";
  }
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpRequest(options, body = null, metricKey = null) {
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const latency = Date.now() - startTime;
        
        if (metricKey && metrics.api[metricKey]) {
          metrics.api[metricKey].calls++;
          const current = metrics.api[metricKey].avgLatency;
          const total = metrics.api[metricKey].calls;
          metrics.api[metricKey].avgLatency = (current * (total - 1) + latency) / total;
        }
        
        try {
          let buffer = Buffer.concat(chunks);
          const encoding = res.headers["content-encoding"];
          
          if (encoding === "gzip") buffer = zlib.gunzipSync(buffer);
          else if (encoding === "br") buffer = zlib.brotliDecompressSync(buffer);
          else if (encoding === "deflate") buffer = zlib.inflateSync(buffer);
          
          const data = JSON.parse(buffer.toString());
          
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new ExternalAPIError(`HTTP ${res.statusCode}`, {
              statusCode: res.statusCode,
              body: data
            }));
          }
        } catch (e) {
          reject(new ExternalAPIError("Failed to parse response", {
            error: e.message,
            statusCode: res.statusCode
          }));
        }
      });
    });
    
    req.on("error", (err) => {
      if (metricKey && metrics.api[metricKey]) {
        metrics.api[metricKey].failures++;
      }
      reject(new ExternalAPIError("Network request failed", {
        error: err.message
      }));
    });
    
    req.setTimeout(options.timeout || config.api.timeout, () => {
      req.destroy();
      if (metricKey && metrics.api[metricKey]) {
        metrics.api[metricKey].failures++;
      }
      reject(new ExternalAPIError("Request timeout", {
        timeout: options.timeout || config.api.timeout
      }));
    });
    
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function retryableRequest(requestFn, retries = config.api.maxRetries, delay = config.api.retryDelay) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      if (i === retries - 1) throw error;
      
      logger.warn(`Request failed, retrying (${i + 1}/${retries})`, {
        error: error.message,
        attempt: i + 1
      });
      
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
}

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function fetchBinanceSpot() {
  logger.debug("Fetching Binance Spot rate");
  
  try {
    const data = await httpRequest({
      hostname: "api.binance.com",
      path: "/api/v3/ticker/price?symbol=USDTINR",
      method: "GET",
    }, null, "binanceSpot");
    
    if (!data || !data.price) {
      throw new ExternalAPIError("Invalid Binance Spot response");
    }
    
    const price = parseFloat(data.price);
    if (isNaN(price) || price <= 0) {
      throw new ExternalAPIError("Invalid price in Binance Spot response");
    }
    
    logger.debug("Binance Spot rate fetched", { price });
    return price;
  } catch (error) {
    logger.error("Binance Spot fetch failed", { error: error.message });
    throw error;
  }
}

async function fetchCoinGecko() {
  logger.debug("Fetching CoinGecko rates");
  
  try {
    const data = await httpRequest({
      hostname: "api.coingecko.com",
      path: "/api/v3/simple/price?ids=tether&vs_currencies=inr,ngn",
      method: "GET",
    }, null, "coinGecko");
    
    if (!data || !data.tether) {
      throw new ExternalAPIError("Invalid CoinGecko response");
    }
    
    const result = { inr: null, ngn: null };
    
    if (data.tether.inr) {
      const price = parseFloat(data.tether.inr);
      result.inr = !isNaN(price) && price > 0 ? price : null;
    }
    
    if (data.tether.ngn) {
      const price = parseFloat(data.tether.ngn);
      result.ngn = !isNaN(price) && price > 0 ? price : null;
    }
    
    logger.debug("CoinGecko rates fetched", result);
    return result;
  } catch (error) {
    logger.error("CoinGecko fetch failed", { error: error.message });
    throw error;
  }
}

async function fetchBinanceP2P() {
  logger.debug("Fetching Binance P2P data");
  
  const body = JSON.stringify({
    asset: "USDT",
    fiat: "INR",
    tradeType: "SELL",
    page: 1,
    rows: 20,
    payTypes: [],
    merchantCheck: false,
    publisherType: null,
  });
  
  try {
    const data = await retryableRequest(async () => {
      return await httpRequest({
        hostname: "p2p.binance.com",
        path: "/bapi/c2c/v2/friendly/c2c/adv/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Accept-Encoding": "gzip, deflate, br",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      }, body, "binanceP2P");
    });
    
    if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
      throw new ExternalAPIError("No P2P data available");
    }
    
    logger.debug("Binance P2P data fetched", { adsCount: data.data.length });
    return data;
  } catch (error) {
    logger.error("Binance P2P fetch failed", { error: error.message });
    throw error;
  }
}

// ============================================================================
// DATA ANALYSIS
// ============================================================================

function analyzeP2P(data) {
  logger.debug("Analyzing P2P data");
  
  if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new ExternalAPIError("Invalid P2P data for analysis");
  }
  
  const ads = [];
  
  for (const item of data.data) {
    try {
      if (!item.adv || !item.advertiser) continue;
      
      const adv = item.adv;
      const seller = item.advertiser;
      
      const price = parseFloat(adv.price);
      if (isNaN(price) || price <= 0) continue;
      
      const qty = parseFloat(adv.surplusAmount || adv.tradableQuantity || 0);
      if (isNaN(qty)) continue;
      
      const trades = parseInt(seller.monthOrderCount) || 0;
      let completion = parseFloat(seller.monthFinishRate) || 0;
      if (completion > 0 && completion <= 1) {
        completion = completion * 100;
      }
      
      ads.push({
        price,
        qty,
        trades,
        completion,
        nickname: seller.nickName || "Unknown",
        userNo: seller.userNo || null
      });
    } catch (e) {
      logger.warn("Failed to parse P2P ad", { error: e.message });
      continue;
    }
  }
  
  if (ads.length === 0) {
    throw new ExternalAPIError("No valid P2P ads found");
  }
  
  let filtered = ads.filter(a => {
    const f = config.filters.strict;
    return (
      a.trades >= f.minTrades &&
      a.completion >= f.minCompletion &&
      a.qty >= f.minQty &&
      a.price >= f.minPrice &&
      a.price <= f.maxPrice
    );
  });
  
  if (filtered.length === 0) {
    logger.warn("No ads passed strict filter, trying relaxed");
    const f = config.filters.relaxed;
    filtered = ads.filter(a => {
      return (
        a.trades >= f.minTrades &&
        a.completion >= f.minCompletion &&
        a.qty >= f.minQty &&
        a.price >= f.minPrice &&
        a.price <= f.maxPrice
      );
    });
    
    if (filtered.length === 0) {
      throw new ExternalAPIError("No P2P ads meet quality criteria");
    }
  }
  
  const sorted = filtered.sort((a, b) => a.price - b.price);
  const top5 = sorted.slice(0, 5);
  const lowestRate = top5[0].price;
  
  const simpleAvg = top5.reduce((sum, a) => sum + a.price, 0) / top5.length;
  const totalWeight = top5.reduce((sum, a) => sum + a.qty, 0);
  const weightedAvg = top5.reduce((sum, a) => {
    return sum + (a.price * a.qty / totalWeight);
  }, 0);
  
  const result = {
    totalAds: ads.length,
    goodAds: filtered.length,
    lowestRate,
    simpleAvg,
    weightedAvg,
    topAds: top5.map(a => ({
      price: a.price,
      qty: a.qty,
      trades: a.trades,
      completion: a.completion.toFixed(1) + "%",
      seller: a.nickname,
      userNo: a.userNo,
      profileLink: a.userNo ? `https://p2p.binance.com/en/advertiserDetail?advertiserNo=${a.userNo}` : null
    }))
  };
  
  logger.debug("P2P analysis complete", {
    totalAds: result.totalAds,
    goodAds: result.goodAds,
    lowestRate: result.lowestRate
  });
  
  return result;
}

function calculateFees(amount) {
  for (const tier of config.fees.tiers) {
    if (amount <= tier.max) {
      const feeAmount = (amount * tier.percent) / 100;
      const netAmount = amount - feeAmount;
      return {
        feePercent: tier.percent,
        feeAmount,
        netAmount
      };
    }
  }
  
  const lastTier = config.fees.tiers[config.fees.tiers.length - 1];
  const feeAmount = (amount * lastTier.percent) / 100;
  return {
    feePercent: lastTier.percent,
    feeAmount,
    netAmount: amount - feeAmount
  };
}

// ✅ COMPLETELY REWRITTEN: New competitive pricing strategy
function calculateCompetitiveRate(lowestInrRate, ngnRate, coinGeckoInr = null) {
  logger.debug("Calculating competitive rate", { lowestInrRate, ngnRate, coinGeckoInr });
  
  // Step 1: Calculate base cost (NGN per INR)
  // Cost = (NGN needed to buy 1 USDT) / (INR we get from selling 1 USDT)
  const baseCostPerInr = ngnRate / lowestInrRate;
  
  // Step 2: Generate random competitive rate within our target range
  // This is what we'll charge the customer (NGN per INR)
  const randomRate = config.pricing.discountRangeMin + 
    (Math.random() * (config.pricing.discountRangeMax - config.pricing.discountRangeMin));
  
  // Round to 2 decimal places
  let finalRate = Math.round(randomRate * 100) / 100;
  
  // Step 3: Calculate profit margin
  // Profit Margin = (Revenue - Cost) / Revenue * 100
  const profitMargin = ((finalRate - baseCostPerInr) / finalRate) * 100;
  
  logger.debug("Initial rate calculation", {
    baseCostPerInr,
    randomRate,
    finalRate,
    profitMargin
  });
  
  // ✅ Step 4: CRITICAL - Check if profit margin is acceptable
  if (profitMargin < config.pricing.minProfitMargin) {
    logger.warn("Profit margin below minimum, attempting CoinGecko fallback", {
      profitMargin,
      minRequired: config.pricing.minProfitMargin,
      baseCostPerInr,
      finalRate
    });
    
    // ✅ FALLBACK TO COINGECKO
    if (coinGeckoInr && coinGeckoInr > 0) {
      logger.info("Using CoinGecko INR rate as fallback", { coinGeckoInr });
      metrics.fallbacks.coinGeckoUsed++;
      metrics.fallbacks.totalFallbacks++;
      
      // Recalculate with CoinGecko rate
      const coinGeckoBaseCost = ngnRate / coinGeckoInr;
      
      // Apply target profit margin
      const targetMultiplier = 1 + (config.pricing.targetProfitMargin / 100);
      finalRate = coinGeckoBaseCost * targetMultiplier;
      
      // Add small random variation for competitive edge
      const microAdjustment = (Math.random() * 0.1) - 0.05; // ±0.05
      finalRate += microAdjustment;
      
      // Round to 2 decimals
      finalRate = Math.round(finalRate * 100) / 100;
      
      // Recalculate profit margin
      const newProfitMargin = ((finalRate - coinGeckoBaseCost) / finalRate) * 100;
      
      logger.info("CoinGecko fallback calculation complete", {
        coinGeckoBaseCost,
        finalRate,
        profitMargin: newProfitMargin
      });
      
      // Final safety check
      if (newProfitMargin < config.pricing.minProfitMargin) {
        // Force minimum profit
        finalRate = coinGeckoBaseCost * (1 + (config.pricing.minProfitMargin / 100) + 0.005);
        finalRate = Math.round(finalRate * 100) / 100;
        
        logger.warn("Forced minimum profit margin", {
          adjustedRate: finalRate,
          profitMargin: ((finalRate - coinGeckoBaseCost) / finalRate) * 100
        });
      }
      
      return {
        baseCost: coinGeckoBaseCost,
        targetRate: finalRate,
        localRateMin: config.pricing.localRateMin,
        localRateMax: config.pricing.localRateMax,
        profitMargin: ((finalRate - coinGeckoBaseCost) / finalRate) * 100,
        savingsVsMin: config.pricing.localRateMin - finalRate,
        savingsVsMax: config.pricing.localRateMax - finalRate,
        savingsPercent: ((config.pricing.localRateMin - finalRate) / config.pricing.localRateMin) * 100,
        usedCoinGeckoFallback: true, // ✅ Flag for client
        rateSource: "CoinGecko (Fallback)"
      };
    } else {
      // ✅ NO COINGECKO AVAILABLE - Force minimum profit or reject
      logger.error("Insufficient profit margin and no CoinGecko fallback available", {
        profitMargin,
        minRequired: config.pricing.minProfitMargin,
        baseCostPerInr,
        finalRate
      });
      
      // Last resort: Force minimum profit and warn
      finalRate = baseCostPerInr * (1 + (config.pricing.minProfitMargin / 100) + 0.01);
      finalRate = Math.round(finalRate * 100) / 100;
      
      const forcedMargin = ((finalRate - baseCostPerInr) / finalRate) * 100;
      
      logger.warn("CRITICAL: Forced minimum rate without CoinGecko", {
        forcedRate: finalRate,
        forcedMargin
      });
      
      return {
        baseCost: baseCostPerInr,
        targetRate: finalRate,
        localRateMin: config.pricing.localRateMin,
        localRateMax: config.pricing.localRateMax,
        profitMargin: forcedMargin,
        savingsVsMin: config.pricing.localRateMin - finalRate,
        savingsVsMax: config.pricing.localRateMax - finalRate,
        savingsPercent: ((config.pricing.localRateMin - finalRate) / config.pricing.localRateMin) * 100,
        usedCoinGeckoFallback: false,
        rateSource: "P2P (Forced Minimum)",
        warning: "Rate adjusted to maintain minimum profit margin"
      };
    }
  }
  
  // ✅ Step 5: Rate is profitable, compare with local market
  const savingsVsMin = config.pricing.localRateMin - finalRate;
  const savingsVsMax = config.pricing.localRateMax - finalRate;
  const savingsPercent = savingsVsMin > 0 ? (savingsVsMin / config.pricing.localRateMin) * 100 : 0;
  
  logger.info("Competitive rate calculated successfully", {
    finalRate,
    profitMargin,
    savingsVsMin,
    savingsPercent
  });
  
  return {
    baseCost: baseCostPerInr,
    targetRate: finalRate,
    localRateMin: config.pricing.localRateMin,
    localRateMax: config.pricing.localRateMax,
    profitMargin,
    savingsVsMin,
    savingsVsMax,
    savingsPercent,
    usedCoinGeckoFallback: false,
    rateSource: "Binance P2P (Primary)"
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

function validateConversionRequest(amount, from, to) {
  if (typeof amount !== 'number' || isNaN(amount)) {
    throw new ValidationError("Amount must be a valid number");
  }
  
  if (amount <= 0) {
    throw new ValidationError("Amount must be greater than 0");
  }
  
  // ✅ NEW: Enhanced limits
  if (amount < config.limits.minTransaction) {
    throw new ValidationError(`Amount must be at least ₦${config.limits.minTransaction.toLocaleString()}`, {
      minAmount: config.limits.minTransaction
    });
  }
  
  if (amount > config.limits.maxTransaction) {
    throw new ValidationError(`Amount exceeds maximum limit of ₦${config.limits.maxTransaction.toLocaleString()}`, {
      maxAmount: config.limits.maxTransaction
    });
  }
  
  if (from !== "NGN") {
    throw new ValidationError("Only NGN source currency supported", {
      provided: from,
      supported: ["NGN"]
    });
  }
  
  if (to !== "INR") {
    throw new ValidationError("Only INR target currency supported", {
      provided: to,
      supported: ["INR"]
    });
  }
  
  return true;
}

function validateAdminAuth(req) {
  if (!config.security.adminApiKey) {
    throw new APIError("Admin API key not configured", 500);
  }
  
  const providedKey = req.headers["x-api-key"] || req.query.apiKey;
  
  if (!providedKey || providedKey !== config.security.adminApiKey) {
    throw new APIError("Unauthorized", 401);
  }
  
  return true;
}

// ✅ NEW: Validate user details
function validateUserDetails(details) {
  const errors = [];
  
  if (details.customerName && details.customerName.length < 2) {
    errors.push("Customer name must be at least 2 characters");
  }
  
  if (details.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    errors.push("Invalid email format");
  }
  
  if (details.phone && !/^[0-9]{10,15}$/.test(details.phone.replace(/\D/g, ''))) {
    errors.push("Invalid phone number");
  }
  
  if (errors.length > 0) {
    throw new ValidationError("Invalid user details", { errors });
  }
  
  return true;
}

// ============================================================================
// FIREBASE SESSION MANAGEMENT
// ============================================================================

// ✅ NEW: Create transaction session in Firebase
// Find this function and replace it:
async function createTransactionSession(transactionData, userDetails) {
  try {
    const sessionId = uuidv4();
    const timestamp = Date.now(); // ✅ Changed: Use Date.now() instead of ServerValue.TIMESTAMP
    const expiresAt = Date.now() + config.security.sessionTTL;
    
    // Validate encryption key exists
    if (!config.security.encryptionKey || config.security.encryptionKey === "change-this-encryption-key") {
      throw new Error("ENCRYPTION_KEY not properly configured in .env");
    }
    
    // Encrypt sensitive data
    const encryptedUserDetails = encryptData(userDetails);
    const encryptedTransaction = encryptData({
      amount: transactionData.amount,
      from: transactionData.from,
      to: transactionData.to,
      exchangeRate: transactionData.exchangeRate,
      youGet: transactionData.youGet,
      feeCharged: transactionData.feeCharged
    });
    
    const sessionData = {
      sessionId,
      status: "pending",
      createdAt: timestamp,
      expiresAt,
      encryptedUserDetails,
      encryptedTransaction,
      ipAddress: transactionData.ipAddress || "unknown",
      userAgent: transactionData.userAgent || "unknown",
      summary: {
        amountNGN: transactionData.amount,
        amountINR: parseFloat(transactionData.youGet.replace(/[^0-9.-]+/g, "")),
        currency: `${transactionData.from} to ${transactionData.to}`,
        userName: userDetails.customerName || "Anonymous"
      }
    };
    
    // Store in Firebase with detailed error handling
    logger.info("Attempting to save transaction to Firebase", { sessionId });
    
    await db.ref(`transactions/${sessionId}`).set(sessionData);
    
    logger.info("Transaction session created successfully", {
      sessionId,
      status: "pending",
      expiresAt: new Date(expiresAt).toISOString()
    });
    
    metrics.transactions.total++;
    metrics.transactions.pending++;
    
    return { sessionId, expiresAt };
    
  } catch (error) {
    // ✅ Enhanced error logging
    logger.error("Failed to create transaction session - DETAILED ERROR", {
      error: error.message,
      stack: error.stack,
      code: error.code,
      details: error.details,
      encryptionKeySet: !!config.security.encryptionKey,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
      hasDbRef: !!db
    });
    
    // Return more specific error
    throw new Error(`Transaction session creation failed: ${error.message}`);
  }
}


// ✅ NEW: Update transaction status
async function updateTransactionStatus(sessionId, status, additionalData = {}) {
  try {
    const updates = {
      status,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      ...additionalData
    };
    
    await db.ref(`transactions/${sessionId}`).update(updates);
    
    logger.info("Transaction status updated", { sessionId, status });
    
    // Update metrics
    if (status === "completed") {
      metrics.transactions.completed++;
      metrics.transactions.pending--;
    } else if (status === "failed") {
      metrics.transactions.failed++;
      metrics.transactions.pending--;
    }
    
    return true;
  } catch (error) {
    logger.error("Failed to update transaction status", {
      error: error.message,
      sessionId,
      status
    });
    throw new APIError("Failed to update transaction status", 500);
  }
}

// ✅ NEW: Get transaction session
async function getTransactionSession(sessionId) {
  try {
    const snapshot = await db.ref(`transactions/${sessionId}`).once('value');
    
    if (!snapshot.exists()) {
      throw new APIError("Session not found", 404);
    }
    
    const session = snapshot.val();
    
    // Check if expired
    if (session.expiresAt && session.expiresAt < Date.now()) {
      logger.warn("Attempted to access expired session", { sessionId });
      throw new APIError("Session expired", 410);
    }
    
    // Decrypt sensitive data
    const userDetails = decryptData(session.encryptedUserDetails);
    const transaction = decryptData(session.encryptedTransaction);
    
    return {
      ...session,
      userDetails,
      transaction
    };
  } catch (error) {
    logger.error("Failed to get transaction session", {
      error: error.message,
      sessionId
    });
    throw error;
  }
}

// ✅ NEW: Cleanup expired sessions (run periodically)
async function cleanupExpiredSessions() {
  try {
    const now = Date.now();
    const snapshot = await db.ref('transactions')
      .orderByChild('expiresAt')
      .endAt(now)
      .once('value');
    
    if (!snapshot.exists()) {
      return 0;
    }
    
    const expiredSessions = snapshot.val();
    const updates = {};
    
    Object.keys(expiredSessions).forEach(sessionId => {
      updates[`transactions/${sessionId}`] = null;
    });
    
    await db.ref().update(updates);
    
    const count = Object.keys(expiredSessions).length;
    logger.info(`Cleaned up ${count} expired sessions`);
    
    return count;
  } catch (error) {
    logger.error("Failed to cleanup expired sessions", {
      error: error.message
    });
    return 0;
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

// ============================================================================
// FRAUD DETECTION
// ============================================================================

// ✅ NEW: Check for suspicious activity
async function checkFraudRisk(userDetails, transactionAmount, ipAddress) {
  const risks = [];
  
  try {
    // Check daily limit
    if (userDetails.email || userDetails.phone) {
      const identifier = userDetails.email || userDetails.phone;
      const today = new Date().toISOString().split('T')[0];
      
      const snapshot = await db.ref('daily_totals')
        .child(identifier)
        .child(today)
        .once('value');
      
      const dailyTotal = snapshot.val() || 0;
      
      if (dailyTotal + transactionAmount > config.limits.dailyLimit) {
        risks.push({
          type: "daily_limit_exceeded",
          message: `Daily limit of ₦${config.limits.dailyLimit.toLocaleString()} would be exceeded`,
          severity: "high"
        });
      }
      
      // Update daily total
      await db.ref('daily_totals').child(identifier).child(today)
        .set(dailyTotal + transactionAmount);
    }
    
    // Check for rapid successive transactions from same IP
    const recentSnapshot = await db.ref('transactions')
      .orderByChild('ipAddress')
      .equalTo(ipAddress)
      .limitToLast(5)
      .once('value');
    
    if (recentSnapshot.exists()) {
      const recentTransactions = Object.values(recentSnapshot.val());
      const last5Min = Date.now() - (5 * 60 * 1000);
      const recentCount = recentTransactions.filter(t => t.createdAt > last5Min).length;
      
      if (recentCount >= 3) {
        risks.push({
          type: "rapid_transactions",
          message: "Multiple transactions detected in short time",
          severity: "medium"
        });
      }
    }
    
  } catch (error) {
    logger.error("Fraud check failed", { error: error.message });
  }
  
  return risks;
}

// ============================================================================
// MARKET DATA AGGREGATION
// ============================================================================

async function getMarketData(useCache = true) {
  const cacheKey = "market_data";
  
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      metrics.cache.hits++;
      logger.debug("Using cached market data");
      return cached;
    }
  }
  
  metrics.cache.misses++;
  logger.info("Fetching fresh market data");
  
  const errors = [];
  let spot = null, coinGecko = null, p2pData = null;
  
  const results = await Promise.allSettled([
    fetchBinanceSpot(),
    fetchCoinGecko(),
    fetchBinanceP2P()
  ]);
  
  if (results[0].status === "fulfilled") {
    spot = results[0].value;
  } else {
    errors.push({ source: "binanceSpot", error: results[0].reason.message });
  }
  
  if (results[1].status === "fulfilled") {
    coinGecko = results[1].value;
  } else {
    errors.push({ source: "coinGecko", error: results[1].reason.message });
  }
  
  if (results[2].status === "fulfilled") {
    p2pData = results[2].value;
  } else {
    errors.push({ source: "binanceP2P", error: results[2].reason.message });
  }
  
  if (!p2pData) {
    throw new ExternalAPIError("Critical: P2P data unavailable", {
      errors,
      recommendation: "Try again in a few moments"
    });
  }
  
  let ngnRate = config.fallback.ngnRate;
  if (coinGecko && coinGecko.ngn) {
    ngnRate = coinGecko.ngn;
    logger.debug("Using fetched NGN rate from CoinGecko", { ngnRate });
  } else {
    logger.warn("CoinGecko NGN unavailable, using fallback rate", { 
      fallbackRate: config.fallback.ngnRate 
    });
  }
  
  ngnRate += config.pricing.ngnMarkup;
  
  const p2pStats = analyzeP2P(p2pData);
  
  const marketData = {
    timestamp: new Date().toISOString(),
    rates: {
      binanceSpot: spot,
      coinGeckoInr: coinGecko?.inr,
      coinGeckoNgn: coinGecko?.ngn,
      ngnRateWithMarkup: ngnRate,
      p2pLowest: p2pStats.lowestRate,
      usedFallback: !coinGecko?.ngn
    },
    p2p: p2pStats,
    errors: errors.length > 0 ? errors : undefined
  };
  
  cache.set(cacheKey, marketData);
  logger.info("Market data cached", { ttl: config.cache.ttl, usedFallback: !coinGecko?.ngn });
  
  return marketData;
}

// ============================================================================
// API ROUTES
// ============================================================================

const app = express();

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

app.use(express.json({ limit: "10kb" }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.security.corsOrigin);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || "unknown";
  }
});

app.use("/api/", limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info("Request completed", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      ip: req.ip
    });
  });
  next();
});

app.get("/health", (req, res) => {
  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
    version: process.env.npm_package_version || "1.0.0"
  };
  res.json(health);
});

app.get("/ready", async (req, res) => {
  try {
    await getMarketData(false);
    res.json({ status: "ready" });
  } catch (error) {
    logger.error("Readiness check failed", { error: error.message });
    res.status(503).json({ status: "not ready", error: error.message });
  }
});

app.get("/metrics", (req, res, next) => {
  try {
    if (config.nodeEnv === "production") {
      validateAdminAuth(req);
    }
    
    const cacheStats = cache.getStats();
    res.json({
      ...metrics,
      cache: {
        ...metrics.cache,
        ...cacheStats
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Get current market rates
app.get("/api/rates", async (req, res, next) => {
  try {
    const marketData = await getMarketData();
    const competitive = calculateCompetitiveRate(
      marketData.rates.p2pLowest,
      marketData.rates.ngnRateWithMarkup,
      marketData.rates.coinGeckoInr // ✅ Pass CoinGecko rate for fallback
    );
    
    res.json({
      timestamp: marketData.timestamp,
      service: "HorizonPay",
      rates: {
        horizonPayRate: parseFloat(competitive.targetRate.toFixed(4)),
        rateDescription: `₦${competitive.targetRate.toFixed(2)} NGN per ₹1 INR`,
        localMarketRange: `₦${competitive.localRateMin} - ₦${competitive.localRateMax} per ₹1`,
        yourSavings: `₦${competitive.savingsVsMin.toFixed(2)} - ₦${competitive.savingsVsMax.toFixed(2)} per ₹1`,
        profitMargin: parseFloat(competitive.profitMargin.toFixed(2)) + "%",
        rateSource: competitive.rateSource, // ✅ NEW
        usedFallback: competitive.usedCoinGeckoFallback // ✅ NEW
      },
      marketData: {
        usdtToNgnRate: parseFloat(marketData.rates.ngnRateWithMarkup.toFixed(2)),
        usdtToInrRate: marketData.rates.p2pLowest,
        ourCostPerInr: `₦${competitive.baseCost.toFixed(2)} NGN`,
        totalP2PAds: marketData.p2p.totalAds,
        qualityP2PAds: marketData.p2p.goodAds,
        topTraders: marketData.p2p.topAds.slice(0, 3),
        usedFallbackRate: marketData.rates.usedFallback
      },
      warnings: marketData.errors
    });
    
    metrics.requests.total++;
    metrics.requests.success++;
  } catch (error) {
    next(error);
  }
});

// ✅ COMPLETELY REWRITTEN: Convert currency with Firebase session
app.post("/api/convert", [
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('from').isString().equals('NGN').withMessage('From currency must be NGN'),
  body('to').isString().equals('INR').withMessage('To currency must be INR'),
  body('customerName').optional().isString().trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().isString().trim(),
  body('paymentMethod').optional().isString().trim(),
  body('receiveMethod').optional().isString().trim()
], async (req, res, next) => {
  try {
    // Validate request
    const validationErrors = validationResult(req);
    if (!validationErrors.isEmpty()) {
      throw new ValidationError("Invalid input data", {
        errors: validationErrors.array()
      });
    }
    
    const { 
      amount, 
      from, 
      to,
      customerName,
      email,
      phone,
      paymentMethod,
      receiveMethod
    } = req.body;
    
    validateConversionRequest(amount, from, to);
    
    // Extract user details
    const userDetails = {
      customerName: customerName || "Anonymous",
      email: email || null,
      phone: phone || null,
      paymentMethod: paymentMethod || null,
      receiveMethod: receiveMethod || null
    };
    
    // Validate user details if provided
    if (email || phone) {
      validateUserDetails(userDetails);
    }
    
    // ✅ Fraud check
    const fraudRisks = await checkFraudRisk(userDetails, amount, req.ip);
    
    if (fraudRisks.some(r => r.severity === "high")) {
      logger.warn("High fraud risk detected", {
        risks: fraudRisks,
        ip: req.ip,
        sanitizedUser: sanitizeForLog(userDetails)
      });
      
      throw new ValidationError("Transaction blocked due to security concerns", {
        risks: fraudRisks.filter(r => r.severity === "high")
      });
    }
    
    // Fetch market data
    const marketData = await getMarketData();
    const competitive = calculateCompetitiveRate(
      marketData.rates.p2pLowest,
      marketData.rates.ngnRateWithMarkup,
      marketData.rates.coinGeckoInr // ✅ Pass CoinGecko for fallback
    );
    
    const grossInr = amount / competitive.targetRate;
    const fees = calculateFees(grossInr);
    
    // Prepare transaction data
    const transactionData = {
      amount,
      from,
      to,
      exchangeRate: `₦${competitive.targetRate.toFixed(2)} per ₹1`,
      youGet: `₹${fees.netAmount.toFixed(2)} INR`,
      feeCharged: `${fees.feePercent}% (₹${fees.feeAmount.toFixed(2)})`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    };
    
    // ✅ Create Firebase session
    const { sessionId, expiresAt } = await createTransactionSession(
      transactionData,
      userDetails
    );
    
    // Log transaction (sanitized)
    logger.info("Transaction initiated", {
      sessionId,
      amount,
      from,
      to,
      exchangeRate: competitive.targetRate,
      profitMargin: competitive.profitMargin,
      rateSource: competitive.rateSource,
      usedCoinGeckoFallback: competitive.usedCoinGeckoFallback,
      sanitizedUser: sanitizeForLog(userDetails),
      fraudRisks: fraudRisks.length > 0 ? fraudRisks : undefined
    });
    
    // Prepare response
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      service: "HorizonPay",
      sessionId, // ✅ NEW: Return session ID
      expiresAt: new Date(expiresAt).toISOString(), // ✅ NEW
      expiresIn: "5 minutes", // ✅ NEW
      query: { amount, from, to },
      horizonPayOffer: {
        youPay: `₦${amount.toLocaleString()} NGN`,
        youGet: `₹${fees.netAmount.toLocaleString()} INR (after fees)`,
        exchangeRate: `₦${competitive.targetRate.toFixed(2)} per ₹1`,
        feeCharged: `${fees.feePercent}% (₹${fees.feeAmount.toFixed(2)})`,
        rateSource: competitive.rateSource // ✅ NEW
      },
      comparison: {
        horizonPayTotal: `₹${fees.netAmount.toFixed(2)} INR`,
        localMarketMin: `₹${(amount / competitive.localRateMin).toFixed(2)} INR`,
        localMarketMax: `₹${(amount / competitive.localRateMax).toFixed(2)} INR`,
        yourExtraSavings: {
          vsLocalMin: `₹${(fees.netAmount - (amount / competitive.localRateMin)).toFixed(2)}`,
          vsLocalMax: `₹${(fees.netAmount - (amount / competitive.localRateMax)).toFixed(2)}`
        }
      },
      breakdown: {
        step1_customerPays: `₦${amount.toLocaleString()} NGN`,
        step2_weBuyUSDT: `${(amount / marketData.rates.ngnRateWithMarkup).toFixed(2)} USDT at ₦${marketData.rates.ngnRateWithMarkup.toFixed(2)}/USDT`,
        step3_weSellUSDT: `${(amount / marketData.rates.ngnRateWithMarkup).toFixed(2)} USDT × ₹${marketData.rates.p2pLowest} = ₹${grossInr.toFixed(2)} INR`,
        step4_afterFees: `₹${fees.netAmount.toFixed(2)} INR (${fees.feePercent}% fee deducted)`,
        ourCostPerInr: `₦${competitive.baseCost.toFixed(2)}`,
        ourSellingRate: `₦${competitive.targetRate.toFixed(2)}`,
        ourProfitMargin: `${competitive.profitMargin.toFixed(2)}%`
      },
      recommendedP2PTraders: marketData.p2p.topAds.slice(0, 2),
      security: { // ✅ NEW
        encrypted: true,
        sessionExpiry: "5 minutes",
        status: "pending"
      }
    };
    
    // ✅ Add warnings if any
    if (fraudRisks.length > 0) {
      response.warnings = fraudRisks.filter(r => r.severity !== "high");
    }
    
    if (competitive.usedCoinGeckoFallback) {
      response.notice = "Rate calculated using CoinGecko fallback for optimal pricing";
    }
    
    if (competitive.warning) {
      response.warning = competitive.warning;
    }
    
    res.json(response);
    
    metrics.requests.total++;
    metrics.requests.success++;
  } catch (error) {
    next(error);
  }
});

app.post("/api/payment/initialize", async (req, res, next) => {
  try {
    const { sessionId, email, phone, customerName } = req.body;
    
    if (!sessionId) {
      throw new ValidationError("Session ID required");
    }
    
    // Get transaction from Firebase
    const session = await getTransactionSession(sessionId);
    
    if (session.status !== 'pending') {
      throw new ValidationError(`Transaction already ${session.status}`);
    }
    
    // Parse amount from transaction
    const amountNGN = session.transaction.amount;
    const amountKobo = Math.round(amountNGN * 100); // Convert to kobo
    
    // Initialize Paystack payment
    const paystackData = {
      email: email || session.userDetails.email || 'customer@horizonpay.com',
      amount: amountKobo,
      currency: 'NGN',
      reference: `HP-${sessionId}-${Date.now()}`,
      callback_url: `${config.paystack.callbackUrl}?session=${sessionId}`,
      metadata: {
        sessionId,
        customerName: customerName || session.userDetails.customerName || 'Anonymous',
        phone: phone || session.userDetails.phone || '',
        amountNGN,
        amountINR: session.summary.amountINR,
        custom_fields: [
          {
            display_name: "Session ID",
            variable_name: "session_id",
            value: sessionId
          }
        ]
      }
    };
    
    logger.info("Initializing Paystack payment", {
      sessionId,
      amount: amountNGN,
      reference: paystackData.reference
    });
    
    // TEMPORARY MOCK - Replace with real Paystack later
if (paystackAPI) {
  // Mock response for testing without Paystack
  response = {
    status: true,
    message: "Mock payment initialized",
    data: {
      authorization_url: "http://api-rate-checker.onrender.com/mock-payment?ref=" + paystackData.reference,
      access_code: "mock_" + Date.now(),
      reference: paystackData.reference
    }
  };
  logger.warn("⚠️  Using MOCK payment - Paystack not configured");
} else {
  response = await paystackAPI.initializeTransaction(paystackData);
}

    
    if (!response.status) {
      throw new APIError("Failed to initialize payment", 500, {
        paystackError: response.message
      });
    }
    
    // Update session with payment reference
    await db.ref(`transactions/${sessionId}`).update({
      paystackReference: paystackData.reference,
      paystackInitializedAt: Date.now(),
      status: 'payment_initiated'
    });
    
    logger.info("Paystack payment initialized", {
      sessionId,
      reference: paystackData.reference,
      authorizationUrl: response.data.authorization_url
    });
    
    res.json({
      success: true,
      sessionId,
      payment: {
        reference: paystackData.reference,
        authorizationUrl: response.data.authorization_url,
        accessCode: response.data.access_code
      }
    });
    
  } catch (error) {
    next(error);
  }
});
// ✅ Manual payment verification endpoint (SAFE VERSION)
app.post("/api/payment/verify-manual", async (req, res) => {
  try {
    const { reference, sessionId } = req.body;
    
    if (!reference) {
      return res.status(400).json({
        error: "Payment reference required"
      });
    }
    
    logger.info("Manual verification requested", { reference, sessionId });
    
    // Verify with Paystack
    const response = await paystackAPI.verifyTransaction(reference);
    
    if (!response.status || !response.data) {
      return res.status(400).json({
        error: "Verification failed",
        message: response.message
      });
    }
    
    const tx = response.data;
    
    // Update Firebase if payment successful
    if (tx.status === 'success' && sessionId) {
      await db.ref(`transactions/${sessionId}`).update({
        status: 'completed',
        paystackReference: reference,
        paidAmount: tx.amount / 100,
        paidAt: Date.now(),
        paymentChannel: tx.channel,
        verifiedAt: Date.now()
      });
      
      logger.info("✅ Payment verified", { sessionId, amount: tx.amount / 100 });
      
      return res.json({
        success: true,
        status: 'completed',
        sessionId,
        reference,
        amount: tx.amount / 100
      });
    }
    
    // Payment failed
    if (sessionId) {
      await db.ref(`transactions/${sessionId}`).update({
        status: 'failed',
        failureReason: tx.gateway_response,
        failedAt: Date.now()
      });
    }
    
    return res.json({
      success: false,
      status: 'failed',
      reason: tx.gateway_response
    });
    
  } catch (error) {
    logger.error("Verification error", { error: error.message });
    return res.status(500).json({
      error: "Verification failed",
      message: error.message
    });
  }
});

// ✅ Verify payment from Paystack
app.get("/api/payment/verify", async (req, res, next) => {
  try {
    const { reference, session: sessionId } = req.query;
    
    if (!reference) {
      throw new ValidationError("Payment reference required");
    }
    
    logger.info("Verifying Paystack payment", { reference, sessionId });
    
    // Verify with Paystack
    const response = await paystackAPI.transaction.verify(reference);
    
    if (!response.status || !response.data) {
      throw new APIError("Payment verification failed", 400, {
        paystackError: response.message
      });
    }
    
    const transaction = response.data;
    
    // Check if payment was successful
    if (transaction.status === 'success') {
      // Update Firebase transaction status
      if (sessionId) {
        await updateTransactionStatus(sessionId, 'completed', {
          paystackReference: reference,
          paidAmount: transaction.amount / 100, // Convert from kobo
          paidAt: new Date(transaction.paid_at).getTime(),
          paymentChannel: transaction.channel,
          paymentGateway: 'Paystack',
          customerEmail: transaction.customer.email,
          verifiedAt: Date.now()
        });
        
        logger.info("Payment completed successfully", {
          sessionId,
          reference,
          amount: transaction.amount / 100
        });
      }
      
      // Redirect to success page
      res.redirect(`/payment-success.html?session=${sessionId}&ref=${reference}`);
    } else {
      // Payment failed
      if (sessionId) {
        await updateTransactionStatus(sessionId, 'failed', {
          paystackReference: reference,
          failureReason: transaction.gateway_response,
          failedAt: Date.now()
        });
        
        logger.warn("Payment failed", {
          sessionId,
          reference,
          reason: transaction.gateway_response
        });
      }
      
      // Redirect to failure page
      res.redirect(`/payment-failed.html?session=${sessionId}&ref=${reference}&reason=${transaction.gateway_response}`);
    }
    
  } catch (error) {
    logger.error("Payment verification error", {
      error: error.message,
      reference: req.query.reference
    });
    res.redirect(`/payment-error.html?error=${encodeURIComponent(error.message)}`);
  }
});

// ✅ Check payment status (polling endpoint)
app.get("/api/payment/status/:sessionId", async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    const snapshot = await db.ref(`transactions/${sessionId}`).once('value');
    
    if (!snapshot.exists()) {
      throw new APIError("Transaction not found", 404);
    }
    
    const session = snapshot.val();
    
    res.json({
      success: true,
      sessionId,
      status: session.status,
      paystackReference: session.paystackReference,
      paidAt: session.paidAt ? new Date(session.paidAt).toISOString() : null,
      verifiedAt: session.verifiedAt ? new Date(session.verifiedAt).toISOString() : null
    });
    
  } catch (error) {
    next(error);
  }
});

// ✅ Webhook endpoint for Paystack (for redundancy)
app.post("/api/webhook/paystack", express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hash = require('crypto')
      .createHmac('sha512', config.paystack.secretKey)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
      logger.warn("Invalid Paystack webhook signature");
      return res.sendStatus(400);
    }
    
    const event = req.body;
    
    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const sessionId = event.data.metadata?.sessionId;
      
      if (sessionId) {
        await updateTransactionStatus(sessionId, 'completed', {
          paystackReference: reference,
          paidAmount: event.data.amount / 100,
          paidAt: new Date(event.data.paid_at).getTime(),
          paymentChannel: event.data.channel,
          webhookReceivedAt: Date.now()
        });
        
        logger.info("Payment completed via webhook", { sessionId, reference });
      }
    }
    
    res.sendStatus(200);
    
  } catch (error) {
    logger.error("Webhook processing error", { error: error.message });
    res.sendStatus(500);
  }
});

// ✅ NEW: Get transaction status
app.get("/api/transaction/:sessionId", async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      throw new ValidationError("Session ID required");
    }
    
    const session = await getTransactionSession(sessionId);
    
    // Return non-sensitive summary
    res.json({
      sessionId: session.sessionId,
      status: session.status,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      summary: session.summary
    });
    
  } catch (error) {
    next(error);
  }
});

// ✅ NEW: Get full transaction details (admin only - with decryption)
app.get("/api/admin/transaction/:sessionId", async (req, res, next) => {
  try {
    // Validate admin authentication
    validateAdminAuth(req);
    
    const { sessionId } = req.params;
    
    if (!sessionId) {
      throw new ValidationError("Session ID required");
    }
    
    // Get transaction from Firebase
    const snapshot = await db.ref(`transactions/${sessionId}`).once('value');
    
    if (!snapshot.exists()) {
      throw new APIError("Transaction not found", 404);
    }
    
    const encryptedSession = snapshot.val();
    
    // Check if expired
    if (encryptedSession.expiresAt && encryptedSession.expiresAt < Date.now()) {
      logger.warn("Admin accessed expired session", { sessionId });
    }
    
    // Decrypt sensitive data
    let userDetails = null;
    let transactionDetails = null;
    
    try {
      userDetails = decryptData(encryptedSession.encryptedUserDetails);
      transactionDetails = decryptData(encryptedSession.encryptedTransaction);
    } catch (error) {
      logger.error("Failed to decrypt transaction data", {
        error: error.message,
        sessionId
      });
      throw new APIError("Failed to decrypt transaction data", 500);
    }
    
    // Return full decrypted data
    res.json({
      success: true,
      sessionId: encryptedSession.sessionId,
      status: encryptedSession.status,
      createdAt: new Date(encryptedSession.createdAt).toISOString(),
      expiresAt: new Date(encryptedSession.expiresAt).toISOString(),
      expired: encryptedSession.expiresAt < Date.now(),
      ipAddress: encryptedSession.ipAddress,
      userAgent: encryptedSession.userAgent,
      
      // Decrypted user details
      userDetails: {
        customerName: userDetails.customerName,
        email: userDetails.email,
        phone: userDetails.phone,
        upiId: userDetails.upiId,
        paymentMethod: userDetails.paymentMethod,
        receiveMethod: userDetails.receiveMethod,
        bankAccount: userDetails.bankAccount,
        notes: userDetails.notes
      },
      
      // Decrypted transaction details
      transactionDetails: {
        amount: transactionDetails.amount,
        from: transactionDetails.from,
        to: transactionDetails.to,
        exchangeRate: transactionDetails.exchangeRate,
        youGet: transactionDetails.youGet,
        feeCharged: transactionDetails.feeCharged
      },
      
      // Summary (already available)
      summary: encryptedSession.summary
    });
    
    logger.info("Admin accessed transaction details", {
      sessionId,
      adminIp: req.ip,
      customerName: userDetails.customerName
    });
    
  } catch (error) {
    next(error);
  }
});

// ✅ NEW: List all transactions (admin only)
app.get("/api/admin/transactions", async (req, res, next) => {
  try {
    validateAdminAuth(req);
    
    const { status, limit = 50, startDate, endDate } = req.query;
    
    let query = db.ref('transactions');
    
    // Filter by status if provided
    if (status) {
      query = query.orderByChild('status').equalTo(status);
    } else {
      query = query.orderByChild('createdAt');
    }
    
    // Limit results
    query = query.limitToLast(parseInt(limit));
    
    const snapshot = await query.once('value');
    
    if (!snapshot.exists()) {
      return res.json({
        success: true,
        count: 0,
        transactions: []
      });
    }
    
    const transactions = [];
    const data = snapshot.val();
    
    for (const sessionId in data) {
      const tx = data[sessionId];
      
      // Apply date filters if provided
      if (startDate && tx.createdAt < new Date(startDate).getTime()) {
        continue;
      }
      if (endDate && tx.createdAt > new Date(endDate).getTime()) {
        continue;
      }
      
      transactions.push({
        sessionId: tx.sessionId,
        status: tx.status,
        createdAt: new Date(tx.createdAt).toISOString(),
        expiresAt: new Date(tx.expiresAt).toISOString(),
        expired: tx.expiresAt < Date.now(),
        summary: tx.summary,
        ipAddress: tx.ipAddress
      });
    }
    
    // Sort by date (newest first)
    transactions.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    res.json({
      success: true,
      count: transactions.length,
      filters: { status, limit, startDate, endDate },
      transactions
    });
    
    logger.info("Admin listed transactions", {
      adminIp: req.ip,
      count: transactions.length,
      filters: { status, limit }
    });
    
  } catch (error) {
    next(error);
  }
});

// ✅ NEW: Search transactions by customer details (admin only)
app.get("/api/admin/transactions/search", async (req, res, next) => {
  try {
    validateAdminAuth(req);
    
    const { email, phone, customerName, minAmount, maxAmount } = req.query;
    
    if (!email && !phone && !customerName && !minAmount && !maxAmount) {
      throw new ValidationError("At least one search parameter required");
    }
    
    const snapshot = await db.ref('transactions').once('value');
    
    if (!snapshot.exists()) {
      return res.json({
        success: true,
        count: 0,
        transactions: []
      });
    }
    
    const results = [];
    const data = snapshot.val();
    
    for (const sessionId in data) {
      const tx = data[sessionId];
      
      try {
        // Decrypt to search
        const userDetails = decryptData(tx.encryptedUserDetails);
        
        // Check search criteria
        let matches = true;
        
        if (email && userDetails.email?.toLowerCase() !== email.toLowerCase()) {
          matches = false;
        }
        if (phone && userDetails.phone !== phone) {
          matches = false;
        }
        if (customerName && !userDetails.customerName?.toLowerCase().includes(customerName.toLowerCase())) {
          matches = false;
        }
        if (minAmount && tx.summary.amountNGN < parseFloat(minAmount)) {
          matches = false;
        }
        if (maxAmount && tx.summary.amountNGN > parseFloat(maxAmount)) {
          matches = false;
        }
        
        if (matches) {
          results.push({
            sessionId: tx.sessionId,
            status: tx.status,
            createdAt: new Date(tx.createdAt).toISOString(),
            customerName: userDetails.customerName,
            email: userDetails.email,
            phone: userDetails.phone,
            amountNGN: tx.summary.amountNGN,
            amountINR: tx.summary.amountINR
          });
        }
      } catch (error) {
        logger.warn("Failed to decrypt transaction during search", { sessionId });
      }
    }
    
    res.json({
      success: true,
      count: results.length,
      searchCriteria: { email, phone, customerName, minAmount, maxAmount },
      transactions: results
    });
    
    logger.info("Admin searched transactions", {
      adminIp: req.ip,
      criteria: { email, phone, customerName },
      resultsCount: results.length
    });
    
  } catch (error) {
    next(error);
  }
});


// ✅ NEW: Update transaction status (webhook/admin)
app.post("/api/transaction/:sessionId/status", async (req, res, next) => {
  try {
    validateAdminAuth(req);
    
    const { sessionId } = req.params;
    const { status, paymentProof, notes } = req.body;
    
    if (!["completed", "failed", "processing"].includes(status)) {
      throw new ValidationError("Invalid status", {
        allowed: ["completed", "failed", "processing"]
      });
    }
    
    await updateTransactionStatus(sessionId, status, {
      paymentProof,
      notes,
      updatedBy: req.ip
    });
    
    res.json({
      success: true,
      sessionId,
      status,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    next(error);
  }
});


app.post("/api/admin/cache/clear", (req, res, next) => {
  try {
    validateAdminAuth(req);
    cache.flushAll();
    logger.info("Cache manually cleared", { by: req.ip });
    res.json({ 
      message: "Cache cleared successfully",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/cache/stats", (req, res, next) => {
  try {
    validateAdminAuth(req);
    const stats = cache.getStats();
    res.json({
      ...stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Error handler
app.use((err, req, res, next) => {
  metrics.requests.total++;
  metrics.requests.errors++;
  
  logger.error("Request error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  if (err instanceof ValidationError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      type: "validation_error"
    });
  }
  
  if (err instanceof ExternalAPIError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      type: "external_api_error"
    });
  }
  
  if (err instanceof APIError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
      type: "api_error"
    });
  }
  
  res.status(500).json({
    error: err.message,           // ✅ Always show
    stack: err.stack,              // ✅ Show stack trace
    details: err.details || {},    // ✅ Show details
    type: "internal_error"
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path,
    availableEndpoints: [
      "GET /health",
      "GET /ready",
      "GET /metrics",
      "GET /api/rates",
      "POST /api/convert",
      "GET /api/transaction/:sessionId",
      "POST /api/transaction/:sessionId/status",
      "POST /api/admin/cache/clear",
      "GET /api/admin/cache/stats"
    ]
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const server = app.listen(config.port, () => {
  logger.info(`🚀 HorizonPay API started on port ${config.port}`, {
    environment: config.nodeEnv,
    cacheEnabled: true,
    cacheTTL: config.cache.ttl,
    trustProxy: true,
    maxRetries: config.api.maxRetries,
    retryDelay: config.api.retryDelay,
    fallbackNgnRate: config.fallback.ngnRate,
    sessionTTL: `${config.security.sessionTTL / 1000}s`,
    encryptionEnabled: true,
    firebaseConnected: true,
    version: process.env.npm_package_version || "2.0.0"
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  server.close(() => {
    logger.info("HTTP server closed");
    
    cache.close();
    logger.info("Cache closed");
    
    // Close Firebase connection
    admin.app().delete().then(() => {
      logger.info("Firebase connection closed");
    });
    
    logger.on('finish', () => {
      process.exit(0);
    });
    logger.end();
  });
  
  setTimeout(() => {
    logger.error("Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 30000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

module.exports = { app, server };
