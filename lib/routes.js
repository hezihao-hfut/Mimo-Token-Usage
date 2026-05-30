/**
 * HTTP 路由分发
 */

const { startAuth, closeBrowser, getAuthState, addSSEClient, removeSSEClient } = require('../auth');
const { json, readBody, corsHeaders } = require('./http-helpers');
const { parseCookie, assembleCookie } = require('./cookie');
const { getAccounts, getAccount, setAccount, deleteAccount, findAccountByEmail, uniqueAccounts, persist } = require('./store');
const { mimoRequest, refreshAccount } = require('./mimo-api');
const { serveStatic } = require('./static');
const { getAutoRefreshStatus, updateAutoRefresh, doRefreshAll } = require('./auto-refresh');

async function handleRequest(req, res) {
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

    // ── Auto Refresh ──
    if (pathname === '/api/auto-refresh/status' && req.method === 'GET') {
        return json(res, 200, getAutoRefreshStatus(), req);
    }

    if (pathname === '/api/auto-refresh/config' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const config = JSON.parse(body);
            const status = updateAutoRefresh(config);
            console.log(`[AutoRefresh] 配置已更新: enabled=${status.enabled}, interval=${status.intervalHours}h`);
            return json(res, 200, { success: true, ...status }, req);
        } catch (e) {
            return json(res, 400, { success: false, error: e.message }, req);
        }
    }

    if (pathname === '/api/auto-refresh/trigger' && req.method === 'POST') {
        console.log('[AutoRefresh] 🔄 手动触发刷新...');
        const result = await doRefreshAll();
        return json(res, 200, { success: true, ...result }, req);
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
}

module.exports = { handleRequest };
