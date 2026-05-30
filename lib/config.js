const path = require('path');

module.exports = {
    PORT: 3456,
    MIMO_BASE: 'platform.xiaomimimo.com',
    DATA_FILE: path.join(__dirname, '..', 'accounts.json'),
    AUTO_REFRESH_INTERVAL: 4 * 60 * 60 * 1000, // 默认 4 小时刷新一次
};
