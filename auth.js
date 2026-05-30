/**
 * Playwright-based MiMo Authentication
 * 打开独立浏览器窗口让用户登录 → 自动拦截 Cookie → 获取全部数据
 */

const { chromium } = require('playwright-core');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIMO_BASE = 'https://platform.xiaomimimo.com';
const LOGIN_URL = MIMO_BASE + '/console/plan-manage';

/**
 * 跨平台查找 Chrome / Chromium 可执行文件路径
 */
function findChromePath() {
    const platform = os.platform();

    if (platform === 'win32') {
        const candidates = [
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
            process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        for (const p of candidates) {
            if (p && fs.existsSync(p)) return p;
        }
    } else if (platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    } else {
        const candidates = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
    }

    return null;
}

/**
 * 获取与当前平台匹配的 User-Agent
 */
function getPlatformUserAgent() {
    const platform = os.platform();
    if (platform === 'win32') {
        return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    } else if (platform === 'darwin') {
        return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    }
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}

/**
 * 查找 Chrome 用户数据目录（用于存放 MimoAuth 独立 Profile）
 */
function findChromeUserDataDir() {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
    } else if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    } else {
        return path.join(home, '.config', 'google-chrome');
    }
}

// 浏览器实例管理
let browserInstance = null;
let currentTempDir = null; // 当前临时目录，用于清理
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
 * 使用独立的 MimoAuth Profile，每次都需要手动登录
 */
async function startAuth() {
    if (browserInstance) {
        return { success: false, error: '浏览器已打开，请先完成或关闭当前登录' };
    }

    updateState({ status: 'launching', message: '正在启动浏览器...', progress: 10 });

    try {
        const chromePath = findChromePath();
        if (!chromePath) {
            const platform = os.platform();
            const hint = platform === 'win32'
                ? '请安装 Google Chrome 或 Microsoft Edge'
                : platform === 'darwin'
                    ? '请安装 Google Chrome'
                    : '请安装 Google Chrome: sudo apt install google-chrome-stable';
            throw new Error(`未找到浏览器可执行文件。${hint}`);
        }
        console.log(`[Auth] Using browser at: ${chromePath}`);

        // 每次使用临时目录，确保全新登录状态
        const tempDir = path.join(os.tmpdir(), 'mimo-auth-' + crypto.randomBytes(8).toString('hex'));
        fs.mkdirSync(tempDir, { recursive: true });
        currentTempDir = tempDir; // 保存用于后续清理
        console.log(`[Auth] Using temp profile: ${tempDir}`);

        // 启动独立 Profile 的浏览器（临时目录，无历史状态）
        updateState({ message: '正在启动浏览器窗口...', progress: 15 });
        const context = await chromium.launchPersistentContext(
            tempDir,
            {
                executablePath: chromePath,
                headless: false,
                args: [
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-blink-features=AutomationControlled',
                ],
                userAgent: getPlatformUserAgent(),
                viewport: { width: 1280, height: 800 },
            }
        );
        browserInstance = context.browser();

        const page = context.pages()[0] || await context.newPage();

        // 拦截 MiMo API 请求，捕获 Cookie
        let capturedCookie = null;
        let capturedData = {};

        // 通过 context.cookies() 获取完整的 cookies（包括 httpOnly）
        let capturedCookieExpires = null;
        async function captureCookiesFromContext() {
            try {
                const cookies = await context.cookies('https://platform.xiaomimimo.com');
                if (cookies && cookies.length > 0) {
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    if (cookieStr.includes('api-platform_serviceToken')) {
                        capturedCookie = cookieStr;
                        const expires = cookies.filter(c => c.expires > 0).map(c => c.expires);
                        if (expires.length > 0) {
                            capturedCookieExpires = new Date(Math.min(...expires) * 1000).toISOString();
                        }
                        console.log('[Auth] ✅ Captured cookies:', cookies.length, 'cookies');
                        return true;
                    }
                }
            } catch (e) {
                console.error('[Auth] Error capturing cookies:', e.message);
            }
            return false;
        }

        // 每次 MiMo API 请求都尝试捕获 Cookie
        page.on('request', async (req) => {
            const reqUrl = req.url();
            if (reqUrl.includes('platform.xiaomimimo.com/api/v1/')) {
                await captureCookiesFromContext();
                if (!capturedCookie) {
                    const cookie = req.headers()['cookie'];
                    if (cookie && cookie.includes('api-platform_serviceToken')) {
                        capturedCookie = cookie;
                        console.log('[Auth] ✅ Captured cookie from request header!');
                    }
                }
            }
        });

        // 拦截 API 响应，捕获数据
        const SAFE_JSON_TIMEOUT = 5000;
        function safeJson(resp) {
            return Promise.race([
                resp.json(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('json timeout')), SAFE_JSON_TIMEOUT)),
            ]);
        }
        page.on('response', async (resp) => {
            const reqUrl = resp.url();
            try {
                if (reqUrl.includes('/api/v1/userProfile')) {
                    const body = await safeJson(resp);
                    if (body?.data) {
                        capturedData.profile = body.data;
                        updateState({ message: `已获取用户: ${body.data.email || body.data.userId}`, progress: 40 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/detail')) {
                    const body = await safeJson(resp);
                    if (body?.data) {
                        capturedData.detail = body.data;
                        updateState({ message: `已获取套餐: ${body.data.planName}`, progress: 50 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/usage')) {
                    const body = await safeJson(resp);
                    if (body?.data) {
                        capturedData.usage = body.data;
                        updateState({ message: '已获取用量数据', progress: 60 });
                    }
                }
                if (reqUrl.includes('/api/v1/balance')) {
                    const body = await safeJson(resp);
                    if (body?.data) {
                        capturedData.balance = body.data;
                        updateState({ message: '已获取余额', progress: 65 });
                    }
                }
                if (reqUrl.includes('/api/v1/tokenPlan/apiKey')) {
                    const body = await safeJson(resp);
                    if (body?.data) {
                        capturedData.apiKey = body.data;
                    }
                }
            } catch (_) { /* ignore parse/timeout errors */ }
        });

        updateState({ status: 'navigating', message: '正在打开 MiMo 登录页面...', progress: 20 });

        // 导航到 MiMo 控制台
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

        updateState({
            status: 'waiting_login',
            message: '请在弹出的浏览器窗口中登录小米账号...',
            progress: 30,
        });

        // 等待登录成功：检测 URL 包含 plan-manage 且有 API 数据
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('登录超时（5分钟），请重试'));
            }, 5 * 60 * 1000);

            let lastUrl = '';
            const checkInterval = setInterval(async () => {
                try {
                    const currentUrl = page.url();

                    if (browserInstance === null) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        reject(new Error('浏览器已关闭'));
                        return;
                    }

                    if (currentUrl !== lastUrl) {
                        lastUrl = currentUrl;
                        if (currentUrl.includes('accounts.google.com')) {
                            updateState({ message: '请在 Google 登录页面完成登录...', progress: 35 });
                        } else if (currentUrl.includes('xiaomi.com') && !currentUrl.includes('plan-manage')) {
                            updateState({ message: '正在处理小米账号登录...', progress: 38 });
                        }
                        console.log('[Auth] URL:', currentUrl);
                    }

                    if (currentUrl.includes('plan-manage') && capturedData.profile) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve();
                    }
                } catch (_) {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    reject(new Error('浏览器已关闭'));
                }
            }, 1000);
        });

        updateState({ status: 'fetching', message: '登录成功！正在获取所有数据...', progress: 70 });

        // 确保捕获 cookies
        if (!capturedCookie) {
            console.log('[Auth] 登录成功但尚未捕获 cookie，尝试从 context 获取...');
            await captureCookiesFromContext();
            if (!capturedCookie) {
                await new Promise(r => setTimeout(r, 1000));
                await captureCookiesFromContext();
            }
        }
        console.log('[Auth] Cookie captured:', !!capturedCookie, '| Data:', Object.keys(capturedData).join(', '));

        // 主动获取缺失数据
        const missingEndpoints = [];
        if (!capturedData.detail) missingEndpoints.push({ key: 'detail', path: '/api/v1/tokenPlan/detail' });
        if (!capturedData.usage) missingEndpoints.push({ key: 'usage', path: '/api/v1/tokenPlan/usage' });
        if (!capturedData.balance) missingEndpoints.push({ key: 'balance', path: '/api/v1/balance' });
        if (!capturedData.apiKey) missingEndpoints.push({ key: 'apiKey', path: '/api/v1/tokenPlan/apiKey' });

        if (missingEndpoints.length > 0) {
            console.log('[Auth] 缺失数据，主动获取:', missingEndpoints.map(e => e.key).join(', '));
            for (const ep of missingEndpoints) {
                try {
                    const r = await page.evaluate(async (B, p) => {
                        const r = await fetch(B + p, { credentials: 'include' });
                        return await r.json();
                    }, MIMO_BASE, ep.path);
                    if (r?.data) {
                        capturedData[ep.key] = r.data;
                        console.log(`[Auth] ✅ 获取 ${ep.key} 成功`);
                    }
                } catch (e) {
                    console.log(`[Auth] ⚠️ 获取 ${ep.key} 失败:`, e.message);
                }
            }
        }

        updateState({ status: 'saving', message: '正在保存数据...', progress: 90 });

        // 组装账号数据
        const profile = capturedData.profile || {};
        const detail = capturedData.detail || {};
        const usage = capturedData.usage || {};
        const balance = capturedData.balance || {};
        const apiKey = capturedData.apiKey || {};

        const usageItems = usage?.usage?.items || [];
        const usageItem = usageItems.find(i => i.name === 'plan_total_token') || usageItems[0];
        const compItem = usageItems.find(i => i.name === 'compensation_total_token');

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
                compUsedTokens: compItem?.used || 0,
                compTotalTokens: compItem?.limit || 0,
                compPercent: compItem?.percent || 0,
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
    // 清理临时目录
    if (currentTempDir) {
        try {
            fs.rmSync(currentTempDir, { recursive: true, force: true });
            console.log(`[Auth] Cleaned temp profile: ${currentTempDir}`);
        } catch (e) {
            console.error(`[Auth] Failed to clean temp dir: ${e.message}`);
        }
        currentTempDir = null;
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
