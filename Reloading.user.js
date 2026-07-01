// ==UserScript==
// @name         Tab Open and close MLDATA
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  Uses V3 injection logic for Bypass + Auto-Reload Queue + Auto-Close
// @match        *://*.mturk.com/*
// @match        *://*.mturkcontent.com/*
// @match        *://s3.amazonaws.com/*
// @allFrames    true
// @grant        GM_openInTab
// ==/UserScript==

(function() {
    'use strict';

    // --- পার্ট ১: Queue অটো-রিলোড ও ব্যাকগ্রাউন্ড ট্যাব ওপেনার ---
    if (window === window.top && window.location.href.includes('worker.mturk.com/tasks')) {
        setInterval(() => {
            let taskLinks = document.querySelectorAll('a[href*="/projects/"][href*="/tasks/"]');
            taskLinks.forEach(link => {
                let row = link.closest('.table-row') || link.closest('li') || link.parentElement.parentElement;
                if (row && row.textContent.includes('MLDataGatherer') && row.textContent.includes('Select the product category')) {
                    let url = link.href;
                    // চেক করা হচ্ছে আগে ওপেন হয়েছে কি না
                    let openedHits = JSON.parse(localStorage.getItem('openedHITs_ML') || '[]');
                    if (!openedHits.includes(url)) {
                        openedHits.push(url);
                        localStorage.setItem('openedHITs_ML', JSON.stringify(openedHits));
                        // ব্যাকগ্রাউন্ডে ট্যাব খোলা
                        GM_openInTab(url, { active: false, insert: true, setParent: true });
                        console.log("Opened target HIT in background!");
                    }
                }
            });
            window.location.reload(); // ৩ সেকেন্ড পর পর রিলোড
        }, 3000);
        return;
    }

    // --- পার্ট ২: V3 ভেরিফাইড ইনজেকশন লজিক ---
    if (window !== window.top) {
        let script = document.createElement('script');
        script.textContent = `
            (function() {
                let checkInterval = setInterval(() => {
                    let blockerBox = document.getElementById('m');
                    if (blockerBox) {
                        // ১. টাইমার ও ব্লকার ধ্বংস
                        for (let i = 1; i < 99999; i++) window.clearInterval(i);
                        blockerBox.remove();

                        // ২. ফর্ম ইনজেক্ট করা
                        if (!document.querySelector('crowd-form')) {
                            let bypassForm = '<crowd-form><div style="padding:20px; max-width:800px; margin:0 auto; background:#fff; border:2px solid #28a745; border-radius:8px;"><h3>Bypass Successful!</h3><crowd-radio-group><div style="padding:8px 0;"><crowd-radio-button name="category" value="Electronics">Electronics</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Household">Household</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Books">Books</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Clothing & Accessories">Clothing & Accessories</crowd-radio-button></div></crowd-radio-group><br><crowd-button form-action="submit" variant="primary">Submit HIT</crowd-button></div></crowd-form>';
                            document.body.insertAdjacentHTML('beforeend', bypassForm);
                        }

                        // ৩. অটো সাবমিট ও ক্লোজ
                        setTimeout(() => {
                            let firstOption = document.querySelector('crowd-radio-button[name="category"]');
                            let submitBtn = document.querySelector('crowd-button[form-action="submit"]');
                            if (firstOption && submitBtn) {
                                firstOption.click();
                                setTimeout(() => {
                                    submitBtn.click();
                                    setTimeout(() => window.close(), 1000);
                                }, 500);
                            }
                        }, 500);
                        clearInterval(checkInterval);
                    }
                }, 200);
            })();
        `;
        document.documentElement.appendChild(script);
    }
})();
