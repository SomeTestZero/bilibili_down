/* content-script.js 集成测试：stub DOM/chrome/fetch，验证消息链路 */
"use strict";

const fs = require("fs");
const path = require("path");

/* ---------- stub 环境 ---------- */
const listeners = [];
const sentMsgs = [];
const storageData = { sessdata: "TEST_SESS" };

const fakeAnchor = {
    attrs: { aid: "12345", cid: "67890", ep_id: "" },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    href: "",
    style: {},
    addEventListener() {},
    click() { sentMsgs.push({ type: "anchor-click" }); },
    remove() {},
    classList: { contains: () => false }
};

global.document = {
    documentElement: { addEventListener() {}, style: {}, classList: { contains: () => false } },
    querySelector(sel) {
        if (sel === "#bili_downloader") return fakeAnchor;
        if (sel === "html") return { addEventListener() {}, style: {}, classList: { contains: () => false } };
        return null; // 其他元素不存在（模拟无 AI logo 等）
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, click() {}, remove() {}, appendChild() {} }),
    body: { appendChild() {}, removeChild() {} },
    title: "测试视频标题"
};
global.window = global;
global.location = {
    href: "https://www.bilibili.com/video/BV1xx411c7mD/?p=1",
    split: String.prototype.split.bind("https://www.bilibili.com/video/BV1xx411c7mD/?p=1")
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "test-ua" }, configurable: true });
global.URL = { createObjectURL: () => "blob:fake", revokeObjectURL() {} };
global.XMLHttpRequest = function () { throw new Error("not used in this test"); };

global.chrome = {
    runtime: {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage(msg, cb) { sentMsgs.push(msg); cb && cb({ ok: true }); },
        lastError: null
    },
    storage: {
        local: {
            get(keys, cb) { cb(storageData); },
            set() {}
        },
        onChanged: { addListener() {} }
    }
};

// fetch mock：view 接口拿 cid；playurl 接口按 mockMode 返回
let mockMode = "ok"; // ok | ladder | dash | nocid
let playurlCalls = 0;
global.fetch = (url) => {
    const u = String(url);
    sentMsgs.push({ type: "fetch", url: u });
    if (u.includes("x/web-interface/view")) {
        if (mockMode === "nocid") return Promise.resolve({
            json: () => Promise.resolve({ code: -400, message: "请求错误", data: null })
        });
        return Promise.resolve({
            json: () => Promise.resolve({ code: 0, data: { cid: "67890", aid: "12345" } })
        });
    }
    if (u.includes("x/player/playurl")) {
        playurlCalls++;
        if (mockMode === "dash") return Promise.resolve({
            json: () => Promise.resolve({ code: 0, data: { quality: 120, dash: { video: [], audio: [] } } })
        });
        if (mockMode === "ladder" && u.includes("qn=80")) return Promise.resolve({
            json: () => Promise.resolve({ code: 0, data: { quality: 80, dash: { video: [] } } })
        });
        return Promise.resolve({
            json: () => Promise.resolve({
                code: 0,
                data: {
                    quality: 64,
                    durl: [
                        { url: "https://cdn.example/seg1.mp4?sign=a", size: 111 },
                        { url: "https://cdn.example/seg2.mp4?sign=b", size: 222 }
                    ]
                }
            })
        });
    }
    return Promise.resolve({ json: () => Promise.resolve({}) });
};

/* ---------- 加载被测脚本 ---------- */
const src = fs.readFileSync(path.join(__dirname, "..", "js", "content-script.js"), "utf8");
eval(src);

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log("  ✓", name)) : (fail++, console.log("  ✗ FAIL:", name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log("A. 消息监听注册");
    check("onMessage 监听器已注册", listeners.length === 1);

    console.log("B. getInfo 完整链路");
    let response;
    listeners[0]({ cmd: "getInfo" }, { tab: { id: 1 } }, (r) => { response = r; });
    await sleep(20);
    check("有响应（不是 undefined）", !!response);
    check("返回视频标题", response && response.videoName === "测试视频标题");
    check("分段大小求和 333", response && response.size === 333);
    check("无错误", response && !response.error);
    check("allowDownload=true", response && response.allowDownload === true);

    console.log("C. download → biliDownload 消息");
    sentMsgs.length = 0;
    listeners[0]({ cmd: "download" }, { tab: { id: 1 } }, () => {});
    await sleep(20);
    const dl = sentMsgs.find((m) => m.command === "biliDownload");
    check("发出 biliDownload", !!dl);
    check("携带全部分段", dl && dl.segments.length === 2);
    check("文件名=标题", dl && dl.filename === "测试视频标题");

    console.log("D. blobFetch 兜底链路");
    sentMsgs.length = 0;
    // 用一个能成功的 XHR stub
    global.XMLHttpRequest = function () {
        this.open = () => {};
        this.send = () => {
            setTimeout(() => {
                this.status = 200;
                this.response = { size: 500 };
                this.onload && this.onload();
            }, 5);
        };
    };
    let resp2;
    listeners[0]({ cmd: "blobFetch", taskId: "task_x", segments: [{ url: "https://cdn.example/s.mp4", size: 500, name: "兜底.mp4" }] }, { tab: { id: 1 } }, (r) => { resp2 = r; });
    check("blobFetch 立即应答 ok", resp2 && resp2.ok === true);
    await sleep(450); // 段间隔 300ms + 余量
    const prog = sentMsgs.filter((m) => m.command === "blobProgress");
    check("有 segmentdone 回报", prog.some((m) => m.phase === "segmentdone"));
    check("有 done 回报", prog.some((m) => m.phase === "done"));

    console.log("E. blobFetch 出错时回报 error");
    sentMsgs.length = 0;
    global.XMLHttpRequest = function () {
        this.open = () => {};
        this.send = () => { setTimeout(() => { this.onerror && this.onerror(); }, 5); };
    };
    listeners[0]({ cmd: "blobFetch", taskId: "task_y", segments: [{ url: "https://cdn.example/s.mp4", size: 1, name: "x.mp4" }] }, { tab: { id: 1 } }, () => {});
    await sleep(30);
    const errProg = sentMsgs.filter((m) => m.command === "blobProgress");
    check("出错时回报 error", errProg.some((m) => m.phase === "error" && /网络错误/.test(m.error)));

    console.log("F. 高清晰度无直链时自动降级重试");
    mockMode = "ladder";
    playurlCalls = 0;
    let responseF;
    listeners[0]({ cmd: "getInfo" }, { tab: { id: 1 } }, (r) => { responseF = r; });
    await sleep(30);
    check("playurl 请求了 2 次（80→64）", playurlCalls === 2);
    check("降级后拿到直链", responseF && !responseF.error && responseF.size === 333);
    check("响应带 quality", responseF && responseF.quality === 64);

    console.log("G. DASH-only 明确报错");
    mockMode = "dash";
    let responseG;
    listeners[0]({ cmd: "getInfo" }, { tab: { id: 1 } }, (r) => { responseG = r; });
    await sleep(30);
    check("错误提示包含 DASH", responseG && /DASH/.test(responseG.error || ""));
    check("allowDownload=false", responseG && responseG.allowDownload === false);

    console.log("H. cid 获取失败明确报错");
    mockMode = "nocid";
    const savedCid = fakeAnchor.attrs.cid;
    fakeAnchor.attrs.cid = "";
    let responseH;
    listeners[0]({ cmd: "getInfo" }, { tab: { id: 1 } }, (r) => { responseH = r; });
    await sleep(30);
    check("错误提示包含 cid", responseH && /cid/.test(responseH.error || ""));
    fakeAnchor.attrs.cid = savedCid;
    mockMode = "ok";

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})();
