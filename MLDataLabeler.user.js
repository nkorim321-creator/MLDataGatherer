// ==UserScript==
// @name         MLDataLabeler Auto Submit (Weighted Selection)
// @namespace    http://tampermonkey.net/
// @version      21.0
// @description  Wait exactly 1200ms, force remove disabled attributes. Selects options with 95% (1st), 3% (2nd), and 2% (3rd) probability.
// @match        https://worker.mturk.com/*
// @match        https://*.mturkcontent.com/*
// @match        https://*.sagemaker.aws/*
// @allFrames    true
// @grant        GM_openInTab
// @grant        window.close
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/main/MLDataLabeler.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/MLDataGatherer/main/MLDataLabeler.user.js
// ==/UserScript==

(function() {
    'use strict';

    const targetRequester = "MLDataLabeler";

    // ==========================================
    // 404 AUTO-CLOSER (Panda Crazy Conflict Fix)
    // ==========================================
    if (window.self === window.top && document.body && document.body.innerText.includes("Sorry, we couldn't find that page")) {
        window.close();
        setTimeout(() => { window.open('', '_self'); window.close(); }, 150);
        return;
    }

    // ==========================================
    // QUEUE PAGE LOGIC
    // ==========================================
    if (window.location.href.includes('worker.mturk.com/tasks') && !window.location.href.includes('/projects/') && window.self === window.top) {
        setInterval(() => {
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
    // INSIDE IFRAME LOGIC (The Real Fix)
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
                
                // ==========================================================
                // THE PERCENTAGE SELECTION LOGIC (95% - 3% - 2%)
                // ==========================================================
                let selectedIndex = 0;
                let rand = Math.random() * 100; // ০ থেকে ১০০ এর মধ্যে র‍্যান্ডম নম্বর
                
                if (options.length >= 3) {
                    if (rand < 95) {
                        selectedIndex = 0; // ৯৫% সম্ভাবনা (১ম অপশন)
                    } else if (rand < 98) {
                        selectedIndex = 1; // ৩% সম্ভাবনা (২য় অপশন)
                    } else {
                        selectedIndex = 2; // ২% সম্ভাবনা (৩য় অপশন)
                    }
                } else if (options.length === 2) {
                    // যদি অপশন ২টা থাকে, তাহলে ৯৫% ১ম টা, ৫% ২য় টা
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
                        // 3. জোর করে Disabled লক ভেঙে দেওয়া!
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
                        
                        // 5. সেফটি ক্লোজ (সাবমিট হওয়ার ৩ সেকেন্ড পর মেইন ট্যাব কেটে দেবে)
                        setTimeout(() => window.top.postMessage("mldl_close", "*"), 3000);
                    }
                }, 1200); // EXACT 1200ms delay

            }
        }, 500);
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
