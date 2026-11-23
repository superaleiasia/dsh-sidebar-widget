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
  balance: '¥116.80',
  balanceLabel: 'TOKEN 用量',
  footerText: '正在记录今日 Token…',
  showPulse: true,
  placement: 'auto',
  // 'usage' = 显示真实 token 用量（可按单价折成金额）；'manual' = 显示手填的余额
  valueMode: 'usage',
  currency: '¥',
  // 单价：人民币 / 百万 token；全为 0 时只显示 token 数
  prices: { input: 0, cache: 0, output: 0 },
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
  return { day: todayKey(), input: 0, cache: 0, output: 0, total: 0, requests: 0, updatedAt: 0 }
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
    s.input += input
    s.cache += cache
    s.output += output
    s.total += input + cache + output
    s.requests += 1
    s.updatedAt = Date.now()
    persistUsageSoon()
  } catch (err) {}
}

function usagePayload() {
  const s = loadUsage()
  const cfg = readConfig()
  const p = normalizePrices(cfg.prices)
  const cost = (s.input * p.input + s.cache * p.cache + s.output * p.output) / 1e6
  return {
    day: s.day,
    tokens: { input: s.input, cache: s.cache, output: s.output, total: s.total },
    cost: Math.round(cost * 10000) / 10000,
    priced: (p.input + p.cache + p.output) > 0,
    requests: s.requests,
    updatedAt: s.updatedAt,
    prices: p,
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
      const off = root.on('session/event', (_session, event) => recordUsage(event))
      root.effect(() => () => { try { if (typeof off === 'function') off() } catch (err) {} })
    } catch (err) {
      try { console.warn('[sidebar-widget] 会话事件订阅失败（用量将不可用）:', err && err.message) } catch (e) {}
    }

    // ③ 路由与 web 端注入
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      // DSH 的 webServer 服务方法名是 register(route)；registerRoute 是早期草案名，
      // 这里两种都兼容，避免再次因为方法名对不上而静默 404。
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
        try { handler(req, res) } catch (err) {
          try { sendJson(res, 500, { ok: false, error: String((err && err.message) || err) }) } catch (e) {}
        }
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
