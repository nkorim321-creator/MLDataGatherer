// ==UserScript==
// @name         MLDataLabeler Auto Submit (Anti-Conflict Version)
// @namespace    http://tampermonkey.net/
// @version      10.1
// @description  Auto-selects a labeling option (Positive/Negative/Neutral or whatever's offered) for MLDataLabeler HITs and clicks the MTurk Submit. Works whether the form is rendered directly on worker.mturk.com OR inside a cross-origin iframe — iframe→parent postMessage handshake coordinates the two layouts. Opens HITs in background tabs to avoid Panda Crazy / Hit Catcher conflicts.
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.sagemaker.aws/*
// @allFrames    true
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataLabeler.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/claude/quirky-galileo-40UCt/MLDataLabeler.user.js
// ==/UserScript==

(function () {
    'use strict';

    var TARGET_REQUESTER       = 'MLDataLabeler';
    var TRUSTED_PARENT_ORIGIN  = 'https://worker.mturk.com';
    var MSG_QUERY              = 'MLDL_QUERY';     // iframe → parent: am I in a target task?
    var MSG_OK                 = 'MLDL_OK';        // parent → iframe: yes, proceed
    var MSG_SELECTED           = 'MLDL_SELECTED';  // iframe → parent: option clicked, please Submit

    var host    = location.hostname;
    var path    = location.pathname || '';
    var isTop   = window.self === window.top;
    var onWorker = host === 'worker.mturk.com';

    var isQueuePage      = onWorker && /^\/tasks\/?$/.test(path) && isTop;
    var isTaskPageParent = onWorker && isTop && /^\/projects\/[^/]+\/tasks\/[^/]+\/?$/.test(path);
    var isSubmit404      = onWorker && /^\/projects\/[^/]+\/tasks\/[^/]+\/submit\/?$/.test(path);
    var inIframe         = !isTop;

    function log(m){ try { console.log('[MLDataLabeler] ' + m); } catch (e) {} }

    // Never click buttons whose visible label is one of these — Return,
    // Cancel, Report, etc. would either return the HIT or open a modal.
    var FORBIDDEN_LABEL_RE = /^\s*(return|cancel|back|skip|reset|clear|delete|remove|reject|close|report\s+this\s+hit|why\s+report|report|instructions|shortcuts)\s*$/i;
    function isForbiddenTarget(el) {
        if (!el) return true;
        var t = (el.textContent || el.value || (el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\s+/g, ' ').trim();
        if (FORBIDDEN_LABEL_RE.test(t)) return true;
        var href = el.getAttribute && el.getAttribute('href') || '';
        if (/\/return\b|\/cancel\b/i.test(href)) return true;
        return false;
    }

    // Recurse through every shadow root so we can see <crowd-*> internals.
    function getElementsDeep(selector, root) {
        root = root || document;
        var results;
        try { results = Array.prototype.slice.call(root.querySelectorAll(selector)); }
        catch (e) { return []; }
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) results = results.concat(getElementsDeep(selector, all[i].shadowRoot));
        }
        return results;
    }

    function isVisible(el) {
        if (!el || el.disabled) return false;
        try {
            var r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            var doc = el.ownerDocument || document;
            var win = doc.defaultView || window;
            if (win && win.getComputedStyle) {
                var st = win.getComputedStyle(el);
                if (st && (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity || '1') < 0.1)) return false;
            }
            return true;
        } catch (e) { return true; }
    }

    function describeEl(el) {
        if (!el) return '(null)';
        var s = (el.tagName || '').toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
        var t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        if (t) s += ' txt="' + t + '"';
        return s;
    }

    // Select-an-option click — single clean click + change event. No
    // double-fire, because triple-clicking a toggle can un-select it.
    function selectOption(el) {
        if (!el) return;
        try { el.click(); } catch (e) {}
        try { if ('checked' in el) el.checked = true; } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        // For crowd-* custom elements, also click the shadow inner radio/label.
        try {
            if (el.shadowRoot) {
                var inner = el.shadowRoot.querySelector('input[type="radio"], button, label');
                if (inner) {
                    try { inner.click(); } catch (e) {}
                    if ('checked' in inner) inner.checked = true;
                }
            }
        } catch (e) {}
    }

    // Submit click — full pointer/mouse sequence on the host element ONLY.
    // Never the shadow-root inner <button>, because that triggers a native
    // form-submit to the form's action (often /submit → 404).
    function fireHostClick(el) {
        if (!el) return;
        var doc = el.ownerDocument || document;
        var win = doc.defaultView || window;
        var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (var i = 0; i < seq.length; i++) {
            try {
                var Ctor = (seq[i].indexOf('pointer') === 0) ? (win.PointerEvent || win.MouseEvent) : win.MouseEvent;
                el.dispatchEvent(new Ctor(seq[i], { bubbles: true, cancelable: true, view: win, button: 0 }));
            } catch (e) {}
        }
        try { el.click(); } catch (e) {}
    }

    // Redirect every form's submit target into a throwaway hidden iframe so
    // any stray native form-submit (action=/submit) lands in the sink and
    // doesn't 404 the visible tab. MTurk's real submission still goes
    // through MTurk's own button POST below.
    function redirectFormsToSink(root) {
        root = root || document;
        try {
            var sinkName = 'mldl_sink_' + Date.now();
            var sink = document.createElement('iframe');
            sink.name = sinkName;
            sink.setAttribute('aria-hidden', 'true');
            sink.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;left:-9999px';
            (document.body || document.documentElement).appendChild(sink);
            var forms = getElementsDeep('form', root);
            for (var i = 0; i < forms.length; i++) {
                try { forms[i].setAttribute('target', sinkName); } catch (e) {}
            }
            if (forms.length) log('Redirected ' + forms.length + ' form(s) → ' + sinkName);
        } catch (e) {}
    }

    // Look for a group of 2+ visible, clickable, non-forbidden elements that
    // sit under the same parent — that's almost always a multi-choice option
    // list. Returns [] if no such group exists (e.g. options live in an
    // iframe we can't see).
    // Only match real labeling controls. Plain <button>, [role="button"],
    // <li>, <a>, <div onclick> are too broad — v10.0 matched the page-
    // footer nav (<li class="nav-item">) as a 6-option group and clicked
    // "Feedback". Buttons must explicitly look like option/answer/category
    // controls; everything inside <nav>/<footer>/<header>/.navbar/.nav-*
    // is dropped.
    function findOptionGroup() {
        var raw = getElementsDeep([
            'crowd-radio-button',
            'crowd-checkbox',
            'input[type="radio"]',
            'input[type="checkbox"]',
            '[role="radio"]',
            'button.category-button',                 // SageMaker labeling
            'button[class*="option" i]',
            'button[class*="answer" i]',
            'button[class*="category" i]',
            'button[class*="choice" i]',
            'button[class*="label" i]',
            '.category-button',
            '.option-button',
            '.answer-button',
            '.choice-button'
        ].join(', '));

        var pool = [];
        for (var i = 0; i < raw.length; i++) {
            var el = raw[i];
            if (!isVisible(el) || isForbiddenTarget(el)) continue;
            // Drop anything inside a navigation context — that's how
            // v10.0 picked the footer "Feedback" link.
            if (el.closest && (
                el.closest('nav') ||
                el.closest('footer') ||
                el.closest('header') ||
                el.closest('[role="navigation"]') ||
                el.closest('[role="contentinfo"]') ||
                el.closest('[role="banner"]') ||
                el.closest('.navbar') ||
                el.closest('.footer') ||
                el.closest('.nav-item') ||
                el.closest('.nav-link')
            )) continue;
            // Plain <button> with exact text "Submit"/"Submit HIT" is the
            // Submit, not an option.
            var t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === 'submit' || t === 'submit hit' || t === 'submit answer') continue;
            pool.push(el);
        }

        var groups = new Map();
        for (var j = 0; j < pool.length; j++) {
            var parent = pool[j].parentElement;
            if (!parent) continue;
            if (!groups.has(parent)) groups.set(parent, []);
            groups.get(parent).push(pool[j]);
        }
        var best = [];
        groups.forEach(function (arr) {
            if (arr.length >= 2 && arr.length <= 12 && arr.length > best.length) best = arr;
        });
        return best;
    }

    function findSubmitButton() {
        var raw = getElementsDeep(
            'crowd-submit, crowd-button[form-action="submit"], [data-testid="crowd-submit"], #submitButton, [id*="submit" i], input[type="submit"], button[type="submit"], button, [role="button"]'
        );
        // First pass: highest-confidence selectors.
        for (var i = 0; i < raw.length; i++) {
            var el = raw[i];
            if (!isVisible(el) || isForbiddenTarget(el)) continue;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'crowd-submit') return el;
            if (tag === 'crowd-button' && el.getAttribute && el.getAttribute('form-action') === 'submit') return el;
            if (el.getAttribute && el.getAttribute('data-testid') === 'crowd-submit') return el;
        }
        // Second pass: text-based match on plain buttons.
        for (var k = 0; k < raw.length; k++) {
            var el2 = raw[k];
            if (!isVisible(el2) || isForbiddenTarget(el2)) continue;
            var t = (el2.textContent || el2.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === 'submit' || t === 'submit hit' || t === 'submit answer') return el2;
        }
        return null;
    }

    // ==========================================================
    // STEP 0: /submit 404 recovery — close the tab; the real submit
    //         already POSTed before this navigation slipped through.
    // ==========================================================
    if (isSubmit404) {
        log('On /submit 404 — finishing this tab.');
        setTimeout(function () {
            try { window.close(); } catch (e) {}
            try { window.top.close(); } catch (e) {}
            try { location.replace('about:blank'); } catch (e) {}
        }, 400);
        return;
    }

    // ==========================================================
    // STEP 1: QUEUE PAGE — open target HITs in background tabs.
    // ==========================================================
    if (isQueuePage) {
        log('Monitoring Queue for requester: ' + TARGET_REQUESTER);
        var openedTasks = new Set();
        setInterval(function () {
            var workLinks = document.querySelectorAll('a[href*="/tasks/"]');
            for (var i = 0; i < workLinks.length; i++) {
                var link = workLinks[i];
                var parentRow = link.closest('div.table-row, tr') || (link.parentElement && link.parentElement.parentElement);
                if (!parentRow || !parentRow.textContent.includes(TARGET_REQUESTER)) continue;
                if (openedTasks.has(link.href)) continue;
                log('Target requester row found — opening in background tab.');
                openedTasks.add(link.href);
                try { link.style.border = '2px solid blue'; } catch (e) {}
                if (typeof GM_openInTab !== 'undefined') {
                    GM_openInTab(link.href, { active: false, insert: true });
                } else {
                    window.open(link.href, '_blank');
                }
                break;
            }
        }, 2000);
        return;
    }

    // ==========================================================
    // STEP 2A: PARENT TASK PAGE (worker.mturk.com/projects/.../tasks/...)
    // The screenshot in v9.0's bug report shows this is where the form
    // and the orange Submit button live for at least one MLDataLabeler
    // task type ("Text Classification (Single Label)"). Handle BOTH:
    //   - options + Submit directly on this page (most common)
    //   - options inside a cross-origin iframe → wait for MLDL_SELECTED
    //     postMessage, then click Submit on this page
    // ==========================================================
    if (isTaskPageParent) {
        log('Parent task page — waiting to confirm MLDataLabeler.');

        var isMLDataLabeler = false;
        var optionSelected  = false;
        var optionSelectedAt = 0;
        var submitClicked   = false;
        var attempts        = 0;

        // 1. Handle iframe handshake + selection notifications.
        window.addEventListener('message', function (ev) {
            if (!ev.data || !ev.data.type) return;
            if (ev.data.type === MSG_QUERY) {
                if (isMLDataLabeler) {
                    try { ev.source.postMessage({ type: MSG_OK }, ev.origin); } catch (e) {}
                }
                return;
            }
            if (ev.data.type === MSG_SELECTED) {
                log('Iframe (' + ev.origin + ') reported option selection.');
                if (!optionSelected) {
                    optionSelected = true;
                    optionSelectedAt = Date.now();
                }
            }
        });

        function maybeSubmit() {
            if (submitClicked || !optionSelected) return;
            if (Date.now() - optionSelectedAt < 700) return;  // brief settle
            var btn = findSubmitButton();
            if (!btn) return;
            log('Clicking Submit on parent: ' + describeEl(btn));
            redirectFormsToSink();
            fireHostClick(btn);
            submitClicked = true;
            log('✅ Submit dispatched.');
        }

        var tick = setInterval(function () {
            if (submitClicked) { clearInterval(tick); return; }
            attempts++;

            var bodyText = document.body ? document.body.textContent : '';
            isMLDataLabeler = bodyText.indexOf(TARGET_REQUESTER) !== -1;
            if (!isMLDataLabeler) {
                if (attempts > 40) { clearInterval(tick); log('Not a MLDataLabeler task — giving up.'); }
                return;
            }

            // Try to select an option directly on this page.
            if (!optionSelected) {
                var opts = findOptionGroup();
                if (opts.length >= 2) {
                    var idx = Math.floor(Math.random() * opts.length);
                    log('Parent: ' + opts.length + ' options visible — selecting index ' + idx + ' (' + describeEl(opts[idx]) + ')');
                    selectOption(opts[idx]);
                    optionSelected = true;
                    optionSelectedAt = Date.now();
                }
            }

            maybeSubmit();

            if (attempts > 80) {
                clearInterval(tick);
                log('Parent: gave up after 80 attempts. optionSelected=' + optionSelected + ' submitClicked=' + submitClicked);
            }
        }, 500);
        return;
    }

    // ==========================================================
    // STEP 2B: IFRAME — form lives inside a cross-origin iframe.
    // Wait for the parent to confirm "yes this is MLDataLabeler",
    // then select an option, post MLDL_SELECTED so the parent can
    // click its Submit, and as backup click any Submit visible
    // inside this iframe too (form-target redirect prevents 404).
    // ==========================================================
    if (inIframe) {
        log('Inside iframe — ' + host + path);

        var authOK    = false;
        var submitted = false;
        var queryTimer = null;

        window.addEventListener('message', function (ev) {
            if (ev.origin !== TRUSTED_PARENT_ORIGIN) return;
            if (!ev.data || ev.data.type !== MSG_OK) return;
            if (!authOK) {
                authOK = true;
                log('Iframe: AUTH OK from ' + ev.origin);
            }
        });

        queryTimer = setInterval(function () {
            if (authOK || submitted) { clearInterval(queryTimer); return; }
            try { window.parent.postMessage({ type: MSG_QUERY }, '*'); } catch (e) {}
        }, 1000);

        var attempts2 = 0;
        var tick2 = setInterval(function () {
            if (submitted) { clearInterval(tick2); return; }
            attempts2++;
            if (!authOK) {
                if (attempts2 > 30) { clearInterval(tick2); log('Iframe: no parent auth after 30 ticks — idle.'); }
                return;
            }

            var opts = findOptionGroup();
            if (opts.length >= 2) {
                var idx = Math.floor(Math.random() * opts.length);
                log('Iframe: ' + opts.length + ' options — selecting ' + idx + ' (' + describeEl(opts[idx]) + ')');
                selectOption(opts[idx]);

                try {
                    window.parent.postMessage({ type: MSG_SELECTED }, TRUSTED_PARENT_ORIGIN);
                    log('Iframe: notified parent (MLDL_SELECTED).');
                } catch (e) {}

                // If the iframe also has a Submit button, click it.
                //
                // We do NOT redirectFormsToSink() here. SageMaker labeling
                // forms (awsui-button) submit through the form's real
                // action endpoint — diverting target to a hidden iframe
                // (as the v10.0 code did) caused the POST to land in the
                // sink, and the HIT was never actually submitted. The
                // parent's STEP 0 /submit-404 recovery catches any stray
                // navigation if the form does turn out to misroute.
                setTimeout(function () {
                    var btn = findSubmitButton();
                    if (btn) {
                        log('Iframe: clicking local Submit ' + describeEl(btn));
                        fireHostClick(btn);
                    }
                }, 900);

                submitted = true;
                clearInterval(tick2);
            } else if (attempts2 > 60) {
                clearInterval(tick2);
                log('Iframe: no option group found after 60 ticks — idle.');
            }
        }, 500);
        return;
    }

    // (Any other worker.mturk.com top page: do nothing.)
})();
