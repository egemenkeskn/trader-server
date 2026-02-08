const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { executeTradeInternal, getUserBinanceContext } = require('./binance');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANALYST_SERVER_URL = process.env.RENDER_ANALYST_URL || `${SUPABASE_URL}/functions/v1/market-analyst`;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Heartbeat Endpoint
app.get('/', (req, res) => {
    res.send('Autonomous Trader Server is Live 🚀');
});

// Trigger Endpoint
app.post('/trigger', async (req, res) => {
    try {
        console.log('🔔 [HEARTBEAT] Otonom Trader Triggered manually!');

        console.log('[Autonomous] Starting background cycle...');

        // 1. Get all users with autonomous mode enabled
        const { data: users, error: userError } = await supabaseAdmin
            .from('user_settings')
            .select('user_id, expo_push_token, autonomous_schedule_type, autonomous_interval, autonomous_daily_time, last_autonomous_run')
            .eq('is_autonomous_enabled', true);

        if (userError) throw userError;
        console.log(`[Autonomous] Found ${users?.length || 0} active otonom users.`);

        const processPromises = users.map(async (user) => {
            const userId = user.user_id;
            const pushToken = user.expo_push_token;
            // Schedule validation logic omitted for manual trigger - assuming trigger means RUN
            // But we should update last_autonomous_run to prevent double runs if we keep cron

            console.log(`[Autonomous] >>> STARTING TRADE CYCLE for user ${userId}`);

            // 2.5 Update Last Run Time
            await supabaseAdmin
                .from('user_settings')
                .update({ last_autonomous_run: new Date().toISOString() })
                .eq('user_id', userId);

            // Fetch context
            console.log(`[Autonomous] Fetching Binance context for ${userId}...`);
            const { balances, positions } = await getUserBinanceContext(supabaseAdmin, userId);

            // 3. Invoke Analyst
            console.log(`[Autonomous] Calling analyst at: ${ANALYST_SERVER_URL}`);

            // NO TIMEOUT LIMIT HERE (Node.js default is very long, or we can set it custom)
            const analystResponse = await fetch(ANALYST_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                    'apikey': SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    userQuery: "Mevcut pozisyonlarımı değerlendir ve kâr gördüğün en iyi 3 yeni fırsatı uygulayarak portföyümü optimize et.",
                    userBalances: balances,
                    userPositions: positions,
                    userId: userId
                })
            });

            if (!analystResponse.ok) {
                const errorBody = await analystResponse.text();
                throw new Error(`Analyst failed for ${userId}: ${errorBody}`);
            }

            const analysis = await analystResponse.json();
            console.log(`[Autonomous] Analyst recommendation count:`, analysis.tradeRecommendations?.length || 0);

            let actionLog = [];
            let executedTradeDetails = [];

            // 4. Execute Trades
            for (const trade of analysis.tradeRecommendations || []) {
                console.log(`[Autonomous] [${userId}] Attempting: ${trade.action} ${trade.symbol}`);

                try {
                    const tradeResult = await executeTradeInternal(supabaseAdmin, userId, trade);
                    if (tradeResult.orderId) {
                        console.log(`[Autonomous] [${userId}] SUCCESS: ${trade.symbol} OrderId: ${tradeResult.orderId}`);
                        actionLog.push(`${trade.symbol} ${tradeResult.isClosing ? 'kapatıldı' : 'alındı'}`);

                        await supabaseAdmin.from('autonomous_trades').insert({
                            order_id: tradeResult.orderId,
                            user_id: userId,
                            symbol: trade.symbol
                        });

                        executedTradeDetails.push({
                            symbol: trade.symbol,
                            reason: trade.reason,
                            action: tradeResult.isClosing ? 'CLOSE' : trade.action,
                            orderId: tradeResult.orderId,
                            leverage: trade.leverage,
                            stopLoss: trade.stopLoss,
                            takeProfit: trade.takeProfit,
                            quantity: trade.quantity
                        });
                    }
                } catch (tErr) {
                    console.error(`[Autonomous] [${userId}] Error executing ${trade.symbol}:`, tErr.message || tErr);
                }
            }

            // 6. Notifications
            if (actionLog.length > 0) {
                const notificationData = {
                    actions: actionLog,
                    ai_narrative: analysis.text,
                    trade_details: executedTradeDetails
                };

                await supabaseAdmin.from('notifications').insert({
                    user_id: userId,
                    type: 'SYSTEM',
                    title: 'Otonom İşlem Raporu',
                    message: actionLog.join(', '),
                    data: notificationData
                });

                if (pushToken) {
                    await fetch('https://exp.host/--/api/v2/push/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            to: pushToken,
                            title: "Otonom İşlem Raporu",
                            body: actionLog.join('\n'),
                            sound: 'default',
                            badge: 1
                        })
                    });
                }
            } else {
                console.log(`[Autonomous] No trade actions took place for user ${userId}`);
            }
        });

        // Wait for all users to be processed
        await Promise.allSettled(processPromises);

        res.json({ success: true, message: 'Cycle completed' });

    } catch (error) {
        console.error('[Error]', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Trader Server live on ${PORT}`);
});
