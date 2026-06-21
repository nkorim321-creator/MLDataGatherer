// ==UserScript==
// @name         MLDataLabeler Auto Submit (Anti-Conflict Version)
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  Auto-selects a labeling option and submits MLDataLabeler HITs. Clicks ONLY the host crowd-submit (never the shadow inner <button>) and redirects the form target to a hidden iframe, so the HIT is credited via externalSubmit with no /submit 404. Opens HITs in background tabs to avoid conflict with Panda Crazy / Hit Catcher.
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

    const TARGET_REQUESTER = "MLDataLabeler";
    const QUEUE_URL = "https://worker.mturk.com/tasks";

    const host = location.hostname;
    const path = location.pathname || '';
    const isTop = window.self === window.top;
    const onWorker = host === 'worker.mturk.com';

    const isQueuePage   = onWorker && /^\/tasks\/?$/.test(path) && isTop;
    // The 404 page Crowd-HTML's native form-submit would have produced.
    const isSubmit404   = onWorker && /^\/projects\/[^/]+\/tasks\/[^/]+\/submit\/?$/.test(path);
    const inIframe      = !isTop;

    const log = (m) => { try { console.log("[MLDataLabeler] " + m); } catch (e) {} };

    // ==========================================================
    // STEP 0: /submit 404 recovery (top frame of a HIT tab)
    // If we ever land on the .../submit 404 (e.g. a stray native
    // form-submit slipped through), the HIT was already POSTed via
    // externalSubmit, so this tab is finished. Close it; if the
    // browser blocks close() (GM_openInTab tabs), blank it out so it
    // stops sitting on a 404.
    // ==========================================================
    if (isSubmit404) {
        log("On /submit 404 — finishing this tab.");
        setTimeout(() => {
            try { window.close(); } catch (e) {}
            try { window.top.close(); } catch (e) {}
            try { location.replace('about:blank'); } catch (e) {}
        }, 400);
        return;
    }

    // ==========================================================
    // STEP 1: QUEUE PAGE — open target-requester HITs in background tabs
    // ==========================================================
    if (isQueuePage) {
        log("Monitoring Queue for requester: " + TARGET_REQUESTER);
        const openedTasks = new Set();

        setInterval(() => {
            const workLinks = document.querySelectorAll('a[href*="/tasks/"]');
            for (let link of workLinks) {
                const parentRow = link.closest('div.table-row, tr') || link.parentElement.parentElement;
                if (!parentRow || !parentRow.textContent.includes(TARGET_REQUESTER)) continue;
                if (openedTasks.has(link.href)) continue;

                log("Target requester found — opening HIT in background tab.");
                openedTasks.add(link.href);
                link.style.border = "2px solid blue";
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
    // STEP 2: TASK LOGIC (inside the labeling iframe)
    // ==========================================================
    if (inIframe) {
        log("Running INSIDE iframe — " + host + path);

        // Recurse through shadow roots so we can see crowd-* elements.
        function getElementsDeep(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const all = root.querySelectorAll('*');
            for (let el of all) {
                if (el.shadowRoot) results = results.concat(getElementsDeep(selector, el.shadowRoot));
            }
            return results;
        }

        function isVisible(el) {
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }

        // Click for selecting a radio/category option — single, clean.
        function selectOption(el) {
            if (!el) return;
            try {
                el.click();
                if ('checked' in el) el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {}
        }

        // Full pointer/mouse sequence for the SUBMIT host element. Fired
        // exactly ONCE on the host — never on the shadow inner <button>,
        // which would trigger a native form-submit to /submit (404).
        function fireHostClick(el) {
            if (!el) return;
            const seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
            for (const type of seq) {
                try {
                    const Ctor = (type.indexOf('pointer') === 0) ? (window.PointerEvent || MouseEvent) : MouseEvent;
                    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
                } catch (e) {}
            }
            try { el.click(); } catch (e) {}
        }

        // Redirect every form's submit target into a throwaway hidden
        // iframe. Crowd-HTML still POSTs the answer to externalSubmit via
        // its OWN internal mechanism (so the HIT is credited), but the
        // form's native target="_top" navigation to /submit lands in the
        // sink instead of 404-ing the visible tab.
        function redirectFormsToSink() {
            try {
                const sinkName = 'mldl_sink_' + Date.now();
                const sink = document.createElement('iframe');
                sink.name = sinkName;
                sink.setAttribute('aria-hidden', 'true');
                sink.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;left:-9999px';
                (document.body || document.documentElement).appendChild(sink);
                const forms = getElementsDeep('form');
                forms.forEach(f => { try { f.setAttribute('target', sinkName); } catch (e) {} });
                log("Redirected " + forms.length + " form(s) to hidden sink " + sinkName);
            } catch (e) { log("sink redirect failed: " + e.message); }
        }

        let submitted = false;
        let attempts = 0;
        const taskInterval = setInterval(() => {
            if (submitted) { clearInterval(taskInterval); return; }
            attempts++;

            const options = getElementsDeep('crowd-radio-button, input[type="radio"], .category-button').filter(isVisible);

            // Find the SUBMIT host. Prefer the Crowd-HTML element by tag /
            // attribute; fall back to a button whose text is exactly Submit.
            let submitHost = null;
            const buttons = getElementsDeep(
                'crowd-submit, crowd-button[form-action="submit"], [data-testid="crowd-submit"], button, input[type="submit"], .btn-primary, .awsui-button'
            ).filter(isVisible);
            for (const btn of buttons) {
                const tag = (btn.tagName || '').toLowerCase();
                if (tag === 'crowd-submit' || tag === 'crowd-button') { submitHost = btn; break; }
                if (btn.getAttribute && btn.getAttribute('data-testid') === 'crowd-submit') { submitHost = btn; break; }
                const t = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
                if (t === 'submit' || t === 'submit hit') { submitHost = btn; break; }
            }

            if (options.length >= 2 && submitHost) {
                submitted = true;
                clearInterval(taskInterval);
                log(`Found ${options.length} visible options + submit host.`);

                // 1) Select a random visible option.
                setTimeout(() => {
                    const idx = Math.floor(Math.random() * options.length);
                    const opt = options[idx];
                    log("Selecting option index " + idx);
                    selectOption(opt);
                    if (opt.shadowRoot) {
                        const inner = opt.shadowRoot.querySelector('input[type="radio"], button, label');
                        if (inner) selectOption(inner);
                    }

                    // 2) Redirect forms, then click ONLY the host submit.
                    setTimeout(() => {
                        redirectFormsToSink();
                        log("Clicking host submit (host only, no shadow inner button).");
                        fireHostClick(submitHost);
                        log("✅ Submit dispatched via host — externalSubmit handles credit, no /submit 404.");
                    }, 1000);
                }, 1200);

            } else if (attempts > 40) {
                clearInterval(taskInterval);
                log("CRITICAL: options/submit not found after 40 attempts.");
            }
        }, 500);
        return;
    }

    // ==========================================================
    // (Any other worker.mturk.com top page: do nothing.)
    // ==========================================================
})();
