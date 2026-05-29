// ==UserScript==
// @name         MLDataGatherer Auto Submit
// @namespace    http://violentmonkey.net/
// @version      1.12
// @description  Auto-open & submit MLDataGatherer "Smart Capture Invoice Review - (prod)" HITs. The HIT form is rendered in a cross-origin SageMaker iframe, so the script also runs there and waits for a postMessage auth signal from the worker.mturk.com parent before clicking.
// @author       nkorim321
// @match        https://worker.mturk.com/*
// @match        https://www.mturk.com/*
// @match        https://*.public-workforce.*.sagemaker.aws/*
// @match        https://*.sagemaker.aws/work*
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataGatherer.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataGatherer.user.js
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
    // DRY_RUN: when true, the script NEVER clicks Submit/Work, NEVER
    // navigates away. It only observes and writes detailed diagnostic
    // logs. v1.8-dryrun diagnostics confirmed click targeting is
    // correct (crowd-button[data-testid="crowd-submit"] in SageMaker
    // iframe, no Return-button false positives), so v1.9 ships with
    // DRY_RUN=false to enable real submission.
    var DRY_RUN = false;

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
    // Persistent log: store last 200 lines in localStorage so we keep history
    // across the page reloads that wipe the DevTools console.
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
        // If we're in an iframe, also forward to the parent so the log viewer
        // running on worker.mturk.com shows a unified timeline.
        if (window.top !== window) {
            try { window.parent.postMessage({ type: 'MLDG_LOG', line: line, origin: location.hostname }, '*'); }
            catch(e){}
        }
    }

    // Parent-side relay: capture iframe log lines into our localStorage so the
    // log viewer shows everything in one place. Also handle MLDG_NAV requests
    // from the SageMaker iframe so it can ask the parent to navigate to the
    // queue after submission (the iframe is cross-origin so it can't change
    // window.top.location itself).
    if (typeof window !== 'undefined' && window.top === window) {
        try {
            window.addEventListener('message', function (ev) {
                if (!ev.data) return;
                // MLDG_LOG — forward log line to our localStorage
                if (ev.data.type === 'MLDG_LOG' && typeof ev.data.line === 'string') {
                    try {
                        var buf = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
                        buf.push('(' + (ev.data.origin || ev.origin) + ') ' + ev.data.line);
                        if (buf.length > LOG_MAX) buf = buf.slice(-LOG_MAX);
                        localStorage.setItem(LOG_KEY, JSON.stringify(buf));
                    } catch (e) {}
                    return;
                }
                // MLDG_NAV — iframe is asking us to navigate the top window
                if (ev.data.type === 'MLDG_NAV' && typeof ev.data.url === 'string') {
                    // Only accept nav requests from sagemaker.aws iframes
                    var ok = false;
                    try { ok = /\.sagemaker\.aws$/i.test(new URL(ev.origin).hostname); } catch (e) {}
                    if (!ok) return;
                    // Only allow navigating to the worker.mturk.com queue
                    if (ev.data.url.indexOf('https://worker.mturk.com/tasks') !== 0) return;
                    log('Parent received MLDG_NAV from ' + ev.origin + ' → ' + ev.data.url);
                    setTimeout(function () {
                        try { location.replace(ev.data.url + (ev.data.url.indexOf('?') > -1 ? '&' : '?') + '_=' + Date.now()); }
                        catch (e) { try { location.href = ev.data.url; } catch (e2) {} }
                    }, 500);
                    return;
                }
            });
        } catch (e) {}
    }
    function txt(el){ return (el && (el.innerText || el.textContent) || '').replace(/\s+/g,' ').trim(); }
    function bust(url){ return url + (url.indexOf('?') > -1 ? '&' : '?') + '_=' + now(); }
    function isOnTaskPage(){
        // Real task page only — exclude the /submit 404 URL so safeReload can
        // bounce us out of it.
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(location.pathname);
    }
    // HARD SAFEGUARD: refuse to navigate away while a task is open. Leaving a task page
    // without submitting orphans the HIT, which MTurk auto-returns after 60 min — exactly
    // the symptom the worker has been hitting.
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
        try { location.replace(bust(QUEUE_URL)); }
        catch(e){ try { location.href = QUEUE_URL; } catch(e2){ try { location.reload(); } catch(e3){} } }
        return true;
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
            setTimeout(function(){ safeReload('server-busy'); }, 1500);
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
                safeReload('white-page');
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
                    if (DRY_RUN) {
                        log('Target HIT found — WOULD click Work (DRY_RUN) href=' + href + ' label="' + label + '"');
                        return true;
                    }
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

    // Collect every root we can reach: main document + same-origin iframes + open shadow roots.
    function collectRoots() {
        var roots = [document];
        function pushFrames(rootDoc) {
            var frames;
            try { frames = rootDoc.querySelectorAll('iframe, frame'); } catch (e) { return; }
            for (var i = 0; i < frames.length; i++) {
                try {
                    var doc = frames[i].contentDocument;
                    if (doc && roots.indexOf(doc) === -1) {
                        roots.push(doc);
                        pushFrames(doc);
                    } else if (!doc) {
                        log('iframe cross-origin: ' + (frames[i].src || '(no src)'));
                    }
                } catch (e) { log('iframe blocked: ' + (frames[i].src || '(no src)')); }
            }
        }
        function pushShadow(node) {
            try {
                if (node.shadowRoot && roots.indexOf(node.shadowRoot) === -1) roots.push(node.shadowRoot);
                var kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
                for (var i = 0; i < kids.length; i++) {
                    if (kids[i].shadowRoot && roots.indexOf(kids[i].shadowRoot) === -1) {
                        roots.push(kids[i].shadowRoot);
                    }
                }
            } catch (e) {}
        }
        pushFrames(document);
        for (var r = 0; r < roots.length; r++) pushShadow(roots[r]);
        return roots;
    }

    function isVisible(el) {
        if (!el) return false;
        try {
            if (el.disabled) return false;
            var rect = el.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) return false;
            // Some libraries hide via opacity / visibility — check computed style
            var doc = el.ownerDocument || document;
            var win = doc.defaultView || window;
            if (win && win.getComputedStyle) {
                var st = win.getComputedStyle(el);
                if (st && (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity || '1') < 0.1)) return false;
            }
            return true;
        } catch (e) { return true; }
    }

    // XPath text match — handles <button><span>Submit</span></button>, nested whitespace,
    // AND Amazon's <crowd-button form-action="submit" data-testid="crowd-submit"> web component
    // (the actual MTurk Submit button — Polymer custom element with shadow DOM).
    function xpathFindSubmit(root) {
        var doc = (root === document || root.nodeType === 9) ? root : (root.ownerDocument || document);
        // XPath 1.0 has no lower-case() that's portable, so we match common casings explicitly.
        // `local-name()` is needed because crowd-button may be in a namespaced parse on some engines.
        var expr =
            // Amazon Crowd HTML Elements — primary target on Smart Capture Invoice Review HITs
            ".//*[local-name()='crowd-button' and (@form-action='submit' or @data-testid='crowd-submit')]" +
            " | .//*[@data-testid='crowd-submit']" +
            " | .//*[local-name()='crowd-button' and normalize-space(.)='Submit']" +
            // Generic HTML
            " | .//button[normalize-space(.)='Submit']" +
            " | .//input[(@type='submit' or @type='button') and (normalize-space(@value)='Submit' or normalize-space(.)='Submit')]" +
            " | .//a[normalize-space(.)='Submit']" +
            " | .//*[@role='button' and normalize-space(.)='Submit']" +
            " | .//*[@aria-label='Submit' or @aria-label='submit']" +
            " | .//*[@id='submitButton' or @id='submit-button']";
        var ctx = (root === document) ? document.documentElement : root;
        if (!ctx) return [];
        try {
            var iter = doc.evaluate(expr, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            var out = [];
            for (var i = 0; i < iter.snapshotLength; i++) out.push(iter.snapshotItem(i));
            return out;
        } catch (e) { log('xpath err: ' + e.message); return []; }
    }

    // Direct CSS-selector search — simpler & more reliable than XPath for custom elements.
    // Returns array of matched elements (in scan order: most-specific first).
    function cssFindSubmit(root) {
        var selectors = [
            'crowd-button[data-testid="crowd-submit"]',
            'crowd-button[form-action="submit"]',
            'crowd-button[variant="primary"]',
            '[data-testid="crowd-submit"]',
            '[data-testid*="submit" i]',
            '#submitButton',
            'button[type="submit"]',
            'input[type="submit"]',
            '[class*="submitButton" i]',
            '[class*="submit-button" i]'
        ];
        var out = [];
        for (var s = 0; s < selectors.length; s++) {
            try {
                var hits = root.querySelectorAll(selectors[s]);
                for (var i = 0; i < hits.length; i++) {
                    if (out.indexOf(hits[i]) === -1) out.push(hits[i]);
                }
            } catch (e) {}
        }
        return out;
    }

    var _debugDumped = false;
    function debugDumpOnce(roots) {
        if (_debugDumped) return;
        _debugDumped = true;
        try {
            log('=== DEBUG DUMP === roots=' + roots.length);
            for (var r = 0; r < roots.length; r++) {
                var root = roots[r];
                var kind = (root === document) ? 'main-doc' : ((root.host ? 'shadow-root' : 'iframe-doc'));
                var url = '';
                try { url = (root.defaultView && root.defaultView.location && root.defaultView.location.href) || ''; } catch (e) {}
                var cbCount = 0, dtCount = 0, btnCount = 0;
                try { cbCount = root.querySelectorAll('crowd-button').length; } catch (e) {}
                try { dtCount = root.querySelectorAll('[data-testid="crowd-submit"]').length; } catch (e) {}
                try { btnCount = root.querySelectorAll('button').length; } catch (e) {}
                log('  root[' + r + '] ' + kind + ' url=' + url.slice(0, 80) +
                    ' crowd-button=' + cbCount + ' [data-testid=crowd-submit]=' + dtCount + ' button=' + btnCount);
            }
            // Also list all iframes in the main document with their src + access status
            var ifr = document.querySelectorAll('iframe, frame');
            log('  iframes in main-doc: ' + ifr.length);
            for (var j = 0; j < ifr.length; j++) {
                var src = ifr[j].src || ifr[j].getAttribute('srcdoc') ? '(srcdoc)' : '(no src)';
                var access = 'unknown';
                try { access = ifr[j].contentDocument ? 'OK' : 'null'; } catch (e) { access = 'BLOCKED: ' + e.message; }
                var sandbox = ifr[j].getAttribute('sandbox');
                log('    iframe[' + j + '] src=' + (ifr[j].src || src).slice(0, 80) + ' sandbox=' + (sandbox || '(none)') + ' contentDocument=' + access);
            }
            log('=== END DUMP ===');
        } catch (e) { log('debugDump err: ' + e.message); }
    }

    function findSubmitButton() {
        var roots = collectRoots();
        debugDumpOnce(roots);

        // 1) Direct CSS selector — best for custom elements like <crowd-button>
        for (var r = 0; r < roots.length; r++) {
            var hits = cssFindSubmit(roots[r]);
            if (hits.length) {
                log('CSS hit in root[' + r + ']: ' + hits.length + ' candidate(s): ' +
                    hits.slice(0, 4).map(describeEl).join(' || '));
                for (var i = 0; i < hits.length; i++) {
                    if (isForbiddenTarget(hits[i])) { log('  skip forbidden: ' + describeEl(hits[i])); continue; }
                    if (isVisible(hits[i])) return hits[i];
                }
                // No visible non-forbidden hit — return first non-forbidden anyway
                for (var i2 = 0; i2 < hits.length; i2++) {
                    if (!isForbiddenTarget(hits[i2])) return hits[i2];
                }
            }
        }

        // 2) XPath fallback for less common cases (text-only buttons, etc.)
        for (var r2 = 0; r2 < roots.length; r2++) {
            var xhits = xpathFindSubmit(roots[r2]);
            if (xhits.length) {
                log('XPath hit in root[' + r2 + ']: ' + xhits.length + ' candidate(s): ' +
                    xhits.slice(0, 4).map(describeEl).join(' || '));
                for (var k = 0; k < xhits.length; k++) {
                    if (isForbiddenTarget(xhits[k])) { log('  skip forbidden: ' + describeEl(xhits[k])); continue; }
                    if (isVisible(xhits[k])) return xhits[k];
                }
                for (var k2 = 0; k2 < xhits.length; k2++) {
                    if (!isForbiddenTarget(xhits[k2])) return xhits[k2];
                }
            }
        }
        return null;
    }

    // ABSOLUTE GUARD — never click anything labelled Return / Cancel / etc.
    // v1.6's CSS selector `button[type="submit"]` matched MTurk's "Return"
    // button (which is technically a submit button for the return-HIT form),
    // causing the script to return every HIT it touched. We reject these
    // labels here regardless of which selector matched.
    var FORBIDDEN_LABEL_RE = /^\s*(return|cancel|back|report\s+this\s+hit|skip|reset|clear|delete|remove|reject|close)\s*$/i;
    function isForbiddenTarget(el) {
        if (!el) return true;
        var t = (el.textContent || el.value || el.getAttribute && el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (FORBIDDEN_LABEL_RE.test(t)) return true;
        // Also guard against href / form-action that returns/cancels
        var href = el.getAttribute && el.getAttribute('href') || '';
        if (/\/return\b|\/cancel\b/i.test(href)) return true;
        return false;
    }

    // Dispatch a full pointer sequence so React onClick handlers always fire.
    function fireClick(el) {
        if (!el) return false;
        if (isForbiddenTarget(el)) {
            log('fireClick REFUSED — forbidden target: ' + describeEl(el));
            return false;
        }
        if (DRY_RUN) {
            log('fireClick SKIPPED (DRY_RUN) on ' + describeEl(el));
            return false;
        }
        var doc = el.ownerDocument || document;
        var win = (doc && doc.defaultView) || window;
        var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (var i = 0; i < seq.length; i++) {
            try {
                var Ctor = (seq[i].indexOf('pointer') === 0) ? (win.PointerEvent || win.MouseEvent) : win.MouseEvent;
                var ev = new Ctor(seq[i], { bubbles: true, cancelable: true, view: win, button: 0 });
                el.dispatchEvent(ev);
            } catch (e) {}
        }
        try { el.click(); } catch (e) {}
        return true;
    }

    // Compact human-readable description of an element for logs
    function describeEl(el){
        if (!el) return '(null)';
        var s = (el.tagName || '').toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0,2).join('.');
        var attrs = [];
        if (el.getAttribute){
            ['data-testid','role','type','aria-label','form-action','variant','name','value','href'].forEach(function(a){
                var v = el.getAttribute(a);
                if (v) attrs.push(a + '="' + v.slice(0,30) + '"');
            });
        }
        if (attrs.length) s += '[' + attrs.join(' ') + ']';
        var tx = (el.textContent || el.value || '').replace(/\s+/g,' ').trim().slice(0, 30);
        if (tx) s += ' txt="' + tx + '"';
        return s;
    }

    // Track last URL to detect successful navigation after click
    var _preSubmitHref = '';

    // Helper: walk up parents AND host parents (for shadow DOM) to find a matching ancestor
    function closestAcrossShadow(el, predicate) {
        var node = el;
        while (node) {
            if (predicate(node)) return node;
            if (node.parentElement) { node = node.parentElement; continue; }
            // crossed a shadow boundary
            var root = node.getRootNode && node.getRootNode();
            if (root && root.host) { node = root.host; continue; }
            node = null;
        }
        return null;
    }

    function clickSubmit() {
        var btn = findSubmitButton();
        if (!btn) return false;

        var tag = (btn.tagName || '') + (btn.id ? '#' + btn.id : '');
        log('Submit located: ' + tag + ' | text="' + ((btn.textContent || btn.value || '').trim().slice(0, 40)) + '"');
        showBadge('task · clicking submit');
        _preSubmitHref = location.href;

        // 1. Click the host element — for <crowd-button>, Polymer listens here.
        fireClick(btn);

        // 2. If it's a <crowd-button>, also click the internal <button> inside its shadow root.
        try {
            if (btn.tagName && btn.tagName.toLowerCase() === 'crowd-button' && btn.shadowRoot) {
                var innerBtn = btn.shadowRoot.querySelector('button');
                if (innerBtn) {
                    log('crowd-button shadow click');
                    fireClick(innerBtn);
                }
            }
        } catch (e) {}

        // 3. Backups — run after the visible click has had a chance to navigate.
        setTimeout(function () {
            if (location.href !== _preSubmitHref) return;       // already submitted, done
            try {
                // 3a. <crowd-form>.submit() — Amazon's wrapper exposes a submit method
                var crowdForm = closestAcrossShadow(btn, function (n) {
                    return n.tagName && n.tagName.toLowerCase() === 'crowd-form';
                });
                if (crowdForm) {
                    if (DRY_RUN) log('Backup crowd-form.submit() SKIPPED (DRY_RUN) on ' + describeEl(crowdForm));
                    else {
                        log('Backup crowd-form.submit()');
                        try {
                            if (typeof crowdForm.submit === 'function') crowdForm.submit();
                            else if (typeof crowdForm.onSubmit === 'function') crowdForm.onSubmit();
                        } catch (e) {}
                    }
                }
                // 3b. Standard <form>.requestSubmit() / submit() as final fallback
                var form = btn.form || closestAcrossShadow(btn, function (n) {
                    return n.tagName && n.tagName.toLowerCase() === 'form';
                });
                if (form && location.href === _preSubmitHref) {
                    if (DRY_RUN) log('Backup form.requestSubmit/submit SKIPPED (DRY_RUN) on ' + describeEl(form));
                    else {
                        log('Backup form.requestSubmit/submit');
                        try {
                            if (typeof form.requestSubmit === 'function') form.requestSubmit();
                            else form.submit();
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }, 1500);

        return true;
    }

    var _submitAttempts = 0;
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
            if (_submitAttempts % 5 === 1) log('Submit not found — retry ' + _submitAttempts);
            // NEVER auto-return the HIT. Just keep retrying for as long as the HIT is open.
            // Worker can manually submit if script truly fails.
            setTimeout(submitAndReturn, 2000);
            return;
        }
        // Verify click actually did something — re-check after wait window.
        // Only go back to queue if URL changed (real submission happened).
        setTimeout(function () {
            if (location.href !== _preSubmitHref) return;             // already navigated by MTurk
            if (!/\/projects\/.+\/tasks\//.test(location.pathname)) return;
            // Still on the same task page — click probably failed silently. Retry instead of leaving.
            log('Post-submit: still on task page — re-trying submit');
            _submitAttempts = 0;
            submitAndReturn();
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
            // Extra guard: if user navigated away to a task page in the meantime, stop.
            if (isOnTaskPage()) return;
            lastReloadAt = now();
            log('Queue auto-reload tick');
            safeReload('queue-tick');
        }, RELOAD_INTERVAL_MS);
    }

    // ============================================================
    //  STATUS BADGE + LOG VIEWER (persists across reloads)
    //  Click the badge to expand the last 200 log lines pulled from
    //  localStorage. "Copy" copies them to clipboard, "Clear" resets.
    // ============================================================
    function showBadge(text) {
        if (window.top !== window) return;  // do not render UI inside iframes
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
        // Auto-refresh while open
        var iv = setInterval(function(){
            if (!document.body.contains(v)){ clearInterval(iv); return; }
            refresh();
        }, 1500);
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
        // Match /projects/{pid}/tasks/{tid} ONLY (not the /submit 404 URL)
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/?$/.test(p);
    }
    // After Crowd-HTML submits, MTurk redirects the parent to a URL that
    // 404s: /projects/{pid}/tasks/{tid}/submit. The externalSubmit POST has
    // already happened (we see the iframe load), so the HIT submission is
    // complete — we just need to bounce off this 404 back to the queue.
    function isPostSubmitPage() {
        var p = location.pathname || '';
        return /^\/projects\/[^\/]+\/tasks\/[^\/]+\/submit\/?$/.test(p);
    }
    // True when this script instance is running inside the cross-origin
    // SageMaker iframe that hosts the Crowd-HTML form.
    function isSagemakerIframe() {
        if (window.top === window) return false;
        return /\.sagemaker\.aws$/i.test(location.hostname);
    }

    // ============================================================
    //  POSTMESSAGE AUTH PROTOCOL
    //  Parent on worker.mturk.com confirms "this is MLDataGatherer"
    //  to the cross-origin SageMaker iframe before the iframe clicks
    //  Submit. Without this, accepting any other requester's HIT
    //  whose form happens to be served from SageMaker would be
    //  auto-submitted — we must not interfere with non-target HITs.
    // ============================================================
    var MSG_TYPE_AUTH = 'MLDG_AUTH';
    var TRUSTED_PARENT_ORIGIN = 'https://worker.mturk.com';

    function startParentAuthSignal() {
        // Verify parent page is the target task first
        if (!pageIsTargetTask()) {
            log('parent: not target task, not signalling iframes');
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
            if (_iframeAttempts % 5 === 1) log('sagemaker: waiting for parent auth (try ' + _iframeAttempts + ')');
            setTimeout(sagemakerSubmitLoop, 1000);
            return;
        }
        // Look for crowd-button right here in this (iframe) document.
        var btn = document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
                  document.querySelector('crowd-button[form-action="submit"]') ||
                  document.querySelector('[data-testid="crowd-submit"]');
        if (!btn) {
            _iframeAttempts++;
            if (_iframeAttempts % 5 === 1) log('sagemaker: crowd-button not present yet (try ' + _iframeAttempts + ')');
            setTimeout(sagemakerSubmitLoop, 1500);
            return;
        }
        log('sagemaker: crowd-button found: ' + describeEl(btn));
        if (isForbiddenTarget(btn)) {
            log('sagemaker: REFUSED — forbidden target');
            return;
        }
        _preSubmitHref = location.href;

        // BEFORE clicking, redirect the underlying <form>'s submit target to
        // a hidden iframe of our own. The form.action is set by the HIT to
        // a worker.mturk.com URL that 404s — when Crowd-HTML's click handler
        // fires, the browser's default form-submit also triggers and posts
        // to that URL with target="_top", navigating the parent to a 404.
        // Sending the default submit into a hidden iframe makes it a no-op
        // while leaving Crowd-HTML's own POST to /mturk/externalSubmit
        // (which still happens via Crowd-HTML's own hidden iframe) intact.
        try {
            var form = btn.closest && btn.closest('form');
            if (form) {
                var sinkName = 'mldg_sink_' + Date.now();
                var sink = document.createElement('iframe');
                sink.name = sinkName;
                sink.setAttribute('aria-hidden', 'true');
                sink.style.cssText = 'display:none;width:0;height:0;border:0;visibility:hidden;position:absolute;left:-9999px';
                (document.body || document.documentElement).appendChild(sink);
                form.setAttribute('target', sinkName);
                log('sagemaker: form.target redirected to hidden iframe ' + sinkName + ' (action was: ' + (form.getAttribute('action') || '(none)') + ')');
            } else {
                log('sagemaker: no form ancestor for crowd-button (cannot redirect target)');
            }
        } catch (e) { log('sagemaker: form-target redirect failed: ' + e.message); }

        // CRITICAL: Click ONLY the host <crowd-button>. Crowd-HTML's own
        // listener on the host element routes the submission via a hidden
        // iframe POST to ${turkSubmitTo}/mturk/externalSubmit — the correct
        // legacy MTurk endpoint that actually accepts the HIT.
        log('sagemaker: firing click on host crowd-button');
        fireClick(btn);

        // Ask the parent to navigate back to the queue. The parent's
        // postMessage listener checks ev.origin so this is safe.
        setTimeout(function () {
            try {
                window.parent.postMessage({ type: 'MLDG_NAV', url: QUEUE_URL }, TRUSTED_PARENT_ORIGIN);
                log('sagemaker: sent MLDG_NAV to parent (→ ' + QUEUE_URL + ')');
            } catch (e) { log('sagemaker: postMessage err: ' + e.message); }
        }, 3500);

        // Verify after 8s. If still on the same URL, retry — but do NOT
        // touch the shadow root or call raw form.submit() this time either.
        setTimeout(function () {
            if (location.href === _preSubmitHref) {
                log('sagemaker: URL unchanged after click, re-trying host click');
                sagemakerSubmitLoop();
            } else {
                log('sagemaker: URL changed to ' + location.href.slice(0, 100));
            }
        }, 8000);
    }

    var V = '1.12' + (DRY_RUN ? ' [DRY-RUN]' : '');
    // One-time log wipe on version change so the unified log viewer
    // is not polluted with messages from older versions.
    try {
        var lastVer = localStorage.getItem('mldg_last_ver');
        if (lastVer !== V) {
            localStorage.removeItem(LOG_KEY);
            localStorage.setItem('mldg_last_ver', V);
        }
    } catch (e) {}
    function main() {
        log('=========================================');
        log('v' + V + ' loaded on ' + location.hostname + location.pathname +
            (window.top !== window ? ' (iframe)' : ' (top)'));
        if (DRY_RUN) log('DRY_RUN=true — NO clicks, NO navigation, NO submits will happen. Observe-only mode.');

        // SAGEMAKER IFRAME CONTEXT — script is running inside the cross-origin
        // SageMaker iframe that hosts the Crowd-HTML form. Wait for an auth
        // postMessage from worker.mturk.com parent, then click crowd-button.
        if (isSagemakerIframe()) {
            log('SageMaker iframe context — waiting for parent auth');
            setupSagemakerListener();
            setTimeout(sagemakerSubmitLoop, 2500);
            return;
        }

        // Everything below = parent window on worker.mturk.com / www.mturk.com
        captchaSystem.watch();
        handleServerBusy();

        // POST-SUBMIT 404 RECOVERY
        // Crowd-HTML's form-submit lands the parent on
        // /projects/{pid}/tasks/{tid}/submit, which 404s. The actual HIT
        // submission happens via a hidden iframe POST to externalSubmit
        // before this navigation, so the 404 is a UI artefact only — we
        // just need to bounce off it back to the queue.
        if (isPostSubmitPage()) {
            log('Post-submit 404 page — bouncing to queue in 800ms');
            showBadge('v' + V + ' post-submit → queue');
            setTimeout(function () {
                try { location.replace(bust(QUEUE_URL)); }
                catch (e) { try { location.href = QUEUE_URL; } catch (e2) {} }
            }, 800);
            return;
        }

        if (isQueuePage()) {
            log('Queue page');
            showBadge('v' + V + ' queue');
            if (!DRY_RUN) {
                whitePageGuard();
                startQueueAutoReload();
            } else {
                log('Queue auto-reload DISABLED (DRY_RUN)');
            }
            setTimeout(findAndClickWork, WORK_CLICK_DELAY_MS);
            setInterval(function () { if (isQueuePage()) findAndClickWork(); }, 5000);
            return;
        }

        if (isTaskPage()) {
            // Parent NEVER tries to find / click Submit directly on the task
            // page anymore — that's how v1.6 ended up clicking "Return"
            // (which is `<button type="submit">` in MTurk's UI). Submission is
            // owned entirely by the SageMaker iframe handler now.
            log('Task page — signalling SageMaker iframe');
            showBadge('v' + V + ' task · iframe-signal');
            startParentAuthSignal();
            return;
        }

        log('Idle on ' + location.pathname);
        showBadge('v' + V + ' idle');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        main();
    } else {
        document.addEventListener('DOMContentLoaded', main);
    }
})();
