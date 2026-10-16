(function(e) {
    var t = {};

    function o(i) {
        if (t[i]) return t[i].exports;
        var n = t[i] = {
            i: i,
            l: !1,
            exports: {}
        };
        return e[i].call(n.exports, n, n.exports, o), n.l = !0, n.exports
    }
    o.m = e, o.c = t, o.d = function(e, t, i) {
        o.o(e, t) || Object.defineProperty(e, t, {
            enumerable: !0,
            get: i
        })
    }, o.r = function(e) {
        "undefined" !== typeof Symbol && Symbol.toStringTag && Object.defineProperty(e, Symbol.toStringTag, {
            value: "Module"
        }), Object.defineProperty(e, "__esModule", {
            value: !0
        })
    }, o.t = function(e, t) {
        if (1 & t && (e = o(e)), 8 & t) return e;
        if (4 & t && "object" === typeof e && e && e.__esModule) return e;
        var i = Object.create(null);
        if (o.r(i), Object.defineProperty(i, "default", {
                enumerable: !0,
                value: e
            }), 2 & t && "string" !== typeof e)
            for (var n in e) o.d(i, n, function(t) {
                return e[t]
            }.bind(null, n));
        return i
    }, o.n = function(e) {
        var t = e && e.__esModule ? function() {
            return e["default"]
        } : function() {
            return e
        };
        return o.d(t, "a", t), t
    }, o.o = function(e, t) {
        return Object.prototype.hasOwnProperty.call(e, t)
    }, o.p = "/", o(o.s = 2)
})({
    2: function(e, t, o) {
        e.exports = o("ecea")
    },
    ecea: function(e, t) {
        /* ============================================================
         * Fork 修复版 content script
         * - 下载主路径：直链交给 background 的 chrome.downloads（不占页面内存）
         * - 兜底路径：页面 XHR 取流 + <a download>.click() 保存（原版建了 <a> 却从不 click）
         * - 所有失败都会回报错误，不再静默卡 100%
         * ============================================================ */
        let o = null;               // 视频总大小（兼容旧引用）
        let i = !0,                 // allowDownload
            n = !1,                 // isDownload（兼容保留，UI 状态改由 background 任务提供）
            r = !1,
            l = !1,
            a = {
                top: "60px",
                left: "92%"
            };
        // 最近一次解析到的下载资源
        let dlState = {
            segments: [],   // [{url, size}]
            size: 0,
            quality: 0,
            error: null
        };

        function sanitizeFilename(name) {
            let s = String(name == null ? "" : name)
                .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
                .replace(/[\s.]+$/g, "")
                .trim();
            if (s.length > 120) s = s.slice(0, 120).replace(/[\s.]+$/g, "");
            return s || "bilibili_video";
        }

        function getTitle() {
            var e1, t1;
            return (null === (e1 = document.querySelector("#viewbox_report .video-title")) || void 0 === e1 ? void 0 : e1.title) || (null === (t1 = document.querySelector("#player-title")) || void 0 === t1 ? void 0 : t1.innerHTML) || document.title || "bilibili_video";
        }

        // —— 工具：从 URL 解析 bvid/aid ——
        function extractIds() {
            const path = location.href.split("?")[0];
            let bvid = "",
                aid = "";
            if (path.includes("/video/")) {
                const last = path.split("/video/")[1].split("/")[0];
                if (/^BV[0-9A-Za-z]{10}$/.test(last)) bvid = last;
                else if (/^av\d+$/i.test(last)) aid = last.replace(/av/i, "")
            }
            return {
                bvid: bvid,
                aid: aid
            }
        }

        // —— 工具：优先用官方 view 接口拿 cid（不再依赖页面抓包，B 站改版也不怕） ——
        async function resolveCid() {
            const dom = document.querySelector("#bili_downloader");
            const ids = extractIds();
            const apiParam = ids.bvid ? "bvid=" + ids.bvid : (ids.aid ? "aid=" + ids.aid : "");
            if (apiParam) {
                try {
                    const resp = await fetch("https://api.bilibili.com/x/web-interface/view?" + apiParam, {
                        method: "get",
                        credentials: "include"
                    });
                    const json = await resp.json();
                    if (json && 0 === json.code && json.data && json.data.cid) {
                        return dom && (dom.setAttribute("cid", json.data.cid), dom.setAttribute("aid", json.data.aid)), {
                            cid: String(json.data.cid),
                            aid: String(json.data.aid),
                            bvid: ids.bvid
                        }
                    }
                    console.warn("[bili-fork] view 接口未返回 cid:", json && json.code, json && json.message)
                } catch (err) {
                    console.warn("[bili-fork] view 接口请求失败:", err)
                }
            }
            // 兜底：ajax_listener 抓包得到的 cid
            return {
                cid: dom ? dom.getAttribute("cid") || "" : "",
                aid: dom ? dom.getAttribute("aid") || ids.aid : ids.aid,
                bvid: ids.bvid
            }
        }

        // —— 工具：依次尝试清晰度直到拿到 durl 直链 ——
        async function fetchDurl(buildUrl, qualityList) {
            let last = null;
            for (let k = 0; k < qualityList.length; k++) {
                try {
                    const resp = await fetch(buildUrl(qualityList[k]), {
                        method: "get",
                        credentials: "include"
                    });
                    const json = await resp.json();
                    console.log("[bili-fork] playurl qn=" + qualityList[k] + " 原始响应:", json);
                    last = json;
                    const node = json && (json.data || json.result);
                    if (node && node.durl && node.durl.length) return {
                        node: node,
                        raw: json
                    }
                } catch (err) {
                    console.warn("[bili-fork] playurl 请求失败:", err)
                }
            }
            return {
                node: null,
                raw: last
            }
        }

        // 拉取播放地址（durl 直链）：cid 走官方接口 + 清晰度降级重试，失败写明原因
        function c(e, t) {
            (async () => {
                dlState = {
                    segments: [],
                    size: 0,
                    quality: 0,
                    error: null
                };
                const isBangumi = location.href.includes("bilibili.com/bangumi/play/");
                const ids = await resolveCid();
                if (!ids.cid) return dlState.error = "未能获取视频 cid（页面未捕获到播放信息），请刷新页面后重试", void(t && t());
                const dom = document.querySelector("#bili_downloader");
                dom && ids.aid && dom.setAttribute("aid", ids.aid);
                const buildUrl = isBangumi ? qn => bangumiPlayurlUrl(qn) : qn => videoPlayurlUrl(ids, qn);
                const primaryQn = isBangumi ? playerSelectedQn() : 80;
                const list = [primaryQn, 64, 32].filter((v, i2, arr) => arr.indexOf(v) === i2);
                const r = await fetchDurl(buildUrl, list);
                if (!r.node) {
                    const raw = r.raw;
                    const node = raw && (raw.data || raw.result);
                    dlState.error = node && node.dash ? "该清晰度仅有 DASH 流（多为大会员/高码率专属），插件暂不支持 DASH 合并；可试在播放器切到 480P 再下载，或用 BBDown/yt-dlp" : raw && raw.code ? "接口未返回直链：code=" + raw.code + " " + (raw.message || "") : "接口未返回可下载直链（可能是大会员/充电专属视频，或接口已变更）";
                    return void(t && t())
                }
                const node = r.node;
                dlState.segments = node.durl.map(d => ({
                    url: d.url,
                    size: d.size || 0
                }));
                dlState.size = node.durl.reduce((acc, d) => acc + (d.size || 0), 0);
                dlState.quality = node.quality || 0;
                o = dlState.size;
                dom && (dom.href = node.durl[0].url);
                i = !(isBangumi && !node.video_project);
                t && t()
            })().catch(err => {
                dlState = {
                    segments: [],
                    size: 0,
                    quality: 0,
                    error: "获取视频信息失败：" + String(err && err.message || err)
                };
                t && t()
            })
        }

        function d(e, t, o) {
            chrome.runtime.sendMessage({
                action: "sendAli",
                type: e,
                control: t,
                lable: o
            }, (function(e) {}))
        }

        /* ---------------- 兜底下载：XHR 取流 + <a download> 保存 ---------------- */

        function report(taskId, payload) {
            try {
                chrome.runtime.sendMessage(Object.assign({
                    command: "blobProgress",
                    taskId: taskId
                }, payload), function() {
                    void chrome.runtime.lastError
                });
            } catch (e) { /* ignore */ }
        }

        function fetchSegment(seg, onProgress) {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                let settled = !1;
                const fail = msg => {
                    if (!settled) {
                        settled = !0;
                        reject(new Error(msg))
                    }
                };
                try {
                    xhr.open("GET", seg.url, !0)
                } catch (e) {
                    return fail("无法发起请求：" + String(e && e.message || e))
                }
                xhr.responseType = "blob";
                xhr.onprogress = function(e) {
                    if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
                };
                xhr.onload = function() {
                    if (settled) return;
                    if (xhr.status >= 200 && xhr.status < 300 && xhr.response && xhr.response.size > 0) {
                        settled = !0;
                        resolve(xhr.response)
                    } else {
                        fail("HTTP " + xhr.status + (xhr.response && xhr.response.size > 0 ? "" : "（响应为空）"))
                    }
                };
                xhr.onerror = () => fail("网络错误");
                xhr.ontimeout = () => fail("网络超时");
                xhr.onabort = () => fail("请求被中断");
                try {
                    xhr.send()
                } catch (e) {
                    fail(String(e && e.message || e))
                }
            })
        }

        function saveBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const el = document.createElement("a");
            el.href = url;
            el.download = sanitizeFilename(filename);
            el.style.display = "none";
            document.body.appendChild(el);
            el.click();                 // ★ 原版建了 <a> 但从不 click，这里真正触发浏览器保存
            setTimeout(() => {
                el.remove();
                URL.revokeObjectURL(url)
            }, 60 * 1000)
        }

        function blobFetchAll(taskId, segments) {
            if (!segments || !segments.length) return report(taskId, {
                phase: "error",
                error: "兜底下载失败：没有可用的视频地址"
            });
            let doneBytes = 0;
            const totalAll = segments.reduce((acc, s) => acc + (s.size || 0), 0);
            const step = idx => {
                if (idx >= segments.length) return report(taskId, {
                    phase: "done"
                });
                const seg = segments[idx];
                fetchSegment(seg, (loaded, total) => {
                    report(taskId, {
                        phase: "progress",
                        loaded: loaded,
                        total: total
                    })
                }).then(blob => {
                    saveBlob(blob, seg.name || ("bilibili_video_" + (idx + 1) + ".mp4"));
                    doneBytes += (blob.size || seg.size || 0);
                    report(taskId, {
                        phase: "segmentdone",
                        total: blob.size || seg.size || 0
                    });
                    setTimeout(() => step(idx + 1), 300)
                }).catch(err => {
                    report(taskId, {
                        phase: "error",
                        error: "兜底取流失败：" + String(err && err.message || err)
                    })
                })
            };
            step(0)
        }

        // 主下载：交给 background 用 chrome.downloads 直链下载
        function requestDownload(title) {
            n = !0;
            const filename = sanitizeFilename(title || "bilibili_video");
            if (!dlState.segments.length) {
                n = !1;
                return console.warn("[bili-fork] 没有可下载的直链：", dlState.error || "未知原因")
            }
            chrome.runtime.sendMessage({
                command: "biliDownload",
                segments: dlState.segments,
                filename: filename
            }, (resp) => {
                const err = chrome.runtime.lastError;
                if (!resp || !resp.ok) {
                    n = !1;
                    console.warn("[bili-fork] 启动下载失败：", (resp && resp.error) || (err && err.message) || "无响应")
                }
            })
        }

        /* ---------------- 消息 ---------------- */

        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            switch (msg.cmd) {
                case "getInfo":
                    return chrome.storage.local.get(["sessdata"], (function(st) {
                        const sess = st.sessdata ? st.sessdata : "";
                        c(sess, () => {
                            const dom = document.querySelector("#bili_downloader");
                            sendResponse({
                                videoName: getTitle(),
                                size: dlState.size,
                                quality: dlState.quality,
                                error: dlState.error,
                                allowDownload: i && !dlState.error,
                                isDownload: !1,
                                aid: dom ? dom.getAttribute("aid") : "",
                                cid: dom ? dom.getAttribute("cid") : ""
                            })
                        })
                    })), !0;
                case "download":
                    d("Download", "download", location.href.includes("play/") ? "drama" : "recommend");
                    requestDownload(getTitle());
                    break;
                case "blobFetch":
                    blobFetchAll(msg.taskId, msg.segments || []), sendResponse({
                        ok: !0
                    });
                    break;
                case "videoSummary":
                    const t = document.getElementById("addCenterLogo");
                    if (t) t.click();
                    else {
                        const e = document.createElement("div");
                        e.id = "addCenterLogo", document.body.appendChild(e), e.click(), e.parentNode.removeChild(e), setTimeout((function() {
                            const e = document.querySelector(".ai-box");
                            e || ("https://chrome.google.com/webstore/detail/b%E7%AB%99%E8%A7%86%E9%A2%91%E4%B8%8B%E8%BD%BD%E5%8A%A9%E6%89%8B/nlhgchhigkpbiefockjkoocnjgbdmpkl?utm_medium=extension&utm_source=bilidownloader".includes("chrome") ? window.open("https://chrome.google.com/webstore/detail/ai_assistant/hcmiiaachajoiijecmakkhlcpagafklj?utm_medium=extension&utm_source=ai_assistant") : window.open("https://microsoftedge.microsoft.com/addons/detail/ai_assistant/jigjjhbimkkakoncmabgiefpjebkaoek?utm_medium=extension&utm_source=ai_assistant"))
                        }), 3e3)
                    }
                    break;
                default:
                    break
            }
        });
        const s = (e, t) => {
            const o = [];
            return Object.keys(t).forEach(e => t[e] && o.push(`${e}=${t[e]}`)), -1 === e.search(/\?/) ? e += "?" + o.join("&") : e += "&" + o.join("&"), e
        };

        function u(e) {
            for (var t = "fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF", o = {}, i = t.length, n = 0; n < i; n++) o[t.charAt(n)] = n;
            var r = [11, 10, 3, 8, 4, 6],
                l = 177451812,
                a = 8728348608,
                c = 0;
            for (n = 0; n < 6; n++) c += o[e.charAt(r[n])] * Math.pow(i, n);
            return c - a ^ l
        }

        function videoPlayurlUrl(ids, qn) {
            const o = {
                cid: ids.cid,
                qn: qn,
                otype: "json"
            };
            ids.bvid ? o.bvid = ids.bvid : ids.aid && (o.aid = ids.aid);
            return s("https://api.bilibili.com/x/player/playurl", o)
        }

        function p() {
            try {
                const e = JSON.parse(document.getElementById("__NEXT_DATA__").innerHTML),
                    t = e.props.pageProps.dehydratedState.queries[0].state.data.mediaInfo.episodes[0].ep_id;
                return t
            } catch (e) {
                return ""
            }
        }

        function playerSelectedQn() {
            const active = document.querySelector(".squirtle-select-item.active");
            const v = active && active.getAttribute("data-value");
            return v ? ("16" === v ? "32" : v) : "64"
        }

        function bangumiPlayurlUrl(qn) {
            const dom = document.querySelector("#bili_downloader");
            if (!dom) return "";
            const epA = document.querySelector(".ep-item.cursor a");
            let epFromA = "";
            if (epA && epA.href) {
                const mm = epA.href.match(/ep(\S*)\//);
                epFromA = mm ? mm[1] : ""
            }
            const pathNoQuery = location.href.split("?")[0];
            const epId = pathNoQuery.includes("ss") ? p() : pathNoQuery.replace(/[^0-9]/gi, "") || epFromA || dom.getAttribute("ep_id");
            dom.setAttribute("ep_id", epId);
            return s("https://api.bilibili.com/pgc/player/web/playurl/", {
                ep_id: epId,
                qn: qn
            })
        }

        function h(e) {
            var t = document.querySelector(".biliAiLogo");
            if (!t) return; /* fork：元素不存在时不再抛错（原版此处会 TypeError） */
            e ? "none" !== t.style.display && "" !== t.style.display || (t.style.display = "block") : t.style.display = "none"
        }
        chrome.storage.onChanged.addListener(e => {
            e.isShowBiliAiLogo && h(e.isShowBiliAiLogo.newValue)
        }), chrome.storage.local.get({
            biliAiPosition: a
        }, e => {
            a = e.biliAiPosition;
            const circle = document.querySelector(".bili-ai-circle");
            circle && circle.addEventListener("click", (function(e) {
                if (!l) {
                    d("pink_button", "", ""), "https://chrome.google.com/webstore/detail/b%E7%AB%99%E8%A7%86%E9%A2%91%E4%B8%8B%E8%BD%BD%E5%8A%A9%E6%89%8B/nlhgchhigkpbiefockjkoocnjgbdmpkl?utm_medium=extension&utm_source=bilidownloader".includes("chrome") ? window.open("https://chrome.google.com/webstore/detail/ai_assistant/hcmiiaachajoiijecmakkhlcpagafklj?utm_medium=extension&utm_source=ai_assistant") : window.open("https://microsoftedge.microsoft.com/addons/detail/ai_assistant/jigjjhbimkkakoncmabgiefpjebkaoek?utm_medium=extension&utm_source=ai_assistant");
                    var t = document.querySelector(".biliAiLogo");
                    t.style.display = "none", chrome.storage.local.set({
                        isShowBiliAiLogo: !1
                    })
                }
            })), chrome.storage.local.get({
                isShowBiliAiLogo: !0
            }, e => {
                r = !!e.isShowBiliAiLogo, setTimeout(() => {
                    h(r)
                }, 300)
            })
        }), document.documentElement.addEventListener("click", (function(e) {
            var t = e.target;
            if (t.classList.contains("bili-ai-close")) {
                if (l) return;
                chrome.storage.local.set({
                    isShowBiliAiLogo: !1
                });
                const logo = document.querySelector(".biliAiLogo");
                logo && (logo.style.display = "none")
            }
        }))
    }
});
