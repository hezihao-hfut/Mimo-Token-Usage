/**
 * MiMo API 请求 + 账号刷新逻辑（含自动续期）
 */

const https = require('https');
const { MIMO_BASE } = require('./config');
const { buildMiMoCookie, parseCookie, assembleCookie } = require('./cookie');
const { getAccount, persist } = require('./store');
const { refreshServiceToken } = require('./cookie-refresher');

const ENDPOINTS = {
    detail:  '/api/v1/tokenPlan/detail',
    usage:   '/api/v1/tokenPlan/usage',
    profile: '/api/v1/userProfile',
    balance: '/api/v1/balance',
};

function mimoRequest(cookie, targetPath) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: MIMO_BASE,
            port: 443,
            path: targetPath,
            method: 'GET',
            headers: {
                Cookie: cookie,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            },
        };
        const r = https.request(opts, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch (_) { resolve({ status: res.statusCode, data: body }); }
            });
        });
        r.on('error', reject);
        r.end();
    });
}

async function refreshAccount(userId) {
    const acc = getAccount(userId);
    if (!acc) return { success: false, error: 'Account not found' };
    const cookie = buildMiMoCookie(acc);
    if (!cookie || !cookie.includes('api-platform_serviceToken')) {
        // 没有 serviceToken，尝试用 passToken 自动获取
        if (acc.xiaomiPassToken) {
            console.log(`[Refresh] No serviceToken for ${userId}, attempting auto-refresh with passToken...`);
            const refreshResult = await refreshServiceToken(acc.xiaomiPassToken, acc.xiaomiCookies || {});
            if (refreshResult.success) {
                acc.cookie = refreshResult.newCookie;
                persist();
                console.log(`[Refresh] ✅ Auto-refreshed serviceToken for ${userId}`);
            } else {
                return { success: false, error: 'No cookie and passToken refresh failed: ' + refreshResult.error };
            }
        } else {
            return { success: false, error: 'No cookie' };
        }
    }

    try {
        let [detail, usage, profile, balance] = await Promise.all([
            mimoRequest(buildMiMoCookie(acc), ENDPOINTS.detail),
            mimoRequest(buildMiMoCookie(acc), ENDPOINTS.usage),
            mimoRequest(buildMiMoCookie(acc), ENDPOINTS.profile),
            mimoRequest(buildMiMoCookie(acc), ENDPOINTS.balance),
        ]);

        // 401 自动续期：尝试用 passToken 获取新的 serviceToken
        if (detail.status === 401 || usage.status === 401) {
            if (acc.xiaomiPassToken) {
                console.log(`[Refresh] Cookie expired for ${userId}, attempting auto-refresh...`);
                const refreshResult = await refreshServiceToken(acc.xiaomiPassToken, acc.xiaomiCookies || {});
                if (refreshResult.success) {
                    acc.cookie = refreshResult.newCookie;
                    persist();
                    console.log(`[Refresh] ✅ Auto-refreshed serviceToken for ${userId}, retrying...`);

                    // 重试原请求
                    [detail, usage, profile, balance] = await Promise.all([
                        mimoRequest(refreshResult.newCookie, ENDPOINTS.detail),
                        mimoRequest(refreshResult.newCookie, ENDPOINTS.usage),
                        mimoRequest(refreshResult.newCookie, ENDPOINTS.profile),
                        mimoRequest(refreshResult.newCookie, ENDPOINTS.balance),
                    ]);

                    if (detail.status === 401 || usage.status === 401) {
                        return { success: false, error: 'Cookie expired (401) even after refresh' };
                    }
                } else {
                    console.log(`[Refresh] ❌ Auto-refresh failed for ${userId}: ${refreshResult.error}`);
                    return { success: false, error: 'Cookie expired (401), auto-refresh failed: ' + refreshResult.error };
                }
            } else {
                return { success: false, error: 'Cookie expired (401)' };
            }
        }

        const usageItems = usage.data?.data?.usage?.items || [];
        const u = usageItems.find(i => i.name === 'plan_total_token') || usageItems[0];
        const c = usageItems.find(i => i.name === 'compensation_total_token');

        acc.data = {
            planName: detail.data?.data?.planName || '-',
            planCode: detail.data?.data?.planCode || '-',
            periodEnd: detail.data?.data?.currentPeriodEnd || null,
            expired: detail.data?.data?.expired || false,
            autoRenew: detail.data?.data?.enableAutoRenew || false,
            usedTokens: u?.used || 0,
            totalTokens: u?.limit || 0,
            percent: u?.percent || usage.data?.data?.usage?.percent || 0,
            compUsedTokens: c?.used || 0,
            compTotalTokens: c?.limit || 0,
            compPercent: c?.percent || 0,
            balance: balance.data?.data || null,
            userId: profile.data?.data?.userId || acc.userId,
            email: profile.data?.data?.email || acc.email,
        };
        acc.lastRefreshed = new Date().toISOString();
        if (profile.data?.data?.email) acc.email = profile.data.data.email;

        persist();
        return { success: true, data: acc.data };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = { mimoRequest, refreshAccount, ENDPOINTS };
