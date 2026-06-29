// ==UserScript==
// @name         MTurk Auto Bypass - Final Auto Fix
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Bypass blocker automatically without manual console paste
// @match        *://*/*
// @include      *
// @allFrames    true
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // এই ফাংশনের ভেতরের কোডটুকু হুবহু আপনার ম্যানুয়াল পেস্ট করা কোড
    function bypassLogic() {
        let checkInterval = setInterval(() => {
            let blockerBox = document.getElementById('m');

            // যখনই ব্লকার বক্সটা পেজে আসবে, স্ক্রিপ্ট কাজ শুরু করবে
            if (blockerBox) {
                // ১. রিকোয়েস্টারের টাইমার চিরতরে বন্ধ করা
                for (let i = 1; i < 99999; i++) {
                    window.clearInterval(i);
                }

                // ২. ব্লকার মুছে ফেলা
                blockerBox.remove();

                // ৩. আপনার কনফার্ম করা ফর্মটি পেজে বসানো
                if (!document.querySelector('crowd-form')) {
                    let bypassForm = `
                      <crowd-form>
                        <div style="padding:20px; max-width:800px; margin:0 auto; background:#fff; border:2px solid #28a745; border-radius:8px;">
                          <h3 style="color:#28a745;">Bypass Successful!</h3>
                          <h4>Pick the product's category</h4>
                          <div style="background:#f9f9f9; padding:15px; margin-bottom:15px;">
                            <strong>Product:</strong> California Costumes Women's Size Rich Witch Plus Costume. <br>
                            Price: $25.56 - $46.99.
                          </div>

                          <crowd-radio-group>
                            <div style="padding:8px 0;"><crowd-radio-button name="category" value="Electronics">Electronics</crowd-radio-button></div>
                            <div style="padding:8px 0;"><crowd-radio-button name="category" value="Household">Household</crowd-radio-button></div>
                            <div style="padding:8px 0;"><crowd-radio-button name="category" value="Books">Books</crowd-radio-button></div>
                            <div style="padding:8px 0;"><crowd-radio-button name="category" value="Clothing & Accessories">Clothing & Accessories</crowd-radio-button></div>
                          </crowd-radio-group>
                          <br>
                          <crowd-button form-action="submit" variant="primary">Submit HIT</crowd-button>
                        </div>
                      </crowd-form>
                    `;
                    document.body.insertAdjacentHTML('beforeend', bypassForm);
                    console.log("Successfully injected automatically!");
                }

                // ৪. অটো সিলেক্ট এবং সাবমিট
                setTimeout(() => {
                    let firstOption = document.querySelector('crowd-radio-button[name="category"]');
                    let submitBtn = document.querySelector('crowd-button[form-action="submit"]');

                    if (firstOption && submitBtn) {
                        firstOption.click(); // রেডিও বাটনে ক্লিক
                        setTimeout(() => {
                            submitBtn.click(); // সাবমিট বাটনে ক্লিক
                        }, 500);
                    }
                }, 500);

                // কাজ শেষ, চেকার বন্ধ
                clearInterval(checkInterval);
            }
        }, 200);
    }

    // ম্যাজিক ট্রিক: documentElement ব্যবহার করে পেজ পুরোপুরি লোড হওয়ার আগেই কোড ইনজেক্ট করা হলো
    let script = document.createElement('script');
    script.textContent = '(' + bypassLogic.toString() + ')();';

    // বডির জন্য অপেক্ষা না করে সরাসরি HTML-এর গোড়ায় বসানো হলো
    if (document.documentElement) {
        document.documentElement.appendChild(script);
        script.remove();
    }
})();
