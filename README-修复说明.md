# bilibili 视频下载助手 · Fork 修复版（v2.0.0）

基于 Chrome 商店版「bilibili哔哩哔哩视频下载助手」v1.0.18 的个人 fork，
**修复了"下载卡在 100% 不动、最终文件保存不下来"的问题**。

## 原版为什么卡 100%

原版下载链路：页面里用 XHR 把**整个视频读进内存**（`responseType="blob"`），
进度条显示的是这个网络拉取进度；拉完后生成 `blob:` 链接交给 MV3 service worker
调 `chrome.downloads.download()` 保存。三个致命点：

1. **进度条撒谎**：100% 只代表"数据拉完"，真正的"写入硬盘"不在进度里；
2. **大视频必翻车**：整个视频塞进页面内存，几百 MB 以上时 `o.response` 为 null、
   `URL.createObjectURL` 抛错 → 保存代码永远不执行 → 停在 100% 且**下载页里连任务都没有**；
3. **一切错误被吞掉**：保存调用的回调是空函数 `t => {}`，不检查 `lastError`；
   文件名直接用标题不过滤非法字符；`isDownload` 标志永不复位，UI 永远显示"下载中(100%)"。

（取证依据：Chrome 下载历史数据库中，原版 37 次下载全部成功且均 ≤100MB；
失败的尝试没有任何下载记录，证明保存调用被拒绝/未执行。）

## 修复方案（新架构）

```
点"下载" → content script 把 B站 CDN 直链交给 background
         → background 用 chrome.downloads 直接下载（零内存占用）
         → 进度 = 真实下载字节数（99% 封顶，写完才显示 100%）
         → 失败自动兜底：页面 XHR 取流 + <a download>.click() 保存
         → 完成/失败都有明确 UI 状态，失败显示具体原因
```

| 修复项 | 原版 | Fork |
|---|---|---|
| 下载方式 | 整片进内存 → blob 链接跨上下文保存 | CDN 直链交给 `chrome.downloads`，大文件无压力 |
| 进度显示 | XHR 网络进度，100% 是假象 | 真实字节进度，完成才显示 100% |
| 错误处理 | 空回调，静默失败 | 全链路错误捕获，UI 显示失败原因 |
| 文件名 | 标题直接用（`/ : ? * " < > \|` 会失败） | 自动清洗非法字符 |
| 完成状态 | 永远"下载中(100%)" | 显示"已下载 ✓" / "下载失败 + 原因" |
| 直链被 CDN 拒(403) | 无此情况（走页面请求） | 自动兜底：页面取流 + `<a download>` 保存 |
| 多分段视频 | 只下 durl[0]（缺斤少两） | 全部分段顺序下载 `-P1/-P2...` |
| 接口无直链 | 静默转圈"加载中" | 明确提示（大会员/充电专属等） |
| 遥测 | 上报 uuid/IP/事件到第三方 | 已禁用 |

## 更新记录

### v2.1.1（修复三处控制台报错）
- 修复 popup.js 对不存在的 `#toAIExtension` 元素取 `addEventListener`/`.style` 的报错
  （原版遗留 bug：该元素从未渲染，导致整条事件绑定链中断）——全部改为判空防御
- 修复 zbase 组件读取 `zbaseConfig["data"]` 的报错（远程配置禁用后未判空）
- content-script 根元素绑定改用 `document.documentElement`（永不为空）

### v2.1.0（修复“额外下载一个 .htm 垃圾文件”）
- 取证定位：B 站 CDN **强制校验 Referer**（无 Referer → 403 + HTML 错误页）；
  `chrome.downloads` 的请求无法携带 Referer → 直链下载必拿到 HTML，
  被 Chrome 拦截后留下 .htm 垃圾文件，再由兜底路径救回视频
- 架构调整：**页面取流（自带 Referer）+ `<a download>` 保存升级为主路径**，
  直链下载默认关闭（保留开关与清理护栏）；Chrome 的 blob 是磁盘落盘的，大文件无压力
- 直链失败时自动取消 + 擦除记录 + 删除文件，不再残留任何垃圾文件

### v2.0.2
- **cid 获取改为官方接口**（`x/web-interface/view`）：原版靠抓包播放器的
  `bvc.bilivideo.com/pbp/data` 请求拿 cid，B 站播放器一改就失效 → 接口报
  "请求错误"；现在直接调官方接口，抓包结果仅作兜底
- **清晰度降级重试**：qn=80 无直链时自动尝试 64 → 32，避免高码率仅 DASH 时完全下不了
- **精确报错**：显示接口 code/message（如 `code=-400 请求错误`）、cid 缺失、DASH-only
  分别给出不同提示；playurl 原始响应打印到 Console 便于排查
- 修复：bangumi 页 ep 提取在元素缺失时的 TypeError；AI logo 初始化判空
- popup：content script 无响应时提示“请刷新本页面(F5)后重试”

### v2.0.1
- 禁用全部外联（twiclips 远程配置 / ipinfo IP 遥测），启动时零外部请求
- 增加启动版本标记日志，便于确认加载的代码版本

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. **先停用或移除商店版原插件**（避免 bilibili 页面出现两个下载按钮）
3. 点「加载已解压的扩展程序」，选择本目录 `E:\chrome_plugin\bili_downloader_fork`
4. 打开任意 B 站视频页/番剧页，点插件图标 → 下载

> fork 已移除原版 `key` 字段，扩展 ID 与商店版不同，可独立共存。

## 使用与排查

- 进度语义：`下载中(x%)` 是真实落盘进度；只有显示 **已下载 ✓** 才算完成
- 失败时按钮下方会显示具体原因（如 `下载中断: SERVER_FORBIDDEN`）
- 需要看底层日志：`chrome://extensions` → 本扩展 → 「服务工作进程」→ Console
- 下载文件保存在 Chrome 默认下载目录（文件名 = 视频标题，已自动清洗非法字符）

## 目录与改动清单

```
bili_downloader_fork/
├─ manifest.json              改：fork 名称/版本 2.0.0，移除 key/update_url
├─ js/
│  ├─ download-manager.js     新：下载管理器（直链下载/兜底/进度/错误/任务状态）
│  ├─ background.js           改：importScripts 加载管理器；移除旧"吞错误"保存；
│  │                            禁用遥测函数 E()
│  ├─ content-script.js       改：下载改为交给 background；兜底 XHR 取流 +
│  │                            <a download>.click() 保存（原版建了 <a> 从不 click）；
│  │                            补 onerror/超时/空响应处理；文件名清洗
│  └─ popup.5323de88.js       改：进度改为轮询任务状态；完成/失败状态展示；
│                               接口错误展示；关面板重开可恢复进度显示
└─ 其余资源文件（css/icons/locales 等）与原版一致
```

## 测试

```
node tests/smoke-test.js          # 下载管理器状态机：17 项断言
node tests/content-script-test.js # 页面脚本消息链路：19 项断言
```

mock `chrome.*` API 驱动下载管理器状态机，覆盖单/多分段、文件名清洗、进度封顶、
错误上报、无直链拒绝启动；content-script 测试覆盖 getInfo/下载/兜底/DASH 报错/
清晰度降级/cid 缺失。当前全部通过（17+19）。

## 兼容性说明

- 目标 Chrome 155+（MV3）；`downloads.download` 的 `headers` 参数做了运行时探测，
  不支持的版本自动去掉后重试，不影响下载
- 兜底路径需要 bilibili 页面存活（页面关闭/跳转会明确报错，而不是无声卡住）
- 仅支持接口返回 durl 直链的视频；大会员/充电专属（DASH-only）仍无法下载——
  这是原版就有的能力边界，现在至少会明确提示而不是卡死
