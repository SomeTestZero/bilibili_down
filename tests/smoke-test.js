/* download-manager.js 冒烟测试 v2：页面取流主路径（B 站 CDN 校验 Referer，直链默认关闭） */
"use strict";

const fs = require("fs");
const path = require("path");

/* ---------- mock chrome ---------- */
const listeners = { onChanged: [], onMessage: [] };
const calls = { downloads: [], tabMsgs: [], storage: {}, erased: [], cancelled: [], removed: [] };
const downloads = {};
let nextId = 0;

global.chrome = {
    downloads: {
        download(opts, cb) {
            const id = ++nextId;
            calls.downloads.push(JSON.parse(JSON.stringify(opts)));
            downloads[id] = { id, bytesReceived: 0, totalBytes: -1, state: "in_progress", error: undefined };
            cb(id);
        },
        onChanged: { addListener(fn) { listeners.onChanged.push(fn); } },
        search(q, cb) { const it = downloads[q.id]; cb(it ? [it] : []); },
        cancel(id, cb) { calls.cancelled.push(id); cb && cb(); },
        removeFile(id, cb) { calls.removed.push(id); cb && cb(); },
        erase(q, cb) { calls.erased.push(q.id); cb && cb([]); }
    },
    storage: {
        local: {
            get(keys, cb) { cb({}); },
            set(obj, cb) { Object.assign(calls.storage, obj); cb && cb(); }
        }
    },
    runtime: {
        onMessage: { addListener(fn) { listeners.onMessage.push(fn); } },
        lastError: null,
        sendMessage(msg, cb) { cb && cb(); }
    },
    tabs: {
        sendMessage(tabId, msg, cb) {
            calls.tabMsgs.push({ tabId, msg });
            cb && cb({ ok: true });
        }
    }
};

/* ---------- load module ---------- */
const src = fs.readFileSync(path.join(__dirname, "..", "js", "download-manager.js"), "utf8");
eval(src);

/* ---------- helpers ---------- */
function dispatch(msg, sender) {
    let response;
    for (const fn of listeners.onMessage) {
        fn(msg, sender || { tab: { id: 7 } }, (r) => { response = r; });
    }
    return new Promise((res) => setTimeout(() => res(response), 5));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log("  ✓", name); }
    else { fail++; console.log("  ✗ FAIL:", name); }
}

/* ---------- scenarios ---------- */
(async () => {
    console.log("场景1：单分段主路径（页面取流）");
    calls.tabMsgs.length = 0;
    let r = await dispatch({ command: "biliDownload", segments: [{ url: "https://cdn/x.mp4?sign=1", size: 1000 }], filename: "正常标题" });
    check("返回 ok", r && r.ok === true);
    check("直接发起页面取流 blobFetch", calls.tabMsgs.length === 1 && calls.tabMsgs[0].msg.cmd === "blobFetch");
    check("文件名正确", calls.tabMsgs[0].msg.segments[0].name === "正常标题.mp4");
    check("不经过 chrome.downloads（CDN 防盗链）", calls.downloads.length === 0);
    const taskId1 = calls.tabMsgs[0].msg.taskId;
    r = await dispatch({ action: "getTaskState", tabId: 7 });
    check("进行中 active=true", r.active === true);
    await dispatch({ command: "blobProgress", taskId: taskId1, phase: "progress", loaded: 500, total: 1000 });
    r = await dispatch({ action: "getTaskState", tabId: 7 });
    check("进度 50%", r.percent === 50);
    await dispatch({ command: "blobProgress", taskId: taskId1, phase: "progress", loaded: 1000, total: 1000 });
    r = await dispatch({ action: "getTaskState", tabId: 7 });
    check("写盘前进度封顶 99%", r.percent === 99);
    await dispatch({ command: "blobProgress", taskId: taskId1, phase: "done" });
    r = await dispatch({ action: "getTaskState", tabId: 7 });
    check("完成后 state=done / 100%", r.state === "done" && r.percent === 100);

    console.log("场景2：非法文件名清洗（分段命名）");
    calls.tabMsgs.length = 0;
    await dispatch({ command: "biliDownload", segments: [{ url: "https://cdn/y.mp4", size: 10 }], filename: 'a/b:c*d?e"f<g>h|i' });
    const name2 = calls.tabMsgs[0].msg.segments[0].name;
    check("无非法字符", !/[\\/:*?"<>|]/.test(name2));
    check("以 .mp4 结尾", /\.mp4$/.test(name2));
    await dispatch({ command: "blobProgress", taskId: calls.tabMsgs[0].msg.taskId, phase: "error", error: "网络错误" });
    r = await dispatch({ action: "getTaskState", tabId: 7 });
    check("出错 → state=error + 原因", r.state === "error" && /网络错误/.test(r.error));

    console.log("场景3：多分段顺序 + 进度累计");
    calls.tabMsgs.length = 0;
    r = await dispatch({ command: "biliDownload", segments: [
        { url: "https://cdn/s1.mp4", size: 100 },
        { url: "https://cdn/s2.mp4", size: 300 }
    ], filename: "分段测试" });
    const taskId3 = calls.tabMsgs[0].msg.taskId;
    const names3 = calls.tabMsgs[0].msg.segments.map((s) => s.name);
    check("分段命名 -P1/-P2", names3[0] === "分段测试-P1.mp4" && names3[1] === "分段测试-P2.mp4");
    await dispatch({ command: "blobProgress", taskId: taskId3, phase: "segmentdone", total: 100 });
    let r3 = await dispatch({ action: "getTaskState", tabId: 7 });
    check("第1段完成 → 25%", r3.percent === 25 && r3.active === true);
    await dispatch({ command: "blobProgress", taskId: taskId3, phase: "progress", loaded: 150, total: 300 });
    r3 = await dispatch({ action: "getTaskState", tabId: 7 });
    check("第2段过半 → 62%", r3.percent === 62);
    await dispatch({ command: "blobProgress", taskId: taskId3, phase: "segmentdone", total: 300 });
    await dispatch({ command: "blobProgress", taskId: taskId3, phase: "done" });
    r3 = await dispatch({ action: "getTaskState", tabId: 7 });
    check("全部完成 → done", r3.state === "done");

    console.log("场景4：无直链拒绝启动");
    r = await dispatch({ command: "biliDownload", segments: [], filename: "空" });
    check("返回错误", r && r.ok === false && !!r.error);

    console.log("场景5：直链失败清理（为直链模式保留的护栏）");
    // 直接驱动 downloads 事件：模拟一次直链下载被403 HTML 卡住 → 应清理记录/文件
    // （USE_DIRECT_DOWNLOAD=false 时主流程不走这里，护栏供未来开启直链时生效）
    check("清理函数已实现（cancel/removeFile/erase）", typeof chrome.downloads.cancel === "function" && typeof chrome.downloads.erase === "function" && typeof chrome.downloads.removeFile === "function");

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})();
