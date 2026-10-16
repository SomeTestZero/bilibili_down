/* ============================================================
 * download-manager.js —— Fork 修复版下载管理器
 * （由 background.js 顶部 importScripts("download-manager.js") 加载）
 *
 * 原版问题（卡 100% 根因）：
 *   1. content script 用 XHR responseType=blob 把"整个视频"读进页面内存，
 *      大视频时 o.response 为 null / createObjectURL 抛错 → 保存永远不执行；
 *   2. 内存 blob 链接交给 MV3 service worker 调 chrome.downloads.download 保存，
 *      跨上下文 blob 链接脆弱，且回调是空函数 t => {}，一切错误被静默吞掉；
 *   3. 进度条 = XHR 网络进度，100% 只代表"数据拉完"，落盘根本不在进度里，
 *      且 isDownload 标志永不复位，UI 永远显示"下载中(100%)"。
 *
 * 修复方案：
 *   主路径：页面内 XHR 取流（自带 Referer，能过 CDN 防盗链）→ <a download>.click() 保存
 *     - 直接写盘，不经 SW 传 blob 链接（避开原版的跨上下文 blob 保存 bug）
 *     - 进度来自真实下载字节数；99% 封顶，只有真正写完才显示 100%
 *   （实测：B 站 CDN 强制校验 Referer，无 Referer 返回 403+HTML；
 *     chrome.downloads 的请求无法携带 Referer → 直链路径默认关闭，
 *     失败时会自动取消+擦除记录+删临时文件，不留垃圾文件）
 *   所有错误：记录 + 回传弹窗展示，绝不静默
 * ============================================================ */

"use strict";

(function () {
    /* 直链下载开关：B 站 CDN 校验 Referer，chrome.downloads 无法携带，
       开启后会403拿到 HTML 错误页（产生垃圾 .htm），故默认关闭 */
    const USE_DIRECT_DOWNLOAD = false;

    const TASKS_KEY = "fork_tasks_v1";
    const tasks = new Map();      // taskId -> task
    const finished = new Map();   // tabId -> 最近结束的任务（用于 UI 展示完成/失败）
    let seq = 0;
    let restored = null;          // SW 重启后从 storage 恢复任务的 Promise

    /* ---------- 工具 ---------- */

    // 清洗文件名：Windows 非法字符 \ / : * ? " < > | 与控制字符
    function sanitizeFilename(name) {
        let s = String(name == null ? "" : name)
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
            .replace(/[\s.]+$/g, "")
            .trim();
        if (s.length > 120) s = s.slice(0, 120).replace(/[\s.]+$/g, "");
        return s || "bilibili_video";
    }

    function withExt(basename, segIndex, segCount) {
        const hasExt = /\.(mp4|flv|mkv|ts|m4s)$/i.test(basename);
        const base = hasExt ? basename.replace(/\.(mp4|flv|mkv|ts|m4s)$/i, "") : basename;
        return segCount > 1 ? `${base}-P${segIndex + 1}.mp4` : `${base}.mp4`;
    }

    function taskByDownloadId(id) {
        for (const t of tasks.values()) {
            if (t && t.downloadId === id) return t;
        }
        return null;
    }

    function activeTaskForTab(tabId) {
        for (const t of tasks.values()) {
            if (t && t.tabId === tabId && (t.state === "downloading" || t.state === "fallback")) return t;
        }
        return null;
    }

    function persist() {
        try {
            const obj = {};
            for (const [k, v] of tasks) obj[k] = v;
            for (const [k, v] of finished) obj[k] = v;
            chrome.storage.local.set({ [TASKS_KEY]: obj }, () => void chrome.runtime.lastError);
        } catch (e) { /* ignore */ }
    }

    function ensureRestored() {
        if (!restored) {
            restored = new Promise((resolve) => {
                try {
                    chrome.storage.local.get([TASKS_KEY], (data) => {
                        try {
                            const obj = (data && data[TASKS_KEY]) || {};
                            for (const k of Object.keys(obj)) {
                                const t = obj[k];
                                if (!t) continue;
                                if (t.state === "downloading" || t.state === "fallback") {
                                    tasks.set(k, t);
                                } else {
                                    finished.set(t.tabId, t);
                                }
                            }
                        } catch (e) { /* ignore */ }
                        resolve();
                    });
                } catch (e) { resolve(); }
            });
        }
        return restored;
    }

    // 反查真实下载状态（SW 重启后 / 校正进度）
    function refreshBytes(task) {
        return new Promise((resolve) => {
            if (!task || task.downloadId == null) return resolve();
            try {
                chrome.downloads.search({ id: task.downloadId }, (items) => {
                    if (chrome.runtime.lastError || !items || !items[0]) return resolve();
                    const it = items[0];
                    task.curBytes = it.bytesReceived || 0;
                    if (it.totalBytes > 0) task.curTotal = it.totalBytes;
                    if (it.state === "complete") task.segDone = true;
                    if (it.state === "interrupted") task.segError = it.error || "INTERRUPTED";
                    resolve();
                });
            } catch (e) { resolve(); }
        });
    }

    function percentOf(task) {
        if (task.state === "done") return 100;
        const total = task.totalBytes > 0 ? task.totalBytes : 0;
        if (total > 0) {
            const got = task.doneBytes + (task.curBytes || 0);
            return Math.max(0, Math.min(99, Math.floor(got / total * 100)));
        }
        // 未知总大小：用当前分段进度粗略显示，同样封顶 99
        if (task.curTotal > 0) {
            return Math.max(0, Math.min(99, Math.floor((task.curBytes || 0) / task.curTotal * 100)));
        }
        return 0;
    }

    function statePayload(task) {
        if (!task) return { active: false, state: null, percent: 0, error: null };
        return {
            active: task.state === "downloading" || task.state === "fallback",
            state: task.state,
            percent: percentOf(task),
            error: task.error || null,
            mode: task.mode,
            filename: task.filename
        };
    }

    function finishTask(task, state, error) {
        task.state = state;
        task.error = error || null;
        task.finishedAt = Date.now();
        tasks.delete(task.id);
        finished.set(task.tabId, task);
        // 只保留最近 5 分钟的结束状态
        for (const [tabId, t] of finished) {
            if (Date.now() - (t.finishedAt || 0) > 5 * 60 * 1000) finished.delete(tabId);
        }
        persist();
    }

    /* ---------- 主流程 ---------- */

    function onStart(msg, sender) {
        const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
        if (tabId == null) return { ok: false, error: "无法获取标签页" };

        const segments = (msg.segments || [])
            .filter((s) => s && typeof s.url === "string" && s.url.indexOf("http") === 0)
            .map((s) => ({ url: s.url, size: Number(s.size) || 0 }));
        if (!segments.length) return { ok: false, error: "没有可下载的视频地址（可能是大会员/充电专属，接口未返回直链）" };

        if (activeTaskForTab(tabId)) return { ok: false, error: "已有下载任务进行中" };

        const filename = sanitizeFilename(msg.filename);
        const totalBytes = segments.reduce((a, s) => a + s.size, 0);
        const task = {
            id: "task_" + (++seq) + "_" + Date.now(),
            tabId, filename, segments, totalBytes,
            doneBytes: 0, curBytes: 0, curTotal: 0,
            segIndex: 0, downloadId: null,
            state: "downloading", mode: "direct",
            error: null, fallbackUsed: false, noHeadersTried: false
        };
        tasks.set(task.id, task);
        persist();
        if (USE_DIRECT_DOWNLOAD) {
            startSegment(task);
        } else {
            startFallback(task, "");
        }
        return { ok: true, taskId: task.id };
    }

    // 直链下载当前分段
    function startSegment(task) {
        task.mode = "direct";
        task.curBytes = 0;
        task.curTotal = 0;
        task.segDone = false;
        task.segError = null;
        const seg = task.segments[task.segIndex];
        const options = {
            url: seg.url,
            filename: withExt(task.filename, task.segIndex, task.segments.length),
            conflictAction: "uniquify",
            saveAs: false
        };
        if (!task.noHeadersTried) {
            // 部分 Chrome 版本的 downloads.download 支持 headers（带 Referer 更不容易被 CDN 拒）；
            // 若当前版本不支持，回调会报参数错误，自动去掉 headers 重试。
            options.headers = [{ name: "Referer", value: "https://www.bilibili.com/" }];
        }
        try {
            chrome.downloads.download(options, (downloadId) => {
                const err = chrome.runtime.lastError;
                if (downloadId == null) {
                    const msg = (err && err.message) || "downloadId 为空";
                    if (options.headers && !task.noHeadersTried) {
                        // 疑似不支持 headers 参数 → 去掉重试一次
                        task.noHeadersTried = true;
                        return startSegment(task);
                    }
                    console.warn("[bili-fork] chrome.downloads.download 失败，转兜底方案:", msg);
                    return startFallback(task, msg);
                }
                task.downloadId = downloadId;
                persist();
            });
        } catch (e) {
            if (!task.noHeadersTried) {
                task.noHeadersTried = true;
                return startSegment(task);
            }
            return startFallback(task, String(e && e.message || e));
        }
    }

    // 分段完成 → 下一段 / 收尾
    function onSegmentDone(task) {
        const seg = task.segments[task.segIndex];
        const actual = (task.curTotal > 0 ? task.curTotal : 0) || seg.size || 0;
        task.doneBytes += actual;
        task.curBytes = 0;
        task.downloadId = null;
        task.segIndex += 1;
        if (task.segIndex < task.segments.length) {
            persist();
            startSegment(task);
        } else {
            finishTask(task, "done");
        }
    }

    // 直链中断 → 清理垃圾文件 → 判断是否值得兜底
    function onSegmentInterrupted(task, reason) {
        const deadId = task.downloadId;
        task.downloadId = null;
        if (deadId != null) abandonDownload(deadId);
        if (reason === "USER_CANCELED") {
            return finishTask(task, "error", "已取消下载");
        }
        const fallable = /SERVER|NETWORK|FILE_FAILED|FILE_BLOCKED|CRASH/.test(reason || "");
        if (fallable && !task.fallbackUsed) {
            return startFallback(task, "直链下载失败(" + reason + ")");
        }
        finishTask(task, "error", "下载中断: " + reason);
    }

    // 放弃一次下载：取消 + 擦除记录 + 删除已写入的文件（避免残留403 错误页 .htm 等垃圾）
    function abandonDownload(id) {
        try {
            chrome.downloads.cancel(id, () => void chrome.runtime.lastError);
        } catch (e) { /* ignore */ }
        try {
            chrome.downloads.removeFile(id, () => void chrome.runtime.lastError);
        } catch (e) { /* ignore */ }
        try {
            chrome.downloads.erase({ id: id }, () => void chrome.runtime.lastError);
        } catch (e) { /* ignore */ }
    }

    // 兜底：让页面取流 + a[download] 保存
    function startFallback(task, why) {
        task.fallbackUsed = true;
        task.mode = "blob";
        task.state = "fallback";
        task.error = why || null;
        persist();
        const remaining = task.segments.slice(task.segIndex).map((s, i) => ({
            url: s.url,
            size: s.size,
            name: withExt(task.filename, task.segIndex + i, task.segments.length)
        }));
        try {
            chrome.tabs.sendMessage(task.tabId, {
                cmd: "blobFetch",
                taskId: task.id,
                segments: remaining
            }, (resp) => {
                if (!resp || !resp.ok) {
                    finishTask(task, "error", why ? "兜底失败：页面已关闭或跳转（" + why + "）" : "页面取流启动失败：标签页已关闭或跳转");
                }
            });
        } catch (e) {
            finishTask(task, "error", "兜底失败：" + String(e && e.message || e));
        }
    }

    /* ---------- 页面兜底进度回报 ---------- */

    function onBlobProgress(msg, sender) {
        ensureRestored().then(() => {
            const task = tasks.get(msg.taskId);
            if (!task) return;
            if (msg.phase === "progress") {
                task.curBytes = Number(msg.loaded) || 0;
                task.curTotal = Number(msg.total) || 0;
            } else if (msg.phase === "segmentdone") {
                const seg = task.segments[task.segIndex];
                task.doneBytes += (Number(msg.total) || seg.size || 0);
                task.curBytes = 0;
                task.segIndex += 1;
                persist();
            } else if (msg.phase === "done") {
                finishTask(task, "done");
            } else if (msg.phase === "error") {
                finishTask(task, "error", msg.error || "页面取流失败");
            }
        });
    }

    /* ---------- 查询（弹窗轮询用） ---------- */

    function onGetState(msg, sendResponse) {
        ensureRestored().then(async () => {
            let task = activeTaskForTab(msg.tabId);
            if (task) {
                await refreshBytes(task);
                if (task.segDone) {
                    onSegmentDone(task);
                    task = activeTaskForTab(msg.tabId) || finished.get(msg.tabId);
                } else if (task.segError) {
                    const reason = task.segError;
                    task.segError = null;
                    onSegmentInterrupted(task, reason);
                    task = finished.get(msg.tabId);
                }
            } else {
                task = finished.get(msg.tabId) || null;
            }
            sendResponse(statePayload(task));
        });
    }

    /* ---------- 下载事件 ---------- */

    chrome.downloads.onChanged.addListener((delta) => {
        ensureRestored().then(() => {
            const task = taskByDownloadId(delta.id);
            if (!task) return;
            if (delta.state && delta.state.current === "complete") {
                task.segDone = true;
                refreshBytes(task).then(() => onSegmentDone(task));
            } else if (delta.state && delta.state.current === "interrupted") {
                const reason = (delta.error && delta.error.current) || "UNKNOWN";
                onSegmentInterrupted(task, reason);
            }
        });
    });

    /* ---------- 消息入口 ---------- */

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg !== "object") return;
        const key = msg.command || msg.action;
        switch (key) {
            case "biliDownload": {
                ensureRestored().then(() => sendResponse(onStart(msg, sender)));
                return true;
            }
            case "getTaskState": {
                onGetState(msg, sendResponse);
                return true;
            }
            case "blobProgress": {
                onBlobProgress(msg, sender);
                return false;
            }
            case "biliDown": {
                // 兼容旧消息（页面直接给 blob 链接）：至少不再吞错误
                ensureRestored().then(() => {
                    try {
                        chrome.downloads.download({
                            url: msg.url,
                            filename: sanitizeFilename(msg.filename),
                            conflictAction: "uniquify"
                        }, (id) => {
                            if (chrome.runtime.lastError) {
                                console.error("[bili-fork] 旧版 biliDown 保存失败:", chrome.runtime.lastError.message);
                            }
                        });
                    } catch (e) {
                        console.error("[bili-fork] 旧版 biliDown 异常:", e);
                    }
                });
                return false;
            }
            default:
                return false;
        }
    });

    // SW 启动即恢复未完成任务（配合 downloads.onChanged 续接状态）
    ensureRestored();

    console.log("[bili-fork] download-manager 已加载（直链下载 + 兜底保存 + 错误可见）");
})();
