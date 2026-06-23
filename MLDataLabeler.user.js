// ==UserScript==
// @name         MLDataLabeler Auto Submit (Weighted Selection)
// @namespace    http://tampermonkey.net/
// @version      22.0
// @description  Weighted radio selection + auto-submit, gated by a Worker-ID allowlist (Google Sheet)
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.sagemaker.aws/*
// @allFrames    true
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        window.close
// @connect      docs.google.com
// @connect      *.google.com
// ==/UserScript==

(function() {
    'use strict';

    const targetRequester = "MLDataLabeler";

    // ================================================================
    //  ACCESS CONTROL — Worker-ID allowlist (Google Sheet), live + fresh.
    //  Only Worker IDs listed in the sheet may run; everyone else is blocked
    //  with a warning. worker.mturk.com detects the Worker ID, verifies it
    //  against the sheet, and publishes ml_auth for the task iframe to read.
    // ================================================================
    const MLACL = {
        sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/1p03KacnfGQhtXm7umEnbktki3wCpaVzC_16W51iKn6U/gviz/tq?tqx=out:csv',
        allowlistTtl: 30000,   // soft cache for periodic re-check; work-time check is always fresh
        authMaxAge:   90000,   // an ml_auth result older than this is treated as stale
        recheckMs:    8000,    // how often worker.mturk.com re-verifies
    };
    const mlSleep = (ms) => new Promise(r => setTimeout(r, ms));

    function detectWorkerIds() {
        const out = new Set();
        let html = '';
        try { html = (document.documentElement && document.documentElement.innerHTML) || ''; } catch (e) {}
        let primary = null;
        const strong = html.matchAll(/"(?:workerId|subjectId)"\s*:\s*"(A[A-Z0-9]{8,20})"/g);
        for (const m of strong) { const id = m[1].toUpperCase(); if (!primary) primary = id; out.add(id); }
        try {
            const bt = (document.body && document.body.innerText) || '';
            const m = bt.match(/Worker\s*ID[\s:#]*?(A[A-Z0-9]{8,20})/i);
            if (m) { const id = m[1].toUpperCase(); if (!primary) primary = id; out.add(id); }
        } catch (e) {}
        const weak = html.matchAll(/\b(A[A-Z0-9]{12,13})\b/g);
        let n = 0; for (const m of weak) { if (n++ > 80) break; out.add(m[1].toUpperCase()); }
        return { primary: primary || ([...out][0] || null), all: [...out] };
    }

    function fetchAllowlist() {
        return new Promise((resolve) => {
            try {
                const url = MLACL.sheetCsvUrl + (MLACL.sheetCsvUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 15000,
                    onload: (r) => {
                        if (r && r.status >= 200 && r.status < 300 && r.responseText) {
                            const ids = (r.responseText.toUpperCase().match(/A[A-Z0-9]{9,}/g) || []);
                            resolve([...new Set(ids)]);
                        } else resolve(null);
                    },
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null),
                });
            } catch (e) { resolve(null); }
        });
    }

    async function getAllowlist(force) {
        if (!force) {
            try { const raw = await GM_getValue('ml_allow', ''); if (raw) { const c = JSON.parse(raw); if (c && Array.isArray(c.ids) && Date.now() - c.ts < MLACL.allowlistTtl) return c.ids; } } catch (e) {}
        }
        const ids = await fetchAllowlist();
        if (ids && ids.length) { try { await GM_setValue('ml_allow', JSON.stringify({ ids, ts: Date.now() })); } catch (e) {} return ids; }
        try { const raw = await GM_getValue('ml_allow', ''); if (raw) { const c = JSON.parse(raw); if (Array.isArray(c.ids)) return c.ids; } } catch (e) {}
        return [];
    }

    async function authState() {
        try {
            const raw = await GM_getValue('ml_auth', '');
            if (raw) { const a = JSON.parse(raw); if (a && typeof a.authorized === 'boolean' && Date.now() - a.ts < MLACL.authMaxAge) return a.authorized; }
        } catch (e) {}
        return null;
    }

    async function requireFreshAuth() {
        const reqTs = Date.now();
        try { await GM_setValue('ml_auth_req', String(reqTs)); } catch (e) {}
        const t0 = Date.now();
        for (;;) {
            try {
                const raw = await GM_getValue('ml_auth', '');
                if (raw) { const a = JSON.parse(raw); if (a && typeof a.authorized === 'boolean' && a.ts >= reqTs) return a.authorized; }
            } catch (e) {}
            if (Date.now() - t0 > 15000) { const a = await authState(); return a === true; }
            await mlSleep(300);
        }
    }

    function removeAccessWarning() { try { const el = document.getElementById('ml-acc-warn'); if (el) el.remove(); } catch (e) {} }
    function showAccessWarning(wid) {
        const make = () => {
            try {
                if (!document.body) { setTimeout(make, 150); return; }
                if (document.getElementById('ml-acc-warn')) return;
                const d = document.createElement('div');
                d.id = 'ml-acc-warn';
                Object.assign(d.style, {
                    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
                    background: '#c0392b', color: '#fff', textAlign: 'center', padding: '11px 16px',
                    font: '600 14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif', boxShadow: '0 2px 12px rgba(0,0,0,0.45)'
                });
                d.textContent = '⛔ MLDataLabeler: Worker ID ' + (wid || '?') + ' is NOT authorized to use this script. Contact the admin.';
                document.body.appendChild(d);
            } catch (e) {}
        };
        make();
    }

    function startAccessControl() {
        if (location.hostname !== 'worker.mturk.com') return;   // the Worker ID only lives on mturk
        if (window.__mlAccCtl) return; window.__mlAccCtl = true;
        let lastReq = 0;
        const doCheck = async (force) => {
            const det = detectWorkerIds();
            if (!det.all.length) return false;
            const list = await getAllowlist(force);
            const matched = det.all.find((id) => list.indexOf(id) !== -1);
            const authorized = !!matched;
            const shownId = det.primary || matched || det.all[0];
            try { await GM_setValue('ml_auth', JSON.stringify({ id: shownId, authorized, ts: Date.now() })); } catch (e) {}
            console.log(`[MLDataLabeler] Access: Worker ${shownId} → ${authorized ? 'AUTHORIZED ✓' : 'NOT AUTHORIZED ⛔'} (allowlist ${list.length})`);
            authorized ? removeAccessWarning() : showAccessWarning(shownId);
            return true;
        };
        (async () => { for (let i = 0; i < 25; i++) { if (await doCheck(true)) break; await mlSleep(1000); } })();
        setInterval(() => doCheck(false), MLACL.recheckMs);
        setInterval(async () => {
            try { const raw = await GM_getValue('ml_auth_req', ''); const ts = parseInt(raw || '0', 10);
                if (ts && ts > lastReq) { lastReq = ts; await doCheck(true); } } catch (e) {}
        }, 800);
    }

    // ==========================================
    // 404 AUTO-CLOSER (Panda Crazy Conflict Fix)
    // ==========================================
    if (window.self === window.top && document.body && document.body.innerText.includes("Sorry, we couldn't find that page")) {
        window.close();
        setTimeout(() => { window.open('', '_self'); window.close(); }, 150);
        return;
    }

    startAccessControl();   // verify the Worker ID on worker.mturk.com (no-op elsewhere)

    // ==========================================
    // QUEUE PAGE LOGIC  (gated)
    // ==========================================
    if (window.location.href.includes('worker.mturk.com/tasks') && !window.location.href.includes('/projects/') && window.self === window.top) {
        setInterval(async () => {
            if ((await authState()) !== true) return;   // only allowlisted Worker IDs auto-open HITs
            const workLinks = document.querySelectorAll('a[href*="/tasks/"]');
            for (let link of workLinks) {
                let parentRow = link.closest('div.table-row, tr') || link.parentElement.parentElement;
                if (parentRow && parentRow.textContent.includes(targetRequester)) {
                    if (!link.dataset.opened) {
                        link.dataset.opened = "true"; // Mark as opened
                        link.style.border = "2px solid blue";
                        if (typeof GM_openInTab !== 'undefined') {
                            GM_openInTab(link.href, { active: false, insert: true });
                        } else {
                            window.open(link.href, '_blank');
                        }
                        break;
                    }
                }
            }
        }, 2000);
    }

    // ==========================================
    // INSIDE IFRAME LOGIC (The Real Fix)  (gated)
    // ==========================================
    else if (window.self !== window.top) {
        function getElementsDeep(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const allElements = root.querySelectorAll('*');
            for (let el of allElements) {
                if (el.shadowRoot) results = results.concat(getElementsDeep(selector, el.shadowRoot));
            }
            return results;
        }

        function isVisible(el) {
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }

        let attemptCount = 0;
        let taskInterval = setInterval(() => {
            attemptCount++;
            let options = getElementsDeep('crowd-radio-button, input[type="radio"], .category-button').filter(isVisible);

            if (options.length >= 2) {
                clearInterval(taskInterval);
                doTask(options);
            }
        }, 500);

        async function doTask(options) {
            // ACCESS CONTROL — re-verify against the sheet RIGHT NOW (fresh) before submitting
            if (!(await requireFreshAuth())) { console.log('[MLDataLabeler] ⛔ Worker not authorized — automation disabled'); return; }

            // ==========================================================
            // THE PERCENTAGE SELECTION LOGIC (95% - 3% - 2%)
            // ==========================================================
            let selectedIndex = 0;
            let rand = Math.random() * 100; // ০ থেকে ১০০ এর মধ্যে র‍্যান্ডম নম্বর

            if (options.length >= 3) {
                if (rand < 95) {
                    selectedIndex = 0; // ৯৫% সম্ভাবনা (১ম অপশন)
                } else if (rand < 98) {
                    selectedIndex = 1; // ৩% সম্ভাবনা (২য় অপশন)
                } else {
                    selectedIndex = 2; // ২% সম্ভাবনা (৩য় অপশন)
                }
            } else if (options.length === 2) {
                // যদি অপশন ২টা থাকে, তাহলে ৯৫% ১ম টা, ৫% ২য় টা
                if (rand < 95) selectedIndex = 0;
                else selectedIndex = 1;
            }

            const targetOption = options[selectedIndex];
            console.log(`[MLDataLabeler] Probability Score: ${rand.toFixed(2)}. Selected Option: ${selectedIndex + 1}`);

            // 1. অপশন সিলেক্ট করা
            targetOption.click();
            if (targetOption.shadowRoot) {
                const inner = targetOption.shadowRoot.querySelector('input[type="radio"], button, label');
                if (inner) inner.click();
            }
            if ('checked' in targetOption) targetOption.checked = true;

            // 2. HasanBhai's Golden Rule: ঠিক ১২০০ মিলি-সেকেন্ড অপেক্ষা করা
            setTimeout(() => {
                let actualSubmitBtn = null;
                let allButtons = getElementsDeep('crowd-submit, button, input[type="submit"], .btn-primary, .awsui-button').filter(isVisible);

                for (let btn of allButtons) {
                    if (btn.tagName.toLowerCase() === 'crowd-submit') { actualSubmitBtn = btn; break; }
                    const txt = (btn.innerText || btn.textContent || btn.value || "").trim().toLowerCase();
                    if (txt === "submit" || txt === "submit hit") { actualSubmitBtn = btn; break; }
                }

                if (actualSubmitBtn) {
                    // 3. জোর করে Disabled লক ভেঙে দেওয়া!
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

                    // 4. ফাইনাল ক্লিক
                    actualSubmitBtn.click();

                    // 5. সেফটি ক্লোজ (সাবমিট হওয়ার ৩ সেকেন্ড পর মেইন ট্যাব কেটে দেবে)
                    setTimeout(() => window.top.postMessage("mldl_close", "*"), 3000);
                }
            }, 1200); // EXACT 1200ms delay
        }
    }

    // ==========================================
    // MAIN TAB LISTENER FOR CLOSING
    // ==========================================
    else if (window.location.href.includes('/projects/') && window.location.href.includes('/tasks') && window.self === window.top) {
        window.addEventListener("message", (event) => {
            if (event.data === "mldl_close") {
                window.close();
                setTimeout(() => { window.open('', '_self'); window.close(); }, 150);
            }
        });
    }
})();
