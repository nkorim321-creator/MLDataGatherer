// ==UserScript==
// @name         MLDataLabeler Auto Submit (AI Radar & Admin Key)
// @namespace    http://tampermonkey.net/
// @version      30.0
// @description  Scans Google servers dynamically. Includes built-in Admin API key fallback for the creator.
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
// @connect      generativelanguage.googleapis.com
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/main/MLDataLabeler.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/main/MLDataLabeler.user.js
// ==/UserScript==

(function() {
    'use strict';

    const targetRequester = "MLDataLabeler";

    // ==========================================================
    // 🔑 ADMIN DEFAULT API KEY (YOUR PERSONAL KEY)
    // ==========================================================
    // WARNING: গিটহাবে বা অন্য ইউজারকে কোড দেওয়ার আগে এই লাইনটি ফাঁকা করে দেবেন। যেমন: const ADMIN_API_KEY = "";
    const ADMIN_API_KEY = "AQ.Ab8RN6LvHFd5f82mfsTf34GpF0iyi_4ndzAN27do15EDfoHncw";

    // ==========================================================
    // 100% REAL LOGGER SYSTEM
    // ==========================================================
    function sysLog(msg) {
        let logs = [];
        try { logs = JSON.parse(GM_getValue('mldl_logs', '[]')); } catch(e) {}
        let time = new Date().toLocaleTimeString('en-US', { hour12: false });
        let finalMsg = `[${time}] ${msg}`;
        logs.push(finalMsg);
        if (logs.length > 60) logs.shift(); 
        GM_setValue('mldl_logs', JSON.stringify(logs));
        console.log(finalMsg);
    }

    // ================================================================
    //  ACCESS CONTROL — Worker-ID allowlist (Google Sheet)
    // ================================================================
    const MLACL = {
        sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/1p03KacnfGQhtXm7umEnbktki3wCpaVzC_16W51iKn6U/gviz/tq?tqx=out:csv',
        allowlistTtl: 30000,
        authMaxAge:   90000,
        recheckMs:    8000,
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
        if (location.hostname !== 'worker.mturk.com') return;
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
    // 404 AUTO-CLOSER
    // ==========================================
    if (window.self === window.top && document.body && document.body.innerText.includes("Sorry, we couldn't find that page")) {
        window.close();
        setTimeout(() => { window.open('', '_self'); window.close(); }, 150);
        return;
    }

    startAccessControl();

    // ==========================================
    // QUEUE PAGE LOGIC (Main Tab - Long Dashboard)
    // ==========================================
    if (window.location.href.includes('worker.mturk.com/tasks') && !window.location.href.includes('/projects/') && window.self === window.top) {
        
        const uiDiv = document.createElement('div');
        uiDiv.innerHTML = `
            <div style="position:fixed; bottom:15px; left:15px; width:450px; background:#0f172a; padding:15px; border-radius:8px; border:2px solid #3b82f6; color:#f1f5f9; z-index:999999; font-family:sans-serif; font-size:12px; box-shadow: 0px 4px 20px rgba(0,0,0,0.7);">
                <b style="color:#60a5fa; font-size:14px;">📊 MLDataLabeler Master Dashboard</b><br>
                
                <div style="margin-top:10px;">
                    <span style="font-size:11px; color:#94a3b8;">User API Key Pool (Leave empty to use Admin Key):</span>
                    <textarea id="ml_api_keys" style="width:100%; height:45px; margin-top:4px; background:#1e293b; color:#10b981; border:1px solid #475569; border-radius:4px; font-size:10px; padding:6px;" placeholder="User can paste API Keys here..."></textarea>
                    <button id="ml_save_keys" style="margin-top:4px; width:100%; background:#3b82f6; color:white; border:none; padding:6px; cursor:pointer; font-weight:bold; border-radius:4px;">💾 Save Keys</button>
                </div>
                
                <div style="margin-top:10px;">
                    <span style="font-size:11px; color:#94a3b8;">Live Task Logs (Real-time tracking):</span>
                    <textarea id="mldl-log-box" style="width:100%; height:320px; margin-top:4px; background:#000; color:#00ff00; border:1px solid #444; font-family:monospace; font-size:11px; padding:6px; resize:none;" readonly></textarea>
                    <button id="mldl-clear-btn" style="margin-top:4px; width:100%; background:#dc3545; color:white; border:none; padding:6px; cursor:pointer; font-weight:bold; border-radius:4px;">🗑️ Clear Logs</button>
                </div>
            </div>
        `;
        document.body.appendChild(uiDiv);

        document.getElementById('ml_api_keys').value = GM_getValue('ml_gemini_keys', '');
        document.getElementById('ml_save_keys').addEventListener('click', () => {
            GM_setValue('ml_gemini_keys', document.getElementById('ml_api_keys').value);
            GM_setValue('ml_gemini_index', 0);
            GM_setValue('ml_working_model', ''); 
            sysLog("✅ User API Keys Saved! Cache Reset.");
        });

        setInterval(() => {
            let logBox = document.getElementById('mldl-log-box');
            if (logBox) {
                let currentLogs = [];
                try { currentLogs = JSON.parse(GM_getValue('mldl_logs', '[]')); } catch(e) {}
                let logText = currentLogs.join('\n\n');
                if (logBox.value !== logText) {
                    logBox.value = logText;
                    logBox.scrollTop = logBox.scrollHeight;
                }
            }
        }, 1000);

        document.getElementById('mldl-clear-btn').addEventListener('click', () => {
            GM_setValue('mldl_logs', '[]');
            sysLog("🧹 Logs Cleared");
        });

        setInterval(async () => {
            if ((await authState()) !== true) return;
            const workLinks = document.querySelectorAll('a[href*="/tasks/"]');
            for (let link of workLinks) {
                let parentRow = link.closest('div.table-row, tr') || link.parentElement.parentElement;
                if (parentRow && parentRow.textContent.includes(targetRequester)) {
                    if (!link.dataset.opened) {
                        link.dataset.opened = "true";
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
    // INSIDE IFRAME LOGIC (AI Radar & Scanner)
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

        // --- 🤖 GEMINI API LOGIC (RADAR SCANNER + ADMIN FALLBACK) ---
        async function askGemini(taskText, optionsTextArray) {
            let keysRaw = await GM_getValue('ml_gemini_keys', '');
            
            // 💡 If User Box is empty, Automatically use the Admin Key
            if (!keysRaw || keysRaw.trim() === '') {
                if (ADMIN_API_KEY && ADMIN_API_KEY.trim() !== '') {
                    keysRaw = ADMIN_API_KEY;
                } else {
                    sysLog("⚠️ No API Key found! Skipping AI.");
                    return null; 
                }
            }

            let keys = keysRaw.split(',').map(k => k.trim()).filter(k => k);
            let currentIndex = parseInt(await GM_getValue('ml_gemini_index', 0)) || 0;
            if (currentIndex >= keys.length) currentIndex = 0;

            let prompt = `You are a strict data labeler. Read this text snippet:\n"${taskText}"\n\nOptions:\n${optionsTextArray.map((o, i) => `${i}: ${o}`).join('\n')}\n\nReply with ONLY the exact index number (0, 1, or 2) of the best matching option. Do not write anything else.`;

            const modelsToTry = ['gemini-1.5-flash', 'gemini-1.0-pro', 'gemini-pro', 'gemini-2.5-flash'];

            for (let tries = 0; tries < keys.length; tries++) {
                let key = keys[currentIndex];
                let cachedModel = await GM_getValue('ml_working_model_' + key, '');

                if (!cachedModel) {
                    sysLog(`🔍 Scanning Google Servers for available models...`);
                    try {
                        let scanRes = await new Promise((resolve, reject) => {
                            GM_xmlhttpRequest({
                                method: 'GET',
                                url: `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                                onload: resolve,
                                onerror: reject
                            });
                        });

                        if (scanRes.status === 200) {
                            let data = JSON.parse(scanRes.responseText);
                            let validModels = data.models.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent") && m.name.includes("gemini"));
                            
                            if (validModels.length > 0) {
                                let chosen = validModels.find(m => m.name.includes('flash')) || validModels[0];
                                cachedModel = chosen.name.replace('models/', '');
                                sysLog(`🎯 Radar Found Valid Model: '${cachedModel}'`);
                                await GM_setValue('ml_working_model_' + key, cachedModel);
                            } else {
                                sysLog(`❌ Key has no active AI models!`);
                                currentIndex = (currentIndex + 1) % keys.length;
                                continue;
                            }
                        } else {
                            sysLog(`❌ Server Scan Failed. Status: ${scanRes.status}. Your API key might be invalid.`);
                            currentIndex = (currentIndex + 1) % keys.length;
                            continue;
                        }
                    } catch (e) {
                        sysLog(`❌ Network Error during Server Scan.`);
                        currentIndex = (currentIndex + 1) % keys.length;
                        continue;
                    }
                }

                try {
                    let res = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: 'POST',
                            url: `https://generativelanguage.googleapis.com/v1beta/models/${cachedModel}:generateContent?key=${key}`,
                            headers: { 'Content-Type': 'application/json' },
                            data: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                            onload: resolve,
                            onerror: reject
                        });
                    });

                    if (res.status === 200) {
                        let data = JSON.parse(res.responseText);
                        let answer = data.candidates[0].content.parts[0].text.trim();
                        
                        // Only update index if we are rotating through multiple user keys
                        if (keys.length > 1) {
                            await GM_setValue('ml_gemini_index', (currentIndex + 1) % keys.length);
                        }
                        
                        sysLog(`✅ AI SUCCESS! Decoded by ${cachedModel}`);
                        return parseInt(answer);
                    } else if (res.status === 404) {
                        sysLog(`🔄 Model '${cachedModel}' is suddenly missing. Clearing cache to rescan...`);
                        await GM_setValue('ml_working_model_' + key, ''); 
                    } else {
                        sysLog(`❌ AI Task Failed. Status: ${res.status}. Reason: ${res.responseText.substring(0, 80).replace(/\n/g, ' ')}...`);
                    }
                } catch (e) {
                    sysLog(`❌ API Network Error.`);
                }
                currentIndex = (currentIndex + 1) % keys.length;
            }
            return null; 
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
            if (!(await requireFreshAuth())) return;

            let rawText = document.body.innerText.replace(/\n\s*\n/g, '\n').trim();
            let displayQuestion = rawText.substring(0, 120).replace(/\n/g, ' ') + "...";
            sysLog(`❓ QUESTION FOUND:\n"${displayQuestion}"`);

            let optionTexts = options.map(o => (o.innerText || o.value || o.textContent || "").trim());
            sysLog(`📋 OPTIONS:\n` + optionTexts.map((o, i) => `${i + 1}. ${o}`).join(', '));

            let aiDecision = await askGemini(rawText.substring(0, 1000), optionTexts);
            
            let selectedIndex = 0;

            if (aiDecision !== null && !isNaN(aiDecision) && aiDecision >= 0 && aiDecision < options.length) {
                selectedIndex = aiDecision;
                sysLog(`🤖 AI DECIDED: Option ${selectedIndex + 1} -> "${optionTexts[selectedIndex].substring(0, 30).replace(/\n/g, ' ')}"`);
            } else {
                let rand = Math.random() * 100;
                if (options.length >= 3) {
                    if (rand < 95) selectedIndex = 0;
                    else if (rand < 98) selectedIndex = 1;
                    else selectedIndex = 2;
                } else if (options.length === 2) {
                    if (rand < 95) selectedIndex = 0;
                    else selectedIndex = 1;
                }
                sysLog(`🎲 FALLBACK (Random ${rand.toFixed(1)}%): Option ${selectedIndex + 1} -> "${optionTexts[selectedIndex].substring(0, 30).replace(/\n/g, ' ')}"`);
            }

            const targetOption = options[selectedIndex];

            targetOption.click();
            if (targetOption.shadowRoot) {
                const inner = targetOption.shadowRoot.querySelector('input[type="radio"], button, label');
                if (inner) inner.click();
            }
            if ('checked' in targetOption) targetOption.checked = true;

            setTimeout(() => {
                let actualSubmitBtn = null;
                let allButtons = getElementsDeep('crowd-submit, button, input[type="submit"], .btn-primary, .awsui-button').filter(isVisible);

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
                    sysLog(`🚀 HIT SUBMITTED Successfully!`);

                    setTimeout(() => window.top.postMessage("mldl_close", "*"), 3000);
                }
            }, 1200); 
        }
    }

    else if (window.location.href.includes('/projects/') && window.location.href.includes('/tasks') && window.self === window.top) {
        window.addEventListener("message", (event) => {
            if (event.data === "mldl_close") {
                window.close();
                setTimeout(() => { window.open('', '_self'); window.close(); }, 150);
            }
        });
    }
})();
