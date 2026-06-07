/**
 * HTTP 路由分发
 */

const { startAuth, closeBrowser, getAuthState, addSSEClient, removeSSEClient } = require('../auth');
const { json, readBody, corsHeaders } = require('./http-helpers');
const { parseCookie, assembleCookie } = require('./cookie');
const { getAccounts, getAccount, setAccount, deleteAccount, findAccountByEmail, uniqueAccounts, persist } = require('./store');
const { mimoRequest, refreshAccount } = require('./mimo-api');
const { refreshServiceToken } = require('./cookie-refresher');
const { serveStatic } = require('./static');

async function handleRequest(req, res) {
    try {
    const url = require('url');
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        return res.end();
    }

    // Health
    if (pathname === '/api/health') {
        return json(res, 200, { status: 'ok', accounts: uniqueAccounts().length, time: new Date().toISOString() }, req);
    }

    // ── Auth: Playwright browser login ──
    if (pathname === '/api/auth/sse' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify(getAuthState())}\n\n`);
        addSSEClient(res);
        req.on('close', () => removeSSEClient(res));
        return;
    }

    if (pathname === '/api/auth/start' && req.method === 'POST') {
        startAuth().then(result => {
            if (result.success && result.account) {
                const acc = result.account;
                const uid = acc.userId;
                const existing = getAccount(uid) || {};
                setAccount(uid, { ...existing, ...acc });
                persist();
                console.log(`[Auth] ✅ Account saved: ${uid} (${acc.email})`);
            }
        }).catch(e => {
            console.error('[Auth] Unexpected error:', e);
        });
        return json(res, 200, { success: true, message: '浏览器启动中...' }, req);
    }

    if (pathname === '/api/auth/cancel' && req.method === 'POST') {
        await closeBrowser();
        return json(res, 200, { success: true }, req);
    }

    if (pathname === '/api/auth/state' && req.method === 'GET') {
        return json(res, 200, getAuthState(), req);
    }

    // ── Account CRUD ──

    // Get all accounts data
    if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = uniqueAccounts();
        return json(res, 200, { accounts }, req);
    }

    // Delete an account by userId or email
    const deleteMatch = pathname.match(/^\/api\/accounts\/(.+)$/);
    if (deleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(deleteMatch[1]);
        if (deleteAccount(id)) {
            persist();
            console.log(`[Delete] ✅ Account removed: ${id}`);
            return json(res, 200, { success: true, message: 'Account deleted' }, req);
        } else {
            return json(res, 404, { success: false, error: 'Account not found' }, req);
        }
    }

    // Update cookie for a specific account
    if (pathname === '/api/cookie' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const { userId, email, serviceToken, cookie: fullCookie } = JSON.parse(body);
            if (!serviceToken && !fullCookie) return json(res, 400, { success: false, error: 'No cookie provided' }, req);

            let acc = null;
            let uid = userId;
            if (uid) acc = getAccount(uid);
            if (!acc && email) {
                const found = findAccountByEmail(email);
                if (found) { uid = found.uid; acc = found.account; }
            }
            if (!acc) {
                uid = uid || 'unknown_' + Date.now();
                acc = { userId: uid, email: email || '', cookie: '', data: null, lastPushed: new Date().toISOString() };
                setAccount(uid, acc);
                console.log(`[Cookie] New account created: ${uid}`);
            }

            if (serviceToken) {
                const existingParts = parseCookie(acc.cookie || '');
                existingParts['api-platform_serviceToken'] = `"${serviceToken.replace(/^["']|["']$/g, '')}"`;
                acc.cookie = assembleCookie(existingParts);
            } else if (fullCookie) {
                acc.cookie = fullCookie;
            }
            persist();
            console.log(`[Cookie] Updated for userId=${acc.userId}, cookie length=${acc.cookie.length}`);
            return json(res, 200, { success: true, userId: acc.userId }, req);
        } catch (e) {
            return json(res, 400, { success: false, error: e.message }, req);
        }
    }

    // ── Refresh ──

    const refreshMatch = pathname.match(/^\/api\/refresh\/(.+)$/);
    if (refreshMatch && req.method === 'POST') {
        const uid = decodeURIComponent(refreshMatch[1]);
        const result = await refreshAccount(uid);
        console.log(`[Refresh] ${result.success ? '✅' : '❌'} userId=${uid}`);
        return json(res, result.success ? 200 : (result.error.includes('401') ? 401 : 500), result, req);
    }

    if (pathname === '/api/refresh-all' && req.method === 'POST') {
        const list = uniqueAccounts();
        const results = {};
        for (const acc of list) results[acc.userId] = await refreshAccount(acc.userId);
        return json(res, 200, { results }, req);
    }

    // ── passToken 续期 ──

    // 手动触发 passToken 续期（单个账号）
    const tokenRefreshMatch = pathname.match(/^\/api\/cookie\/refresh-token\/(.+)$/);
    if (tokenRefreshMatch && req.method === 'POST') {
        const uid = decodeURIComponent(tokenRefreshMatch[1]);
        const acc = getAccount(uid);
        if (!acc) return json(res, 404, { success: false, error: 'Account not found' }, req);
        if (!acc.xiaomiPassToken) return json(res, 400, { success: false, error: 'No passToken saved for this account' }, req);

        const result = await refreshServiceToken(acc.xiaomiPassToken, acc.xiaomiCookies || {});
        if (result.success) {
            acc.cookie = result.newCookie;
            persist();
            console.log(`[CookieRefresher] ✅ Manual refresh for ${uid} (${acc.email})`);
            return json(res, 200, { success: true, message: 'serviceToken refreshed' }, req);
        } else {
            return json(res, 500, { success: false, error: result.error }, req);
        }
    }

    // 手动触发 passToken 续期（全部账号）
    if (pathname === '/api/cookie/refresh-token' && req.method === 'POST') {
        const results = {};
        for (const acc of uniqueAccounts()) {
            if (!acc.xiaomiPassToken) {
                results[acc.userId] = { success: false, error: 'No passToken' };
                continue;
            }
            const result = await refreshServiceToken(acc.xiaomiPassToken, acc.xiaomiCookies || {});
            if (result.success) {
                const fullAcc = getAccount(acc.userId);
                fullAcc.cookie = result.newCookie;
                results[acc.userId] = { success: true };
            } else {
                results[acc.userId] = { success: false, error: result.error };
            }
        }
        persist();
        return json(res, 200, { results }, req);
    }

    // 查看 passToken 状态
    if (pathname === '/api/cookie/pass-token-status' && req.method === 'GET') {
        const accounts = uniqueAccounts().map(acc => {
            const fullAcc = getAccount(acc.userId) || acc;
            const hasPassToken = !!fullAcc.xiaomiPassToken;
            let passTokenStatus = 'missing';
            let passTokenDaysLeft = null;

            if (hasPassToken && fullAcc.passTokenExpires) {
                const expiresAt = new Date(fullAcc.passTokenExpires);
                const now = new Date();
                const daysLeft = (expiresAt - now) / (1000 * 60 * 60 * 24);
                passTokenDaysLeft = Math.round(daysLeft * 10) / 10;
                passTokenStatus = daysLeft <= 0 ? 'expired' : daysLeft <= 3 ? 'expiring_soon' : 'valid';
            } else if (hasPassToken) {
                passTokenStatus = 'valid'; // 无过期时间但有 token
            }

            return {
                userId: acc.userId,
                email: fullAcc.email || acc.email,
                hasPassToken,
                passTokenStatus,
                passTokenDaysLeft,
                passTokenExpires: fullAcc.passTokenExpires || null,
            };
        });
        return json(res, 200, { accounts }, req);
    }

    // 手动保存 passToken（用于已有账号补充 passToken）
    if (pathname === '/api/cookie/save-pass-token' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const { userId, email, passToken, xiaomiCookies } = JSON.parse(body);
            if (!passToken) return json(res, 400, { success: false, error: 'No passToken provided' }, req);

            let acc = null;
            let uid = userId;
            if (uid) acc = getAccount(uid);
            if (!acc && email) {
                const found = findAccountByEmail(email);
                if (found) { uid = found.uid; acc = found.account; }
            }
            if (!acc) return json(res, 404, { success: false, error: 'Account not found' }, req);

            acc.xiaomiPassToken = passToken;
            if (xiaomiCookies) acc.xiaomiCookies = xiaomiCookies;
            // passToken 有效期 30 天（从现在开始算）
            acc.passTokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            persist();

            console.log(`[CookieRefresher] passToken saved for ${uid} (${acc.email})`);
            return json(res, 200, { success: true, userId: uid }, req);
        } catch (e) {
            return json(res, 400, { success: false, error: e.message }, req);
        }
    }

    // ── Legacy proxy ──
    if (pathname.startsWith('/proxy/')) {
        const target = '/' + pathname.replace('/proxy/', '');
        const cookie = req.headers['x-mimo-cookie'] || '';
        try {
            const r = await mimoRequest(cookie, target);
            res.writeHead(r.status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
            return res.end(JSON.stringify(r.data));
        } catch (e) { return json(res, 502, { error: e.message }, req); }
    }

    // ── Static files ──
    serveStatic(res, pathname);

    } catch (e) {
        console.error('[Server] Unhandled error:', e.message);
        if (!res.headersSent) {
            json(res, 500, { error: 'Internal server error', message: e.message }, req);
        }
    }
}

module.exports = { handleRequest };
