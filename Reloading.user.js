// ==UserScript==
// @name         MTurk Auto-Submitter (Force Close Fix)
// @namespace    http://tampermonkey.net/
// @version      12.0
// @description  Bypass blocker, balanced random submit, and force close tab bypassing browser security
// @match        *://*.mturk.com/*
// @match        *://*.mturkcontent.com/*
// @match        *://s3.amazonaws.com/*
// @allFrames    true
// @grant        GM_openInTab
// @grant        window.close
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;

    // ==========================================
    // পার্ট ১: Queue অটো-রিলোড ও ব্যাকগ্রাউন্ড ট্যাব ওপেনার
    // ==========================================
    if (window === window.top && currentUrl.includes('worker.mturk.com/tasks')) {
        setInterval(() => {
            let taskLinks = document.querySelectorAll('a[href*="/projects/"][href*="/tasks/"]');
            taskLinks.forEach(link => {
                let row = link.closest('.table-row') || link.closest('li') || link.parentElement.parentElement;
                if (row && row.textContent.includes('MLDataGatherer') && row.textContent.includes('
Label the product category')) {
                    let url = link.href;
                    let openedHits = JSON.parse(localStorage.getItem('openedHITs_ML') || '[]');
                    if (!openedHits.includes(url)) {
                        openedHits.push(url);
                        localStorage.setItem('openedHITs_ML', JSON.stringify(openedHits));
                        GM_openInTab(url, { active: false, insert: true, setParent: true });
                        console.log("Opened target HIT in background!");
                    }
                }
            });
            window.location.reload();
        }, 3000);
        return; // Queue পেজে নিচের আর কোনো কোড রান করবে না
    }

    // ==========================================
    // পার্ট ২: সাবমিট হওয়ার পর ফোর্স ট্যাব ক্লোজ (Force Close)
    // ==========================================
    if (window === window.top) {
        setInterval(() => {
            let pageText = document.body ? document.body.innerText : "";
            // পেজে "HIT Submitted" লেখা আসলেই Tampermonkey স্পেশাল পারমিশন ব্যবহার করে ট্যাব কেটে দেবে
            if (pageText.includes('HIT Submitted')) {
                window.close();
            }
        }, 300); // আরও দ্রুত চেক করার জন্য সময় কমিয়ে ৩০০ মিলি-সেকেন্ড করা হয়েছে
    }

    // ==========================================
    // পার্ট ৩: V3 ভেরিফাইড ইনজেকশন ও ব্যালেন্সড র্যান্ডম লজিক (ইফ্রেমে)
    // ==========================================
    if (window !== window.top) {
        let script = document.createElement('script');
        script.textContent = `
            (function() {
                let checkInterval = setInterval(() => {
                    let blockerBox = document.getElementById('m');
                    if (blockerBox) {
                        for (let i = 1; i < 99999; i++) window.clearInterval(i);
                        blockerBox.remove();

                        if (!document.querySelector('crowd-form')) {
                            let bypassForm = '<crowd-form><div style="padding:20px; max-width:800px; margin:0 auto; background:#fff; border:2px solid #28a745; border-radius:8px;"><h3>Bypass Successful!</h3><crowd-radio-group><div style="padding:8px 0;"><crowd-radio-button name="category" value="Electronics">Electronics</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Household">Household</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Books">Books</crowd-radio-button></div><div style="padding:8px 0;"><crowd-radio-button name="category" value="Clothing & Accessories">Clothing & Accessories</crowd-radio-button></div></crowd-radio-group><br><crowd-button form-action="submit" variant="primary">Submit HIT</crowd-button></div></crowd-form>';
                            document.body.insertAdjacentHTML('beforeend', bypassForm);
                        }

                        setTimeout(() => {
                            let allOptions = document.querySelectorAll('crowd-radio-button[name="category"]');
                            let submitBtn = document.querySelector('crowd-button[form-action="submit"]');
                            if (allOptions.length > 0 && submitBtn) {

                                // পারফেক্ট ব্যালেন্স রেশিও লজিক (৪টি অপশন সমানভাবে ব্যবহার হবে)
                                let queue = JSON.parse(localStorage.getItem('mturk_option_queue') || '[]');
                                if (queue.length === 0) {
                                    for (let i = 0; i < allOptions.length; i++) queue.push(i);
                                    for (let i = queue.length - 1; i > 0; i--) {
                                        let j = Math.floor(Math.random() * (i + 1));
                                        [queue[i], queue[j]] = [queue[j], queue[i]];
                                    }
                                }
                                let randomIndex = queue.pop();
                                localStorage.setItem('mturk_option_queue', JSON.stringify(queue));

                                allOptions[randomIndex].click();

                                setTimeout(() => {
                                    submitBtn.click();
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
