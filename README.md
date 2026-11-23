# dsh-sidebar-widget

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 左侧栏加一张竖卡：动漫头像 + 时钟 + 日期 + 运行状态 + THINK MAX 心电波形 + **今日消耗 / 真实 Token 用量**（按 DeepSeek 官方峰谷价自动计价）。

头像可换、**不限尺寸**（原图原样保存，不压缩不上限；只在显示时按圆形裁切）。

## 安装

```bash
# 从 npm 安装（发布后可用）
dsh plugin --profile desktop add dsh-sidebar-widget

# 直接从 GitHub 装（无需 npm 账号；已验证）
dsh plugin --profile desktop add https://codeload.github.com/superaleiasia/dsh-sidebar-widget/tar.gz/refs/heads/main

# 或本机目录安装（开发用）
dsh plugin --profile desktop add link:F:\\生活废话\\sidebar-widget
```

GitHub 装的是当时 main 的快照，仓库更新后重跑同一条命令即可升级。

手动安装等价于三件事：

1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加 `"dsh-sidebar-widget": "<版本或 link:路径>"`
2. 同一文件的 `dsh.profile.bundles` 数组里加 `"dsh-sidebar-widget"`
3. profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: dsh-sidebar-widget
      name: dsh-sidebar-widget
```

装完**重启 DSH**。挂件出现在左侧栏最下方（设置按钮上方）；侧栏收起（只剩图标）时自动隐藏。

## 用法

| 操作 | 效果 |
| --- | --- |
| 点头像 | 选图片更换 |
| 拖图片到头像 | 直接更换 |
| **右键卡片** | 打开设置面板（文案 / 数值来源 / 单价 / 峰谷价开关 / 手填余额 / 重置用量） |

### 数值

卡片底部默认显示**今日消耗金额**，数据来自 DSH 会话事件流里每条 `assistant/message` 的 `usage`：

- `inputTokens`、`cacheReadTokens`、`outputTokens` 三项分别累计
- 跨重启保留，按自然日自动归零（`~/.dsh/sidebar-widget/usage.json`）
- 默认按 **DeepSeek 官方价**计价：工作日 9:00–12:00、14:00–18:00（北京时间）为峰价，其余时段、周末与法定节假日为谷价，峰价 = 谷价 × 2
  - Flash：缓存 0.02 / 1、输入 1 / 2、输出 4 / 8（谷 / 峰，¥ 每百万 token）
  - Pro：0.15 / 0.3、4.5 / 9、13.5 / 27
  - 价格来源：[DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)，每年 11 月按国务院安排补次年节假日
- 金额在**每次请求结束时**按当时档位累加（改价不回溯，只影响之后的用量）
- 底部小字实时显示「峰价中 · 0:23:45 后转谷价」这类倒计时；单价全为 0 时只显示 token 数
- 设置里可以取消「自动跟随官方峰谷价」，改成手填单价；也可以切到「手填余额」直接写死数字

### 状态 / 余额

- 「任务进行中…」只在 DSH 真的在跑 turn 时出现（订阅 `turn/start` / `turn/end`），空闲时整行隐藏；多会话并行时显示 `×N`
- 余额优先取 DSH 凭据里的 `DEEPSEEK_API_KEY` 调官方 `/user/balance`（缓存 60 秒）；没有 key 时退回设置面板里的手填余额（标「手填」），两者都没有就隐藏该行

## 设置面板（右键卡片）

| 字段 | 说明 |
| --- | --- |
| 状态文字 | 蓝点后面那句，默认「任务进行中…」 |
| 底部说明 | 无用量数据时显示的文案 |
| 数值标签 | 余额/用量上方的小标题 |
| 数值来源 | 「真实 Token 用量」或「手填余额」 |
| 手填余额 | 数值来源＝手填时生效 |
| 自动跟随官方峰谷价 | 默认开；关掉后才用下面的手填单价 |
| 输入/缓存/输出价 | ¥ / 百万 token，自动峰谷价关闭时生效 |
| 手填余额 | 没有官方余额接口时显示的余额（标「手填」） |
| 显示心电波形 | 关掉后 canvas 隐藏 |
| 重置今日用量 | 把当天累计清零 |

保存后立即生效并写入 `~/.dsh/sidebar-widget/config.json`；也可以直接编辑这个文件（挂件每 60 秒重读）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-sidebar/widget.js` | 浏览器半侧脚本 |
| GET/POST | `/dsh-sidebar/config.json` | 读取 / 合并写入配置 |
| GET | `/dsh-sidebar/usage.json` | 今日用量（token 明细 + 今日消耗金额 + 峰谷档位与切换倒计时） |
| POST | `/dsh-sidebar/usage.json` | `{"reset":true}` 重置今日用量 |
| GET | `/dsh-sidebar/status.json` | 是否在跑任务（`running.busy/count`）+ 官方余额 |
| GET/POST/DELETE | `/dsh-sidebar/avatar` | 取 / 传 / 复位头像 |

所有接口只接受本机回环 Host 的同源请求。

## 开发

```bash
node scripts/smoke.mjs   # 假 ctx 跑一遍服务端：注入行、五条路由、配置、用量累加与计价、busy 联动、头像上传
```

改了 `assets/widget.js` 只需刷新页面（脚本按请求现读，不常驻缓存）；改了 `lib/index.js` 要重启 DSH。

## 原理

- **注入**：桌面端走 `webserver/index-inject` 结构化行（内联 script 行，自带 onerror 吞错），web 端走 `webServer.tapIndex`；两条并存、各自去重。
- **用量**：订阅 `session/event`，从 `assistant/message` 的 `usage` 累加并按当时峰谷档位折算金额；`outputTokens` 已含 `reasoningTokens`，不重复计。
- **状态**：同一事件流里的 `turn/start` / `turn/end` 维护在跑会话集合；`busy` 即前端状态行是否显示。
- **挂载**：在 `[data-sidebar-scrollport]` 与 `[data-slot="sidebar.settings"]` 的公共祖先（侧栏列）里，把卡片插到「设置」所在的顶层子节点之前；找不到锚点则退化成左下角固定卡片。

MIT License.
