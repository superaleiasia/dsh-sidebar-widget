/**
 * dsh-sidebar-widget — 左侧栏挂件（服务端半侧）
 *
 * 职责：
 *  1) 把 assets/widget.js 注入 DSH 页面（桌面端 index-inject 行 + web 端 tapIndex，两条并存、各自去重）
 *  2) 提供数据接口：/dsh-sidebar/{widget.js,config.json,avatar}
 *
 * 用户数据一律放在 $DSH_HOME/sidebar-widget/，升级/重装插件不会丢：
 *   config.json     挂件文案与余额
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
const AVATAR_FILE_BASE = path.join(DATA_DIR, 'avatar')
const DEFAULT_AVATAR = path.join(PACKAGE_ROOT, 'assets', 'default-avatar.png')
const WIDGET_JS = path.join(PACKAGE_ROOT, 'assets', 'widget.js')
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

const DEFAULT_CONFIG = {
  status: '任务进行中…',
  balance: '¥116.80',
  balanceLabel: 'TOKEN 余量',
  footerText: '正在记录今日 Token…',
  showPulse: true,
  placement: 'auto',
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (err) {}
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch (err) {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(patch) {
  ensureDir()
  const next = { ...readConfig(), ...(patch && typeof patch === 'object' ? patch : {}) }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

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

/** 当前头像：用户上传的优先，找不到就用包内默认图。 */
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

    // ② 路由与 web 端注入
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const register = (route) => {
        try {
          const d = ctx.webServer.registerRoute(route)
          if (typeof d === 'function') disposers.push(d)
        } catch (err) {
          try { console.warn('[sidebar-widget] 路由注册失败 ' + route.path + ':', err && err.message) } catch (e) {}
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
      try { console.log('[sidebar-widget] 已就绪：/dsh-sidebar/widget.js') } catch (err) {}
    })
  },
}
