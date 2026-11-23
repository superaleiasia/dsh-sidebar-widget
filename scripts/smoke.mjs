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
const listeners = new Map()

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
    if (event === 'webserver/index-inject') { cb(rows); return () => {} }
    listeners.set(event, cb)
    return () => listeners.delete(event)
  },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject(deps, cb) {
    cb({
      webServer: {
        register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
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
for (const p of ['/dsh-sidebar/widget.js', '/dsh-sidebar/config.json', '/dsh-sidebar/usage.json', '/dsh-sidebar/avatar']) {
  if (!routes.has(p)) fail('missing route ' + p)
}
if (!process.exitCode) ok('四条路由已注册')
if (typeof listeners.get('session/event') !== 'function') fail('session/event 未订阅')

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

res = await call('/dsh-sidebar/config.json', 'POST', Buffer.from(JSON.stringify({ status: '写代码中…', valueMode: 'usage', prices: { input: 2, cache: 0.5, output: 8 } })))
const cfg = JSON.parse(res.body.toString('utf8'))
if (!cfg.ok || cfg.config.status !== '写代码中…' || cfg.config.prices.output !== 8) fail('config post: ' + res.body.toString('utf8'))
else ok('config.json 写入正常（含单价归一化）')

// 用量：喂三条 assistant/message 事件，验证累加与计价
const emit = listeners.get('session/event')
const msg = (turn, input, cache, output) => ({ type: 'assistant/message', data: { turn, usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output }, message: { source: { model: 'deepseek-v4.1-flash-1017' } } } })
emit({ id: 's1' }, msg(1, 1000, 200, 300))
emit({ id: 's1' }, msg(1, 2000, 100, 400))
emit({ id: 's1' }, { type: 'turn/end', data: { turn: 1 } })

res = await call('/dsh-sidebar/usage.json', 'GET')
const usage = JSON.parse(res.body.toString('utf8')).usage
if (usage.tokens.total !== 4000 || usage.tokens.input !== 3000 || usage.tokens.cache !== 300 || usage.tokens.output !== 700) fail('usage accumulate: ' + JSON.stringify(usage))
else ok('用量累加正确（3000 in / 300 cache / 700 out）')
const expectCost = (3000 * 2 + 300 * 0.5 + 700 * 8) / 1e6
if (Math.abs(usage.cost - Math.round(expectCost * 10000) / 10000) > 1e-6) fail('usage cost: ' + usage.cost + ' vs ' + expectCost)
else ok('单价折算正确（¥' + usage.cost + '）')

res = await call('/dsh-sidebar/usage.json', 'POST', Buffer.from(JSON.stringify({ reset: true })))
const reset = JSON.parse(res.body.toString('utf8')).usage
if (reset.tokens.total !== 0 || reset.requests !== 0) fail('usage reset: ' + JSON.stringify(reset))
else ok('用量重置正常')

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
