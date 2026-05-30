/**
 * 静态文件服务
 */

const fs = require('fs');
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

function serveStatic(res, pathname) {
    const fp = path.join(__dirname, '..', pathname === '/' ? '/index.html' : pathname);
    fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
    });
}

module.exports = { serveStatic };
