/**
 * Cookie 自动续期模块
 * 利用小米账号 passToken（30天有效期）自动获取新的 serviceToken
 *
 * 原理：手动跟踪重定向链
 *   genLoginUrl (302) → account.xiaomi.com (302) → /sts (307) → 原始页面
 *   passToken 在 account.xiaomi.com 域名下自动完成认证
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { MIMO_BASE } = require('./config');

const MAX_REDIRECTS = 10;

/**
 * 跟踪单个 HTTP(S) 请求，手动处理重定向
 * @param {string} url - 请求 URL
 * @param {string} cookie - 当前域名的 cookie 字符串
 * @param {string} method - HTTP 方法
 * @param {number} redirectCount - 已跟随的重定向次数
 * @returns {Promise<{status, headers, body, setCookies, finalUrl}>}
 */
function followRedirects(url, cookie, method = 'GET', redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) {
            return reject(new Error(`Too many redirects (${MAX_REDIRECTS})`));
        }

        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;

        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
        };

        if (cookie) {
            opts.headers['Cookie'] = cookie;
        }

        const req = transport.request(opts, (res) => {
            // 收集 Set-Cookie 响应头（可能有多个）
            const setCookies = res.headers['set-cookie'] || [];
            const status = res.statusCode;
            const location = res.headers['location'];

            // 3xx 重定向
            if (status >= 300 && status < 400 && location) {
                // 消费掉响应体（避免内存泄漏）
                res.resume();

                // 解析重定向 URL（可能是相对路径）
                let nextUrl;
                try {
                    nextUrl = new URL(location, url).href;
                } catch (e) {
                    return reject(new Error(`Invalid redirect URL: ${location}`));
                }

                // 重定向后不携带 cookie（除非是同域或子域）
                // 但我们需要跨域携带 passToken 到 account.xiaomi.com
                // 所以根据目标域名决定携带哪些 cookie
                resolve({
                    status,
                    headers: res.headers,
                    body: null,
                    setCookies,
                    redirect: true,
                    location: nextUrl,
                });
                return;
            }

            // 非重定向，读取响应体
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                resolve({
                    status,
                    headers: res.headers,
                    body,
                    setCookies,
                    redirect: false,
                    finalUrl: url,
                });
            });
        });

        req.on('error', reject);
        req.end();
    });
}

/**
 * 从 Set-Cookie 数组中提取指定 cookie 的值
 * @param {string[]} setCookies - Set-Cookie 响应头数组
 * @param {string} name - cookie 名称
 * @returns {string|null}
 */
function extractCookieValue(setCookies, name) {
    for (const sc of setCookies) {
        // Set-Cookie 格式: name=value; Path=/; Domain=...; ...
        const match = sc.match(new RegExp(`^${name}=([^;]+)`));
        if (match) return match[1];
    }
    return null;
}

/**
 * 从 Set-Cookie 数组中提取所有 MiMo 相关的 cookie
 * @param {string[]} setCookies - Set-Cookie 响应头数组
 * @returns {{serviceToken: string|null, slh: string|null, ph: string|null, userId: string|null}}
 */
function extractMiMoCookies(setCookies) {
    const result = {
        serviceToken: null,
        slh: null,
        ph: null,
        userId: null,
    };
    for (const sc of setCookies) {
        const nameMatch = sc.match(/^([^=]+)=/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const value = nameMatch[1] + '=' + sc.substring(nameMatch[0].length).split(';')[0];
        const val = value.substring(name.length + 1);

        if (name === 'api-platform_serviceToken') result.serviceToken = val;
        else if (name === 'api-platform_slh') result.slh = val;
        else if (name === 'api-platform_ph') result.ph = val;
        else if (name === 'userId') result.userId = val;
    }
    return result;
}

/**
 * 用 passToken 自动刷新 serviceToken
 *
 * @param {string} passToken - 小米账号的 passToken（httpOnly cookie，30天有效）
 * @param {Object} [extraCookies] - 额外的小米账号 cookie {cUserId, deviceId, ...}
 * @returns {Promise<{success: boolean, newCookie?: string, error?: string}>}
 */
async function refreshServiceToken(passToken, extraCookies = {}) {
    if (!passToken) {
        return { success: false, error: 'No passToken provided' };
    }

    try {
        // Step 1: 访问 MiMo API 获取 loginUrl（从 401 响应中）
        // 或者直接构造 genLoginUrl
        const genLoginUrl = `https://${MIMO_BASE}/api/v1/genLoginUrl?currentPath=/console/plan-manage`;

        console.log('[CookieRefresher] Step 1: Requesting genLoginUrl...');
        const step1 = await followRedirects(genLoginUrl, '');

        if (step1.status !== 302 || !step1.location) {
            console.error('[CookieRefresher] genLoginUrl did not redirect:', step1.status);
            return { success: false, error: `genLoginUrl returned ${step1.status}` };
        }

        const accountUrl = step1.location;
        console.log('[CookieRefresher] Step 2: Following redirect to account.xiaomi.com...');

        // Step 2: 访问 account.xiaomi.com，携带 passToken
        // 构造 account.xiaomi.com 的 cookie
        let accountCookie = `passToken=${passToken}`;
        if (extraCookies.cUserId) accountCookie += `; cUserId=${extraCookies.cUserId}`;
        if (extraCookies.deviceId) accountCookie += `; deviceId=${extraCookies.deviceId}`;
        if (extraCookies.userId) accountCookie += `; userId=${extraCookies.userId}`;

        const step2 = await followRedirects(accountUrl, accountCookie);

        // account.xiaomi.com 验证 passToken 后会 302 到 /sts
        if (step2.status >= 300 && step2.status < 400 && step2.location) {
            const stsUrl = step2.location;
            console.log('[CookieRefresher] Step 3: Following redirect to /sts...');

            // Step 3: 访问 /sts 端点，这里会设置新的 MiMo cookie
            // 不携带任何 MiMo cookie（因为要获取新的）
            const step3 = await followRedirects(stsUrl, '');

            // 收集 /sts 设置的 cookie
            const newCookies = extractMiMoCookies(step3.setCookies);

            if (newCookies.serviceToken) {
                console.log('[CookieRefresher] ✅ New serviceToken obtained!');

                // 组装新的 cookie 字符串
                const parts = [];
                if (newCookies.serviceToken) parts.push(`api-platform_serviceToken=${newCookies.serviceToken}`);
                if (newCookies.userId) parts.push(`userId=${newCookies.userId}`);
                if (newCookies.slh) parts.push(`api-platform_slh=${newCookies.slh}`);
                if (newCookies.ph) parts.push(`api-platform_ph=${newCookies.ph}`);

                const newCookieStr = parts.join('; ');

                // 跟踪后续重定向（如果有），收集更多 cookie
                if (step3.redirect && step3.location) {
                    let current = step3;
                    while (current.redirect && current.location) {
                        const moreCookies = extractMiMoCookies(current.setCookies);
                        if (moreCookies.serviceToken && !newCookies.serviceToken) {
                            newCookies.serviceToken = moreCookies.serviceToken;
                        }
                        if (moreCookies.userId && !newCookies.userId) {
                            newCookies.userId = moreCookies.userId;
                        }
                        if (moreCookies.slh && !newCookies.slh) {
                            newCookies.slh = moreCookies.slh;
                        }
                        if (moreCookies.ph && !newCookies.ph) {
                            newCookies.ph = moreCookies.ph;
                        }
                        try {
                            current = await followRedirects(current.location, newCookieStr);
                        } catch (e) {
                            break;
                        }
                    }
                }

                return {
                    success: true,
                    newCookie: newCookieStr,
                    details: newCookies,
                };
            }

            // /sts 没有设置 serviceToken，可能 passToken 已过期
            console.error('[CookieRefresher] /sts did not set serviceToken. Status:', step3.status);
            if (step3.status >= 300 && step3.status < 400 && step3.location) {
                console.error('[CookieRefresher] Redirected to:', step3.location);
                // 如果被重定向到登录页面，说明 passToken 过期
                if (step3.location.includes('account.xiaomi.com') || step3.location.includes('serviceLogin')) {
                    return { success: false, error: 'passToken expired, redirected to login page' };
                }
            }
            return { success: false, error: 'STS did not issue new serviceToken' };
        }

        // account.xiaomi.com 没有重定向，可能显示登录页面（passToken 过期）
        if (step2.status === 200) {
            console.error('[CookieRefresher] account.xiaomi.com returned 200 (login page?). passToken may be expired.');
            return { success: false, error: 'passToken expired (login page returned)' };
        }

        return { success: false, error: `Unexpected response from account.xiaomi.com: ${step2.status}` };

    } catch (e) {
        console.error('[CookieRefresher] Error:', e.message);
        return { success: false, error: e.message };
    }
}

module.exports = { refreshServiceToken, extractMiMoCookies, extractCookieValue };
