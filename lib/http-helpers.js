/**
 * HTTP 工具函数：CORS、JSON 响应、请求体读取
 */

function corsHeaders(req) {
    const origin = req?.headers?.origin || '*';
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, api-key, Cookie, X-Mimo-Cookie',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '86400',
    };
}

function json(res, code, data, req) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        ...corsHeaders(req),
    });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => resolve(body));
    });
}

module.exports = { corsHeaders, json, readBody };
