/**
 * MiMo Token Plan Proxy Server
 * 入口文件 — 启动 HTTP 服务，所有路由由 lib/routes.js 处理
 * 用法: node server.js
 */

const http = require('http');
const { PORT, KEEPALIVE_INTERVAL } = require('./lib/config');
const { handleRequest } = require('./lib/routes');
const { uniqueAccounts, getAccount, persist } = require('./lib/store');
const { refreshServiceToken } = require('./lib/cookie-refresher');

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`
══════════════════════════════════════════════════════
   🔥 MiMo Token Plan Dashboard Server

   面板:      http://localhost:${PORT}

   POST /api/auth/start    ← 浏览器自动登录
   GET  /api/auth/sse      ← 登录进度 SSE
   POST /api/refresh/:id   ← 用存储的Cookie刷新单个
   POST /api/refresh-all   ← 刷新全部
   POST /api/cookie/refresh-token ← 手动触发 passToken 续期
   GET  /api/cookie/pass-token-status ← 查看 passToken 状态
══════════════════════════════════════════════════════`);

    // 启动定时保活检查
    startKeepalive();
});

/**
 * 定时保活：定期检查所有账号的 cookie 有效性
 * 如果 serviceToken 过期，自动用 passToken 续期
 */
function startKeepalive() {
    const check = async () => {
        const accounts = uniqueAccounts();
        if (accounts.length === 0) return;

        console.log(`[Keepalive] Checking ${accounts.length} account(s)...`);
        let refreshed = 0, failed = 0, skipped = 0;

        for (const acc of accounts) {
            const userId = acc.userId;
            const fullAcc = getAccount(userId);
            if (!fullAcc) continue;

            // 没有 passToken 的账号跳过
            if (!fullAcc.xiaomiPassToken) {
                skipped++;
                continue;
            }

            // 检查 passToken 是否过期
            if (fullAcc.passTokenExpires) {
                const expiresAt = new Date(fullAcc.passTokenExpires);
                const now = new Date();
                if (expiresAt <= now) {
                    console.log(`[Keepalive] ⚠️ passToken expired for ${userId} (${fullAcc.email}), skipping`);
                    failed++;
                    continue;
                }
            }

            try {
                // 尝试用当前 cookie 请求 API
                const https = require('https');
                const { MIMO_BASE } = require('./lib/config');
                const { buildMiMoCookie } = require('./lib/cookie');

                const testResult = await new Promise((resolve) => {
                    const opts = {
                        hostname: MIMO_BASE,
                        port: 443,
                        path: '/api/v1/userProfile',
                        method: 'GET',
                        headers: {
                            Cookie: buildMiMoCookie(fullAcc),
                            Accept: 'application/json',
                            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
                        },
                    };
                    const r = https.request(opts, (res) => {
                        let body = '';
                        res.on('data', (c) => (body += c));
                        res.on('end', () => resolve({ status: res.statusCode }));
                    });
                    r.on('error', () => resolve({ status: 0 }));
                    r.setTimeout(10000, () => { r.destroy(); resolve({ status: 0 }); });
                    r.end();
                });

                if (testResult.status === 200) {
                    // Cookie 仍然有效
                    continue;
                }

                if (testResult.status === 401) {
                    // serviceToken 过期，尝试用 passToken 续期
                    console.log(`[Keepalive] serviceToken expired for ${userId}, refreshing...`);
                    const result = await refreshServiceToken(fullAcc.xiaomiPassToken, fullAcc.xiaomiCookies || {});
                    if (result.success) {
                        fullAcc.cookie = result.newCookie;
                        persist();
                        refreshed++;
                        console.log(`[Keepalive] ✅ Refreshed serviceToken for ${userId} (${fullAcc.email})`);
                    } else {
                        failed++;
                        console.log(`[Keepalive] ❌ Failed to refresh ${userId}: ${result.error}`);
                    }
                }
            } catch (e) {
                console.error(`[Keepalive] Error checking ${userId}:`, e.message);
                failed++;
            }
        }

        console.log(`[Keepalive] Done. Refreshed: ${refreshed}, Failed: ${failed}, Skipped: ${skipped}`);
    };

    // 首次检查延迟 30 秒（等服务完全启动）
    setTimeout(check, 30 * 1000);

    // 定期检查
    setInterval(check, KEEPALIVE_INTERVAL);
    console.log(`[Keepalive] Started. Interval: ${KEEPALIVE_INTERVAL / 1000 / 60} minutes`);
}
