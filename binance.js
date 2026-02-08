const fetch = require('node-fetch');
const crypto = require('crypto');
const CryptoJS = require('crypto-js'); // Added CryptoJS import
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const ENCRYPTION_KEY = process.env.APP_SECRET_KEY;

// Helper to get 32-byte key from any string (SHA-256)
function getCryptoKey(secret) {
    return CryptoJS.SHA256(secret).toString(CryptoJS.enc.Hex);
}

// Decryption Helper
async function decrypt(text) {
    const [ivHex, cipherHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');

    // Derive key using SHA-256 from ENCRYPTION_KEY
    const derivedKeyHex = getCryptoKey(ENCRYPTION_KEY);
    const derivedKeyBuffer = Buffer.from(derivedKeyHex, 'hex');

    const key = await crypto.webcrypto.subtle.importKey(
        "raw",
        derivedKeyBuffer, // Use the SHA-256 derived key
        "AES-GCM",
        false,
        ["decrypt"]
    );

    const decrypted = await crypto.webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        ciphertext
    );

    return new TextDecoder().decode(decrypted);
}

// Helper: HMAC SHA256 Signature
function signHmac(key, queryString) {
    return crypto.createHmac('sha256', key).update(queryString).digest('hex');
}

async function getSymbolStepSize(symbol) {
    try {
        const response = await fetch('https://testnet.binancefuture.com/fapi/v1/exchangeInfo');
        const data = await response.json();
        const symbolInfo = data.symbols.find(s => s.symbol === symbol);
        if (symbolInfo) {
            const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
            if (lotSizeFilter) {
                return parseFloat(lotSizeFilter.stepSize);
            }
        }
        return 0.001; // Default fallback
    } catch (error) {
        console.error(`[Binance API] Failed to fetch exchangeInfo for ${symbol}:`, error);
        return 0.001;
    }
}

async function getSymbolTickSize(symbol) {
    try {
        const response = await fetch('https://testnet.binancefuture.com/fapi/v1/exchangeInfo');
        const data = await response.json();
        const symbolInfo = data.symbols.find(s => s.symbol === symbol);
        if (symbolInfo) {
            const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
            if (priceFilter) {
                return parseFloat(priceFilter.tickSize);
            }
        }
        return 0.01; // Default fallback
    } catch (error) {
        console.error(`[Binance API] Failed to fetch tickSize for ${symbol}:`, error);
        return 0.01;
    }
}

function roundToStep(value, stepSize) {
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    const rounded = Math.floor(value / stepSize) * stepSize;
    return rounded.toFixed(precision);
}

async function getUserBinanceContext(supabaseAdmin, userId) {
    if (!ENCRYPTION_KEY) throw new Error('Server config error: encryption key missing');

    // Fetch User Keys
    const { data: settings, error: settingsError } = await supabaseAdmin
        .from('user_settings')
        .select('binance_api_key, binance_secret_key')
        .eq('user_id', userId)
        .single();

    if (settingsError || !settings) throw new Error('API Keys not configured');

    // Decrypt Keys
    const apiKey = (await decrypt(settings.binance_api_key)).replace(/[^\x20-\x7E]/g, '').trim();
    const secretKey = (await decrypt(settings.binance_secret_key)).replace(/[^\x20-\x7E]/g, '').trim();

    const timestamp = Date.now();
    const recvWindow = 5000;
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = signHmac(secretKey, queryString);

    const BINANCE_API_URL = 'https://testnet.binancefuture.com/fapi/v2/account';
    const response = await fetch(`${BINANCE_API_URL}?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': apiKey },
        timeout: 10000
    });

    const accountData = await response.json();
    if (!response.ok) throw new Error(`Binance API Error: ${JSON.stringify(accountData)}`);

    const balances = (accountData.assets || []).filter(b =>
        parseFloat(b.walletBalance) > 0 || parseFloat(b.marginBalance) > 0
    ).map(b => ({
        asset: b.asset,
        free: b.walletBalance,
        locked: b.maintMargin
    }));

    const positions = (accountData.positions || []).filter(p =>
        parseFloat(p.positionAmt) !== 0
    ).map(p => ({
        symbol: p.symbol,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice || 0,
        unrealizedProfit: p.unrealizedProfit,
        leverage: p.leverage,
        positionSide: p.positionSide
    }));

    return { balances, positions };
}

async function executeTradeInternal(supabaseAdmin, userId, trade) {
    if (!ENCRYPTION_KEY) throw new Error('Server config error: encryption key missing');

    const { data: settings } = await supabaseAdmin
        .from('user_settings')
        .select('binance_api_key, binance_secret_key')
        .eq('user_id', userId)
        .single();

    if (!settings) throw new Error('API Keys not configured');

    const apiKey = (await decrypt(settings.binance_api_key)).replace(/[^\x20-\x7E]/g, '').trim();
    const secretKey = (await decrypt(settings.binance_secret_key)).replace(/[^\x20-\x7E]/g, '').trim();

    const timestamp = Date.now();
    const cleanSymbol = trade.symbol.replace(/[\/\s-]/g, '').toUpperCase();

    const BINANCE_ORDER_URL = 'https://testnet.binancefuture.com/fapi/v1/order';
    const BINANCE_ALGO_ORDER_URL = 'https://testnet.binancefuture.com/fapi/v1/algoOrder';

    // 1. Fetch current position to check for opposite sides
    console.log(`[Binance API] Fetching current state for ${cleanSymbol} position awareness...`);
    const { positions } = await getUserBinanceContext(supabaseAdmin, userId);
    const existingPos = positions.find(p => p.symbol === cleanSymbol);
    const posAmt = existingPos ? parseFloat(existingPos.positionAmt) : 0;

    // 1.5 Set Leverage (if provided and different)
    const targetLeverage = trade.leverage || 1;
    if (trade.action !== 'CLOSE' && (!existingPos || parseInt(existingPos.leverage) !== targetLeverage)) {
        console.log(`[Binance API] Setting Leverage for ${cleanSymbol} to ${targetLeverage}x`);
        try {
            const levQuery = `symbol=${cleanSymbol}&leverage=${targetLeverage}&timestamp=${timestamp}&recvWindow=5000`;
            const levSig = signHmac(secretKey, levQuery);

            const levRes = await fetch(`https://testnet.binancefuture.com/fapi/v1/leverage?${levQuery}&signature=${levSig}`, {
                method: 'POST',
                headers: { 'X-MBX-APIKEY': apiKey }
            });
            const levData = await levRes.json();
            if (!levRes.ok) console.warn(`[Binance API] Failed to set leverage: ${JSON.stringify(levData)}`);
            else console.log(`[Binance API] Leverage set result: ${JSON.stringify(levData)}`);
        } catch (levErr) {
            console.error(`[Binance API] Leverage error:`, levErr);
        }
    }

    // 2. Determine Order Side & Logic
    const requestedSide = trade.action.toUpperCase().startsWith('BUY') ? 'BUY' : 'SELL';

    const params = {
        symbol: cleanSymbol,
        side: requestedSide,
        type: 'MARKET',
        quantity: trade.quantity,
        timestamp: timestamp,
        newClientOrderId: `AI_${Date.now()}`
    };

    // 3. Intelligent Routing (Auto-Close/Flip)
    let isClosing = false;
    if (trade.action === 'CLOSE') {
        if (posAmt !== 0) {
            params.side = posAmt > 0 ? 'SELL' : 'BUY';
            params.quantity = Math.abs(posAmt);
            isClosing = true;
            console.log(`[Binance API] Explicit CLOSE for ${cleanSymbol}: ${posAmt} -> ${params.side} ${params.quantity}`);
        } else {
            throw new Error(`Kapatılacak ${cleanSymbol} pozisyonu bulunamadı.`);
        }
    } else {
        const reducingLong = requestedSide === 'SELL' && posAmt > 0;
        const reducingShort = requestedSide === 'BUY' && posAmt < 0;

        if (reducingLong || reducingShort) {
            isClosing = true;
            console.log(`[Binance API] ${requestedSide} identified as CLOSING/REDUCING action for ${cleanSymbol} (Current: ${posAmt})`);
        }
    }

    // 4. Apply Precision Rounding
    const stepSize = await getSymbolStepSize(cleanSymbol);
    params.quantity = roundToStep(parseFloat(params.quantity.toString()), stepSize);
    console.log(`[Binance API] Order: ${params.side} ${params.quantity} ${cleanSymbol} (Step: ${stepSize})`);

    const queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    const signature = signHmac(secretKey, queryString);

    const response = await fetch(`${BINANCE_ORDER_URL}?${queryString}&signature=${signature}`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': apiKey }
    });

    const result = await response.json();
    console.log(`[Binance API] Order Response for ${cleanSymbol}:`, JSON.stringify(result));

    if (!response.ok) {
        throw new Error(`Binance API Error: ${result.msg || JSON.stringify(result)} (Code: ${result.code})`);
    }

    // 5. Place Stop Loss & Take Profit
    if (!isClosing && result.orderId && (trade.stopLoss > 0 || trade.takeProfit > 0)) {
        console.log(`[Binance API] Placing SL/TP orders for ${cleanSymbol}...`);
        const tickSize = await getSymbolTickSize(cleanSymbol);

        const placeConditionalOrder = async (type, stopPrice) => {
            const exitSide = params.side === 'BUY' ? 'SELL' : 'BUY';
            const roundedPrice = roundToStep(stopPrice, tickSize);
            const condParams = `symbol=${cleanSymbol}&side=${exitSide}&algoType=CONDITIONAL&type=${type}&triggerPrice=${roundedPrice}&closePosition=true&timestamp=${Date.now()}&recvWindow=5000`;
            const condSig = signHmac(secretKey, condParams);

            const r = await fetch(`${BINANCE_ALGO_ORDER_URL}?${condParams}&signature=${condSig}`, {
                method: 'POST',
                headers: { 'X-MBX-APIKEY': apiKey }
            });
            return await r.json();
        };

        if (trade.stopLoss > 0) {
            const slRes = await placeConditionalOrder('STOP_MARKET', trade.stopLoss);
            console.log(`[Binance API] SL Result:`, JSON.stringify(slRes));
        }
        if (trade.takeProfit > 0) {
            const tpRes = await placeConditionalOrder('TAKE_PROFIT_MARKET', trade.takeProfit);
            console.log(`[Binance API] TP Result:`, JSON.stringify(tpRes));
        }
    }

    return { ...result, isClosing };
}

module.exports = { getUserBinanceContext, executeTradeInternal };
