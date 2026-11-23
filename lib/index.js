/**
 * dsh-sidebar-widget — 左侧栏挂件（服务端半侧）
 *
 * 职责：
 *  1) 把 assets/widget.js 注入 DSH 页面（桌面端 index-inject 行 + web 端 tapIndex，两条并存、各自去重）
 *  2) 提供数据接口：/dsh-sidebar/{widget.js,config.json,avatar,usage.json}
 *  3) 订阅会话事件流，累计**真实** token 用量（input / cacheRead / output）并按需折算金额
 *
 * 用户数据一律放在 $DSH_HOME/sidebar-widget/，升级/重装插件不会丢：
 *   config.json     挂件文案、数值来源、单价
 *   usage.json      今日 token 累计（跨重启保留）
 *   avatar.<ext>    用户自己换的头像（原图原样保存，不限尺寸）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'sidebar-widget')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const USAGE_FILE = path.join(DATA_DIR, 'usage.json')
const AVATAR_FILE_BASE = path.join(DATA_DIR, 'avatar')
const DEFAULT_AVATAR = path.join(PACKAGE_ROOT, 'assets', 'default-avatar.png')
const WIDGET_JS = path.join(PACKAGE_ROOT, 'assets', 'widget.js')
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

const DEFAULT_CONFIG = {
  status: '任务进行中…',
  balance: '',
  balanceLabel: '今日消耗',
  footerText: '正在记录今日 Token…',
  showPulse: true,
  placement: 'auto',
  // 'usage' = 显示真实 token 用量（可按单价折成金额）；'manual' = 显示手填的余额
  valueMode: 'usage',
  currency: '¥',
  // 单价：人民币 / 百万 token；全为 0 时只显示 token 数
  prices: { input: 0, cache: 0, output: 0 },
  // true = 按官方 DeepSeek 峰谷价自动计价（与 prices 无关）；false = 用上面手填的单价
  autoPrice: true,
}

/* ------------------------------------------------------- 官方峰谷价（DeepSeek）
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（法定节假日与周末全天按谷价）；
 * 谷价 = 其余时段；高峰价 = 谷价 × 2。单位：元 / 百万 token。
 * ⚠️ 每年 11 月国务院公布次年放假安排后，需要往 HOLIDAY_VALLEY 里补日期。
 */
const PEAK_HOURS = [[9, 12], [14, 18]]
const PRICE_FAMILY = {
  // [谷价, 峰价]
  flash: { cache: [0.02, 0.04], input: [1, 2], output: [4, 8] },
  pro: { cache: [0.15, 0.3], input: [4.5, 9], output: [13.5, 27] },
}
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

function bjClock(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return { dow: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), date: d.toISOString().slice(0, 10) }
}

/** 某一时刻是否高峰价。 */
function isPeakAt(ms) {
  const c = bjClock(ms)
  if (c.dow === 0 || c.dow === 6) return false
  if (HOLIDAY_VALLEY[c.date]) return false
  for (const [start, end] of PEAK_HOURS) if (c.hour >= start && c.hour < end) return true
  return false
}

/** 下一次峰谷切换的时间戳（毫秒）；扫 14 天，扫不到就 null。 */
function nextPeakSwitchAt(ms) {
  const cur = isPeakAt(ms)
  const day0 = Math.floor((ms + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000 // 北京当日 00:00
  for (let d = 0; d <= 14; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400000 + edge * 3600000
      if (cand <= ms + 1000) continue
      if (isPeakAt(cand) !== cur) return cand
    }
  }
  return null
}

function familyFor(model) {
  return /pro/i.test(String(model || '')) ? 'pro' : 'flash'
}

/** 当前时段的官方单价（元 / 百万 token）。 */
function officialPricesAt(ms, family) {
  const tier = isPeakAt(ms) ? 1 : 0
  const f = PRICE_FAMILY[family] || PRICE_FAMILY.flash
  return { input: f.input[tier], cache: f.cache[tier], output: f.output[tier], tier: tier ? 'peak' : 'valley' }
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (err) {}
}

// 启动诊断日志：插件到底有没有被加载、路由注册成没成功，一眼可见（appendFileSync，出错不影响主流程）
const BOOT_LOG = path.join(DATA_DIR, 'boot.log')
function note(msg) {
  try {
    ensureDir()
    try { if (fs.statSync(BOOT_LOG).size > 256 * 1024) fs.truncateSync(BOOT_LOG, 0) } catch (err) {}
    fs.appendFileSync(BOOT_LOG, new Date().toISOString() + ' ' + msg + '\n')
  } catch (err) {}
  try { console.log('[sidebar-widget] ' + msg) } catch (err) {}
}

function normalizePrices(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0 }
  return { input: num(p.input), cache: num(p.cache), output: num(p.output) }
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
    merged.prices = normalizePrices(merged.prices)
    return merged
  } catch (err) {
    return { ...DEFAULT_CONFIG, prices: { ...DEFAULT_CONFIG.prices } }
  }
}

function writeConfig(patch) {
  ensureDir()
  const next = { ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) }
  next.prices = normalizePrices(next.prices)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ---------------------------------------------------------------- 用量统计 */

function todayKey(d) {
  const t = d || new Date()
  const p = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
}

function freshUsage() {
  // cost 是「按当时单价累加出的今日消耗」，改单价不回溯（换价只影响之后的用量）
  return { day: todayKey(), input: 0, cache: 0, output: 0, total: 0, requests: 0, updatedAt: 0, cost: 0, model: '' }
}

let usageState = null
let saveTimer = null

function loadUsage() {
  if (usageState) {
    if (usageState.day !== todayKey()) usageState = freshUsage()
    return usageState
  }
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (raw && typeof raw === 'object' && raw.day === todayKey()) {
      const s = freshUsage()
      s.input = Number(raw.input) || 0
      s.cache = Number(raw.cache) || 0
      s.output = Number(raw.output) || 0
      s.total = Number(raw.total) || (s.input + s.cache + s.output)
      s.requests = Number(raw.requests) || 0
      s.updatedAt = Number(raw.updatedAt) || 0
      s.cost = Number(raw.cost) || 0
      s.model = typeof raw.model === 'string' ? raw.model : ''
      usageState = s
      return usageState
    }
  } catch (err) {}
  usageState = freshUsage()
  return usageState
}

function persistUsageSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      ensureDir()
      fs.writeFileSync(USAGE_FILE, JSON.stringify(loadUsage(), null, 2), 'utf8')
    } catch (err) {}
  }, 1200)
  try { if (typeof saveTimer.unref === 'function') saveTimer.unref() } catch (err) {}
}

/** 从 assistant/message 事件里累加真实 usage；口径与 DSH 一致：outputTokens 已含 reasoning。 */
function recordUsage(event) {
  try {
    if (!event || event.type !== 'assistant/message') return
    const d = event.data
    if (!d || typeof d !== 'object') return
    const u = d.usage
    if (!u || typeof u !== 'object') return
    const input = Number(u.inputTokens) || 0
    const cache = Number(u.cacheReadTokens) || 0
    const output = Number(u.outputTokens) || 0
    if (input + cache + output <= 0) return
    const s = loadUsage()
    const cfg = readConfig()
    const model = String((d.message && d.message.source && d.message.source.model) || (d.source && d.source.model) || '')
    let price
    if (cfg.autoPrice) {
      price = officialPricesAt(Date.now(), familyFor(model))
    } else {
      const p = normalizePrices(cfg.prices)
      price = { input: p.input, cache: p.cache, output: p.output, tier: 'manual' }
    }
    const delta = (input * price.input + cache * price.cache + output * price.output) / 1e6
    s.input += input
    s.cache += cache
    s.output += output
    s.total += input + cache + output
    s.cost += delta
    s.requests += 1
    s.updatedAt = Date.now()
    if (model) s.model = model
    persistUsageSoon()
  } catch (err) {}
}

function usagePayload() {
  const s = loadUsage()
  const cfg = readConfig()
  const now = Date.now()
  const family = familyFor(s.model)
  const current = cfg.autoPrice ? officialPricesAt(now, family) : { ...normalizePrices(cfg.prices), tier: 'manual' }
  const nextAt = nextPeakSwitchAt(now)
  return {
    day: s.day,
    tokens: { input: s.input, cache: s.cache, output: s.output, total: s.total },
    cost: Math.round(s.cost * 10000) / 10000,
    priced: cfg.autoPrice || (current.input + current.cache + current.output) > 0,
    requests: s.requests,
    updatedAt: s.updatedAt,
    model: s.model,
    autoPrice: !!cfg.autoPrice,
    tier: current.tier,
    nextSwitchAt: nextAt,
    secondsLeft: nextAt ? Math.max(0, Math.round((nextAt - now) / 1000)) : null,
    prices: { input: current.input, cache: current.cache, output: current.output },
  }
}

function resetUsage() {
  usageState = freshUsage()
  try {
    ensureDir()
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageState, null, 2), 'utf8')
  } catch (err) {}
  return usagePayload()
}

/* ------------------------------------------------------------- 运行状态 */

// 正在跑的会话：turn/start 进、turn/end 出。挂件据此显示 / 隐藏「任务进行中…」
const busySessions = new Map()

function trackBusy(event) {
  try {
    if (!event || typeof event !== 'object') return
    const type = event.type
    if (type !== 'turn/start' && type !== 'turn/end') return
    const sid = String((event.sessionId || (event.session && event.session.id) || 'default'))
    if (type === 'turn/start') {
      if (!busySessions.has(sid)) busySessions.set(sid, Date.now())
    } else {
      busySessions.delete(sid)
    }
  } catch (err) {}
}

function busyPayload() {
  const now = Date.now()
  const list = []
  for (const [sid, since] of busySessions) list.push({ session: sid, seconds: Math.round((now - since) / 1000) })
  return { busy: list.length > 0, count: list.length, sessions: list }
}

/* --------------------------------------------------------------- 余额（可选） */

let balanceCache = { at: 0, value: null, error: null }

/** 用 DSH 凭据里的 DEEPSEEK_API_KEY 查官方余额；查不到就返回 null（前端隐藏）。 */
async function fetchBalance(credentials) {
  if (!credentials) return null
  const now = Date.now()
  if (now - balanceCache.at < 60000) return balanceCache.value
  balanceCache.at = now
  try {
    const key = await credentials.resolve('DEEPSEEK_API_KEY')
    if (!key) { balanceCache.value = null; return null }
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) { balanceCache.value = null; balanceCache.error = 'HTTP ' + res.status; return null }
    const json = await res.json()
    const info = (json && Array.isArray(json.balance_infos) && json.balance_infos[0]) || {}
    const amount = Number(info.total_balance)
    if (!isFinite(amount)) { balanceCache.value = null; return null }
    balanceCache.value = { amount: Math.round(amount * 100) / 100, currency: info.currency || 'CNY', available: json.is_available !== false, at: now }
    balanceCache.error = null
    return balanceCache.value
  } catch (err) {
    balanceCache.error = String((err && err.message) || err)
    balanceCache.value = null
    return null
  }
}

/* ------------------------------------------------------------------ 头像 */

/** 按文件头识别图片类型，不信任客户端给的 Content-Type / 文件名。 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif'
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (buf.slice(4, 12).toString('latin1') === 'ftypavif') return 'avif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  const head = buf.slice(0, 400).toString('utf8').trim().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'svg'
  return null
}

function currentAvatar() {
  try {
    const names = fs.readdirSync(DATA_DIR)
    for (const name of names) {
      if (!name.startsWith('avatar.')) continue
      const ext = name.slice('avatar.'.length).toLowerCase()
      const full = path.join(DATA_DIR, name)
      const st = fs.statSync(full)
      if (st.isFile() && st.size > 0) return { file: full, mime: MIME_BY_EXT[ext] || 'application/octet-stream', version: String(Math.round(st.mtimeMs)) }
    }
  } catch (err) {}
  return { file: DEFAULT_AVATAR, mime: 'image/png', version: 'default' }
}

function readWidgetJs() {
  return fs.readFileSync(WIDGET_JS, 'utf8')
}

/* -------------------------------------------------------------- 请求栅栏 */

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** 轻量栅栏：只服务本机回环页面的同源请求（写接口额外要求回环）。 */
function rejectRequest(req) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl = null
      try { originUrl = new URL(origin) } catch (err) { return 403 }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    return null
  } catch (err) {
    return 403
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }))
        try { req.destroy() } catch (err) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function saveAvatar(buf) {
  const ext = sniffImageExt(buf)
  if (!ext) return null
  ensureDir()
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name.startsWith('avatar.') && name !== 'avatar.' + ext) {
        try { fs.unlinkSync(path.join(DATA_DIR, name)) } catch (err) {}
      }
    }
  } catch (err) {}
  const target = AVATAR_FILE_BASE + '.' + ext
  const tmp = target + '.tmp'
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, target)
  return ext
}

const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="/dsh-sidebar/widget.js";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'dsh-sidebar-widget',

  apply(root) {
    note('apply() 已执行；DSH_HOME=' + DSH_HOME)
    // ① 桌面端（Electron）唯一的注入通道：结构化行，必须在服务就绪前就登记。
    try {
      const disposer = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === '/dsh-sidebar/widget.js') return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-sidebar/widget.js') >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        } catch (err) {}
      })
      root.effect(() => () => { try { disposer() } catch (err) {} })
    } catch (err) {
      try { console.warn('[sidebar-widget] index-inject 订阅失败:', err && err.message) } catch (e) {}
    }

    // ② 会话事件流：每条 assistant/message 都带真实 usage，累加进今日统计
    try {
      const off = root.on('session/event', (_session, event) => { recordUsage(event); trackBusy(event) })
      root.effect(() => () => { try { if (typeof off === 'function') off() } catch (err) {} })
    } catch (err) {
      try { console.warn('[sidebar-widget] 会话事件订阅失败（用量将不可用）:', err && err.message) } catch (e) {}
    }

    // ③ 路由与 web 端注入
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      // DSH 的 webServer 服务方法名是 register(route)；registerRoute 是早期草案名，
      // 这里两种都兼容，避免再次因为方法名对不上而静默 404。
      // 可选服务：拿 DSH 凭据里存的 DEEPSEEK_API_KEY 查官方余额；没有服务就跳过
      let credentials = null
      try { credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : null } catch (err) { credentials = null }
      const webServer = ctx.webServer
      const addRoute = typeof webServer.register === 'function'
        ? webServer.register.bind(webServer)
        : (typeof webServer.registerRoute === 'function' ? webServer.registerRoute.bind(webServer) : null)
      if (!addRoute) {
        try { console.warn('[sidebar-widget] 当前 DSH 的 webServer 没有 register/registerRoute，路由不可用') } catch (e) {}
      }
      const register = (route) => {
        if (!addRoute) return
        try {
          const d = addRoute(route)
          if (typeof d === 'function') disposers.push(d)
          note('路由已注册 ' + route.path)
        } catch (err) {
          note('路由注册失败 ' + route.path + ': ' + String((err && err.message) || err))
        }
      }
      const guarded = (handler) => (req, res) => {
        const status = rejectRequest(req)
        if (status) { res.writeHead(status, { 'Cache-Control': 'no-store' }); res.end('forbidden'); return }
        const fail = (err) => {
          try { sendJson(res, 500, { ok: false, error: String((err && err.message) || err) }) } catch (e) {}
        }
        try {
          const r = handler(req, res)
          if (r && typeof r.then === 'function') r.catch(fail)
        } catch (err) { fail(err) }
      }

      register({
        kind: 'exact',
        path: '/dsh-sidebar/widget.js',
        handler: guarded((req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(readWidgetJs())
        }),
      })

      register({
        kind: 'exact',
        path: '/dsh-sidebar/config.json',
        handler: guarded(async (req, res) => {
          const method = String(req.method || 'GET').toUpperCase()
          if (method === 'GET') { sendJson(res, 200, { ok: true, config: readConfig() }); return }
          if (method === 'POST') {
            const body = await readBody(req, 1024 * 1024)
            let patch = {}
            try { patch = JSON.parse(body.toString('utf8') || '{}') } catch (err) { sendJson(res, 400, { ok: false, error: 'invalid json' }); return }
            sendJson(res, 200, { ok: true, config: writeConfig(patch) })
            return
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }),
      })

      register({
        kind: 'exact',
        path: '/dsh-sidebar/usage.json',
        handler: guarded(async (req, res) => {
          const method = String(req.method || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') { sendJson(res, 200, { ok: true, usage: usagePayload() }); return }
          if (method === 'POST') {
            const body = await readBody(req, 64 * 1024)
            let patch = {}
            try { patch = JSON.parse(body.toString('utf8') || '{}') } catch (err) {}
            if (patch && patch.reset) { sendJson(res, 200, { ok: true, usage: resetUsage() }); return }
            sendJson(res, 400, { ok: false, error: 'unknown action' })
            return
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }),
      })

      register({
        kind: 'exact',
        path: '/dsh-sidebar/status.json',
        handler: guarded(async (req, res) => {
          let balance = null
          try { balance = await fetchBalance(credentials) } catch (err) {}
          sendJson(res, 200, { ok: true, running: busyPayload(), balance })
        }),
      })

      register({
        kind: 'exact',
        path: '/dsh-sidebar/avatar',
        handler: guarded(async (req, res) => {
          const method = String(req.method || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            const avatar = currentAvatar()
            let stat = null
            try { stat = fs.statSync(avatar.file) } catch (err) {}
            if (!stat) { res.writeHead(404); res.end('not found'); return }
            res.writeHead(200, {
              'Content-Type': avatar.mime,
              'Content-Length': stat.size,
              'Cache-Control': 'no-store',
            })
            if (method === 'HEAD') { res.end(); return }
            fs.createReadStream(avatar.file).pipe(res)
            return
          }
          if (method === 'POST') {
            let buf
            try { buf = await readBody(req, MAX_UPLOAD_BYTES) } catch (err) {
              sendJson(res, err && err.code === 413 ? 413 : 400, { ok: false, error: 'upload failed' })
              return
            }
            const ext = saveAvatar(buf)
            if (!ext) { sendJson(res, 400, { ok: false, error: 'unsupported image' }); return }
            const avatar = currentAvatar()
            sendJson(res, 200, { ok: true, url: '/dsh-sidebar/avatar?v=' + avatar.version, bytes: buf.length, ext })
            return
          }
          if (method === 'DELETE') {
            try {
              for (const name of fs.readdirSync(DATA_DIR)) {
                if (name.startsWith('avatar.')) { try { fs.unlinkSync(path.join(DATA_DIR, name)) } catch (err) {} }
              }
            } catch (err) {}
            sendJson(res, 200, { ok: true, url: '/dsh-sidebar/avatar?v=default' })
            return
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }),
      })

      try {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.indexOf('/dsh-sidebar/widget.js') !== -1) return html
          const tag = '<script defer src="/dsh-sidebar/widget.js"></script>'
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
          return html + tag
        }))
      } catch (err) {}

      root.effect(() => () => { for (const d of disposers) { try { d() } catch (err) {} } })
      note('web 端注入与路由就绪，disposers=' + disposers.length)
    })
  },
}
