// ==UserScript==
// @name         MTurk Auto Bypass - Ultimate Fix (Fast Submit V11)
// @namespace    http://tampermonkey.net/
// @version      11.0
// @description  Bypass blocker and submit smoothly using hidden iframe with a fast 1-second submit
// @match        *://worker.mturk.com/projects/*/tasks/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const urlParams = new URLSearchParams(window.location.search);
    const assignmentId = urlParams.get('assignment_id');
    
    // কাজ এক্সেপ্ট করা না থাকলে (Preview) স্ক্রিপ্ট রান করবে না
    if (!assignmentId || assignmentId === 'ASSIGNMENT_ID_NOT_AVAILABLE') return;

    function bypassLogic() {
        // ১. রিকোয়েস্টারের টাইমার চিরতরে বন্ধ করা
        for (let i = 1; i < 99999; i++) {
            window.clearInterval(i);
        }

        // ২. "Loading..." দেখানো ব্রোকেন iframe টা লুকিয়ে ফেলা
        const iframeContainer = document.querySelector('.task-question-iframe-container');
        if (iframeContainer) iframeContainer.style.display = 'none';

        // ৩. লুকানো iFrame তৈরি করা (Version 9 এর সেই মাস্টার ফিক্স)
        if (!document.getElementById('hidden-submit-frame')) {
            let hiddenFrame = document.createElement('iframe');
            hiddenFrame.name = 'hidden-submit-frame';
            hiddenFrame.id = 'hidden-submit-frame';
            hiddenFrame.style.display = 'none';
            document.body.appendChild(hiddenFrame);
        }

        const submitUrl = 'https://www.mturk.com/mturk/externalSubmit';

        // ৪. ফর্ম বসানো 
        if (!document.getElementById('custom-bypass-form')) {
            let bypassForm = `
              <div id="custom-bypass-form" style="padding:20px; max-width:800px; margin:20px auto; background:#fff; border:2px solid #28a745; border-radius:8px;">
                <h3 style="color:#28a745;">Bypass Successful!</h3>
                <h4>Pick the product's category</h4>
                <div style="background:#f9f9f9; padding:15px; margin-bottom:15px;">
                  <strong>Product:</strong> California Costumes Women's Size Rich Witch Plus Costume. <br>
                  Price: $25.56 - $46.99.
                </div>
                
                <form id="mturk-submit-form" action="${submitUrl}" method="POST" target="hidden-submit-frame">
                  <input type="hidden" name="assignmentId" value="${assignmentId}">
                  
                  <div style="padding:8px 0;"><input type="radio" id="cat1" name="category" value="Electronics"> <label for="cat1">Electronics</label></div>
                  <div style="padding:8px 0;"><input type="radio" id="cat2" name="category" value="Household"> <label for="cat2">Household</label></div>
                  <div style="padding:8px 0;"><input type="radio" id="cat3" name="category" value="Books"> <label for="cat3">Books</label></div>
                  <div style="padding:8px 0;"><input type="radio" id="cat4" name="category" value="Clothing & Accessories"> <label for="cat4">Clothing & Accessories</label></div>
                  <br>
                  <button type="button" id="auto-submit-btn" style="background:#007bff; color:white; padding:10px 20px; border:none; border-radius:4px; font-size:16px; cursor:wait;">Submitting...</button>
                </form>
              </div>
            `;

            const mainContent = document.getElementById('MainContent') || document.body;
            mainContent.insertAdjacentHTML('afterbegin', bypassForm);
        }

        // ৫. ব্যালেন্সড র্যান্ডম অপশন সিলেক্ট এবং ফাস্ট সাবমিট
        setTimeout(() => {
            let allOptions = document.querySelectorAll('input[name="category"]');
            let submitBtn = document.getElementById('auto-submit-btn');
            let form = document.getElementById('mturk-submit-form');

            if (allOptions.length > 0 && submitBtn) {
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
                allOptions[randomIndex].checked = true; 

                // ৬ সেকেন্ডের বদলে মাত্র ১ সেকেন্ড (1000ms) ওয়েট করে সাবমিট
                setTimeout(() => {
                    submitBtn.textContent = "Submitted! Loading next...";
                    submitBtn.style.background = "#28a745";
                    submitBtn.style.cursor = "pointer";
                    
                    form.submit(); // লুকানো ফ্রেমের মাধ্যমে সাবমিট হবে
                }, 1000); 
            }
        }, 1000); 
    }

    // পেজ লোড হওয়ার ১ সেকেন্ড পর কাজ শুরু হবে
    window.addEventListener('load', () => {
        setTimeout(bypassLogic, 1000);
    });

})();
