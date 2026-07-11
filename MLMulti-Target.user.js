// ==UserScript==
// @name         MLDataGatherer Auto Submit (Multi-Target)
// @namespace    http://violentmonkey.net/
// @version      1.30
// @description  Auto-open & submit multiple MTurk Requester HITs. Integrated page-context native click logic for flawless submission.
// @author       nkorim321
// @match        https://worker.mturk.com/*
// @match        https://www.mturk.com/*
// @match        https://*.public-workforce.*.sagemaker.aws/*
// @match        https://*.sagemaker.aws/work*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //  CONFIG — TARGET REQUESTERS & TITLES
    // ============================================================
    var DRY_RUN = false;

    // এখানে আপনি যত খুশি Requester এবং Title এর জোড়া (Pair) যোগ করতে পারবেন।
    // নিচের ফরম্যাট অনুযায়ী কমা (,) দিয়ে দিয়ে নতুন লাইন যোগ করুন।
    var TARGETS = [
        { requester: 'MLDataGatherer', title: 'Smart Capture Invoice Review' },
        { requester: 'MLDataGatherer', title: 'the taskTitle' },
        { requester: 'MLDataLabeler', title: 'Classify short bits of text' },
        { requester: 'MLDataLabeler', title: 'Classify the following image' },
        { requester: 'MLDataLabeling', title: 'Categorize the image into one or more classes' },
        { requester: 'MLDataLabeling', title: 'Classify the following video' },
        { requester: 'Requester Name 7', title: 'Task Title 7' },
        { requester: 'Requester Name 8', title: 'Task Title 8' },
        { requester: 'Requester Name 9', title: 'Task Title 9' },
        { requester: 'Requester Name 10', title: 'Task Title 10' }
    ];

    var QUEUE_URL           = 'https://worker.mturk.com/tasks';
    var QUEUE_AUTO_RELOAD   = false;
    var RELOAD_INTERVAL_MS  = 60 * 1000;
    var SUBMIT_DELAY_MS     = 3500;                               // Wait time before clicking Submit
    var POST_SUBMIT_WAIT_MS = 8000;
    var WHITE_PAGE_WAIT_MS  = 10000;
    var WORK_CLICK_DELAY_MS = 1500;

    var TAG = '[MLDG]';

    // ============================================================
    //  HELPERS
    // ============================================================
    function now(){ return Date.now(); }
    var LOG_KEY = 'mldg_log';
    var LOG_MAX = 200;
    function tsNow(){
        var d = new Date();
        function pad(n){ return n < 10 ? '0' + n : '' + n; }
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function log(msg){
        var line = '[' + tsNow() + '] ' + msg;
        try { console.log(TAG + ' ' + line); } catch(e){}
        try {
            var prefix = (window.top !== window)
                ? ('(' + (location.hostname || 'iframe') + ') ')
                : '';
            var buf = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            buf.push(prefix + line);
            if (buf.length > LOG_MAX) buf = buf.slice(-LOG_MAX);
            localStorage.setItem(LOG_KEY, JSON.stringify(buf));
        } catch(e){}
        if (window.top !== window) {
            try { window.parent.postMessage({ type: 'MLDG_LOG', line: line, origin: location.hostname }, '*'); }
            catch(e){}
        }
    }

    if (typeof window !== 'undefined' && window.top === window) {
        try {
            window.addEventListener('message', function (ev) {
                if (!ev.data) return;
                var fromSagemaker = false;
                try { fromSagemaker = /\.sagemaker\.aws$/i.test(new URL(ev.origin).hostname); } catch (e) {}

                if (fromSagemaker && typeof noteIframeResponse === 'function') {
                    try { noteIframeResponse(ev.origin); } catch (e) {}
                }

                if (ev.data.type === 'MLDG_LOG' && typeof ev.data.line === 'string') {
                    try {
                        var buf = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
                        buf.push('(' + (ev.data.origin || ev.origin) + ') ' + ev.data.line);
                        if (buf.length > LOG_MAX) buf = buf.slice(-LOG_MAX);
                        localStorage.setItem(LOG_KEY, JSON.stringify(buf));
                    } catch (e) {}
                    return;
                }
            });
        } catch (e) {}
    }

    function txt(el){ return (el && (el.innerText || el.textContent) || '').replace(/\s+/g,' ').trim(); }

    function goToQueue(){
        if (/^\/tasks\/?$/.test(location.pathname)) {
            try { location.reload(); } catch(e){}
            return;
        }
        try { location.href = QUEUE_URL; }
        catch(e){ try { location.replace(QUEUE_URL); } catch(e2){} }
    }

    function isOnTaskPage(){
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(location.pathname);
    }

    function safeReload(reason){
        if (DRY_RUN){
            log('safeReload SKIPPED (DRY_RUN) reason=' + (reason || '?'));
            return false;
        }
        if (isOnTaskPage()){
            log('safeReload BLOCKED (on task page) reason=' + (reason || '?'));
            return false;
        }
        log('safeReload reason=' + (reason || '?'));
        goToQueue();
        return true;
    }

    // ============================================================
    //  SERVER-BUSY DISMISSER
    // ============================================================
    function handleServerBusy() {
        if (!document.body) return false;
        var title = (document.title || '').toLowerCase();
        var body  = (document.body.innerText || '');
        if (title.indexOf('server busy') > -1 || body.indexOf('Continue shopping') > -1) {
            log('Server-busy detected — dismissing');
            var els = document.querySelectorAll('input[type="submit"],button,a');
            for (var i = 0; i < els.length; i++) {
                var t = (els[i].textContent || els[i].value || '');
                if (t.indexOf('Continue') > -1) { try { els[i].click(); } catch (e) {} break; }
            }
            setTimeout(function(){ safeReload('server-busy'); }, 1500);
            return true;
        }
        return false;
    }

    // ============================================================
    //  WHITE / BLANK PAGE GUARD
    // ============================================================
    function isWhitePage() {
        if (!document.body) return true;
        var html = (document.body.innerHTML || '').length;
        var text = ((document.body.innerText || '').trim()).length;
        if (html < 500 || text < 80) return true;
        if (!document.querySelector('a[href*="mturk"],img[alt*="mturk" i],[class*="mturk" i]')) {
            return true;
        }
        return false;
    }

    function whitePageGuard() {
        setTimeout(function () {
            if (isWhitePage()) {
                log('White/blank page detected — forcing full reload');
                safeReload('white-page');
            }
        }, WHITE_PAGE_WAIT_MS);
    }

    // ============================================================
    //  QUEUE PAGE MATCH LOGIC
    // ============================================================
    function rowMatchesTarget(rowEl) {
        var t = txt(rowEl);
        if (!t) return false;

        // চেক করবে লিস্টের যেকোনো একটি Requester এবং Title মিলছে কি না
        return TARGETS.some(function(target) {
            return t.indexOf(target.requester) !== -1 && t.indexOf(target.title) !== -1;
        });
    }

    function findAndClickWork() {
        var rows = document.querySelectorAll(
            'tr, [class*="task-queue" i] [class*="row" i], [data-react-class] tr, .panel, .row, [class*="task-row" i]'
        );

        for (var i = 0; i < rows.length; i++) {
            if (!rowMatchesTarget(rows[i])) continue;

            var candidates = rows[i].querySelectorAll('a, button, input[type="submit"]');
            for (var j = 0; j < candidates.length; j++) {
                var el = candidates[j];
                var label = (el.textContent || el.value || '').trim();
                var href  = (el.getAttribute && el.getAttribute('href')) || '';
                var isWork = /^\s*work\s*$/i.test(label) || /\/projects\/.+\/tasks\//.test(href);
                if (isWork) {
                    if (DRY_RUN) {
                        log('Target HIT found — WOULD click Work (DRY_RUN) href=' + href + ' label="' + label + '"');
                        return true;
                    }
                    log('Target HIT found — clicking Work');
                    try {
                        if (href && href.indexOf('/projects/') > -1) {
                            location.href = href.indexOf('http') === 0 ? href : ('https://worker.mturk.com' + href);
                            return true;
                        }
                        el.click();
                        return true;
                    } catch (e) {
                        log('Work click failed: ' + e.message);
                    }
                }
            }
        }
        return false;
    }

    // ============================================================
    //  TASK PAGE MATCH LOGIC
    // ============================================================
    function pageIsTargetTask() {
        var body = document.body ? (document.body.innerText || '') : '';

        // টাস্ক পেজে চেক করবে লিস্টের কোনো Requester ও Title আছে কি না
        return TARGETS.some(function(target) {
            return body.indexOf(target.requester) !== -1 && body.indexOf(target.title) !== -1;
        });
    }

    function describeEl(el){
        if (!el) return '(null)';
        var s = (el.tagName || '').toLowerCase();
        if (el.id) s += '#' + el.id;
        var tx = (el.textContent || el.value || '').replace(/\s+/g,' ').trim().slice(0, 30);
        if (tx) s += ' txt="' + tx + '"';
        return s;
    }

    var lastReloadAt = now();
    function startQueueAutoReload() {
        setInterval(function () {
            if (now() - lastReloadAt < RELOAD_INTERVAL_MS - 500) return;
            if (isOnTaskPage()) return;
            lastReloadAt = now();
            safeReload('queue-tick');
        }, RELOAD_INTERVAL_MS);
    }

    function showBadge(text) {
        if (window.top !== window) return;
        var b = document.getElementById('mldg-badge');
        if (!b) {
            b = document.createElement('div'); b.id = 'mldg-badge';
            b.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483646;background:#222;color:#7CFC00;font:600 11px system-ui;padding:4px 8px;border-radius:4px;opacity:.9;cursor:pointer;user-select:none';
            b.title = 'Click to view logs';
            b.onclick = function () { toggleLogViewer(); };
            if (document.body) document.body.appendChild(b);
        }
        b.textContent = 'MLDG ' + text + ' · 📋';
    }

    function toggleLogViewer() {
        var v = document.getElementById('mldg-log-viewer');
        if (v) { v.remove(); return; }
        v = document.createElement('div'); v.id = 'mldg-log-viewer';
        v.style.cssText = 'position:fixed;right:8px;bottom:40px;width:560px;max-height:60vh;z-index:2147483647;background:#111;color:#eee;font:11px ui-monospace,monospace;border:1px solid #444;border-radius:6px;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.5)';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'padding:6px 10px;background:#222;color:#7CFC00;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #444';
        hdr.innerHTML = '<span style="font-weight:600">MLDG logs (persistent)</span>';
        var btns = document.createElement('div');
        function mkBtn(label, fn){
            var x = document.createElement('button');
            x.textContent = label;
            x.style.cssText = 'margin-left:6px;padding:2px 8px;background:#333;color:#eee;border:1px solid #555;border-radius:3px;font:600 10px system-ui;cursor:pointer';
            x.onclick = fn; return x;
        }
        var body = document.createElement('pre');
        body.style.cssText = 'margin:0;padding:8px 10px;overflow:auto;white-space:pre-wrap;flex:1;color:#ddd;font:11px ui-monospace,monospace';
        function refresh(){
            try {
                var buf = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
                body.textContent = buf.join('\n') || '(no logs yet)';
                body.scrollTop = body.scrollHeight;
            } catch(e){ body.textContent = 'log read err: ' + e.message; }
        }
        btns.appendChild(mkBtn('Copy', function(){
            try { navigator.clipboard.writeText(body.textContent); } catch(e){}
        }));
        btns.appendChild(mkBtn('Refresh', refresh));
        btns.appendChild(mkBtn('Clear', function(){
            try { localStorage.removeItem(LOG_KEY); } catch(e){}
            refresh();
        }));
        btns.appendChild(mkBtn('Close', function(){ v.remove(); }));
        hdr.appendChild(btns);
        v.appendChild(hdr); v.appendChild(body);
        document.body.appendChild(v);
        refresh();
        var iv = setInterval(function(){
            if (!document.body.contains(v)){ clearInterval(iv); return; }
            refresh();
        }, 1500);
    }

    function isQueuePage() {
        var p = location.pathname || '';
        return /^\/tasks\/?$/.test(p);
    }
    function isTaskPage() {
        var p = location.pathname || '';
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(p);
    }
    function isPostSubmitPage() {
        var p = location.pathname || '';
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/submit\/?$/.test(p);
    }
    function isSagemakerIframe() {
        if (window.top === window) return false;
        return /\.sagemaker\.aws$/i.test(location.hostname);
    }

    var MSG_TYPE_AUTH = 'MLDG_AUTH';
    var TRUSTED_PARENT_ORIGIN = 'https://worker.mturk.com';
    var _iframeEverResponded = false;

    function noteIframeResponse(origin) {
        if (_iframeEverResponded) return;
        _iframeEverResponded = true;
        log('parent: iframe-side script is alive (heard from ' + origin + ')');
    }

    function startParentAuthSignal() {
        if (!pageIsTargetTask()) {
            return;
        }
        log('parent: signalling auth to iframes every 1s');
        function blast() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try { iframes[i].contentWindow.postMessage({ type: MSG_TYPE_AUTH, ts: now() }, '*'); }
                catch (e) {}
            }
        }
        blast();
        setInterval(blast, 1000);

        setTimeout(function () {
            if (_iframeEverResponded) return;
            if (!isOnTaskPage()) return;
            var sageIframe = null;
            try {
                var all = document.querySelectorAll('iframe');
                for (var i = 0; i < all.length; i++) {
                    if (all[i].src && /\.sagemaker\.aws/.test(all[i].src)) { sageIframe = all[i]; break; }
                }
            } catch (e) {}
            try { showBadge('v' + V + ' task · ⚠ NO IFRAME — fix loader @match'); } catch (e) {}
        }, 10000);
    }

    var _sagemakerAuthOk = false;
    var _iframeAttempts = 0;
    function setupSagemakerListener() {
        window.addEventListener('message', function (ev) {
            if (ev.origin !== TRUSTED_PARENT_ORIGIN) return;
            if (!ev.data || ev.data.type !== MSG_TYPE_AUTH) return;
            if (!_sagemakerAuthOk) {
                _sagemakerAuthOk = true;
                log('sagemaker: AUTH received from ' + ev.origin);
            }
        });
    }

    function sagemakerSubmitLoop() {
        if (!_sagemakerAuthOk) {
            _iframeAttempts++;
            setTimeout(sagemakerSubmitLoop, 1000);
            return;
        }

        var btn = document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
                  document.querySelector('crowd-button[form-action="submit"]') ||
                  document.querySelector('[data-testid="crowd-submit"]');

        if (!btn) {
            _iframeAttempts++;
            setTimeout(sagemakerSubmitLoop, 1500);
            return;
        }

        // Delay logic
        if (!btn.dataset.mldgDelayed) {
            btn.dataset.mldgDelayed = "true";
            log('sagemaker: waiting ' + SUBMIT_DELAY_MS + 'ms before clicking submit...');
            setTimeout(sagemakerSubmitLoop, SUBMIT_DELAY_MS);
            return;
        }

        log('sagemaker: injecting pure native click into page context (Bypass style)');

        // --- PAGE CONTEXT INJECTION ---
        let script = document.createElement('script');
        script.textContent = `
            (function() {
                var submitBtn = document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
                                document.querySelector('crowd-button[form-action="submit"]') ||
                                document.querySelector('[data-testid="crowd-submit"]');
                if (submitBtn) {
                    submitBtn.click();
                }
            })();
        `;
        if (document.documentElement) {
            document.documentElement.appendChild(script);
            script.remove();
        }
    }

    var V = '1.30' + (DRY_RUN ? ' [DRY-RUN]' : '');
    try {
        var lastVer = localStorage.getItem('mldg_last_ver');
        if (lastVer !== V) {
            localStorage.removeItem(LOG_KEY);
            localStorage.setItem('mldg_last_ver', V);
        }
    } catch (e) {}

    function main() {
        if (isSagemakerIframe()) {
            setupSagemakerListener();
            setTimeout(sagemakerSubmitLoop, 2500);
            return;
        }

        handleServerBusy();

        if (isPostSubmitPage()) {
            log('Post-submit 404 page — bouncing to queue in 4000ms');
            showBadge('v' + V + ' post-submit → queue');
            setTimeout(goToQueue, 4000);
            return;
        }

        if (isQueuePage()) {
            if (!DRY_RUN) {
                whitePageGuard();
            }
            setTimeout(findAndClickWork, WORK_CLICK_DELAY_MS);
            setInterval(function () { if (isQueuePage()) findAndClickWork(); }, 5000);
            return;
        }

        if (isTaskPage()) {
            startParentAuthSignal();
            return;
        }

        showBadge('v' + V + ' idle');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }
})();
