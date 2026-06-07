const path = require('path');

module.exports = {
    PORT: 3456,
    MIMO_BASE: 'platform.xiaomimimo.com',
    DATA_FILE: path.join(__dirname, '..', 'accounts.json'),
    // Cookie 自动保活检查间隔（默认 6 小时）
    KEEPALIVE_INTERVAL: 6 * 60 * 60 * 1000,
    // passToken 即将过期提醒阈值（默认 3 天）
    PASS_TOKEN_WARN_DAYS: 3,
};
