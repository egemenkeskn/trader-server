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

// Get current market price for a symbol
async function getMarketPrice(symbol) {
    try {
        const response = await fetch(`https://testnet.binancefuture.com/fapi/v1/ticker/price?symbol=${symbol}`);
        const data = await response.json();
        return parseFloat(data.price);
    } catch (error) {
        console.error(`[Binance API] Failed to fetch market price for ${symbol}:`, error);
        return 0;
    }
}

// Validate trade before execution
async function validateTrade(cleanSymbol, quantity, side, userBalances) {
    // 1. Quantity must be greater than zero
    const qty = parseFloat(quantity);
    if (qty <= 0) {
        throw new Error(`Invalid quantity: ${quantity} must be greater than zero`);
    }

    // 2. Get market price
    const marketPrice = await getMarketPrice(cleanSymbol);
    if (marketPrice === 0) {
        throw new Error(`Could not fetch market price for ${cleanSymbol}`);
    }

    // 3. Calculate notional value (quantity * price)
    const notionalValue = qty * marketPrice;

    // Minimum notional values
    const MIN_NOTIONAL_STANDARD = 20; // Most symbols require at least 20 USDT
    const MIN_NOTIONAL_SMALL = 5; // BTC, ETH, and other high-value assets

    // High-value symbols that can have smaller notional
    const highValueSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
    const minNotional = highValueSymbols.includes(cleanSymbol) ? MIN_NOTIONAL_SMALL : MIN_NOTIONAL_STANDARD;

    if (notionalValue < minNotional) {
        throw new Error(`Notional value ${notionalValue.toFixed(2)} USDT is below minimum ${minNotional} USDT for ${cleanSymbol}`);
    }

    // 4. Check if user has sufficient balance (USDT)
    const usdtBalance = userBalances.find(b => b.asset === 'USDT');
    const availableBalance = usdtBalance ? parseFloat(usdtBalance.free) : 0;

    // Rough margin requirement check (notional / leverage, but we'll use full notional for safety)
    if (side === 'BUY' || side === 'SELL') {
        // For opening positions, check if notional is less than or equal to available balance
        // This is a rough check - actual margin requirement depends on leverage
        if (notionalValue > availableBalance * 0.9) { // 90% of balance to leave room for fees
            throw new Error(`Insufficient balance: Need ~${notionalValue.toFixed(2)} USDT but only ${availableBalance.toFixed(2)} USDT available`);
        }
    }

    return { notionalValue, marketPrice };
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
    if (!response.ok) throw new Error(`Binance API Error: ${JSON.stringify(accountData)} `);

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
        console.log(`[Binance API] Setting Leverage for ${cleanSymbol} to ${targetLeverage} x`);
        try {
            const levQuery = `symbol = ${cleanSymbol}& leverage=${targetLeverage}& timestamp=${timestamp}& recvWindow=5000`;
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

    // Determine detailed Client Order ID
    let idPrefix = 'AI_OPEN';
    if (isClosing) idPrefix = 'AI_CLOSE';
    params.newClientOrderId = `${idPrefix}_${timestamp}`;

    console.log(`[Binance API] Order: ${params.side} ${params.quantity} ${cleanSymbol} (Step: ${stepSize}) ID: ${params.newClientOrderId}`);

    // VALIDATION: Check quantity, notional value, and balance before executing
    try {
        const { balances } = await getUserBinanceContext(supabaseAdmin, userId);
        const validationResult = await validateTrade(cleanSymbol, params.quantity, params.side, balances);
        console.log(`[Binance API] Trade validated. Notional: ${validationResult.notionalValue.toFixed(2)} USDT, Price: ${validationResult.marketPrice}`);
    } catch (validationError) {
        console.error(`[Binance API] Validation failed for ${cleanSymbol}:`, validationError.message);
        throw validationError; // Throw to prevent order execution
    }

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

        const placeConditionalOrder = async (type, stopPrice, tag) => {
            const exitSide = params.side === 'BUY' ? 'SELL' : 'BUY';
            const roundedPrice = roundToStep(stopPrice, tickSize);
            const algoId = `${tag}_${Date.now()}`;
            const condParams = `symbol=${cleanSymbol}&side=${exitSide}&algoType=CONDITIONAL&type=${type}&triggerPrice=${roundedPrice}&closePosition=true&newClientOrderId=${algoId}&timestamp=${Date.now()}&recvWindow=5000`;
            const condSig = signHmac(secretKey, condParams);

            const r = await fetch(`${BINANCE_ALGO_ORDER_URL}?${condParams}&signature=${condSig}`, {
                method: 'POST',
                headers: { 'X-MBX-APIKEY': apiKey }
            });
            return await r.json();
        };

        if (trade.stopLoss > 0) {
            const slRes = await placeConditionalOrder('STOP_MARKET', trade.stopLoss, 'AI_RULE_SL');
            console.log(`[Binance API] SL Result:`, JSON.stringify(slRes));
        }
        if (trade.takeProfit > 0) {
            const tpRes = await placeConditionalOrder('TAKE_PROFIT_MARKET', trade.takeProfit, 'AI_RULE_TP');
            console.log(`[Binance API] TP Result:`, JSON.stringify(tpRes));
        }
    }

    return { ...result, isClosing };
}

module.exports = { getUserBinanceContext, executeTradeInternal };
