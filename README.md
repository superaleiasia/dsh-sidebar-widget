# dsh-sidebar-widget

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 左侧栏加一张竖卡：动漫头像 + 时钟 + 日期 + 状态 + THINK MAX 心电波形 + Token 余额。

头像可换、**不限尺寸**（原图原样保存，不压缩不上限；只在显示时按圆形裁切）。

## 安装

```bash
# 本机目录安装（推荐用于开发）
dsh plugin --profile desktop add link:F:\\生活废话\\sidebar-widget

# 或者从 npm 安装（发布之后）
dsh plugin --profile desktop add dsh-sidebar-widget
```

手动安装等价于三件事：

1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-sidebar-widget": "link:<绝对路径>"`
2. 同一文件的 `dsh.profile.bundles` 数组里加 `"dsh-sidebar-widget"`
3. profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-sidebar-widget
      name: dsh-sidebar-widget
```

装完**重启 DSH**。挂件会出现在左侧栏最下方（设置按钮上方）；侧栏收起（只剩图标）时自动隐藏。

## 换头像

三种方式，随便挑：

- **点头像** → 选图片
- **把图片拖到头像上**（资源管理器里直接拖）
- 直接把图片放到 `~/.dsh/sidebar-widget/avatar.png`（也支持 `.jpg` / `.webp` / `.gif` / `.avif` / `.bmp` / `.svg`，按文件头识别，改完刷新页面即可）

原图会原封不动地存下来，几万像素的大图也没问题（上限 64 MB 是防误传的保护）。

## 改文案 / 余额

`~/.dsh/sidebar-widget/config.json`（挂件每 60 秒自动重读，也可以改完刷新页面）：

```json
{
  "status": "任务进行中…",
  "balance": "¥116.80",
  "balanceLabel": "TOKEN 余量",
  "footerText": "正在记录今日 Token…",
  "showPulse": true
}
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-sidebar/widget.js` | 浏览器半侧脚本 |
| GET/POST | `/dsh-sidebar/config.json` | 读取 / 合并写入配置 |
| GET | `/dsh-sidebar/avatar` | 当前头像（二进制） |
| POST | `/dsh-sidebar/avatar` | 上传头像（请求体就是图片字节） |
| DELETE | `/dsh-sidebar/avatar` | 恢复默认头像 |

所有接口只接受本机回环 Host 的同源请求。

## 开发

```bash
node scripts/smoke.mjs   # 假 ctx 跑一遍服务端半侧：注入行、路由、配置、头像上传
```

改了 `assets/widget.js` 只需刷新页面（脚本按请求现读，不常驻缓存）；改了 `lib/index.js` 要重启 DSH。

## 原理

- **注入**：桌面端走 `webserver/index-inject` 结构化行（内联 script 行，自带 onerror 吞错），web 端走 `webServer.tapIndex`；两条并存、各自去重。
- **挂载**：在 `[data-sidebar-scrollport]` 与 `[data-slot="sidebar.settings"]` 的公共祖先（侧栏列）里，把卡片插到「设置」所在的顶层子节点之前；找不到锚点则退化成左下角固定卡片。

MIT License.
