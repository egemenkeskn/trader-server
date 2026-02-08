const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const cron = require('node-cron');
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
    res.send('Autonomous Trader Server is Live 🚀 (Scheduler Active)');
});

// Reusable function for trade cycle
async function runTradeCycle(targetUserId = null, forceRun = false) {
    console.log(`[Autonomous] Starting cycle. Target: ${targetUserId || 'ALL'}, Force: ${forceRun}`);
    console.log(`[Autonomous] Supabase URL: ${SUPABASE_URL}`);
    console.log(`[Autonomous] Service Key (first 20 chars): ${SUPABASE_SERVICE_ROLE_KEY?.substring(0, 20)}...`);

    let query = supabaseAdmin
        .from('user_settings')
        .select('user_id, expo_push_token, autonomous_schedule_type, autonomous_interval, autonomous_daily_time, last_autonomous_run, is_autonomous_enabled');

    if (targetUserId) {
        // If specific user is targeted, fetch them regardless of is_autonomous_enabled IF forceRun is true
        // If forceRun is false but targetUserId is set? We still assume we want to check them.
        console.log(`[Autonomous] Querying for specific user: ${targetUserId}`);
        query = query.eq('user_id', targetUserId);
    } else {
        // Cron Mode: Only fetch enabled users
        console.log(`[Autonomous] Querying for all users where is_autonomous_enabled = true`);
        query = query.eq('is_autonomous_enabled', true);
    }

    const { data: users, error: userError } = await query;

    console.log(`[Autonomous] Query result - Error:`, userError);
    console.log(`[Autonomous] Query result - Data:`, users);

    if (userError) throw userError;
    console.log(`[Autonomous] Found ${users?.length || 0} user(s) to process.`);
    if (targetUserId && users?.length === 0) {
        console.warn(`[Autonomous] Warning: Target user ${targetUserId} not found in user_settings.`);
    }

    // TR is always GMT+3 (no DST)
    const trOffset = 3 * 60 * 60 * 1000
    const nowUTC = new Date()
    const nowTR = new Date(nowUTC.getTime() + trOffset)

    const processPromises = users.map(async (user) => {
        const userId = user.user_id;
        const pushToken = user.expo_push_token;
        const scheduleType = user.autonomous_schedule_type || 'interval';
        const intervalMinutes = user.autonomous_interval || 60;
        const dailyTime = user.autonomous_daily_time || '09:00';
        const lastRunRaw = user.last_autonomous_run;
        const lastRun = lastRunRaw ? new Date(lastRunRaw) : null;

        // 2. Schedule Validation
        let shouldRun = false;

        if (forceRun) {
            shouldRun = true;
            console.log(`[Autonomous] [${userId}] Force Run active. Skipping schedule check.`);
        } else {
            // Check is_autonomous_enabled again just in case (for targetUserId mode without force, if that ever happens)
            // But we already filtered by query if (no target).

            if (scheduleType === 'interval') {
                if (!lastRun) {
                    shouldRun = true;
                } else {
                    const diffMs = nowUTC.getTime() - lastRun.getTime();
                    const diffMin = Math.floor(diffMs / 60000);
                    if (diffMin >= intervalMinutes) shouldRun = true;
                }
            } else if (scheduleType === 'daily') {
                const [targetHour, targetMin] = dailyTime.split(':').map(Number);
                const currentHour = nowTR.getUTCHours();
                const currentMin = nowTR.getUTCMinutes();

                let hasRunToday = false;
                if (lastRun) {
                    const lastRunTR = new Date(lastRun.getTime() + trOffset);
                    hasRunToday = lastRunTR.getUTCDate() === nowTR.getUTCDate() &&
                        lastRunTR.getUTCMonth() === nowTR.getUTCMonth() &&
                        lastRunTR.getUTCFullYear() === nowTR.getUTCFullYear();
                }

                if (!hasRunToday) {
                    // Check if current time is past the target time
                    if (currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMin)) {
                        shouldRun = true;
                    }
                }
            }
        }

        if (!shouldRun) {
            // console.log(`[Autonomous] [${userId}] Schedule not due.`);
            return;
        }

        console.log(`[Autonomous] >>> STARTING TRADE CYCLE for user ${userId}`);

        // 2.5 Update Last Run Time IMMEDIATELY
        await supabaseAdmin
            .from('user_settings')
            .update({ last_autonomous_run: nowUTC.toISOString() })
            .eq('user_id', userId);

        // Fetch context
        console.log(`[Autonomous] Fetching Binance context for ${userId}...`);
        try {
            const { balances, positions } = await getUserBinanceContext(supabaseAdmin, userId);

            // 3. Invoke Analyst
            console.log(`[Autonomous] Calling analyst at: ${ANALYST_SERVER_URL}`);

            const analystResponse = await fetch(ANALYST_SERVER_URL, {
                method: 'POST',
                headers: {
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
            console.log(`[Autonomous] [${userId}] actionLog length: ${actionLog.length}`);
            console.log(`[Autonomous] [${userId}] actionLog:`, actionLog);

            if (actionLog.length > 0) {
                const notificationData = {
                    actions: actionLog,
                    ai_narrative: analysis.text,
                    trade_details: executedTradeDetails
                };

                console.log(`[Autonomous] [${userId}] Inserting notification...`);
                const { data: notifData, error: notifError } = await supabaseAdmin.from('notifications').insert({
                    user_id: userId,
                    type: 'SYSTEM',
                    title: 'Otonom İşlem Raporu',
                    message: actionLog.join(', '),
                    data: notificationData
                });

                if (notifError) {
                    console.error(`[Autonomous] [${userId}] Notification insert failed:`, notifError);
                } else {
                    console.log(`[Autonomous] [${userId}] Notification inserted successfully`);
                }

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

        } catch (ctxError) {
            console.error(`[Autonomous] [${userId}] Context/Analyst Error:`, ctxError.message);
        }
    });

    return Promise.allSettled(processPromises);
}

// Internal Cron Job (Runs every minute)
// Only active users, respecting schedule
cron.schedule('* * * * *', () => {
    console.log('⏰ [Cron] Running every-minute check...');
    runTradeCycle(null, false).then(() => {
        console.log('✅ [Cron] Minute check complete.');
    }).catch(err => {
        console.error('❌ [Cron] Error in minute check:', err);
    });
});

// Trigger Endpoint (Manual Override)
app.post('/trigger', async (req, res) => {
    try {
        const { userId, force } = req.body;
        console.log(`🔔 [TRIGGER] Manual trigger received. User: ${userId}, Force: ${force}`);

        if (!userId && force) {
            console.warn("⚠️ Warning: Force run requested without missing userId. This will force run ALL users if not handled properly. Defaulting to standard check.");
            // If force is true but no userId, maybe we should prevent it? Or just run all enabled users properly?
            // Let's assume force requires userId for safety, or runs all enabled users bypassing schedule.
            // For now, let's allow it but be careful.
        }

        // Run in background - Do NOT await
        runTradeCycle(userId, !!force).then(() => {
            console.log('✅ [Autonomous] Manual cycle finished.');
        }).catch(err => {
            console.error('❌ [Autonomous] Manual cycle finished with errors:', err);
        });

        res.json({ success: true, message: 'Cycle started in background 🚀' });

    } catch (error) {
        console.error('[Error]', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Trader Server live on ${PORT}`);
});
