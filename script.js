const express = require("express");
const https = require("https");
const zlib = require("zlib");
const winston = require("winston");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  api: {
    timeout: parseInt(process.env.API_TIMEOUT) || 10000,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    retryDelay: parseInt(process.env.RETRY_DELAY) || 1000,
  },
  cache: {
    ttl: parseInt(process.env.CACHE_TTL) || 300, // 5 minutes
    checkPeriod: parseInt(process.env.CACHE_CHECK_PERIOD) || 60,
  },
  pricing: {
    minProfitMargin: parseFloat(process.env.MIN_PROFIT_MARGIN) || 0.5, // 0.5%
    ngnMarkup: parseFloat(process.env.NGN_MARKUP) || 20,
    discountMin: parseFloat(process.env.DISCOUNT_MIN) || 0.20,
    discountMax: parseFloat(process.env.DISCOUNT_MAX) || 0.40,
    localRateMin: parseFloat(process.env.LOCAL_RATE_MIN) || 16.2,
    localRateMax: parseFloat(process.env.LOCAL_RATE_MAX) || 16.5,
  },
  fees: JSON.parse(process.env.FEE_STRUCTURE || JSON.stringify({
    tiers: [
      { max: 10000, percent: 2.5 },
      { max: 50000, percent: 2.0 },
      { max: 100000, percent: 1.5 },
      { max: 500000, percent: 1.0 },
      { max: Infinity, percent: 0.75 }
    ]
  })),
  filters: {
    strict: {
      minTrades: parseInt(process.env.FILTER_MIN_TRADES) || 300,
      minCompletion: parseFloat(process.env.FILTER_MIN_COMPLETION) || 90,
      minQty: parseFloat(process.env.FILTER_MIN_QTY) || 500,
      minPrice: parseFloat(process.env.FILTER_MIN_PRICE) || 70,
      maxPrice: parseFloat(process.env.FILTER_MAX_PRICE) || 120,
    },
    relaxed: {
      minTrades: parseInt(process.env.FILTER_RELAXED_TRADES) || 100,
      minCompletion: parseFloat(process.env.FILTER_RELAXED_COMPLETION) || 85,
      minQty: parseFloat(process.env.FILTER_RELAXED_QTY) || 100,
      minPrice: parseFloat(process.env.FILTER_MIN_PRICE) || 70,
      maxPrice: parseFloat(process.env.FILTER_MAX_PRICE) || 120,
    }
  },
  security: {
    adminApiKey: process.env.ADMIN_API_KEY || "2ff7697c82b91af96b5722cbb6b066c3",
    corsOrigin: process.env.CORS_ORIGIN || "*",
    trustProxy: process.env.TRUST_PROXY === "true",
  }
};

// ============================================================================
// LOGGING
// ============================================================================

// Ensure logs directory exists
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: config.nodeEnv === "production" ? "info" : "debug",
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
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, "combined.log"),
      maxsize: 10485760,
      maxFiles: 5
    })
  ]
});

// Handle uncaught exceptions and rejections
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection", { reason, promise });
});

// ============================================================================
// CACHE
// ============================================================================

const cache = new NodeCache({
  stdTTL: config.cache.ttl,
  checkperiod: config.cache.checkPeriod,
  useClones: false
});

// ============================================================================
// METRICS
// ============================================================================

const metrics = {
  requests: { total: 0, success: 0, errors: 0 },
  api: {
    binanceSpot: { calls: 0, failures: 0, avgLatency: 0 },
    coinGecko: { calls: 0, failures: 0, avgLatency: 0 },
    binanceP2P: { calls: 0, failures: 0, avgLatency: 0 }
  },
  cache: { hits: 0, misses: 0 }
};

// ============================================================================
// CUSTOM ERRORS
// ============================================================================

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
      
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i))); // Exponential backoff
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
  
  // Apply filters
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
  
  // Fallback (should never reach here with Infinity in tiers)
  const lastTier = config.fees.tiers[config.fees.tiers.length - 1];
  const feeAmount = (amount * lastTier.percent) / 100;
  return {
    feePercent: lastTier.percent,
    feeAmount,
    netAmount: amount - feeAmount
  };
}

function calculateCompetitiveRate(lowestInrRate, ngnRate) {
  // FLOW: Customer NGN → Buy USDT → Sell USDT for INR → Customer gets INR
  
  // Step 1: How much does it cost us to buy 1 USDT? = ngnRate NGN
  // Step 2: How much INR do we get when we sell 1 USDT? = lowestInrRate INR
  
  // Therefore: Cost to provide 1 INR to customer
  // baseCostPerInr = (NGN needed to buy 1 USDT) / (INR we get from selling 1 USDT)
  // baseCostPerInr = ngnRate / lowestInrRate
  const baseCostPerInr = ngnRate / lowestInrRate;
  
  // Add profit margin to our cost
  const profitMultiplier = 1 + (config.pricing.minProfitMargin / 100);
  const rateWithProfit = baseCostPerInr * profitMultiplier;
  
  // Add small random variation for competitive pricing
  const randomAdjustment = config.pricing.discountMin + 
    (Math.random() * (config.pricing.discountMax - config.pricing.discountMin));
  
  // Final rate we charge customer (NGN per INR)
  let finalRate = rateWithProfit + (randomAdjustment * 0.1);
  
  // Ensure we stay competitive with local market (but don't exceed it)
  if (finalRate > config.pricing.localRateMax) {
    finalRate = config.pricing.localRateMax - 0.1;
  }
  
  // Ensure we maintain minimum profit
  if (finalRate < baseCostPerInr * 1.005) {
    finalRate = baseCostPerInr * 1.005; // Force at least 0.5% margin
  }
  
  // Calculate actual profit margin: (Revenue - Cost) / Revenue * 100
  const profitMargin = ((finalRate - baseCostPerInr) / finalRate) * 100;
  
  // Validate minimum profit margin
  if (profitMargin < config.pricing.minProfitMargin) {
    logger.warn("Profit margin below minimum", {
      profitMargin,
      minRequired: config.pricing.minProfitMargin,
      baseCostPerInr,
      finalRate,
      ngnRate,
      lowestInrRate
    });
    throw new APIError("Insufficient profit margin - rates unfavorable", 503, {
      profitMargin,
      minRequired: config.pricing.minProfitMargin,
      recommendation: "Wait for better market conditions"
    });
  }
  
  const savingsVsMin = config.pricing.localRateMin - finalRate;
  const savingsVsMax = config.pricing.localRateMax - finalRate;
  const savingsPercent = savingsVsMin > 0 ? (savingsVsMin / config.pricing.localRateMin) * 100 : 0;
  
  return {
    baseCost: baseCostPerInr,
    targetRate: finalRate,
    localRateMin: config.pricing.localRateMin,
    localRateMax: config.pricing.localRateMax,
    discount: randomAdjustment,
    profitMargin,
    savingsVsMin,
    savingsVsMax,
    savingsPercent
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
  
  if (amount > 100000000) {
    throw new ValidationError("Amount exceeds maximum limit (100,000,000)");
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
  
  // Fetch all sources in parallel with individual error handling
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
  
  // Require P2P data and NGN rate at minimum
  if (!p2pData) {
    throw new ExternalAPIError("Critical: P2P data unavailable", {
      errors,
      recommendation: "Try again in a few moments"
    });
  }
  
  if (!coinGecko || !coinGecko.ngn) {
    throw new ExternalAPIError("Critical: NGN rate unavailable", {
      errors,
      recommendation: "Try again in a few moments"
    });
  }
  
  const p2pStats = analyzeP2P(p2pData);
  const ngnRate = coinGecko.ngn + config.pricing.ngnMarkup;
  
  const marketData = {
    timestamp: new Date().toISOString(),
    rates: {
      binanceSpot: spot,
      coinGeckoInr: coinGecko.inr,
      coinGeckoNgn: coinGecko.ngn,
      ngnRateWithMarkup: ngnRate,
      p2pLowest: p2pStats.lowestRate
    },
    p2p: p2pStats,
    errors: errors.length > 0 ? errors : undefined
  };
  
  cache.set(cacheKey, marketData);
  logger.info("Market data cached", { ttl: config.cache.ttl });
  
  return marketData;
}

// ============================================================================
// API ROUTES
// ============================================================================

const app = express();

// Trust proxy if configured
if (config.security.trustProxy) {
  app.set("trust proxy", 1);
}

// Middleware
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
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health", // Skip rate limit for health checks
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

// Health check
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

// Readiness check (for Kubernetes)
app.get("/ready", async (req, res) => {
  try {
    // Check if we can fetch market data
    await getMarketData(true);
    res.json({ status: "ready" });
  } catch (error) {
    logger.error("Readiness check failed", { error: error.message });
    res.status(503).json({ status: "not ready", error: error.message });
  }
});

// Metrics endpoint (protected in production)
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
      marketData.rates.ngnRateWithMarkup
    );
    
    res.json({
      timestamp: marketData.timestamp,
      service: "HorizonPay",
      rates: {
        horizonPayRate: parseFloat(competitive.targetRate.toFixed(4)),
        rateDescription: `₦${competitive.targetRate.toFixed(2)} NGN per ₹1 INR`,
        localMarketRange: `₦${competitive.localRateMin} - ₦${competitive.localRateMax} per ₹1`,
        yourSavings: `₦${competitive.savingsVsMin.toFixed(2)} - ₦${competitive.savingsVsMax.toFixed(2)} per ₹1`,
        profitMargin: parseFloat(competitive.profitMargin.toFixed(2)) + "%"
      },
      marketData: {
        usdtToNgnRate: parseFloat(marketData.rates.ngnRateWithMarkup.toFixed(2)),
        usdtToInrRate: marketData.rates.p2pLowest,
        ourCostPerInr: `₦${competitive.baseCost.toFixed(2)} NGN`,
        totalP2PAds: marketData.p2p.totalAds,
        qualityP2PAds: marketData.p2p.goodAds,
        topTraders: marketData.p2p.topAds.slice(0, 3)
      },
      warnings: marketData.errors
    });
    
    metrics.requests.total++;
    metrics.requests.success++;
  } catch (error) {
    next(error);
  }
});

// Convert currency
app.post("/api/convert", async (req, res, next) => {
  try {
    const { amount, from, to } = req.body;
    
    validateConversionRequest(amount, from, to);
    
    const marketData = await getMarketData();
    const competitive = calculateCompetitiveRate(
      marketData.rates.p2pLowest,
      marketData.rates.ngnRateWithMarkup
    );
    
    const grossInr = amount / competitive.targetRate;
    const fees = calculateFees(grossInr);
    
    const localMinTotal = amount * competitive.localRateMin;
    const localMaxTotal = amount * competitive.localRateMax;
    
    res.json({
      timestamp: new Date().toISOString(),
      service: "HorizonPay",
      query: { amount, from, to },
      horizonPayOffer: {
        youPay: `₦${amount.toLocaleString()} NGN`,
        youGet: `₹${fees.netAmount.toLocaleString()} INR (after fees)`,
        exchangeRate: `₦${competitive.targetRate.toFixed(2)} per ₹1`,
        feeCharged: `${fees.feePercent}% (₹${fees.feeAmount.toFixed(2)})`
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
      recommendedP2PTraders: marketData.p2p.topAds.slice(0, 2)
    });
    
    metrics.requests.total++;
    metrics.requests.success++;
  } catch (error) {
    next(error);
  }
});

// Clear cache (admin endpoint - requires authentication)
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

// Get cache statistics (admin endpoint)
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
  
  // Unknown error
  res.status(500).json({
    error: config.nodeEnv === "production" 
      ? "Internal server error" 
      : err.message,
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
      "POST /api/admin/cache/clear",
      "GET /api/admin/cache/stats"
    ]
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const server = app.listen(config.port, () => {
  logger.info(`Server started on port ${config.port}`, {
    environment: config.nodeEnv,
    cacheEnabled: true,
    cacheTTL: config.cache.ttl,
    version: process.env.npm_package_version || "1.0.0"
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  server.close(() => {
    logger.info("HTTP server closed");
    
    // Close cache
    cache.close();
    logger.info("Cache closed");
    
    // Close all transports for logger
    logger.on('finish', () => {
      process.exit(0);
    });
    logger.end();
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error("Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 30000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Export for testing
module.exports = { app, server };