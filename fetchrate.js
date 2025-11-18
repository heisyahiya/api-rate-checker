const https = require("https");
const zlib = require("zlib");

// Get CoinGecko USDT/INR rate
function getCoinGeckoRate(callback) {
  const options = {
    hostname: "api.coingecko.com",
    path: "/api/v3/simple/price?ids=tether&vs_currencies=inr",
    method: "GET",
  };

  https.get(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        callback(parseFloat(json.tether.inr) || 88.50);
      } catch {
        callback(88.50);
      }
    });
  }).on("error", () => callback(88.50));
}

// Get Binance spot market rate
function getBinanceRate(callback) {
  const options = {
    hostname: "api.binance.com",
    path: "/api/v3/ticker/price?symbol=USDTINR",
    method: "GET",
  };

  https.get(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        callback(parseFloat(json.price) || 88.50);
      } catch {
        callback(88.50);
      }
    });
  }).on("error", () => callback(88.50));
}

// Calculate minimum trades based on day of month
function getMinTradesForMonth() {
  const today = new Date();
  const currentDay = today.getDate();
  const totalDaysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  
  const expectedTrades = Math.floor((currentDay / totalDaysInMonth) * 100);
  return Math.max(expectedTrades, 10);
}

// Rate calculator for SELLING USDT (amount in INR)
function calculateRateMetrics(p2pPrice, binanceRate, coinGeckoRate, inrAmount) {
  // When selling for INR, calculate how much USDT you need to sell
  const usdtToSell = inrAmount / p2pPrice;
  const binanceUSDT = inrAmount / binanceRate;
  const coinGeckoUSDT = inrAmount / coinGeckoRate;
  
  // When selling, HIGHER P2P price = LESS USDT needed = BETTER
  const vsBinanceDiff = p2pPrice - binanceRate;
  const vsBinancePct = ((vsBinanceDiff / binanceRate) * 100).toFixed(2);
  const usdtSaved = binanceUSDT - usdtToSell; // Less USDT = savings
  
  const vsCoinGeckoDiff = p2pPrice - coinGeckoRate;
  const vsCoinGeckoPct = ((vsCoinGeckoDiff / coinGeckoRate) * 100).toFixed(2);
  const usdtSavedCG = coinGeckoUSDT - usdtToSell;
  
  return {
    inrAmount: inrAmount.toFixed(2),
    usdtToSell: usdtToSell.toFixed(4),
    p2pRate: p2pPrice.toFixed(2),
    binanceRate: binanceRate.toFixed(2),
    coinGeckoRate: coinGeckoRate.toFixed(2),
    
    vsBinanceDiff: vsBinanceDiff.toFixed(2),
    vsBinancePct: vsBinancePct,
    usdtSaved: usdtSaved.toFixed(4),
    inrValueSaved: (usdtSaved * binanceRate).toFixed(2),
    
    vsCoinGeckoDiff: vsCoinGeckoDiff.toFixed(2),
    vsCoinGeckoPct: vsCoinGeckoPct,
    usdtSavedCG: usdtSavedCG.toFixed(4),
    inrValueSavedCG: (usdtSavedCG * coinGeckoRate).toFixed(2),
    
    recommendation: parseFloat(vsCoinGeckoPct) >= 0 ? "🟢 GOOD" : "🔴 BELOW MARKET"
  };
}

function findBestBuyers(inrAmount) {
  const minTrades = getMinTradesForMonth();
  
  getCoinGeckoRate((coinGeckoRate) => {
    getBinanceRate((binanceRate) => {
      console.log(`\n📅 Day ${new Date().getDate()} of ${new Date().toLocaleString('default', { month: 'long' })}`);
      console.log(`📊 Minimum trades required: ${minTrades}`);
      console.log(`💱 Binance Spot: ₹${binanceRate.toFixed(2)}/USDT`);
      console.log(`💱 CoinGecko: ₹${coinGeckoRate.toFixed(2)}/USDT`);
      console.log(`💳 Payment methods: UPI, Paytm, Google Pay, PhonePe, Bank Transfer`);
      console.log(`🔄 SELLING USDT to get ₹${inrAmount} INR`);
      console.log(`\n🔍 Searching for buyers...\n`);

      const postData = JSON.stringify({
        page: 1,
        rows: 20,
        payTypes: ["UPI", "Paytm", "GooglePay", "PhonePe", "BANK"],
        asset: "USDT",
        tradeType: "SELL",
        fiat: "INR",
        publisherType: null,
      });

      const options = {
        hostname: "p2p.binance.com",
        port: 443,
        path: "/bapi/c2c/v2/friendly/c2c/adv/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "Accept-Encoding": "gzip, deflate, br",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
      };

      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));

        res.on("end", () => {
          let buffer = Buffer.concat(chunks);

          const encoding = res.headers["content-encoding"];
          try {
            if (encoding === "gzip") buffer = zlib.gunzipSync(buffer);
            else if (encoding === "br") buffer = zlib.brotliDecompressSync(buffer);
            else if (encoding === "deflate") buffer = zlib.inflateSync(buffer);
          } catch (err) {
            console.log("❌ Decompression error:", err.message);
            return;
          }

          try {
            const json = JSON.parse(buffer.toString());

            if (!json.success || !json.data) {
              console.log("❌ API Error:", json.message || json.messageDetail || "Unknown error");
              return;
            }

            if (json.data.length === 0) {
              console.log("❌ No buyers found");
              return;
            }

            console.log(`📦 Received ${json.data.length} total ads\n`);

            // Map all buyers
            let buyers = json.data
              .map((item) => {
                const adv = item.adv;
                const advertiser = item.advertiser;

                const paymentMethods = adv.tradeMethods 
                  ? adv.tradeMethods.map(m => m.tradeMethodName || m.identifier).join(", ")
                  : "N/A";

                return {
                  name: advertiser.nickName,
                  price: parseFloat(adv.price),
                  minINR: parseFloat(adv.minSingleTransAmount),
                  maxINR: parseFloat(adv.maxSingleTransAmount),
                  completion: parseFloat(advertiser.monthOrderFinishRate) || 0,
                  trades: parseInt(advertiser.monthOrderCount) || 0,
                  userNo: advertiser.userNo,
                  paymentMethods: paymentMethods,
                };
              })
              .filter((b) => inrAmount >= b.minINR && inrAmount <= b.maxINR);

            console.log(`💰 ${buyers.length} buyers accept ₹${inrAmount}\n`);

            if (buyers.length === 0) {
              console.log("⚠️  No suitable buyers found for ₹" + inrAmount);
              return;
            }

            // Sort: HIGHEST price first (best deal when selling)
            buyers.sort((a, b) => b.price - a.price);

            console.log("═══════════════════════════════════════════════════════════════");
            console.log("🏆 TOP BUYERS (HIGHEST PRICE = BEST FOR YOU):");
            console.log("═══════════════════════════════════════════════════════════════\n");

            buyers.slice(0, 10).forEach((buyer, i) => {
              const metrics = calculateRateMetrics(buyer.price, binanceRate, coinGeckoRate, inrAmount);
              
              console.log(`${i + 1}. ${metrics.recommendation} ${buyer.name}`);
              console.log(`   ├─ 💰 Their Rate: ₹${buyer.price}/USDT`);
              console.log(`   ├─ 💵 You SELL: ${metrics.usdtToSell} USDT → GET ₹${inrAmount}`);
              console.log(`   │`);
              console.log(`   ├─ 📊 vs Binance (₹${metrics.binanceRate}):`);
              console.log(`   │   ${parseFloat(metrics.vsBinancePct) >= 0 ? '🟢' : '🔴'} ${metrics.vsBinancePct > 0 ? '+' : ''}${metrics.vsBinancePct}% (₹${metrics.vsBinanceDiff})`);
              console.log(`   │   At Binance: ${(inrAmount/binanceRate).toFixed(4)} USDT needed`);
              console.log(`   │   ${parseFloat(metrics.usdtSaved) >= 0 ? '💚 You save' : '💔 You lose'}: ${Math.abs(parseFloat(metrics.usdtSaved)).toFixed(4)} USDT (₹${Math.abs(parseFloat(metrics.inrValueSaved)).toFixed(2)})`);
              console.log(`   │`);
              console.log(`   ├─ 📊 vs CoinGecko (₹${metrics.coinGeckoRate}):`);
              console.log(`   │   ${parseFloat(metrics.vsCoinGeckoPct) >= 0 ? '🟢' : '🔴'} ${metrics.vsCoinGeckoPct > 0 ? '+' : ''}${metrics.vsCoinGeckoPct}% (₹${metrics.vsCoinGeckoDiff})`);
              console.log(`   │   At CoinGecko: ${(inrAmount/coinGeckoRate).toFixed(4)} USDT needed`);
              console.log(`   │   ${parseFloat(metrics.usdtSavedCG) >= 0 ? '💚 You save' : '💔 You lose'}: ${Math.abs(parseFloat(metrics.usdtSavedCG)).toFixed(4)} USDT (₹${Math.abs(parseFloat(metrics.inrValueSavedCG)).toFixed(2)})`);
              console.log(`   │`);
              console.log(`   ├─ 💳 Payment: ${buyer.paymentMethods}`);
              console.log(`   ├─ 🔢 INR Limits: ₹${buyer.minINR.toLocaleString()} - ₹${buyer.maxINR.toLocaleString()}`);
              console.log(`   ├─ ✅ Completion: ${buyer.completion}%`);
              console.log(`   ├─ 📈 Monthly Trades: ${buyer.trades}`);
              console.log(`   └─ 👤 https://p2p.binance.com/en/advertiserDetail?advertiserNo=${buyer.userNo}\n`);
            });

            console.log("═══════════════════════════════════════════════════════════════");
            console.log(`💎 BEST DEAL: ₹${buyers[0].price}/USDT by ${buyers[0].name}`);
            console.log(`🎯 Sell ${(inrAmount / buyers[0].price).toFixed(4)} USDT → Get ₹${inrAmount}`);
            console.log(`📊 Binance: ₹${binanceRate.toFixed(2)} | CoinGecko: ₹${coinGeckoRate.toFixed(2)}`);
            console.log("═══════════════════════════════════════════════════════════════\n");

          } catch (err) {
            console.log("❌ Parse error:", err.message);
          }
        });
      });

      req.on("error", (error) => console.error("❌ Request error:", error.message));
      req.write(postData);
      req.end();
    });
  });
}

// Run - Looking to get ₹5146 INR by selling USDT
findBestBuyers(2000);
