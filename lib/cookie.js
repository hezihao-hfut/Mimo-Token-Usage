/**
 * Cookie 解析、组装、构建 MiMo API 所需 Cookie 字符串
 */

// Parse "a=1; b=2; c=3" into { a: "1", b: "2", c: "3" }
function parseCookie(str) {
    const result = {};
    if (!str) return result;
    const parts = str.split(/;\s*/);
    for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const key = part.substring(0, eqIdx).trim();
        let val = part.substring(eqIdx + 1).trim();
        result[key] = val;
    }
    return result;
}

// Assemble { key: "value" } back into "key=value; key2=value2"
function assembleCookie(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Build the full cookie string for MiMo API from an account's stored data
function buildMiMoCookie(acc) {
    const parsed = parseCookie(acc.cookie || '');
    const parts = [];
    if (parsed['api-platform_serviceToken']) parts.push(`api-platform_serviceToken=${parsed['api-platform_serviceToken']}`);
    if (parsed['userId']) parts.push(`userId=${parsed['userId']}`);
    if (parsed['api-platform_slh']) parts.push(`api-platform_slh=${parsed['api-platform_slh']}`);
    if (parsed['api-platform_ph']) parts.push(`api-platform_ph=${parsed['api-platform_ph']}`);
    if (parts.length === 0 && acc.cookie) return acc.cookie;
    return parts.join('; ');
}

module.exports = { parseCookie, assembleCookie, buildMiMoCookie };
