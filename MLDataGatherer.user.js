// ==UserScript==
// @name         MLDataGatherer Auto Submit
// @namespace    http://violentmonkey.net/
// @version      1.1
// @description  Auto-open & submit MLDataGatherer "Smart Capture Invoice Review - (prod)" HITs. Auto-reloads queue every 1 min with white-page protection. Captcha detection ported from NMSH VACUUM.
// @author       nkorim321
// @match        https://worker.mturk.com/*
// @match        https://www.mturk.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //  CONFIG — only act on this requester + title
    // ============================================================
    var TARGET_REQUESTER = 'MLDataGatherer';
    var TARGET_TITLE_PREFIX = 'Smart Capture Invoice Review';   // matches "... - (prod)" or "... - (..."
    var TARGET_TITLE_TAG    = '(prod)';                          // additional safety check
    var QUEUE_URL           = 'https://worker.mturk.com/tasks';
    var RELOAD_INTERVAL_MS  = 60 * 1000;                         // 1 minute
    var SUBMIT_DELAY_MS     = 3500;                              // wait before clicking Submit (React form needs time)
    var POST_SUBMIT_WAIT_MS = 8000;                              // if still on task page, force back to queue
    var WHITE_PAGE_WAIT_MS  = 10000;                             // how long to wait before deciding page is blank
    var WORK_CLICK_DELAY_MS = 1500;                              // wait after queue load before clicking Work

    var TAG = '[MLDG]';

    // ============================================================
    //  HELPERS
    // ============================================================
    function now(){ return Date.now(); }
    function log(msg, lvl){ try { console.log(TAG + ' ' + msg); } catch(e){} }
    function txt(el){ return (el && (el.innerText || el.textContent) || '').replace(/\s+/g,' ').trim(); }
    function bust(url){ return url + (url.indexOf('?') > -1 ? '&' : '?') + '_=' + now(); }
    function safeReload(){
        try { location.replace(bust(QUEUE_URL)); }
        catch(e){ try { location.href = QUEUE_URL; } catch(e2){ try { location.reload(); } catch(e3){} } }
    }

    // ============================================================
    //  CAPTCHA SYSTEM (ported from NMSH VACUUM v19)
    //  When captcha appears: audible alarm, on-screen banner, pause
    //  auto-submit until human solves it.
    // ============================================================
    var captchaSystem = {
        alertTimer: null,
        solveTimer: null,
        captchaActive: false,

        hasCaptchaInText: function (h) {
            return h ? /captchacharacters|validatecaptcha|\/captcha\/|g-recaptcha|recaptcha-checkbox|captchainput|opfcaptcha/i.test(h) : false;
        },
        hasCaptchaOnPage: function () {
            if (!document.body) return false;
            if (document.querySelector('img[src*="captcha" i],iframe[src*="recaptcha"],.g-recaptcha,.recaptcha-checkbox-border,input[name="captchacharacters"],form[action*="captcha" i]')) return true;
            return /captchacharacters|CaptchaInput|validateCaptcha|opfcaptcha/i.test(document.body.innerHTML || '');
        },
        playAlert: function () {
            try {
                var ctx = new (window.AudioContext || window.webkitAudioContext)();
                var comp = ctx.createDynamicsCompressor();
                comp.threshold.value = -3; comp.ratio.value = 15; comp.connect(ctx.destination);
                [800, 1200, 800, 1200, 600, 1000, 600, 1400].forEach(function (f, i) {
                    ['square', 'sawtooth'].forEach(function (type) {
                        var o = ctx.createOscillator(), g = ctx.createGain();
                        o.type = type; o.frequency.value = f; o.connect(g); g.connect(comp);
                        var t = ctx.currentTime + i * 0.1;
                        g.gain.setValueAtTime(type === 'square' ? 0.9 : 0.5, t);
                        g.gain.exponentialRampToValueAtTime(0.01, t + 0.09);
                        o.start(t); o.stop(t + 0.09);
                    });
                });
                setTimeout(function () { try { ctx.close(); } catch (e) {} }, 2000);
            } catch (e) {}
        },
        startRepeating: function () {
            var s = this; this.stopRepeating(); this.playAlert();
            this.alertTimer = setInterval(function () {
                if (!s.captchaActive) { s.stopRepeating(); return; }
                s.playAlert();
            }, 20000);
        },
        stopRepeating: function () {
            if (this.alertTimer) { clearInterval(this.alertTimer); this.alertTimer = null; }
        },
        showOverlay: function () {
            var ex = document.getElementById('mldg-cap-ov'); if (ex) ex.remove();
            var ov = document.createElement('div'); ov.id = 'mldg-cap-ov';
            ov.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647';
            ov.innerHTML = '<div style="background:#c0392b;color:#fff;padding:10px;text-align:center;font:bold 16px system-ui;box-shadow:0 3px 15px rgba(0,0,0,.4)">CAPTCHA — SOLVE NOW' +
                '<span style="display:block;font-size:11px;opacity:.8;margin-top:3px">Auto-submit paused — resumes when captcha is solved</span>' +
                '<button id="mldg-cap-close" style="margin-left:12px;padding:3px 10px;background:#fff;color:#c0392b;border:none;border-radius:3px;font-weight:bold;cursor:pointer">OK</button></div>';
            if (document.body) {
                document.body.appendChild(ov);
                var btn = document.getElementById('mldg-cap-close');
                if (btn) btn.onclick = function(){ ov.remove(); };
            }
        },
        removeOverlay: function () { var el = document.getElementById('mldg-cap-ov'); if (el) el.remove(); },
        startSolveMonitor: function () {
            var s = this;
            if (this.solveTimer) clearInterval(this.solveTimer);
            this.solveTimer = setInterval(function () {
                if (!s.hasCaptchaOnPage()) s.onSolved();
            }, 500);
        },
        onSolved: function () {
            if (this.solveTimer) { clearInterval(this.solveTimer); this.solveTimer = null; }
            this.stopRepeating();
            this.removeOverlay();
            this.captchaActive = false;
            log('CAPTCHA solved — resuming');
            try { GM_notification({ title: 'MLDG', text: 'CAPTCHA solved — resuming', timeout: 4000 }); } catch (e) {}
        },
        trigger: function () {
            if (this.captchaActive) return;
            this.captchaActive = true;
            log('CAPTCHA detected — pausing auto-submit');
            try { GM_notification({ title: 'CAPTCHA!', text: 'Solve to auto-resume', timeout: 30000 }); } catch (e) {}
            this.showOverlay();
            this.startRepeating();
            this.startSolveMonitor();
        },
        watch: function () {
            var s = this;
            function check() {
                if (!s.captchaActive && s.hasCaptchaOnPage()) s.trigger();
            }
            if (document.body) check();
            setInterval(check, 2000);
        }
    };

    // ============================================================
    //  SERVER-BUSY DISMISSER (Amazon "Continue shopping" page)
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
            setTimeout(safeReload, 1500);
            return true;
        }
        return false;
    }

    // ============================================================
    //  WHITE / BLANK PAGE GUARD
    //  If the queue page loads with essentially no content, hard-reload.
    // ============================================================
    function isWhitePage() {
        if (!document.body) return true;
        var html = (document.body.innerHTML || '').length;
        var text = ((document.body.innerText || '').trim()).length;
        if (html < 500 || text < 80) return true;
        // No mturk header => something's wrong
        if (!document.querySelector('a[href*="mturk"],img[alt*="mturk" i],[class*="mturk" i]')) {
            // /tasks page should ALWAYS have an mturk link somewhere
            return true;
        }
        return false;
    }
    function whitePageGuard() {
        setTimeout(function () {
            if (captchaSystem.captchaActive) return;
            if (isWhitePage()) {
                log('White/blank page detected — forcing full reload');
                safeReload();
            }
        }, WHITE_PAGE_WAIT_MS);
    }

    // ============================================================
    //  QUEUE PAGE — find target HIT and click "Work"
    // ============================================================
    function rowMatchesTarget(rowEl) {
        var t = txt(rowEl);
        if (!t) return false;
        if (t.indexOf(TARGET_REQUESTER) === -1) return false;
        if (t.indexOf(TARGET_TITLE_PREFIX) === -1) return false;
        if (t.indexOf(TARGET_TITLE_TAG) === -1) return false;
        return true;
    }

    function findAndClickWork() {
        if (captchaSystem.captchaActive) return false;

        // Each HIT in /tasks renders as a row. Try the common containers.
        var rows = document.querySelectorAll(
            'tr, [class*="task-queue" i] [class*="row" i], [data-react-class] tr, .panel, .row, [class*="task-row" i]'
        );

        for (var i = 0; i < rows.length; i++) {
            if (!rowMatchesTarget(rows[i])) continue;

            // Look for a Work button/link inside the matching row
            var candidates = rows[i].querySelectorAll('a, button, input[type="submit"]');
            for (var j = 0; j < candidates.length; j++) {
                var el = candidates[j];
                var label = (el.textContent || el.value || '').trim();
                var href  = (el.getAttribute && el.getAttribute('href')) || '';
                var isWork = /^\s*work\s*$/i.test(label) || /\/projects\/.+\/tasks\//.test(href);
                if (isWork) {
                    log('Target HIT found — clicking Work');
                    try {
                        if (href && href.indexOf('/projects/') > -1) {
                            // Navigate directly — avoids React click bubbling glitches
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
    //  TASK PAGE — verify target and click "Submit"
    // ============================================================
    function pageIsTargetTask() {
        var body = document.body ? (document.body.innerText || '') : '';
        if (body.indexOf(TARGET_REQUESTER) === -1) return false;
        if (body.indexOf(TARGET_TITLE_PREFIX) === -1) return false;
        // (prod) tag may be truncated in the header — accept either full or truncated
        return true;
    }

    // Search by text "Submit" across buttons / inputs / anchors / role=button / clickable divs/spans.
    // We pick the most-likely-clickable ancestor when the matched element is plain text.
    function findSubmitButton(root) {
        if (!root) return null;
        var candidates = [];

        // 1) Strong selectors first (id / type / class containing submit)
        var strong = [
            '#submitButton',
            'input[type="submit"]',
            'button[type="submit"]',
            '[id*="submit" i]',
            '[class*="submitButton" i]',
            '[class*="submit-button" i]',
            '[name*="submit" i]',
            '[data-testid*="submit" i]'
        ];
        for (var s = 0; s < strong.length; s++) {
            try {
                var hits = root.querySelectorAll(strong[s]);
                for (var i = 0; i < hits.length; i++) candidates.push(hits[i]);
            } catch (e) {}
        }

        // 2) Wider net by element type + label text
        try {
            var widen = root.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], div[role="button"], span[role="button"]');
            for (var j = 0; j < widen.length; j++) {
                var el = widen[j];
                var lbl = (el.value || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                if (/^submit$/i.test(lbl)) candidates.push(el);
            }
        } catch (e) {}

        // 3) Last resort: any element whose visible text is exactly "Submit" — climb to clickable parent
        try {
            var all = root.querySelectorAll('div, span, p, h1, h2, h3, h4, h5, h6');
            for (var k = 0; k < all.length; k++) {
                if (all[k].children && all[k].children.length) continue;  // leaf nodes only
                var t = (all[k].textContent || '').replace(/\s+/g, ' ').trim();
                if (/^submit$/i.test(t)) {
                    var p = all[k];
                    for (var hop = 0; hop < 5 && p; hop++) {
                        if (p.tagName === 'BUTTON' || p.tagName === 'A' || p.tagName === 'INPUT' ||
                            (p.getAttribute && (p.getAttribute('role') === 'button' || p.onclick))) {
                            candidates.push(p); break;
                        }
                        p = p.parentElement;
                    }
                    candidates.push(all[k]);  // text element itself as final fallback
                }
            }
        } catch (e) {}

        // Pick first candidate that is visible & enabled
        for (var c = 0; c < candidates.length; c++) {
            var el2 = candidates[c];
            if (!el2 || el2.disabled) continue;
            var rect = el2.getBoundingClientRect ? el2.getBoundingClientRect() : null;
            if (rect && rect.width > 0 && rect.height > 0) return el2;
        }
        // If nothing visible, return first candidate so caller can still attempt
        return candidates.length ? candidates[0] : null;
    }

    // Fire a real MouseEvent — required because React listens on synthetic events
    // and a bare `.click()` on a custom <button> sometimes no-ops.
    function fireClick(el) {
        if (!el) return false;
        try {
            var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 });
            el.dispatchEvent(ev);
        } catch (e) {}
        try { el.click(); } catch (e) {}
        return true;
    }

    function findSubmitAnywhere() {
        // Main document
        var btn = findSubmitButton(document);
        if (btn) return btn;
        // Same-origin iframes (any depth-1)
        var frames = document.querySelectorAll('iframe, frame');
        for (var i = 0; i < frames.length; i++) {
            try {
                var doc = frames[i].contentDocument;
                if (!doc) continue;
                var b = findSubmitButton(doc);
                if (b) return b;
                // Depth-2
                var inner = doc.querySelectorAll('iframe, frame');
                for (var j = 0; j < inner.length; j++) {
                    try {
                        var doc2 = inner[j].contentDocument;
                        if (!doc2) continue;
                        var b2 = findSubmitButton(doc2);
                        if (b2) return b2;
                    } catch (e2) {}
                }
            } catch (e) { /* cross-origin */ }
        }
        return null;
    }

    function clickSubmit() {
        var btn = findSubmitAnywhere();
        if (!btn) return false;

        log('Submit button located — clicking');
        showBadge('task · submit');
        fireClick(btn);

        // Belt-and-suspenders: also submit the form if there is one
        setTimeout(function () {
            try {
                var form = btn.form || (btn.closest && btn.closest('form'));
                if (form && /\/projects\/.+\/tasks\//.test(location.pathname)) {
                    log('Backup form.submit()');
                    try { form.submit(); } catch (e) {}
                }
            } catch (e) {}
        }, 800);

        return true;
    }

    var _submitAttempts = 0;
    var _submitMaxAttempts = 30;       // ~45s of retries at 1.5s
    function submitAndReturn() {
        if (captchaSystem.captchaActive) {
            showBadge('task · captcha');
            log('Captcha active — submit deferred');
            setTimeout(submitAndReturn, 3000);
            return;
        }
        if (!pageIsTargetTask()) {
            showBadge('task · skip (not target)');
            log('Not the target task — staying idle');
            return;
        }
        var clicked = clickSubmit();
        if (!clicked) {
            _submitAttempts++;
            showBadge('task · finding submit (' + _submitAttempts + ')');
            log('Submit not found yet — retry ' + _submitAttempts);
            if (_submitAttempts >= _submitMaxAttempts) {
                log('Gave up finding Submit — returning to queue');
                safeReload();
                return;
            }
            setTimeout(submitAndReturn, 1500);
            return;
        }
        // If we're still on a task page after a while, hard-return to queue
        setTimeout(function () {
            if (/\/projects\/.+\/tasks\//.test(location.pathname)) {
                log('Still on task page after submit — forcing back to queue');
                safeReload();
            }
        }, POST_SUBMIT_WAIT_MS);
    }

    // ============================================================
    //  QUEUE AUTO-RELOAD (every 1 minute, full reload)
    // ============================================================
    var lastReloadAt = now();
    function startQueueAutoReload() {
        setInterval(function () {
            if (captchaSystem.captchaActive) return;
            if (now() - lastReloadAt < RELOAD_INTERVAL_MS - 500) return;
            lastReloadAt = now();
            log('Queue auto-reload tick');
            safeReload();
        }, RELOAD_INTERVAL_MS);
    }

    // ============================================================
    //  STATUS BADGE (tiny, optional)
    // ============================================================
    function showBadge(text) {
        var b = document.getElementById('mldg-badge');
        if (!b) {
            b = document.createElement('div'); b.id = 'mldg-badge';
            b.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483646;background:#222;color:#7CFC00;font:600 11px system-ui;padding:4px 8px;border-radius:4px;opacity:.85;pointer-events:none';
            if (document.body) document.body.appendChild(b);
        }
        b.textContent = 'MLDG ' + text;
    }

    // ============================================================
    //  ROUTER
    // ============================================================
    function isQueuePage() {
        var p = location.pathname || '';
        return /^\/tasks\/?$/.test(p);
    }
    function isTaskPage() {
        var p = location.pathname || '';
        return /\/projects\/.+\/tasks\//.test(p);
    }

    function main() {
        captchaSystem.watch();
        handleServerBusy();

        if (isQueuePage()) {
            log('Queue page');
            showBadge('queue · auto');
            whitePageGuard();
            startQueueAutoReload();
            setTimeout(findAndClickWork, WORK_CLICK_DELAY_MS);
            // Re-scan every few seconds in case the row appears late
            setInterval(function () { if (isQueuePage()) findAndClickWork(); }, 5000);
            return;
        }

        if (isTaskPage()) {
            log('Task page');
            showBadge('task · checking');
            setTimeout(submitAndReturn, SUBMIT_DELAY_MS);
            return;
        }

        log('Idle on ' + location.pathname);
        showBadge('idle');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }
})();
