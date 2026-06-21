// ==UserScript==
// @name         MLDataLabeler Auto Submit (Anti-Conflict Version)
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Prevents 404 conflicts with Panda Crazy/Hit Catcher by doing ONLY physical clicks.
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.sagemaker.aws/*
// @allFrames    true
// @grant        GM_openInTab
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;
    const targetRequester = "MLDataLabeler";

    // ==========================================
    // STEP 1: QUEUE PAGE LOGIC (Main Tab)
    // ==========================================
    if (currentUrl.includes('worker.mturk.com/tasks') && !currentUrl.includes('/projects/') && window.self === window.top) {
        console.log("[MLDataLabeler] Monitoring Queue...");
        const openedTasks = new Set(); 

        setInterval(() => {
            const workLinks = document.querySelectorAll('a[href*="/tasks/"]');
            for (let link of workLinks) {
                let parentRow = link.closest('div.table-row, tr') || link.parentElement.parentElement;
                if (parentRow && parentRow.textContent.includes(targetRequester)) {
                    if (!openedTasks.has(link.href)) {
                        console.log("[MLDataLabeler] Target Requester found. Opening...");
                        openedTasks.add(link.href);
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
    // STEP 2: TASK LOGIC (Inside Iframe)
    // ==========================================
    else if (window.self !== window.top) {
        console.log("[MLDataLabeler] Running INSIDE iframe...");

        function getElementsDeep(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const allElements = root.querySelectorAll('*');
            for (let el of allElements) {
                if (el.shadowRoot) {
                    results = results.concat(getElementsDeep(selector, el.shadowRoot));
                }
            }
            return results;
        }

        function isVisible(el) {
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }

        // একদম জেনুইন মাউস ক্লিকের মতো ইভেন্ট তৈরি করবে
        function humanLikeClick(el) {
            if (!el) return;
            try {
                el.click(); 
                if ('checked' in el) el.checked = true;
                ['mousedown', 'mouseup', 'click'].forEach(evt => {
                    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, buttons: 1 }));
                });
            } catch(e) {}
        }

        let attemptCount = 0;
        let taskInterval = setInterval(() => {
            attemptCount++;

            let rawOptions = getElementsDeep('crowd-radio-button, input[type="radio"], .category-button');
            let options = rawOptions.filter(isVisible);

            let actualSubmitBtn = null;
            let rawButtons = getElementsDeep('crowd-submit, button, input[type="submit"], .btn-primary, .awsui-button');
            let allButtons = rawButtons.filter(isVisible);
            
            for (let btn of allButtons) {
                if (btn.tagName.toLowerCase() === 'crowd-submit') {
                    actualSubmitBtn = btn;
                    break;
                }
                const txt = (btn.innerText || btn.textContent || btn.value || "").trim().toLowerCase();
                if (txt === "submit" || txt === "submit hit") {
                    actualSubmitBtn = btn;
                    break;
                }
            }

            if (options.length >= 2 && actualSubmitBtn) {
                clearInterval(taskInterval);
                console.log(`[MLDataLabeler] Found ${options.length} VISIBLE Options and Submit Button!`);

                setTimeout(() => {
                    const randomIndex = Math.floor(Math.random() * options.length);
                    const targetOption = options[randomIndex];
                    
                    console.log(`[MLDataLabeler] Selected visible option index: ${randomIndex}`);
                    humanLikeClick(targetOption);

                    if (targetOption.shadowRoot) {
                        const innerRadio = targetOption.shadowRoot.querySelector('input[type="radio"], button, label');
                        if (innerRadio) humanLikeClick(innerRadio);
                    }

                    // অপশন সিলেক্ট করার পর ১ সেকেন্ড অপেক্ষা করে সাবমিট করবে
                    setTimeout(() => {
                        console.log("[MLDataLabeler] Forcing pure human-like submit click...");
                        
                        // 1. প্রথমে ভেতরের আসল বাটনটিতে ক্লিক করবে (যদি থাকে)
                        if (actualSubmitBtn.tagName.toLowerCase() === 'crowd-submit' && actualSubmitBtn.shadowRoot) {
                            const innerSubmit = actualSubmitBtn.shadowRoot.querySelector('button');
                            if (innerSubmit) {
                                humanLikeClick(innerSubmit);
                            }
                        }
                        
                        // 2. এরপর বাইরের বাটনটিতে ক্লিক করবে
                        setTimeout(() => {
                            humanLikeClick(actualSubmitBtn);
                            console.log("✅ [MLDataLabeler] Click completed. (Form script injection removed to prevent 404)");
                        }, 300);

                        // ⚠️ form.submit() ফাংশনটি পুরোপুরি রিমুভ করা হয়েছে যাতে Panda Crazy এর সাথে কনফ্লিক্ট না হয়। 

                    }, 1000);
                }, 1500);

            } else if (attemptCount > 30) {
                clearInterval(taskInterval);
                console.log("[MLDataLabeler] CRITICAL: Visible elements missing.");
            }
        }, 500);
    }
})();
