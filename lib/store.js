/**
 * 账号数据持久化存储 + CRUD 操作
 */

const fs = require('fs');
const { DATA_FILE } = require('./config');

let accounts = {};
let settings = {};

try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    // 兼容旧格式：如果 data 包含 _settings 则提取，否则整个对象是 accounts
    if (data._settings) {
        settings = { ...settings, ...data._settings };
        accounts = data.accounts || {};
    } else {
        accounts = data;
    }
    console.log(`[Init] Loaded ${Object.keys(accounts).length} account(s)`);
} catch (_) {}

function persist() {
    const data = { accounts, _settings: settings };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getSettings() {
    return settings;
}

function updateSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    persist();
    return settings;
}

function getAccounts() {
    return accounts;
}

function getAccount(userId) {
    return accounts[userId];
}

function setAccount(userId, data) {
    accounts[userId] = data;
}

function deleteAccount(id) {
    // Try by userId (key)
    if (accounts[id]) {
        delete accounts[id];
        return true;
    }
    // Try by email or userId field
    const found = Object.entries(accounts).find(([, v]) => v.email === id || v.userId === id);
    if (found) {
        delete accounts[found[0]];
        return true;
    }
    return false;
}

function findAccountByEmail(email) {
    const found = Object.entries(accounts).find(([, v]) => v.email === email);
    return found ? { uid: found[0], account: found[1] } : null;
}

function uniqueAccounts() {
    const seen = new Set();
    return Object.values(accounts).filter(a => {
        if (!a.userId || seen.has(a.userId)) return false;
        seen.add(a.userId);
        return true;
    });
}

module.exports = { getAccounts, getAccount, setAccount, deleteAccount, findAccountByEmail, uniqueAccounts, persist, getSettings, updateSettings };
