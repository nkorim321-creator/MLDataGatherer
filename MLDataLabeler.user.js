// ==UserScript==
// @name         MLDataLabeler Auto Submit (Anti-Conflict Version)
// @namespace    http://tampermonkey.net/
// @version      10.3
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

    // Does this element look "selected/pressed/checked"? awsui category
    // buttons don't expose a native .checked — they flip aria-pressed /
    // aria-checked / aria-selected and add a class (selected/active/
    // checked/pressed or an awsui primary-variant class). Check the element
    // and one level of descendants.
    function looksSelected(el) {
        if (!el) return false;
        function one(n) {
            if (!n || !n.getAttribute) return false;
            if (n.getAttribute('aria-pressed') === 'true') return true;
            if (n.getAttribute('aria-checked') === 'true') return true;
            if (n.getAttribute('aria-selected') === 'true') return true;
            if (n.checked === true) return true;
            var c = (typeof n.className === 'string' ? n.className : '').toLowerCase();
            if (/\b(selected|active|checked|pressed)\b/.test(c)) return true;
            if (/awsui-button-variant-primary/.test(c)) return true;
            return false;
        }
        if (one(el)) return true;
        try {
            var kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
            for (var i = 0; i < kids.length && i < 8; i++) if (one(kids[i])) return true;
        } catch (e) {}
        return false;
    }

    // Is this control actually clickable? awsui marks buttons unusable with
    // aria-disabled="true" and/or a -disabled class, NOT the native
    // .disabled property — so a plain .disabled check (as in isVisible)
    // wrongly treats them as enabled.
    function isEnabled(el) {
        if (!el) return false;
        try {
            if (el.disabled === true) return false;
            if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
            var c = (typeof el.className === 'string' ? el.className : '').toLowerCase();
            if (/\b(disabled|is-disabled|awsui-button-disabled)\b/.test(c)) return false;
            return true;
        } catch (e) { return true; }
    }

    // True if this page embeds the labeling iframe (SageMaker / mturkcontent).
    // When it does, the parent must NOT try to select/submit itself — the
    // iframe owns that — it only relays the auth handshake.
    function hasTaskIframe() {
        try {
            var ifr = document.querySelectorAll('iframe, frame');
            for (var i = 0; i < ifr.length; i++) {
                var src = ifr[i].src || '';
                if (/\.sagemaker\.aws|\.mturkcontent\.com|\.s3\.amazonaws\.com/.test(src)) return true;
            }
        } catch (e) {}
        return false;
    }

    // realClick: thorough click simulator for React-aware components like
    // SageMaker's awsui-button. v10.1's fireHostClick fired only
    // pointerdown/mousedown/pointerup/mouseup/click — React onClick
    // handlers that listen for the full hover→press→release sequence
    // (with proper clientX/clientY and focus) sometimes refuse to react
    // to a bare event series with origin (0,0). Adds:
    //  - scrollIntoView + focus so the element is genuinely interactable
    //  - pointerover/pointerenter/mouseover/mouseenter/pointermove/mousemove
    //    in the sequence (hover state most React libraries gate on)
    //  - clientX/clientY = element center so handlers that consult coords
    //    don't treat the click as "outside the button"
    //  - buttons=1 throughout the press phase
    function realClick(el) {
        if (!el) return;
        var rect;
        try { rect = el.getBoundingClientRect(); } catch (e) { rect = { left: 0, top: 0, width: 1, height: 1 }; }
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        try { el.focus(); } catch (e) {}

        var doc = el.ownerDocument || document;
        var win = doc.defaultView || window;

        function dispatch(type, init) {
            try {
                var Ctor;
                if (type.indexOf('pointer') === 0) Ctor = win.PointerEvent || win.MouseEvent;
                else if (type === 'focus' || type === 'focusin' || type === 'blur' || type === 'focusout') Ctor = win.FocusEvent;
                else Ctor = win.MouseEvent;
                var defaults = { bubbles: true, cancelable: true, view: win, button: 0, clientX: cx, clientY: cy };
                for (var k in init) defaults[k] = init[k];
                el.dispatchEvent(new Ctor(type, defaults));
            } catch (e) {}
        }

        dispatch('focusin');
        dispatch('focus');
        dispatch('pointerover', { pointerType: 'mouse' });
        dispatch('pointerenter', { pointerType: 'mouse' });
        dispatch('mouseover');
        dispatch('mouseenter');
        dispatch('pointermove', { pointerType: 'mouse' });
        dispatch('mousemove');
        dispatch('pointerdown', { pointerType: 'mouse', buttons: 1 });
        dispatch('mousedown', { buttons: 1 });
        dispatch('pointerup', { pointerType: 'mouse' });
        dispatch('mouseup');
        dispatch('click');

        try { el.click(); } catch (e) {}
    }

    // Option click: realClick + checked + change. React-state-aware option
    // groups (SageMaker category-button, crowd-radio-button) need the full
    // sequence so onClick / onChange both fire and the option actually
    // registers as selected — without that, Submit later does nothing
    // because React thinks no answer was provided.
    function selectOption(el) {
        if (!el) return;
        realClick(el);
        try { if ('checked' in el) el.checked = true; } catch (e) {}
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        // For crowd-* custom elements, also activate the shadow inner control.
        try {
            if (el.shadowRoot) {
                var inner = el.shadowRoot.querySelector('input[type="radio"], button, label');
                if (inner) {
                    realClick(inner);
                    if ('checked' in inner) inner.checked = true;
                }
            }
        } catch (e) {}
    }

    // Submit click: realClick on host ONLY (never the shadow-root inner
    // <button>, which would trigger a native form-submit to the form's
    // relative action and 404).
    function fireHostClick(el) {
        if (!el) return;
        realClick(el);
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
        log('Parent task page — confirming MLDataLabeler...');

        var isMLDataLabeler = false;

        // Always relay the auth handshake to iframes (so the SageMaker
        // iframe can proceed). Only reply once we've confirmed this is a
        // MLDataLabeler task by the requester name in the page chrome.
        window.addEventListener('message', function (ev) {
            if (!ev.data || ev.data.type !== MSG_QUERY) return;
            if (isMLDataLabeler) {
                try { ev.source.postMessage({ type: MSG_OK }, ev.origin); } catch (e) {}
            }
        });

        // ANSWER→SUBMIT LOOP. Runs continuously so multi-item HITs (one
        // HIT = many records, each submit loads the next record in place
        // with NO url change) get every item answered, not just the first.
        // The loop ends naturally when the page finally navigates away.
        //
        // If the page embeds the SageMaker/mturkcontent iframe, the parent
        // does NOT select/submit — the iframe owns that. The parent only
        // relays auth above.
        var phase = 'answer';        // 'answer' -> 'submit' -> 'answer' ...
        var phaseSince = Date.now();
        var loopAttempts = 0;

        setInterval(function () {
            loopAttempts++;

            var bodyText = document.body ? document.body.textContent : '';
            isMLDataLabeler = bodyText.indexOf(TARGET_REQUESTER) !== -1;
            if (!isMLDataLabeler) return;

            // Iframe-hosted HIT → defer entirely to the iframe.
            if (hasTaskIframe()) return;

            var opts = findOptionGroup();
            if (opts.length < 2) return;   // nothing answerable right now

            if (phase === 'answer') {
                if (opts.some(looksSelected)) { phase = 'submit'; phaseSince = Date.now(); return; }
                var idx = Math.floor(Math.random() * opts.length);
                log('Parent: ' + opts.length + ' options — selecting ' + idx + ' (' + describeEl(opts[idx]) + ')');
                selectOption(opts[idx]);
                // Move on even if selection can't be confirmed after ~1.5s.
                if (Date.now() - phaseSince > 1500) { phase = 'submit'; phaseSince = Date.now(); }
                return;
            }

            // phase === 'submit'
            var btn = findSubmitButton();
            if (btn && isEnabled(btn)) {
                log('Parent: clicking Submit ' + describeEl(btn));
                redirectFormsToSink();
                fireHostClick(btn);
            }
            // After ~2.5s go back to answering — handles the next item in a
            // multi-item HIT; for a single-item HIT the page has already
            // navigated away by now so this is a harmless no-op.
            if (Date.now() - phaseSince > 2500) { phase = 'answer'; phaseSince = Date.now(); }
        }, 1000);
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

        var authOK = false;

        window.addEventListener('message', function (ev) {
            if (ev.origin !== TRUSTED_PARENT_ORIGIN) return;
            if (!ev.data || ev.data.type !== MSG_OK) return;
            if (!authOK) {
                authOK = true;
                log('Iframe: AUTH OK from ' + ev.origin);
            }
        });

        // Keep asking the parent for auth until granted.
        setInterval(function () {
            if (authOK) return;
            try { window.parent.postMessage({ type: MSG_QUERY }, '*'); } catch (e) {}
        }, 1000);

        // ANSWER→SUBMIT LOOP (mirrors the parent loop). SageMaker labeling
        // HITs are usually MULTI-ITEM: one HIT = many records, each Submit
        // loads the next record in the SAME iframe with NO url change.
        // v10.2 stopped after the first item (submitted=true), so the
        // remaining items stayed blank and the HIT was never completed.
        // This loop answers EVERY item until the iframe finally navigates
        // away (HIT complete).
        //
        // Per item: phase 'answer' selects a random option and waits for it
        // to register (looksSelected) or ~1.5s; phase 'submit' clicks the
        // Submit button only when it's actually enabled (awsui uses
        // aria-disabled, which isEnabled() checks) then cycles back to
        // 'answer' for the next record.
        var phase = 'answer';
        var phaseSince = Date.now();
        var lastSelLog = 0;

        setInterval(function () {
            if (!authOK) return;

            var opts = findOptionGroup();
            if (opts.length < 2) return;   // nothing to answer this tick

            if (phase === 'answer') {
                if (opts.some(looksSelected)) { phase = 'submit'; phaseSince = Date.now(); return; }
                var idx = Math.floor(Math.random() * opts.length);
                if (Date.now() - lastSelLog > 700) {
                    log('Iframe: ' + opts.length + ' options — selecting ' + idx + ' (' + describeEl(opts[idx]) + ')');
                    lastSelLog = Date.now();
                }
                selectOption(opts[idx]);
                try { window.parent.postMessage({ type: MSG_SELECTED }, TRUSTED_PARENT_ORIGIN); } catch (e) {}
                if (Date.now() - phaseSince > 1500) { phase = 'submit'; phaseSince = Date.now(); }
                return;
            }

            // phase === 'submit'
            var btn = findSubmitButton();
            if (btn && isEnabled(btn)) {
                log('Iframe: clicking Submit ' + describeEl(btn));
                fireHostClick(btn);
            } else if (btn) {
                log('Iframe: Submit present but disabled (aria-disabled) — selection not registered yet.');
            }
            if (Date.now() - phaseSince > 2500) { phase = 'answer'; phaseSince = Date.now(); }
        }, 1000);
        return;
    }

    // (Any other worker.mturk.com top page: do nothing.)
})();
