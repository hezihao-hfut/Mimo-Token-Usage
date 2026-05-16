/**
 * Playwright-based MiMo Authentication
 * 打开浏览器让用户登录 → 自动拦截 Cookie → 获取全部数据
 */

const { chromium } = require('playwright-core');

const MIMO_BASE = 'https://platform.xiaomimimo.com';
const LOGIN_URL = MIMO_BASE + '/console/plan-manage';

// 浏览器实例管理
let browserInstance = null;
let authState = { status: 'idle', message: '', progress: 0 };

// SSE 客户端列表
const sseClients = new Set();

function broadcastSSE(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (_) { sseClients.delete(client); }
    }
}

function updateState(state) {
    authState = { ...authState, ...state };
    broadcastSSE(authState);
}

/**
 * 启动浏览器进行认证
 */
async function startAuth() {
    if (browserInstance) {
        return { success: false, error: '浏览器已打开，请先完成或关闭当前登录' };
    }

    updateState({ status: 'launching', message: '正在启动浏览器...', progress: 10 });

    try {
        browserInstance = await chromium.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: false,        // 必须显示浏览器让用户登录
            args: [
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-blink-features=AutomationControlled',
            ],
        });

        const context = await browserInstance.newContext({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });

        const page = await context.newPage();

        // 拦截 MiMo API 请求，捕获 Cookie
        let capturedCookie = null;
        let capturedData = {};

        // 通过 context.cookies() 获取完整的 cookies（包括 httpOnly）
        let capturedCookieExpires = null; // cookie 过期时间
        async function captureCookiesFromContext() {
            try {
                const cookies = await context.cookies('https://platform.xiaomimimo.com');
                if (cookies && cookies.length > 0) {
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    if (cookieStr.includes('api-platform_serviceToken')) {
                        capturedCookie = cookieStr;
                        // 获取最早的过期时间
                        const expires = cookies
                            .filter(c => c.expires > 0)
                            .map(c => c.expires);
                        if (expires.length > 0) {
                            capturedCookieExpires = new Date(Math.min(...expires) * 1000).toISOString();
                        }
                        console.log('[Auth] ✅ Captured cookies from context:', cookies.length, 'cookies');
                        return true;
                    }
                }
            } catch (e) {
                console.error('[Auth] Error capturing cookies:', e.message);
            }
            return false;
        }

        // 也通过请求头尝试捕获（作为备份）
        page.on('request', async (req) => {
            const reqUrl = req.url();
            if (reqUrl.includes('/api/v1/') && !capturedCookie) {
                // 优先从 context 获取
                const captured = await captureCookiesFromContext();
                if (!captured) {
                    // 备用：从请求头获取
                    const cookie = req.headers()['cookie'];
                    if (cookie && cookie.includes('api-platform_serviceToken')) {
                        capturedCookie = cookie;
                        console.log('[Auth] ✅ Captured cookie from request header!');
                    }
                }
            }
        });

        // 拦截 API 响应，捕获数据
        page.on('response', async (resp) => {
            const reqUrl = resp.url();
            try {
                if (reqUrl.includes('/api/v1/userProfile')) {
                    const body = await resp.json();
                    if (body?.data) {
                        capturedData.profile = body.data;
                        updateState({ message: `已获取用户: ${body.data.email || body.data.userId}`, progress: 40 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/detail')) {
                    const body = await resp.json();
                    if (body?.data) {
                        capturedData.detail = body.data;
                        updateState({ message: `已获取套餐: ${body.data.planName}`, progress: 50 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/usage')) {
                    const body = await resp.json();
                    if (body?.data) {
                        capturedData.usage = body.data;
                        updateState({ message: '已获取用量数据', progress: 60 });
                    }
                }
                if (reqUrl.includes('/api/v1/balance')) {
                    const body = await resp.json();
                    if (body?.data) {
                        capturedData.balance = body.data;
                        updateState({ message: '已获取余额', progress: 65 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/apiKey')) {
                    const body = await resp.json();
                    if (body?.data) {
                        capturedData.apiKey = body.data;
                    }
                }
            } catch (_) { /* ignore parse errors */ }
        });

        updateState({ status: 'navigating', message: '正在打开 MiMo 登录页面...', progress: 20 });

        // 导航到 MiMo 控制台
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        updateState({
            status: 'waiting_login',
            message: '请在弹出的浏览器窗口中登录小米账号...',
            progress: 30,
        });

        // 等待登录成功：检测 URL 变化或 API 数据获取
        // 最长等待 5 分钟
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('登录超时（5分钟），请重试'));
            }, 5 * 60 * 1000);

            const checkInterval = setInterval(async () => {
                try {
                    const currentUrl = page.url();
                    // 登录成功的标志：URL 包含 plan-manage 且有 API 数据
                    if (currentUrl.includes('plan-manage') && capturedData.profile) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve();
                    }
                    // 检查浏览器是否被关闭
                    if (browserInstance === null) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        reject(new Error('浏览器已关闭'));
                    }
                } catch (_) {
                    // Page might be closed
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    reject(new Error('浏览器已关闭'));
                }
            }, 1000);
        });

        updateState({ status: 'fetching', message: '登录成功！正在获取所有数据...', progress: 70 });

        // 登录成功后，确保捕获 cookies
        if (!capturedCookie) {
            console.log('[Auth] 登录成功但尚未捕获 cookie，尝试从 context 获取...');
            await captureCookiesFromContext();
        }

        // 如果某些数据还没拿到，主动请求
        if (!capturedData.detail || !capturedData.usage) {
            const cookie = capturedCookie;
            if (cookie) {
                if (!capturedData.detail) {
                    try {
                        const r = await page.evaluate(async (B) => {
                            const r = await fetch(B + '/api/v1/tokenPlan/detail', { credentials: 'include' });
                            return await r.json();
                        }, MIMO_BASE);
                        if (r?.data) capturedData.detail = r.data;
                    } catch (_) {}
                }
                if (!capturedData.usage) {
                    try {
                        const r = await page.evaluate(async (B) => {
                            const r = await fetch(B + '/api/v1/tokenPlan/usage', { credentials: 'include' });
                            return await r.json();
                        }, MIMO_BASE);
                        if (r?.data) capturedData.usage = r.data;
                    } catch (_) {}
                }
                if (!capturedData.balance) {
                    try {
                        const r = await page.evaluate(async (B) => {
                            const r = await fetch(B + '/api/v1/balance', { credentials: 'include' });
                            return await r.json();
                        }, MIMO_BASE);
                        if (r?.data) capturedData.balance = r.data;
                    } catch (_) {}
                }
                if (!capturedData.apiKey) {
                    try {
                        const r = await page.evaluate(async (B) => {
                            const r = await fetch(B + '/api/v1/tokenPlan/apiKey', { credentials: 'include' });
                            return await r.json();
                        }, MIMO_BASE);
                        if (r?.data) capturedData.apiKey = r.data;
                    } catch (_) {}
                }
            }
        }

        updateState({ status: 'saving', message: '正在保存数据...', progress: 90 });

        // 组装并保存账号数据
        const profile = capturedData.profile || {};
        const detail = capturedData.detail || {};
        const usage = capturedData.usage || {};
        const balance = capturedData.balance || {};
        const apiKey = capturedData.apiKey || {};

        const usageItem = usage?.usage?.items?.find(i => i.name === 'plan_total_token')
            || usage?.usage?.items?.[0];

        const uid = profile.userId || 'unknown_' + Date.now();
        const accountData = {
            userId: uid,
            email: profile.email || '',
            cookie: capturedCookie || '',
            cookieExpires: capturedCookieExpires,
            data: {
                planName: detail.planName || '-',
                planCode: detail.planCode || '-',
                periodEnd: detail.currentPeriodEnd || null,
                expired: detail.expired || false,
                autoRenew: detail.enableAutoRenew || false,
                usedTokens: usageItem?.used || 0,
                totalTokens: usageItem?.limit || 0,
                percent: usageItem?.percent || usage?.usage?.percent || 0,
                balance: balance || null,
                userId: uid,
                email: profile.email,
            },
            apiKey: apiKey.redactedApiKey || '',
            openaiBaseUrl: apiKey.openaiBaseUrl || '',
            lastPushed: new Date().toISOString(),
            lastRefreshed: new Date().toISOString(),
        };

        // 关闭浏览器
        await closeBrowser();

        updateState({ status: 'done', message: '✅ 登录成功！', progress: 100, account: accountData });

        return { success: true, account: accountData };

    } catch (e) {
        console.error('[Auth] Error:', e.message);
        await closeBrowser();
        updateState({ status: 'error', message: '❌ ' + e.message, progress: 0 });
        return { success: false, error: e.message };
    }
}

async function closeBrowser() {
    if (browserInstance) {
        try {
            await browserInstance.close();
        } catch (_) {}
        browserInstance = null;
    }
}

function getAuthState() {
    return authState;
}

function addSSEClient(res) {
    sseClients.add(res);
}

function removeSSEClient(res) {
    sseClients.delete(res);
}

module.exports = { startAuth, closeBrowser, getAuthState, addSSEClient, removeSSEClient };
