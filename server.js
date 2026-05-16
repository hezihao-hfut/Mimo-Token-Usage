/**
 * MiMo Token Plan Proxy Server
 * 代理 + Cookie 存储 + 自动刷新 + 浏览器自动登录
 * 用法: node server.js
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { startAuth, closeBrowser, getAuthState, addSSEClient, removeSSEClient } = require('./auth');

const PORT = 3456;
const MIMO_BASE = 'platform.xiaomimimo.com';
const DATA_FILE = path.join(__dirname, 'accounts.json');

// ── Persistent storage ──────────────────────────────────────────────
let accounts = {};
try {
    accounts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    console.log(`[Init] Loaded ${Object.keys(accounts).length} account(s)`);
} catch (_) {}

function persist() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, api-key, Cookie, X-Mimo-Cookie');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, data) {
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => resolve(body));
    });
}

// ── Cookie helpers ───────────────────────────────────────────────────
// Parse "a=1; b=2; c=3" into { a: "1", b: "2", c: "3" }
function parseCookie(str) {
    const result = {};
    if (!str) return result;
    // Handle: key=value; key2="quoted value"; ...
    // Split on "; " but be careful with quoted values containing ";"
    const parts = str.split(/;\s*/);
    for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const key = part.substring(0, eqIdx).trim();
        let val = part.substring(eqIdx + 1).trim();
        result[key] = val;
    }
    return result;
}

// Assemble { key: "value" } back into "key=value; key2=value2"
function assembleCookie(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Build the full cookie string for MiMo API from an account's stored data
function buildMiMoCookie(acc) {
    // If cookie string exists, parse it
    const parsed = parseCookie(acc.cookie || '');
    // Also merge any non-httpOnly cookie from document.cookie (pushed from script)
    const parts = [];
    if (parsed['api-platform_serviceToken']) parts.push(`api-platform_serviceToken=${parsed['api-platform_serviceToken']}`);
    if (parsed['userId']) parts.push(`userId=${parsed['userId']}`);
    if (parsed['api-platform_slh']) parts.push(`api-platform_slh=${parsed['api-platform_slh']}`);
    if (parsed['api-platform_ph']) parts.push(`api-platform_ph=${parsed['api-platform_ph']}`);
    // Fallback: try the raw cookie if we couldn't parse known fields
    if (parts.length === 0 && acc.cookie) return acc.cookie;
    return parts.join('; ');
}

// ── Proxy to MiMo API ───────────────────────────────────────────────
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

const ENDPOINTS = {
    detail:  '/api/v1/tokenPlan/detail',
    usage:   '/api/v1/tokenPlan/usage',
    profile: '/api/v1/userProfile',
    balance: '/api/v1/balance',
};

// ── Refresh one account ──────────────────────────────────────────────
async function refreshAccount(userId) {
    const acc = accounts[userId];
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

        const u = usage.data?.data?.usage?.items?.find(i => i.name === 'plan_total_token')
            || usage.data?.data?.usage?.items?.[0];

        acc.data = {
            planName: detail.data?.data?.planName || '-',
            planCode: detail.data?.data?.planCode || '-',
            periodEnd: detail.data?.data?.currentPeriodEnd || null,
            expired: detail.data?.data?.expired || false,
            autoRenew: detail.data?.data?.enableAutoRenew || false,
            usedTokens: u?.used || 0,
            totalTokens: u?.limit || 0,
            percent: u?.percent || usage.data?.data?.usage?.percent || 0,
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

// ── Deduplicated account list ────────────────────────────────────────
function uniqueAccounts() {
    const seen = new Set();
    return Object.values(accounts).filter(a => {
        if (!a.userId || seen.has(a.userId)) return false;
        seen.add(a.userId);
        return true;
    });
}

// ── Static files ─────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
    const fp = path.join(__dirname, pathname === '/' ? '/index.html' : pathname);
    fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
    });
}

// ── HTTP Server ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    // Health
    if (pathname === '/api/health') {
        return json(res, 200, { status: 'ok', accounts: uniqueAccounts().length, time: new Date().toISOString() });
    }

    // ── Auth: Playwright browser login ──
    // GET  /api/auth/sse     ← SSE 实时进度
    // POST /api/auth/start   ← 启动浏览器登录
    // POST /api/auth/cancel  ← 关闭浏览器
    // GET  /api/auth/state   ← 获取当前状态

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
        // 异步启动，立即返回
        startAuth().then(result => {
            if (result.success && result.account) {
                const acc = result.account;
                const uid = acc.userId;
                accounts[uid] = { ...accounts[uid], ...acc };
                persist();
                console.log(`[Auth] ✅ Account saved: ${uid} (${acc.email})`);
            }
        }).catch(e => {
            console.error('[Auth] Unexpected error:', e);
        });
        return json(res, 200, { success: true, message: '浏览器启动中...' });
    }

    if (pathname === '/api/auth/cancel' && req.method === 'POST') {
        await closeBrowser();
        return json(res, 200, { success: true });
    }

    if (pathname === '/api/auth/state' && req.method === 'GET') {
        return json(res, 200, getAuthState());
    }

    // Push: script pushes data + cookie from MiMo page
    if (pathname === '/api/push' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const incoming = JSON.parse(body);
            // Find existing account: by userId first, then by email
            let uid = incoming.userId;
            let existing = uid ? accounts[uid] : null;
            if (!existing && incoming.email) {
                const found = Object.entries(accounts).find(([,v]) => v.email === incoming.email);
                if (found) { uid = found[0]; existing = found[1]; }
            }
            if (!uid) uid = 'unknown_' + Date.now();
            existing = existing || {};
            console.log(`[Push] userId=${uid} email=${incoming.email || '?'} hasCookie=${!!incoming.cookie}`);
            // Only update cookie if explicitly provided
            const cookie = incoming.cookie || existing.cookie || '';
            // Only update data if incoming has actual data fields (not just a cookie-only push)
            const hasData = incoming.planName || incoming.used || incoming.limit;
            const data = hasData ? {
                planName: incoming.planName || '-',
                planCode: incoming.planCode || '-',
                usedTokens: incoming.used || 0,
                totalTokens: incoming.limit || 0,
                percent: incoming.percent || 0,
                periodEnd: incoming.periodEnd || null,
                autoRenew: incoming.autoRenew || false,
                balance: incoming.balance || null,
                userId: uid,
                email: incoming.email,
            } : (existing.data || null);

            accounts[uid] = {
                ...existing,
                userId: uid,
                email: incoming.email || existing.email || '',
                cookie: cookie,
                data: data,
                lastPushed: new Date().toISOString(),
                lastRefreshed: data ? new Date().toISOString() : (existing.lastRefreshed || null),
            };

            persist();
            const hasCookie = !!accounts[uid].cookie;
            return json(res, 200, {
                success: true,
                hasCookie,
                message: hasCookie
                    ? '✅ 数据 + Cookie 已保存，后续可自动刷新'
                    : '⚠️ 数据已保存，但未收到 Cookie，无法自动刷新（请在脚本中加入 cookie 字段）',
            });
        } catch (e) {
            return json(res, 400, { success: false, error: e.message });
        }
    }

    // List all accounts
    if (pathname === '/api/accounts' && req.method === 'GET') {
        return json(res, 200, { accounts: uniqueAccounts() });
    }

    // Delete an account by userId or email
    const deleteMatch = pathname.match(/^\/api\/accounts\/(.+)$/);
    if (deleteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(deleteMatch[1]);
        let deleted = false;

        // Try by userId (key in accounts object)
        if (accounts[id]) {
            delete accounts[id];
            deleted = true;
        }
        // Try by email
        if (!deleted) {
            const found = Object.entries(accounts).find(([, v]) => v.email === id || v.userId === id);
            if (found) {
                delete accounts[found[0]];
                deleted = true;
            }
        }

        if (deleted) {
            persist();
            console.log(`[Delete] ✅ Account removed: ${id}`);
            return json(res, 200, { success: true, message: 'Account deleted' });
        } else {
            return json(res, 404, { success: false, error: 'Account not found' });
        }
    }

    // Update cookie for a specific account (by userId or email)
    if (pathname === '/api/cookie' && req.method === 'POST') {
        const body = await readBody(req);
        try {
            const { userId, email, serviceToken, cookie: fullCookie } = JSON.parse(body);
            if (!serviceToken && !fullCookie) return json(res, 400, { success: false, error: 'No cookie provided' });

            // Find account by userId or email
            let acc = null;
            let uid = userId;
            if (uid && accounts[uid]) acc = accounts[uid];
            if (!acc && email) {
                const found = Object.entries(accounts).find(([,v]) => v.email === email);
                if (found) { uid = found[0]; acc = found[1]; }
            }
            if (!acc) {
                uid = uid || 'unknown_' + Date.now();
                accounts[uid] = { userId: uid, email: email || '', cookie: '', data: null, lastPushed: new Date().toISOString() };
                acc = accounts[uid];
                console.log(`[Cookie] New account created: ${uid}`);
            }

            // Assemble full cookie: combine existing non-httpOnly cookies + the httpOnly serviceToken
            if (serviceToken) {
                // Parse existing cookie to get non-httpOnly fields
                const existingParts = parseCookie(acc.cookie || '');
                existingParts['api-platform_serviceToken'] = `"${serviceToken.replace(/^["']|["']$/g, '')}"`;
                acc.cookie = assembleCookie(existingParts);
            } else if (fullCookie) {
                acc.cookie = fullCookie;
            }
            persist();
            console.log(`[Cookie] Updated for userId=${acc.userId}, cookie length=${acc.cookie.length}`);
            return json(res, 200, { success: true, userId: acc.userId });
        } catch (e) {
            return json(res, 400, { success: false, error: e.message });
        }
    }

    // Refresh one account
    const refreshMatch = pathname.match(/^\/api\/refresh\/(.+)$/);
    if (refreshMatch && req.method === 'POST') {
        const uid = decodeURIComponent(refreshMatch[1]);
        const result = await refreshAccount(uid);
        console.log(`[Refresh] ${result.success ? '✅' : '❌'} userId=${uid}`);
        return json(res, result.success ? 200 : (result.error.includes('401') ? 401 : 500), result);
    }

    // Refresh all
    if (pathname === '/api/refresh-all' && req.method === 'POST') {
        const list = uniqueAccounts();
        const results = {};
        for (const acc of list) results[acc.userId] = await refreshAccount(acc.userId);
        return json(res, 200, { results });
    }

    // Legacy proxy
    if (pathname.startsWith('/proxy/')) {
        const target = '/' + pathname.replace('/proxy/', '');
        const cookie = req.headers['x-mimo-cookie'] || '';
        try {
            const r = await mimoRequest(cookie, target);
            cors(res);
            res.writeHead(r.status, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(r.data));
        } catch (e) { return json(res, 502, { error: e.message }); }
    }

    // Static
    serveStatic(res, pathname);
});

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║  🔥 MiMo Token Plan Dashboard Server                 ║
║                                                      ║
║  面板:      http://localhost:${PORT}                     ║
║                                                      ║
║  POST /api/auth/start    ← 浏览器自动登录             ║
║  GET  /api/auth/sse      ← 登录进度 SSE              ║
║  POST /api/push          ← 脚本推送数据+Cookie        ║
║  GET  /api/accounts      ← 面板拉取所有账号           ║
║  POST /api/refresh/:id   ← 用存储的Cookie刷新单个     ║
║  POST /api/refresh-all   ← 刷新全部                  ║
╚══════════════════════════════════════════════════════╝`);
});
