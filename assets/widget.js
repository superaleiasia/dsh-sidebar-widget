/* dsh-sidebar-widget — 浏览器半侧：在 DSH 左侧栏里挂一张竖卡。
 * 头像点击/拖入即可更换（原图原样上传到 $DSH_HOME/sidebar-widget/avatar.<ext>，不限尺寸）。
 * 文案与余额来自 /dsh-sidebar/config.json，可热改。
 */
(function () {
  if (window.__dshSidebarWidget) return
  window.__dshSidebarWidget = true

  var API = '/dsh-sidebar'
  var HOST_ID = 'dsh-sidebar-widget-host'
  var CONFIG = {
    status: '任务进行中…',
    balance: '¥116.80',
    balanceLabel: 'TOKEN 余量',
    footerText: '正在记录今日 Token…',
    showPulse: true,
    placement: 'auto',
  }
  var avatarVersion = String(Date.now())
  var shadow = null
  var rootEl = null
  var canvas = null
  var ctx2d = null
  var raf = 0
  var phase = 0
  var mounted = false

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  var STYLE = ':host{all:initial}' +
    '.card{position:relative;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:100%;padding:14px 14px 12px;border-radius:18px;overflow:hidden;' +
    'background:linear-gradient(160deg,rgba(38,41,52,.96),rgba(24,26,33,.98));' +
    'border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05);' +
    'color:var(--dsw-alias-label-primary,#eceef5);font-family:var(--ds-font-family,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);' +
    'user-select:none;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);}' +
    '.avatar-wrap{position:relative;width:100%;aspect-ratio:1/1;max-height:180px;margin:2px auto 0;border-radius:999px;display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'background:conic-gradient(from 0deg,#6f8cff,#b06cff,#4fd1e0,#6f8cff);padding:2px;animation:spin 16s linear infinite;}' +
    '.avatar-wrap::after{content:"";position:absolute;inset:2px;border-radius:999px;background:rgba(10,11,15,.55);}' +
    '.avatar{position:relative;z-index:1;width:100%;height:100%;border-radius:999px;object-fit:cover;object-position:center;display:block;transform:scale(1.16);filter:saturate(1.05)}' +
    '.hint{position:absolute;z-index:3;inset:2px;border-radius:999px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 10px;font-size:11px;line-height:1.4;color:#fff;background:rgba(8,10,16,.62);opacity:0;transition:opacity .15s ease;pointer-events:none}' +
    '.avatar-wrap:hover .hint,.avatar-wrap.dragover .hint{opacity:1}' +
    '@keyframes spin{to{transform:rotate(360deg)}}' +
    '.time{display:flex;align-items:baseline;justify-content:center;gap:6px;font-variant-numeric:tabular-nums;letter-spacing:.5px;margin-top:2px}' +
    '.hh{font-size:40px;font-weight:600;line-height:1}' +
    '.mm{font-size:40px;font-weight:600;line-height:1;opacity:.86}' +
    '.ss{font-size:14px;font-weight:600;opacity:.55;transform:translateY(-4px)}' +
    '.date{text-align:center;font-size:12px;opacity:.62;letter-spacing:.6px;margin-top:-2px}' +
    '.status{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:12px;background:rgba(255,255,255,.05);font-size:12px;opacity:.92}' +
    '.dot{width:7px;height:7px;border-radius:999px;background:#4f8cff;box-shadow:0 0 0 0 rgba(79,140,255,.6);animation:breathe 2.4s ease-in-out infinite}' +
    '@keyframes breathe{0%,100%{box-shadow:0 0 0 0 rgba(79,140,255,.55);opacity:.7}50%{box-shadow:0 0 0 6px rgba(79,140,255,0);opacity:1}}' +
    '.status-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.pulse-head{display:flex;align-items:center;justify-content:space-between;font-size:9.5px;letter-spacing:1.4px;opacity:.42;padding:0 2px}' +
    '.pulse-head .live{color:#54e0a8;opacity:.9}' +
    'canvas{width:100%;height:74px;display:block}' +
    '.balance{padding:9px 10px;border-radius:12px;background:rgba(255,255,255,.05);display:flex;flex-direction:column;gap:3px}' +
    '.blabel{display:flex;align-items:center;justify-content:space-between;font-size:10px;letter-spacing:.8px;opacity:.5}' +
    '.bvalue{display:flex;align-items:baseline;gap:4px;font-variant-numeric:tabular-nums}' +
    '.bvalue .cur{font-size:12px;opacity:.75}' +
    '.bvalue .num{font-size:23px;font-weight:600;letter-spacing:.5px}' +
    '.bfoot{font-size:10px;opacity:.42}' +
    '.toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);font-size:11px;padding:5px 10px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}' +
    '.toast.show{opacity:1}'

  function build() {
    var host = el('div')
    host.id = HOST_ID
    host.style.cssText = 'display:flex;width:100%;margin:8px 0 6px;flex:0 0 auto;'
    shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = STYLE
    shadow.appendChild(style)

    var card = el('div', 'card')
    shadow.appendChild(card)

    var wrap = el('div', 'avatar-wrap')
    wrap.title = '点击或拖入图片即可更换头像'
    var img = el('img', 'avatar')
    img.alt = 'avatar'
    img.draggable = false
    img.src = API + '/avatar?v=' + avatarVersion
    var hint = el('div', 'hint', '点击 / 拖入图片更换头像')
    wrap.appendChild(img)
    wrap.appendChild(hint)
    card.appendChild(wrap)

    var time = el('div', 'time')
    var hh = el('span', 'hh', '--')
    var mm = el('span', 'mm', '--')
    var ss = el('span', 'ss', '--')
    time.appendChild(hh)
    time.appendChild(mm)
    time.appendChild(ss)
    card.appendChild(time)

    var date = el('div', 'date', '')
    card.appendChild(date)

    var status = el('div', 'status')
    status.appendChild(el('span', 'dot'))
    var statusText = el('span', 'status-text', CONFIG.status)
    status.appendChild(statusText)
    card.appendChild(status)

    var head = el('div', 'pulse-head')
    head.appendChild(el('span', '', 'THINK MAX'))
    head.appendChild(el('span', 'live', 'LIVE'))
    card.appendChild(head)

    canvas = document.createElement('canvas')
    card.appendChild(canvas)

    var balance = el('div', 'balance')
    var blabel = el('div', 'blabel')
    blabel.appendChild(el('span', '', CONFIG.balanceLabel))
    blabel.appendChild(el('span', '', '▾'))
    balance.appendChild(blabel)
    var bvalue = el('div', 'bvalue')
    bvalue.appendChild(el('span', 'cur', '¥'))
    var num = el('span', 'num', String(CONFIG.balance || '').replace(/^¥\s*/, ''))
    bvalue.appendChild(num)
    balance.appendChild(bvalue)
    balance.appendChild(el('div', 'bfoot', CONFIG.footerText))
    card.appendChild(balance)

    var toast = el('div', 'toast', '')
    card.appendChild(toast)

    var file = document.createElement('input')
    file.type = 'file'
    file.accept = 'image/*'
    file.style.display = 'none'
    card.appendChild(file)

    rootEl = { host: host, card: card, wrap: wrap, img: img, hh: hh, mm: mm, ss: ss, date: date, statusText: statusText, num: num, toast: toast, file: file, canvas: canvas }

    wrap.addEventListener('click', function () { rootEl.file.click() })
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]
      file.value = ''
      if (f) upload(f)
    })
    wrap.addEventListener('dragover', function (e) { e.preventDefault(); wrap.classList.add('dragover') })
    wrap.addEventListener('dragleave', function () { wrap.classList.remove('dragover') })
    wrap.addEventListener('drop', function (e) {
      e.preventDefault()
      e.stopPropagation()
      wrap.classList.remove('dragover')
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (f) upload(f)
    })
    return host
  }

  function showToast(text) {
    if (!rootEl) return
    rootEl.toast.textContent = text
    rootEl.toast.classList.add('show')
    clearTimeout(showToast._t)
    showToast._t = setTimeout(function () { rootEl.toast.classList.remove('show') }, 1800)
  }

  function upload(file) {
    if (!file || !/^image\//.test(file.type || '')) { showToast('请选择图片文件'); return }
    showToast('正在上传…')
    fetch(API + '/avatar', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'upload failed')
        avatarVersion = String(Date.now())
        rootEl.img.src = API + '/avatar?v=' + avatarVersion
        showToast('头像已更新')
      })
      .catch(function (err) { showToast('上传失败：' + (err && err.message ? err.message : err)) })
  }

  function refreshConfig() {
    fetch(API + '/config.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok || !j.config) return
        CONFIG = Object.assign({}, CONFIG, j.config)
        if (!rootEl) return
        rootEl.statusText.textContent = CONFIG.status
        rootEl.num.textContent = String(CONFIG.balance || '').replace(/^¥\s*/, '')
      })
      .catch(function () {})
  }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  function pad(n) { return n < 10 ? '0' + n : String(n) }
  function tick() {
    if (!rootEl) return
    var d = new Date()
    rootEl.hh.textContent = pad(d.getHours())
    rootEl.mm.textContent = pad(d.getMinutes())
    rootEl.ss.textContent = pad(d.getSeconds())
    rootEl.date.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()]
  }

  function gauss(x, mu, sigma) { var d = (x - mu) / sigma; return Math.exp(-0.5 * d * d) }
  function setupCanvas() {
    if (!canvas) return
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    var w = canvas.clientWidth || 240
    var h = 74
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx2d = canvas.getContext('2d')
  }
  function draw() {
    raf = requestAnimationFrame(draw)
    if (!canvas || !ctx2d) return
    setupCanvas()
    if (!ctx2d) return
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    var w = canvas.width
    var h = canvas.height
    ctx2d.clearRect(0, 0, w, h)
    var period = 190 * dpr
    phase += 2.0 * dpr
    if (phase > period) phase -= period
    ctx2d.lineWidth = Math.max(1.4, 1.6 * dpr)
    ctx2d.lineJoin = 'round'
    ctx2d.lineCap = 'round'
    ctx2d.shadowBlur = 9 * dpr
    ctx2d.shadowColor = 'rgba(84,224,168,.85)'
    ctx2d.strokeStyle = 'rgba(120,236,186,.95)'
    ctx2d.beginPath()
    var amp = h * 0.27
    var base = h * 0.56
    for (var x = 0; x <= w; x += dpr) {
      var p = ((x + phase) % period) / period
      var y = -gauss(p, 0.12, 0.022) * amp * 0.16
      y += gauss(p, 0.28, 0.008) * amp * 0.22
      y -= gauss(p, 0.34, 0.007) * amp
      y += gauss(p, 0.40, 0.010) * amp * 0.55
      y -= gauss(p, 0.56, 0.040) * amp * 0.30
      var py = base + y
      if (x === 0) ctx2d.moveTo(x, py)
      else ctx2d.lineTo(x, py)
    }
    ctx2d.stroke()
    ctx2d.shadowBlur = 0
  }

  function topChild(column, inner) {
    var node = inner
    while (node && node.parentElement !== column) node = node.parentElement
    return node
  }
  function findColumn() {
    var scrollport = document.querySelector('[data-sidebar-scrollport]')
    var settings = document.querySelector('[data-slot="sidebar.settings"]') ||
      document.querySelector('[data-slot="sidebar.footer.action"]')
    if (scrollport && settings) {
      var node = scrollport.parentElement
      while (node && !(node.contains(settings) && node.contains(scrollport))) node = node.parentElement
      if (node) return { column: node, before: topChild(node, settings) }
    }
    if (scrollport) return { column: scrollport.parentElement || scrollport, before: null }
    if (settings) return { column: settings.parentElement, before: topChild(settings.parentElement, settings) }
    return null
  }

  function place(host) {
    var target = null
    try { target = findColumn() } catch (err) { target = null }
    if (!target || !target.column) return false
    var column = target.column
    var width = column.getBoundingClientRect().width
    if (width < 150) { host.style.display = 'none'; return true }
    host.style.display = 'flex'
    if (host.parentElement !== column || host.nextElementSibling !== target.before) {
      if (target.before) column.insertBefore(host, target.before)
      else column.appendChild(host)
    }
    return true
  }

  function fixedFallback(host) {
    if (host.getAttribute('data-fixed') === '1') return
    host.setAttribute('data-fixed', '1')
    host.style.cssText = 'position:fixed;left:10px;bottom:64px;width:244px;z-index:9000;display:flex;flex:0 0 auto'
    document.body.appendChild(host)
  }

  function mount() {
    if (mounted) return
    var host = build()
    mounted = true
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      var ok = false
      try { ok = place(host) } catch (err) { ok = false }
      if (ok) { clearInterval(timer); return }
      if (tries >= 40) {
        clearInterval(timer)
        try { fixedFallback(host) } catch (err) {}
      }
    }, 250)
    setInterval(function () {
      if (host.getAttribute('data-fixed') === '1') return
      if (!document.body.contains(host) || !host.isConnected) {
        try { place(host) } catch (err) {}
      }
    }, 1200)
    tick()
    setInterval(tick, 400)
    try { setupCanvas(); draw() } catch (err) {}
    refreshConfig()
    setInterval(refreshConfig, 60000)
  }

  function boot() {
    var waited = 0
    var timer = setInterval(function () {
      waited += 1
      var hasSidebar = false
      try {
        hasSidebar = !!(document.querySelector('[data-sidebar-scrollport]') ||
          document.querySelector('[data-slot="sidebar.settings"]'))
      } catch (err) {}
      if (hasSidebar || waited > 120) { clearInterval(timer); mount() }
    }, 250)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
