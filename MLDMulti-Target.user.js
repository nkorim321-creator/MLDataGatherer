// ==UserScript==
// @name         MLD Ultimate Auto Submit (Dual Action Mode - New Tab & Auto Close)
// @namespace    http://violentmonkey.net/
// @version      2.2
// @description  Perfectly handles BOTH 'Invoice' and 'Labeling' tasks. Opens HITs in a new tab and auto-closes them after submission reliably.
// @author       nkorim321
// @match        https://worker.mturk.com/*
// @match        https://www.mturk.com/*
// @match        https://*.public-workforce.*.sagemaker.aws/*
// @match        https://*.sagemaker.aws/work*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    var DRY_RUN = false;

    // ============================================================
    //  🎯 TARGET LIST (কাজের তালিকা ও তার নিয়ম)
    // ============================================================
    // action: 'invoice' = অপশন খুঁজবে না, সোজা 3.5s পর সাবমিট করবে। (1.20 এর নিয়ম)
    // action: 'labeling' = অপশনের জন্য অপেক্ষা করবে, টিক দিয়ে সাবমিট করবে।

    var TARGETS = [
        // --- Invoice কাজের লিস্ট ---
        { requester: 'MLDataGatherer', title: 'Smart Capture Invoice Review', action: 'invoice' },
        { requester: 'MLDataGatherer', title: 'the taskTitle', action: 'invoice' },

        // --- Labeling কাজের লিস্ট ---
        { requester: 'MLDataLabeler', title: 'Classify short bits of text', action: 'labeling' },
        { requester: 'MLDataLabeler', title: 'Classify the following image', action: 'labeling' },
        { requester: 'MLDataLabeling', title: 'Categorize the image into one or more classes', action: 'labeling' },
        { requester: 'MLDataLabeling', title: 'Classify the following video', action: 'labeling' },
        { requester: 'MLDataLabeling', title: 'Classify short bits of text', action: 'labeling' },
        { requester: 'MLDataLabeler', title: 'Text Classification (Single Label)', action: 'labeling' },
        // --- ফাঁকা ২০টি স্লট (ভবিষ্যতের জন্য) ---
        { requester: 'Requester Name 9', title: 'Task Title 9', action: 'labeling' },
        { requester: 'Requester Name 10', title: 'Task Title 10', action: 'labeling' },
        { requester: 'Requester Name 11', title: 'Task Title 11', action: 'labeling' },
        { requester: 'Requester Name 12', title: 'Task Title 12', action: 'labeling' },
        { requester: 'Requester Name 13', title: 'Task Title 13', action: 'labeling' },
        { requester: 'Requester Name 14', title: 'Task Title 14', action: 'labeling' },
        { requester: 'Requester Name 15', title: 'Task Title 15', action: 'labeling' },
        { requester: 'Requester Name 16', title: 'Task Title 16', action: 'labeling' },
        { requester: 'Requester Name 17', title: 'Task Title 17', action: 'labeling' },
        { requester: 'Requester Name 18', title: 'Task Title 18', action: 'labeling' },
        { requester: 'Requester Name 19', title: 'Task Title 19', action: 'labeling' },
        { requester: 'Requester Name 20', title: 'Task Title 20', action: 'labeling' }
    ];

    var QUEUE_URL           = 'https://worker.mturk.com/tasks';
    var INVOICE_DELAY_MS    = 3500; // Invoice এর জন্য 3.5s অপেক্ষা
    var LABELING_DELAY_MS   = 1200; // Labeling এ টিক দেওয়ার পর 1.2s অপেক্ষা
    var POST_SUBMIT_WAIT_MS = 8000;
    var WHITE_PAGE_WAIT_MS  = 10000;
    var WORK_CLICK_DELAY_MS = 1500;
    var TAG = '[MLDG]';

    // ============================================================
    //  HELPERS
    // ============================================================
    function now(){ return Date.now(); }
    function tsNow(){
        var d = new Date();
        function pad(n){ return n < 10 ? '0' + n : '' + n; }
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function log(msg){
        var line = '[' + tsNow() + '] ' + msg;
        try { console.log(TAG + ' ' + line); } catch(e){}
    }
    function txt(el){ return (el && (el.innerText || el.textContent) || '').replace(/\s+/g,' ').trim(); }

    function goToQueue(){
        if (/^\/tasks\/?$/.test(location.pathname)) {
            try { location.reload(); } catch(e){}
            return;
        }
        try { location.href = QUEUE_URL; } catch(e){ try { location.replace(QUEUE_URL); } catch(e2){} }
    }
    function isOnTaskPage(){ return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(location.pathname); }

    function safeReload(reason){
        if (DRY_RUN || isOnTaskPage()) return false;
        goToQueue();
        return true;
    }

    function handleServerBusy() {
        if (!document.body) return false;
        var title = (document.title || '').toLowerCase();
        var body  = (document.body.innerText || '');
        if (title.indexOf('server busy') > -1 || body.indexOf('Continue shopping') > -1) {
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

    function isWhitePage() {
        if (!document.body) return true;
        var html = (document.body.innerHTML || '').length;
        var text = ((document.body.innerText || '').trim()).length;
        if (html < 500 || text < 80) return true;
        if (!document.querySelector('a[href*="mturk"],img[alt*="mturk" i],[class*="mturk" i]')) return true;
        return false;
    }

    function whitePageGuard() {
        setTimeout(function () {
            if (isWhitePage()) safeReload('white-page');
        }, WHITE_PAGE_WAIT_MS);
    }

    // ============================================================
    //  QUEUE & TASK PAGE LOGIC
    // ============================================================
    function rowMatchesTarget(rowEl) {
        var t = txt(rowEl);
        if (!t) return false;
        return TARGETS.some(function(target) {
            return t.indexOf(target.requester) !== -1 && t.indexOf(target.title) !== -1;
        });
    }

    function findAndClickWork() {
        var rows = document.querySelectorAll('tr, [class*="task-queue" i] [class*="row" i], [data-react-class] tr, .panel, .row, [class*="task-row" i]');
        for (var i = 0; i < rows.length; i++) {
            if (!rowMatchesTarget(rows[i])) continue;
            var candidates = rows[i].querySelectorAll('a, button, input[type="submit"]');
            for (var j = 0; j < candidates.length; j++) {
                var el = candidates[j];
                var label = (el.textContent || el.value || '').trim();
                var href  = (el.getAttribute && el.getAttribute('href')) || '';
                var isWork = /^\s*work\s*$/i.test(label) || /\/projects\/.+\/tasks\//.test(href);
                if (isWork) {
                    if (DRY_RUN) return true;
                    if (el.dataset.opened) continue; 

                    try {
                        el.dataset.opened = "true";
                        el.style.border = "2px solid blue";

                        if (href && href.indexOf('/projects/') > -1) {
                            var targetUrl = href.indexOf('http') === 0 ? href : ('https://worker.mturk.com' + href);
                            if (typeof GM_openInTab !== 'undefined') {
                                GM_openInTab(targetUrl, { active: false, insert: true });
                            } else {
                                window.open(targetUrl, '_blank');
                            }
                            return true;
                        }
                        el.click();
                        return true;
                    } catch (e) {}
                }
            }
        }
        return false;
    }

    function getMatchedTarget() {
        var body = document.body ? (document.body.innerText || '') : '';
        for (var i = 0; i < TARGETS.length; i++) {
            if (body.indexOf(TARGETS[i].requester) > -1 && body.indexOf(TARGETS[i].title) > -1) {
                return TARGETS[i];
            }
        }
        return null;
    }

    function showBadge(text) {
        if (window.top !== window) return;
        var b = document.getElementById('mldg-badge');
        if (!b) {
            b = document.createElement('div'); b.id = 'mldg-badge';
            b.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483646;background:#222;color:#7CFC00;font:600 11px system-ui;padding:4px 8px;border-radius:4px;opacity:.9;pointer-events:none;';
            if (document.body) document.body.appendChild(b);
        }
        b.textContent = 'MLD ' + text;
    }

    function isQueuePage() { return /^\/tasks\/?$/.test(location.pathname || ''); }
    function isTaskPage() { return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(location.pathname || ''); }
    function isPostSubmitPage() { return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/submit\/?$/.test(location.pathname || ''); }
    function isSagemakerIframe() { return window.top !== window && /\.sagemaker\.aws$/i.test(location.hostname); }

    // ============================================================
    //  PARENT-TO-IFRAME MESSAGE PASSING (Action Routing)
    // ============================================================
    var MSG_TYPE_AUTH = 'MLDG_AUTH';
    var TRUSTED_PARENT_ORIGIN = 'https://worker.mturk.com';
    var _sagemakerAuthOk = false;
    var _taskAction = 'labeling'; 

    function startParentAuthSignal() {
        var matched = getMatchedTarget();
        if (!matched) return;

        var actionType = matched.action || 'labeling';

        function blast() {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    iframes[i].contentWindow.postMessage({
                        type: MSG_TYPE_AUTH,
                        ts: now(),
                        action: actionType
                    }, '*');
                } catch (e) {}
            }
        }
        blast();
        setInterval(blast, 1000);
    }

    function setupSagemakerListener() {
        window.addEventListener('message', function (ev) {
            if (ev.origin !== TRUSTED_PARENT_ORIGIN) return;
            if (!ev.data || ev.data.type !== MSG_TYPE_AUTH) return;
            _sagemakerAuthOk = true;
            _taskAction = ev.data.action || 'labeling';
        });
    }

    // ============================================================
    // SHADOW DOM HELPERS FOR OPTIONS
    // ============================================================
    function getElementsDeep(selector, root = document) {
        let results = Array.from(root.querySelectorAll(selector));
        const allElements = root.querySelectorAll('*');
        for (let el of allElements) {
            if (el.shadowRoot) results = results.concat(getElementsDeep(selector, el.shadowRoot));
        }
        return results;
    }

    function isVisible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

    function getTaskOptions() {
        let els = getElementsDeep('crowd-radio-button, input[type="radio"], .category-button, paper-radio-button').filter(isVisible);
        if (els.length >= 2) return els;

        let allBtns = getElementsDeep('button, crowd-button, paper-button').filter(isVisible);
        let options = allBtns.filter(b => {
            let txt = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
            return txt && !['submit', 'submit hit', 'cancel', 'close', 'instructions'].includes(txt);
        });

        if (options.length >= 2) return options;
        return [];
    }

    // ============================================================
    // DUAL EXECUTION LOOP
    // ============================================================
    var _hasExecuted = false;

    function sagemakerSubmitLoop() {
        if (_hasExecuted) return;

        if (!_sagemakerAuthOk) {
            setTimeout(sagemakerSubmitLoop, 500);
            return;
        }

        if (_taskAction === 'invoice') {
            _hasExecuted = true;
            log(`sagemaker: Action=Invoice. Waiting ${INVOICE_DELAY_MS}ms before forced submit.`);
            setTimeout(doFinalSubmit, INVOICE_DELAY_MS);
            return;
        }

        if (_taskAction === 'labeling') {
            let options = getTaskOptions();

            if (options.length >= 2) {
                _hasExecuted = true;
                log(`sagemaker: Action=Labeling. Found ${options.length} options! Applying selection logic...`);

                let selectedIndex = 0;
                let rand = Math.random() * 100;
                if (options.length >= 3) {
                    if (rand < 95) selectedIndex = 0;
                    else if (rand < 98) selectedIndex = 1;
                    else selectedIndex = 2;
                } else if (options.length === 2) {
                    if (rand < 95) selectedIndex = 0;
                    else selectedIndex = 1;
                }

                const targetOption = options[selectedIndex];
                targetOption.click();
                if (targetOption.shadowRoot) {
                    const inner = targetOption.shadowRoot.querySelector('input, button, label');
                    if (inner) inner.click();
                }
                if ('checked' in targetOption) targetOption.checked = true;

                setTimeout(doFinalSubmit, LABELING_DELAY_MS);
                return;
            }

            setTimeout(sagemakerSubmitLoop, 500);
            return;
        }
    }

    // ============================================================
    // THE FINAL SUBMIT UNLOCKER (Native Context)
    // ============================================================
    function doFinalSubmit() {
        log('sagemaker: injecting pure native click & unlock into page context');
        let script = document.createElement('script');
        script.textContent = `
            (function() {
                function getDeep(selector, root = document) {
                    let res = Array.from(root.querySelectorAll(selector));
                    for (let el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) res = res.concat(getDeep(selector, el.shadowRoot));
                    }
                    return res;
                }

                let allButtons = getDeep('crowd-submit, button, input[type="submit"], .btn-primary, .awsui-button');
                let actualSubmitBtn = null;

                for (let btn of allButtons) {
                    if (btn.tagName.toLowerCase() === 'crowd-submit') { actualSubmitBtn = btn; break; }
                    const txt = (btn.innerText || btn.textContent || btn.value || "").trim().toLowerCase();
                    if (txt === "submit" || txt === "submit hit") { actualSubmitBtn = btn; break; }
                }

                if (actualSubmitBtn) {
                    actualSubmitBtn.removeAttribute('disabled');
                    actualSubmitBtn.disabled = false;

                    if (actualSubmitBtn.tagName.toLowerCase() === 'crowd-submit' && actualSubmitBtn.shadowRoot) {
                        const innerSubmit = actualSubmitBtn.shadowRoot.querySelector('button');
                        if (innerSubmit) {
                            innerSubmit.removeAttribute('disabled');
                            innerSubmit.disabled = false;
                            innerSubmit.click();
                        }
                    }
                    actualSubmitBtn.click();
                } else {
                    var basicBtn = document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
                                   document.querySelector('crowd-button[form-action="submit"]');
                    if (basicBtn) basicBtn.click();
                }
            })();
        `;
        if (document.documentElement) {
            document.documentElement.appendChild(script);
            script.remove();
        }
    }

    function main() {
        // ==========================================
        // 404 & SUCCESS PAGE AUTO-CLOSER (Fixed for New Tab)
        // ==========================================
        if (window.self === window.top && document.body) {
            var pageText = document.body.innerText || '';
            var is404 = pageText.includes("Sorry, we couldn't find that page");
            var isSubmitted = pageText.includes("HIT Submitted") || pageText.includes("There are no more of these HITs available");

            if (is404 || isSubmitted) {
                showBadge('closing tab...');
                setTimeout(function() {
                    window.close();
                    setTimeout(function() { window.open('', '_self'); window.close(); }, 150);
                }, 2000); // কাজ শেষ হওয়ার ২ সেকেন্ড পর কেটে যাবে
                return;
            }
        }

        if (isSagemakerIframe()) {
            setupSagemakerListener();
            setTimeout(sagemakerSubmitLoop, 500);
            return;
        }

        handleServerBusy();

        if (isPostSubmitPage()) {
            showBadge('post-submit → closing tab');
            setTimeout(function() {
                window.close();
                setTimeout(function() { window.open('', '_self'); window.close(); }, 150);
            }, 2500);
            return;
        }

        if (isQueuePage()) {
            if (!DRY_RUN) whitePageGuard();
            setTimeout(findAndClickWork, WORK_CLICK_DELAY_MS);
            setInterval(function () { if (isQueuePage()) findAndClickWork(); }, 5000);
            return;
        }

        if (isTaskPage()) {
            startParentAuthSignal();
            return;
        }

        showBadge('idle');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }
})();
