/**
 * MiMo Token Plan Proxy Server
 * 入口文件 — 启动 HTTP 服务，所有路由由 lib/routes.js 处理
 * 用法: node server.js
 */

const http = require('http');
const { PORT } = require('./lib/config');
const { handleRequest } = require('./lib/routes');
const { startAutoRefresh, getAutoRefreshStatus } = require('./lib/auto-refresh');

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
══════════════════════════════════════════════════════`);

    // 启动自动刷新定时器
    startAutoRefresh();
    const status = getAutoRefreshStatus();
    if (status.enabled) {
        console.log(`[AutoRefresh] ✅ 已启用，间隔: ${status.intervalHours}小时`);
        console.log(`[AutoRefresh]    下次刷新: ${status.nextRefresh || '等待计算...'}`);
    } else {
        console.log(`[AutoRefresh] ⏸️  已禁用`);
    }
});
