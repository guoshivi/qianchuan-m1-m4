'use strict';
// 比特浏览器 localAPI 客户端（阶段1+2 共用，零依赖，Node>=22 原生 fetch）
// API 基址: http://127.0.0.1:54345 (config.json: {"localServerAddress":"...","enableAuth":false})
const BASE = process.env.BIT_API || 'http://127.0.0.1:54345';

async function call(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${path}`);
  const json = await res.json();
  if (json.success !== true) throw new Error(`${path} fail: ${json.msg || JSON.stringify(json)}`);
  return json.data;
}

// 环境列表
async function list(page = 0, pageSize = 100) {
  const d = await call('/browser/list', { page, pageSize });
  return d.list || [];
}

// 开启环境 → 返回 { ws, http, pid, name, ... } (http=CDP debug 端口)
async function open(id) {
  return call('/browser/open', { id });
}

// 关闭环境
async function close(id) {
  return call('/browser/close', { id });
}

// 详情（含完整 browserFingerPrint）
async function detail(id) {
  return call('/browser/detail', { id });
}

// upsert 建档/改配置。要点（踩坑已验证）:
//  - host/port 必须传顶层字段(open 读顶层)，user_proxy_config 单独传不生效
//  - proxyMethod: 1=自定义代理 2=复用上次; proxyType: 'http'|'socks5'...
//  - browserFingerPrint 传 {name} 即可，其余自动生成唯一指纹
async function update(browser) {
  const body = { ...browser };
  if (body.browserFingerPrint) body.browserFingerPrint = { name: body.name || '', ...body.browserFingerPrint };
  return call('/browser/update', body);
}

async function deleteProfile(id) {
  return call('/browser/delete', { id });
}

module.exports = { BASE, call, list, open, close, detail, update, deleteProfile };