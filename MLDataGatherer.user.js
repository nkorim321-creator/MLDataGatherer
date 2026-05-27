// ==UserScript==
// @name         MLDataGatherer Auto Submit
// @namespace    http://violentmonkey.net/
// @version      1.0
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
    var SUBMIT_DELAY_MS     = 2000;                              // wait before clicking Submit
    var POST_SUBMIT_WAIT_MS = 6000;                              // if still on task page, force back to queue
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

    function findSubmitButton(root) {
        if (!root) return null;
        var nodes;
        try { nodes = root.querySelectorAll('button, input[type="submit"], input[type="button"], a'); }
        catch (e) { return null; }
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var lbl = (el.textContent || el.value || '').trim();
            if (/^\s*submit\s*$/i.test(lbl)) return el;
        }
        return null;
    }

    function clickSubmit() {
        // Main document first
        var btn = findSubmitButton(document);
        if (!btn) {
            // Then any same-origin iframe (Onphase form sometimes ships its own Submit)
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    var doc = iframes[i].contentDocument;
                    if (doc) { btn = findSubmitButton(doc); if (btn) break; }
                } catch (e) { /* cross-origin */ }
            }
        }
        if (!btn) return false;

        log('Clicking Submit');
        try { btn.click(); }
        catch (e) {
            try {
                var form = btn.form || btn.closest('form');
                if (form) form.submit();
            } catch (e2) { log('Submit fallback failed: ' + e2.message); return false; }
        }
        return true;
    }

    function submitAndReturn() {
        if (captchaSystem.captchaActive) {
            log('Captcha active — submit deferred');
            setTimeout(submitAndReturn, 3000);
            return;
        }
        if (!pageIsTargetTask()) {
            log('Not the target task — staying idle');
            return;
        }
        var clicked = clickSubmit();
        if (!clicked) {
            // Retry while page is still rendering
            log('Submit not found yet — retrying');
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
