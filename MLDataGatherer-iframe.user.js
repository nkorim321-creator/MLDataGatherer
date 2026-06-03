// ==UserScript==
// @name         MLDataGatherer Iframe Stub
// @namespace    http://violentmonkey.net/
// @version      1.0
// @description  Standalone iframe-side companion for the MLDataGatherer auto-submitter. Runs ONLY inside the cross-origin SageMaker iframe that hosts the Crowd-HTML invoice form. Pair with the main MLDataGatherer script (or its payload-loaded equivalent) running on worker.mturk.com. Install this directly in Violentmonkey when the main script is delivered via a loader that does not @match sagemaker.aws.
// @author       nkorim321
// @match        https://*.public-workforce.*.sagemaker.aws/*
// @match        https://*.sagemaker.aws/work*
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataGatherer-iframe.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataGatherer-iframe.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Bail if we're not actually inside an iframe — this stub has no parent
    // to talk to from a top-level window, and should not interfere with the
    // bare /work URL if someone opens it directly.
    if (window.top === window) return;

    var TAG = '[MLDG-IF]';
    var MSG_TYPE_AUTH = 'MLDG_AUTH';
    var TRUSTED_PARENT_ORIGIN = 'https://worker.mturk.com';
    var QUEUE_URL = 'https://worker.mturk.com/tasks';
    var LOG_KEY = 'mldg_log';
    var LOG_MAX = 200;

    function tsNow() {
        var d = new Date();
        function p(n){ return n < 10 ? '0' + n : '' + n; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function log(msg) {
        var line = '[' + tsNow() + '] ' + msg;
        try { console.log(TAG + ' ' + line); } catch (e) {}
        // Local copy so the iframe's own DevTools console (and persistent
        // log on this origin) keeps a record.
        try {
            var buf = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            buf.push('(' + location.hostname + ') ' + line);
            if (buf.length > LOG_MAX) buf = buf.slice(-LOG_MAX);
            localStorage.setItem(LOG_KEY, JSON.stringify(buf));
        } catch (e) {}
        // Forward to the parent's log viewer so the operator only has to
        // look in one place.
        try { window.parent.postMessage({ type: 'MLDG_LOG', line: line, origin: location.hostname }, '*'); }
        catch (e) {}
    }

    function describeEl(el) {
        if (!el) return '(null)';
        var s = (el.tagName || '').toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') {
            s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
        }
        var attrs = [];
        if (el.getAttribute) {
            ['data-testid','role','type','aria-label','form-action','variant','name'].forEach(function (a) {
                var v = el.getAttribute(a);
                if (v) attrs.push(a + '="' + v.slice(0, 30) + '"');
            });
        }
        if (attrs.length) s += '[' + attrs.join(' ') + ']';
        var tx = (el.textContent || el.value || '').replace(/\s+/g,' ').trim().slice(0, 30);
        if (tx) s += ' txt="' + tx + '"';
        return s;
    }

    // Refuse to click anything labelled Return / Cancel / etc. The main
    // script proved this guard is necessary on the parent side; we mirror
    // it here for safety in case a future Crowd-HTML form has both Submit
    // and Return crowd-buttons.
    var FORBIDDEN_LABEL_RE = /^\s*(return|cancel|back|report\s+this\s+hit|skip|reset|clear|delete|remove|reject|close)\s*$/i;
    function isForbiddenTarget(el) {
        if (!el) return true;
        var t = (el.textContent || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\s+/g,' ').trim();
        if (FORBIDDEN_LABEL_RE.test(t)) return true;
        var href = el.getAttribute && el.getAttribute('href') || '';
        if (/\/return\b|\/cancel\b/i.test(href)) return true;
        return false;
    }

    // Full pointer-sequence click — Polymer/Crowd-HTML handlers want the
    // whole sequence, not just a bare .click().
    function fireClick(el) {
        if (!el) return false;
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

    // Listen for the auth ping from the worker.mturk.com parent. ONLY
    // messages whose ev.origin is exactly worker.mturk.com are accepted —
    // this stops any other site that embeds a SageMaker iframe from
    // auto-submitting the worker's HIT.
    var _authOk = false;
    function setupListener() {
        window.addEventListener('message', function (ev) {
            if (ev.origin !== TRUSTED_PARENT_ORIGIN) return;
            if (!ev.data || ev.data.type !== MSG_TYPE_AUTH) return;
            if (!_authOk) {
                _authOk = true;
                log('AUTH received from ' + ev.origin);
            }
        });
    }

    var _attempts = 0;
    function submitLoop() {
        if (!_authOk) {
            _attempts++;
            if (_attempts % 5 === 1) log('waiting for parent auth (try ' + _attempts + ')');
            setTimeout(submitLoop, 1000);
            return;
        }
        var btn = document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
                  document.querySelector('crowd-button[form-action="submit"]') ||
                  document.querySelector('[data-testid="crowd-submit"]');
        if (!btn) {
            _attempts++;
            if (_attempts % 5 === 1) log('crowd-button not present yet (try ' + _attempts + ')');
            setTimeout(submitLoop, 1500);
            return;
        }
        log('crowd-button found: ' + describeEl(btn));
        if (isForbiddenTarget(btn)) {
            log('REFUSED — forbidden target');
            return;
        }

        // Redirect the form's default submit into a hidden iframe so the
        // browser does not navigate the parent window to the HIT's
        // (404-returning) /submit URL when Crowd-HTML's click fires. The
        // legitimate POST to /mturk/externalSubmit still happens via
        // Crowd-HTML's own internal hidden iframe, so the HIT is submitted.
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
                log('form.target redirected to hidden iframe ' + sinkName +
                    ' (action was: ' + (form.getAttribute('action') || '(none)') + ')');
            } else {
                log('no form ancestor for crowd-button');
            }
        } catch (e) { log('form-target redirect failed: ' + e.message); }

        log('firing click on host crowd-button');
        fireClick(btn);

        // Ask the worker.mturk.com parent to navigate back to the queue.
        // The main script's parent listener accepts this only from a
        // *.sagemaker.aws origin and only when the URL targets the queue,
        // so this is safe to send unconditionally.
        setTimeout(function () {
            try {
                window.parent.postMessage({ type: 'MLDG_NAV', url: QUEUE_URL }, TRUSTED_PARENT_ORIGIN);
                log('sent MLDG_NAV to parent (→ ' + QUEUE_URL + ')');
            } catch (e) { log('postMessage err: ' + e.message); }
        }, 3500);
    }

    function main() {
        log('iframe stub v1.0 loaded on ' + location.hostname + location.pathname);
        setupListener();
        setTimeout(submitLoop, 2500);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') main();
    else document.addEventListener('DOMContentLoaded', main);
})();
