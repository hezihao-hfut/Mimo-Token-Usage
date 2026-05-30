/**
 * MiMo API 请求 + 账号刷新逻辑
 */

const https = require('https');
const { MIMO_BASE } = require('./config');
const { buildMiMoCookie } = require('./cookie');
const { getAccount, persist } = require('./store');

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
    if (!cookie || !cookie.includes('api-platform_serviceToken')) return { success: false, error: 'No cookie' };

    try {
        const [detail, usage, profile, balance] = await Promise.all([
            mimoRequest(cookie, ENDPOINTS.detail),
            mimoRequest(cookie, ENDPOINTS.usage),
            mimoRequest(cookie, ENDPOINTS.profile),
            mimoRequest(cookie, ENDPOINTS.balance),
        ]);

        if (detail.status === 401 || usage.status === 401) {
            return { success: false, error: 'Cookie expired (401)' };
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
