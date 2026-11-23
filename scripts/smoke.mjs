/**
 * 离线自测：用一个假的 cordis 根上下文跑一遍服务端半侧。
 * 用法：node scripts/smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-widget-'))
process.env.DSH_HOME = sandbox

const mod = await import('../lib/index.js')
const plugin = mod.default

const routes = new Map()
const rows = []
const taps = []

function fakeReq(method, headers, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = Object.assign({ host: '127.0.0.1:60220', 'sec-fetch-site': 'same-origin' }, headers)
  req.url = '/'
  if (body) process.nextTick(() => { req.emit('data', body); req.emit('end') })
  else process.nextTick(() => req.emit('end'))
  return req
}
function fakeRes() {
  const res = {
    status: 0, headers: {}, body: null, chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this },
    write(chunk) { this.chunks.push(chunk) },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); this.body = Buffer.concat(this.chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))) },
    on() {}, once() {}, emit() {}, pipe() {},
  }
  return res
}
const root = {
  on(event, cb) {
    if (event === 'webserver/index-inject') { cb(rows) }
    return () => {}
  },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject(deps, cb) {
    cb({
      webServer: {
        registerRoute(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
        tapIndex(fn) { taps.push(fn); return () => {} },
      },
    })
  },
}

plugin.apply(root)
const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1 }
const ok = (msg) => console.log('ok  ' + msg)

if (rows.length !== 1 || !String(rows[0].text).includes('/dsh-sidebar/widget.js')) fail('index-inject row: ' + JSON.stringify(rows))
else ok('桌面端 index-inject 行已登记')
if (!taps.length || !String(taps[0]('<html><body></body></html>')).includes('/dsh-sidebar/widget.js')) fail('tapIndex')
else ok('web 端 tapIndex 注入正常')
for (const p of ['/dsh-sidebar/widget.js', '/dsh-sidebar/config.json', '/dsh-sidebar/avatar']) {
  if (!routes.has(p)) fail('missing route ' + p)
}
if (!process.exitCode) ok('三条路由已注册')

const call = async (p, method, body, headers) => {
  const res = fakeRes()
  await routes.get(p)(fakeReq(method, headers, body), res)
  await new Promise((r) => setTimeout(r, 30))
  return res
}

let res = await call('/dsh-sidebar/widget.js', 'GET')
if (res.status !== 200 || !res.body.toString('utf8').includes('__dshSidebarWidget')) fail('widget.js')
else ok('widget.js 正常返回 (' + res.body.length + ' bytes)')

res = await call('/dsh-sidebar/config.json', 'GET')
if (res.status !== 200 || !JSON.parse(res.body.toString('utf8')).ok) fail('config get')
else ok('config.json 读取正常')

res = await call('/dsh-sidebar/config.json', 'POST', Buffer.from(JSON.stringify({ balance: '¥42.00', status: '写代码中…' })))
const cfg = JSON.parse(res.body.toString('utf8'))
if (!cfg.ok || cfg.config.balance !== '¥42.00') fail('config post: ' + res.body.toString('utf8'))
else ok('config.json 写入正常')

res = await call('/dsh-sidebar/avatar', 'GET')
if (res.status !== 200 || res.headers['Content-Type'] !== 'image/png') fail('avatar default: ' + res.status)
else ok('默认头像可读')

const png = fs.readFileSync(new URL('../assets/default-avatar.png', import.meta.url))
res = await call('/dsh-sidebar/avatar', 'POST', png, { 'content-type': 'image/png' })
const up = JSON.parse(res.body.toString('utf8'))
if (!up.ok || up.ext !== 'png') fail('avatar upload: ' + res.body.toString('utf8'))
else ok('头像上传成功 (' + up.bytes + ' bytes)')

res = await call('/dsh-sidebar/avatar', 'GET')
if (res.status !== 200) fail('avatar after upload')
else ok('上传后头像可读')

res = await call('/dsh-sidebar/avatar', 'POST', Buffer.from('not an image at all, definitely'))
if (res.status !== 400) fail('junk upload should be 400, got ' + res.status)
else ok('非图片上传被拒')

res = await call('/dsh-sidebar/avatar', 'GET', null, { host: 'evil.example.com' })
if (res.status !== 403) fail('foreign host should be 403, got ' + res.status)
else ok('非回环 Host 被拒')

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED')
