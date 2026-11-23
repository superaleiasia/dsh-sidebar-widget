/* dsh-sidebar-widget — 浏览器半侧：在 DSH 左侧栏里挂一张竖卡。
 * 头像点击/拖入即可更换（原图原样上传到 $DSH_HOME/sidebar-widget/avatar.<ext>，不限尺寸）。
 * 数值来自 /dsh-sidebar/usage.json（真实 token 用量，可折金额）或手填余额；
 * 右键卡片打开设置面板，直接改文案/单价，不用手编 json。
 */
(function () {
  if (window.__dshSidebarWidget) return
  window.__dshSidebarWidget = true

  var API = '/dsh-sidebar'
  var HOST_ID = 'dsh-sidebar-widget-host'
  var CONFIG = {
    status: '任务进行中…',
    balance: '',
    balanceLabel: '今日消耗',
    footerText: '正在记录今日 Token…',
    autoPrice: true,
    showPulse: true,
    placement: 'auto',
    valueMode: 'usage',
    currency: '¥',
    prices: { input: 0, cache: 0, output: 0 },
  }
  var avatarVersion = String(Date.now())
  var shadow = null
  var rootEl = null
  var canvas = null
  var ctx2d = null
  var raf = 0
  var phase = 0
  var mounted = false
  var lastUsage = null
  var cardEl = null

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
    '.c{font-size:30px;font-weight:600;line-height:1;opacity:.45;margin:0 1px}' +
    '.bfoot{font-size:10px;opacity:.42}' +
    '.bmeta{font-size:10px;opacity:.55;display:none;letter-spacing:.3px}' +
    '.toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);font-size:11px;padding:5px 10px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap;z-index:20}' +
    '.toast.show{opacity:1}' +
    '.panel{position:absolute;inset:0;z-index:10;display:none;flex-direction:column;gap:7px;box-sizing:border-box;padding:12px;' +
    'background:linear-gradient(160deg,rgba(30,33,43,.99),rgba(18,20,26,.99));overflow:auto;font-size:11px}' +
    '.panel.show{display:flex}' +
    '.panel h4{margin:0 0 2px;font-size:11px;letter-spacing:1px;opacity:.55;font-weight:600;display:flex;justify-content:space-between;align-items:center}' +
    '.panel .x{cursor:pointer;font-size:14px;opacity:.5;padding:0 2px;line-height:1}' +
    '.panel label{display:flex;flex-direction:column;gap:3px}' +
    '.panel label span{font-size:10px;opacity:.5;letter-spacing:.6px}' +
    '.panel input[type=text],.panel input[type=number],.panel select{width:100%;box-sizing:border-box;font:inherit;font-size:11px;padding:4px 6px;border-radius:6px;' +
    'border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.32);color:inherit;outline:none}' +
    '.panel .row{display:flex;gap:6px}' +
    '.panel .row label{flex:1}' +
    '.panel .check{flex-direction:row;align-items:center;gap:6px;opacity:.85}' +
    '.panel .check input{width:auto}' +
    '.panel .actions{display:flex;gap:6px;margin-top:2px}' +
    '.panel button{flex:1;font:inherit;font-size:11px;padding:6px 8px;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,.14);' +
    'background:rgba(255,255,255,.08);color:inherit}' +
    '.panel button.primary{background:linear-gradient(180deg,#5b8cff,#4468e8);border-color:transparent;font-weight:600}' +
    '.panel button.ghost{opacity:.7}'

  // v0.2.1：头像缩小 + 旋转光环裁切（旋转放到 overflow:hidden 容器里的伪元素，外溢不再压到时间）
  var OVERRIDE = '.card{gap:8px;padding:12px 12px 10px;border-radius:16px}' +
    '.avatar-wrap{position:relative;width:86px;height:86px;aspect-ratio:auto;max-height:86px;margin:2px auto 0;border-radius:999px;overflow:hidden;animation:none;padding:0;background:none;isolation:isolate}' +
    '.avatar-wrap::before{content:"";position:absolute;inset:0;border-radius:999px;background:conic-gradient(from 0deg,#6f8cff,#b06cff,#4fd1e0,#6f8cff);animation:spin 16s linear infinite}' +
    '.avatar-wrap::after{inset:2px;z-index:1}' +
    '.avatar{position:absolute;inset:2px;width:calc(100% - 4px);height:calc(100% - 4px);transform:none;z-index:2}' +
    '.hint{font-size:9.5px;padding:0 6px}' +
    '.hh,.mm{font-size:30px}.ss{font-size:12px;transform:none}.time{gap:1px}' +
    '.status[hidden]{display:none}' +
    '.date{font-size:11px}.status{font-size:11.5px;padding:6px 8px}' +
    'canvas{height:52px}.bvalue .num{font-size:20px}' +
    '.card.compact .date,.card.compact .pulse-head,.card.compact canvas{display:none}'

  function build() {
    var host = el('div')
    host.id = HOST_ID
    host.style.cssText = 'display:flex;width:100%;margin:6px 0 4px;flex:0 0 auto;min-height:0;position:relative;z-index:1;'
    shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = STYLE + OVERRIDE
    shadow.appendChild(style)

    var card = el('div', 'card')
    cardEl = card
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
    var c1 = el('span', 'c', ':')
    var mm = el('span', 'mm', '--')
    var c2 = el('span', 'c', ':')
    var ss = el('span', 'ss', '--')
    time.appendChild(hh)
    time.appendChild(c1)
    time.appendChild(mm)
    time.appendChild(c2)
    time.appendChild(ss)
    card.appendChild(time)

    var date = el('div', 'date', '')
    card.appendChild(date)

    var status = el('div', 'status')
    status.hidden = true // 只有真的在跑任务时才显示（/dsh-sidebar/status.json）
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
    var blabelText = el('span', '', CONFIG.balanceLabel)
    blabel.appendChild(blabelText)
    blabel.appendChild(el('span', '', '▾'))
    balance.appendChild(blabel)
    var bvalue = el('div', 'bvalue')
    var cur = el('span', 'cur', '¥')
    bvalue.appendChild(cur)
    var num = el('span', 'num', String(CONFIG.balance || '').replace(/^¥\s*/, ''))
    bvalue.appendChild(num)
    balance.appendChild(bvalue)
    var foot = el('div', 'bfoot', CONFIG.footerText)
    balance.appendChild(foot)
    var bmeta = el('div', 'bmeta', '')
    balance.appendChild(bmeta)
    card.appendChild(balance)

    var toast = el('div', 'toast', '')
    card.appendChild(toast)

    var file = document.createElement('input')
    file.type = 'file'
    file.accept = 'image/*'
    file.style.display = 'none'
    card.appendChild(file)

    rootEl = {
      host: host, card: card, wrap: wrap, img: img, hh: hh, mm: mm, ss: ss, date: date,
      statusText: statusText, status: status, cur: cur, num: num, blabelText: blabelText, foot: foot, bmeta: bmeta,
      toast: toast, file: file, canvas: canvas, balance: balance,
    }

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

    card.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      openPanel()
    })

    return host
  }

  /* ------------------------------------------------------------ 设置面板 */

  var panelCtl = null

  function field(labelText, input) {
    var l = el('label')
    l.appendChild(el('span', '', labelText))
    l.appendChild(input)
    return l
  }

  function textInput(value) {
    var i = document.createElement('input')
    i.type = 'text'
    i.value = value == null ? '' : String(value)
    return i
  }

  function numInput(value) {
    var i = document.createElement('input')
    i.type = 'number'
    i.step = 'any'
    i.value = value == null ? '' : String(value)
    return i
  }

  function buildPanel() {
    if (panelCtl) return panelCtl
    var card = rootEl.card
    var panel = el('div', 'panel')

    var title = el('h4')
    title.appendChild(el('span', '', '挂件设置'))
    var x = el('span', 'x', '✕')
    title.appendChild(x)
    panel.appendChild(title)

    var iStatus = textInput(CONFIG.status)
    var iFoot = textInput(CONFIG.footerText)
    var iLabel = textInput(CONFIG.balanceLabel)
    panel.appendChild(field('状态文字', iStatus))
    panel.appendChild(field('底部说明', iFoot))
    panel.appendChild(field('数值标签', iLabel))

    var modeRow = el('div', 'row')
    var modeSelect = document.createElement('select')
    ;[['usage', '真实 Token 用量'], ['manual', '手填余额']].forEach(function (pair) {
      var o = document.createElement('option')
      o.value = pair[0]
      o.textContent = pair[1]
      modeSelect.appendChild(o)
    })
    modeSelect.value = CONFIG.valueMode || 'usage'
    modeRow.appendChild(field('数值来源', modeSelect))
    panel.appendChild(modeRow)

    var iBalance = textInput(String(CONFIG.balance || ''))
    var manualRow = field('手填余额（数值来源＝手填时生效）', iBalance)
    manualRow.style.display = modeSelect.value === 'manual' ? 'flex' : 'none'
    panel.appendChild(manualRow)

    var priceRow = el('div', 'row')
    var prices = CONFIG.prices || {}
    var iIn = numInput(prices.input)
    var iCache = numInput(prices.cache)
    var iOut = numInput(prices.output)
    priceRow.appendChild(field('输入价', iIn))
    priceRow.appendChild(field('缓存价', iCache))
    priceRow.appendChild(field('输出价', iOut))
    panel.appendChild(priceRow)

    var autoCheck = el('label', 'check')
    var iAuto = document.createElement('input')
    iAuto.type = 'checkbox'
    iAuto.checked = CONFIG.autoPrice !== false
    autoCheck.appendChild(iAuto)
    autoCheck.appendChild(el('span', '', '自动跟随官方峰谷价'))
    panel.appendChild(autoCheck)
    panel.appendChild(el('div', 'bfoot', '勾选后按 DeepSeek 官方价（工作日 9–12、14–18 峰价，其余谷价）计费；上面的单价只在取消勾选后生效。'))

    function syncPriceDisabled() {
      var d = iAuto.checked
      ;[iIn, iCache, iOut].forEach(function (n) { n.disabled = d })
    }
    iAuto.addEventListener('change', syncPriceDisabled)
    syncPriceDisabled()

    var check = el('label', 'check')
    var iShowPulse = document.createElement('input')
    iShowPulse.type = 'checkbox'
    iShowPulse.checked = CONFIG.showPulse !== false
    check.appendChild(iShowPulse)
    check.appendChild(el('span', '', '显示心电波形'))
    panel.appendChild(check)

    var actions = el('div', 'actions')
    var save = el('button', 'primary', '保存')
    var cancel = el('button', 'ghost', '取消')
    actions.appendChild(save)
    actions.appendChild(cancel)
    panel.appendChild(actions)

    var actions2 = el('div', 'actions')
    var reset = el('button', 'ghost', '重置今日用量')
    actions2.appendChild(reset)
    panel.appendChild(actions2)

    card.appendChild(panel)

    function close() { panel.classList.remove('show') }
    x.addEventListener('click', close)
    cancel.addEventListener('click', close)
    modeSelect.addEventListener('change', function () {
      manualRow.style.display = modeSelect.value === 'manual' ? 'flex' : 'none'
    })
    panel.addEventListener('contextmenu', function (e) { e.preventDefault() })
    panel.addEventListener('click', function (e) { e.stopPropagation() })
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close()
      e.stopPropagation()
    })

    save.addEventListener('click', function () {
      var patch = {
        status: iStatus.value,
        footerText: iFoot.value,
        balanceLabel: iLabel.value,
        valueMode: modeSelect.value,
        balance: iBalance.value,
        showPulse: iShowPulse.checked,
        autoPrice: iAuto.checked,
        prices: {
          input: Number(iIn.value) || 0,
          cache: Number(iCache.value) || 0,
          output: Number(iOut.value) || 0,
        },
      }
      save.disabled = true
      fetch(API + '/config.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || 'save failed')
          applyConfig(j.config)
          showToast('已保存')
          close()
          refreshUsage()
        })
        .catch(function (err) { showToast('保存失败：' + (err && err.message ? err.message : err)) })
        .then(function () { save.disabled = false })
    })

    reset.addEventListener('click', function () {
      fetch(API + '/usage.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || 'reset failed')
          lastUsage = j.usage
          renderValue()
          showToast('今日用量已重置')
        })
        .catch(function (err) { showToast('重置失败：' + (err && err.message ? err.message : err)) })
    })

    panelCtl = {
      panel: panel,
      sync: function () {
        iStatus.value = CONFIG.status || ''
        iFoot.value = CONFIG.footerText || ''
        iLabel.value = CONFIG.balanceLabel || ''
        iBalance.value = String(CONFIG.balance || '')
        modeSelect.value = CONFIG.valueMode || 'usage'
        manualRow.style.display = modeSelect.value === 'manual' ? 'flex' : 'none'
        var p = CONFIG.prices || {}
        iIn.value = String(p.input || 0)
        iCache.value = String(p.cache || 0)
        iOut.value = String(p.output || 0)
        iShowPulse.checked = CONFIG.showPulse !== false
        iAuto.checked = CONFIG.autoPrice !== false
        iAuto.dispatchEvent(new Event('change'))
      },
    }
    return panelCtl
  }

  function openPanel() {
    var ctl = buildPanel()
    ctl.sync()
    ctl.panel.classList.add('show')
  }

  /* ---------------------------------------------------------------- 数据 */

  function showToast(text) {
    if (!rootEl) return
    rootEl.toast.textContent = text
    rootEl.toast.classList.add('show')
    clearTimeout(showToast._t)
    showToast._t = setTimeout(function () { rootEl.toast.classList.remove('show') }, 1800)
  }

  function formatTokens(n) {
    var v = Number(n) || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(Math.round(v))
  }

  function hhmm(ts) {
    if (!ts) return '--:--'
    var d = new Date(Number(ts))
    if (isNaN(d.getTime())) return '--:--'
    var p = function (n) { return n < 10 ? '0' + n : String(n) }
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }

  var usageAt = 0
  var balanceInfo = null

  function pad2(n) { return n < 10 ? '0' + n : String(n) }
  function mmss(sec) {
    var s = Math.max(0, Math.floor(sec))
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var r = s % 60
    return (h > 0 ? h + ':' + pad2(m) : String(m)) + ':' + pad2(r)
  }

  /** 底部小字：峰/谷 + 切换倒计时；余额另起一行（有才显示）。 */
  function renderFoot(u) {
    if (!rootEl) return
    if (CONFIG.valueMode === 'manual' || !u) {
      rootEl.foot.textContent = CONFIG.footerText
      if (rootEl.bmeta) rootEl.bmeta.style.display = 'none'
      return
    }
    var parts = []
    if (u.autoPrice) {
      var left = (Number(u.secondsLeft) || 0) - (Date.now() - usageAt) / 1000
      var label = u.tier === 'peak' ? '峰价中' : '谷价中'
      var to = u.tier === 'peak' ? '转谷价' : '转峰价'
      parts.push(label + (u.nextSwitchAt ? ' · ' + mmss(left) + ' 后' + to : ''))
    } else {
      parts.push('自定义单价')
    }
    parts.push((u.requests || 0) + ' 次')
    rootEl.foot.textContent = parts.join(' · ')
    if (rootEl.bmeta) {
      if (balanceInfo && balanceInfo.amount != null) {
        var sym = (!balanceInfo.currency || balanceInfo.currency === 'CNY') ? '¥' : balanceInfo.currency + ' '
        rootEl.bmeta.style.display = 'block'
        rootEl.bmeta.textContent = '余额 ' + sym + Number(balanceInfo.amount).toFixed(2)
      } else {
        // 没有官方余额接口时，退回设置面板里的手填余额；都没填就整行隐藏
        var manual = String(CONFIG.balance || '').replace(/^¥\s*/, '').trim()
        if (manual && !isNaN(Number(manual))) {
          rootEl.bmeta.style.display = 'block'
          rootEl.bmeta.textContent = '余额 ¥' + Number(manual).toFixed(2) + '（手填）'
        } else {
          rootEl.bmeta.style.display = 'none'
        }
      }
    }
  }

  function renderValue() {
    if (!rootEl) return
    var u = lastUsage
    var curSym = CONFIG.currency || '¥'
    if (CONFIG.valueMode === 'manual' || !u) {
      rootEl.cur.textContent = curSym
      rootEl.num.textContent = String(CONFIG.balance || '').replace(/^¥\s*/, '')
      rootEl.foot.textContent = CONFIG.footerText
      if (rootEl.bmeta) rootEl.bmeta.style.display = 'none'
      return
    }
    if (u.priced) {
      rootEl.cur.textContent = curSym
      rootEl.num.textContent = Number(u.cost || 0).toFixed(2)
    } else {
      rootEl.cur.textContent = 'TOK'
      rootEl.num.textContent = formatTokens(u.tokens ? u.tokens.total : 0)
    }
    rootEl.blabelText.textContent = CONFIG.balanceLabel
    renderFoot(u)
  }

  function applyConfig(cfg) {
    if (!cfg) return
    CONFIG = Object.assign({}, CONFIG, cfg)
    if (!rootEl) return
    rootEl.statusText.textContent = CONFIG.status
    rootEl.blabelText.textContent = CONFIG.balanceLabel
    if (rootEl.canvas) rootEl.canvas.style.display = CONFIG.showPulse === false ? 'none' : 'block'
    renderValue()
  }

  function refreshConfig() {
    fetch(API + '/config.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j && j.ok && j.config) applyConfig(j.config) })
      .catch(function () {})
  }

  function refreshUsage() {
    fetch(API + '/usage.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok || !j.usage) return
        lastUsage = j.usage
        usageAt = Date.now()
        renderValue()
      })
      .catch(function () {})
  }

  /** 真实运行状态（turn/start…turn/end）+ 官方余额。 */
  function refreshStatus() {
    fetch(API + '/status.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) return
        var running = j.running || {}
        if (rootEl && rootEl.status) {
          if (running.busy) {
            rootEl.status.hidden = false
            rootEl.statusText.textContent = CONFIG.status + (running.count > 1 ? ' ×' + running.count : '')
          } else {
            rootEl.status.hidden = true
          }
        }
        var nextBalance = j.balance && j.balance.amount != null ? j.balance : null
        if (JSON.stringify(nextBalance) !== JSON.stringify(balanceInfo)) {
          balanceInfo = nextBalance
          renderValue()
        }
      })
      .catch(function () {})
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

  /* ---------------------------------------------------------------- 视图 */

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  function pad(n) { return n < 10 ? '0' + n : String(n) }
  function tick() {
    if (!rootEl) return
    var d = new Date()
    rootEl.hh.textContent = pad(d.getHours())
    rootEl.mm.textContent = pad(d.getMinutes())
    rootEl.ss.textContent = pad(d.getSeconds())
    rootEl.date.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()]
    if (lastUsage) renderFoot(lastUsage)
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
    if (CONFIG.showPulse === false) return
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
    // 侧栏矮的时候自动进紧凑模式（收起日期 / 波形），避免把工作区列表挤掉或盖住设置
    try {
      var ch = column.getBoundingClientRect().height
      if (cardEl) {
        if (ch && ch < 820) cardEl.classList.add('compact')
        else cardEl.classList.remove('compact')
      }
    } catch (err) {}
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
    refreshUsage()
    refreshStatus()
    setInterval(refreshConfig, 60000)
    setInterval(refreshUsage, 3000)
    setInterval(refreshStatus, 3000)
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
