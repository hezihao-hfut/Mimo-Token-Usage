/**
 * 自动刷新模块
 * 定期调用 API 保持 Cookie 会话活跃
 */

const { getSettings, uniqueAccounts } = require('./store');
const { refreshAccount } = require('./mimo-api');

let refreshTimer = null;
let lastRefreshTime = null;
let lastRefreshResult = null;
let nextRefreshTime = null;

/**
 * 执行一次刷新所有账号
 */
async function doRefreshAll() {
    const accounts = uniqueAccounts();
    if (accounts.length === 0) {
        console.log('[AutoRefresh] 没有账号需要刷新');
        return { success: 0, failed: 0, total: 0 };
    }

    console.log(`[AutoRefresh] 🔄 开始刷新 ${accounts.length} 个账号...`);
    let success = 0, failed = 0;

    for (const acc of accounts) {
        try {
            const result = await refreshAccount(acc.userId);
            if (result.success) {
                success++;
                console.log(`[AutoRefresh] ✅ ${acc.userId} (${acc.email || 'no email'})`);
            } else {
                failed++;
                console.log(`[AutoRefresh] ❌ ${acc.userId}: ${result.error}`);
            }
        } catch (e) {
            failed++;
            console.log(`[AutoRefresh] ❌ ${acc.userId}: ${e.message}`);
        }
        // 每个账号间隔 2 秒，避免请求过快
        if (accounts.indexOf(acc) < accounts.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    lastRefreshTime = new Date().toISOString();
    lastRefreshResult = { success, failed, total: accounts.length };
    console.log(`[AutoRefresh] ✨ 刷新完成: ${success} 成功, ${failed} 失败`);

    return lastRefreshResult;
}

/**
 * 计算下次刷新时间
 */
function calcNextRefreshTime() {
    const settings = getSettings();
    if (!settings.autoRefreshEnabled) {
        nextRefreshTime = null;
        return null;
    }
    const intervalMs = (settings.autoRefreshInterval || 4) * 60 * 60 * 1000;
    nextRefreshTime = new Date(Date.now() + intervalMs).toISOString();
    return nextRefreshTime;
}

/**
 * 启动自动刷新定时器
 */
function startAutoRefresh() {
    // 先停止现有的定时器
    stopAutoRefresh();

    const settings = getSettings();
    if (!settings.autoRefreshEnabled) {
        console.log('[AutoRefresh] 自动刷新已禁用');
        return;
    }

    const intervalHours = settings.autoRefreshInterval || 4;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // 启动定时器
    refreshTimer = setInterval(async () => {
        console.log(`[AutoRefresh] ⏰ 定时触发，开始刷新...`);
        await doRefreshAll();
        calcNextRefreshTime();
    }, intervalMs);

    calcNextRefreshTime();
    console.log(`[AutoRefresh] 定时器已启动，间隔: ${intervalHours}小时`);
}

/**
 * 停止自动刷新定时器
 */
function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
    nextRefreshTime = null;
}

/**
 * 更新自动刷新配置并重启定时器
 */
function updateAutoRefresh(config) {
    const { updateSettings } = require('./store');
    updateSettings({
        autoRefreshEnabled: config.enabled,
        autoRefreshInterval: config.intervalHours,
    });

    if (config.enabled) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }

    return getAutoRefreshStatus();
}

/**
 * 获取自动刷新状态
 */
function getAutoRefreshStatus() {
    const settings = getSettings();
    return {
        enabled: settings.autoRefreshEnabled !== false,
        intervalHours: settings.autoRefreshInterval || 4,
        lastRefreshTime,
        lastRefreshResult,
        nextRefreshTime,
    };
}

module.exports = {
    startAutoRefresh,
    stopAutoRefresh,
    updateAutoRefresh,
    getAutoRefreshStatus,
    doRefreshAll,
};
