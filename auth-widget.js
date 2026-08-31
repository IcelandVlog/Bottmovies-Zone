/* ==================== SHARED AUTH STATUS WIDGET ====================
   dmca.html, report-broken-links.html, How-to-Download.html - এই static
   পেজগুলোর মধ্যে movie-management কোনো লজিক নেই, তাই সেগুলোতে পুরো
   Sign In / Sign Up ফর্ম বা Admin Panel বসানো হয়নি। কিন্তু main site-এ
   Sign In করা থাকলে (session localStorage-এ persist হয় - সব পেজেই সেটা
   দেখা যায়), তাই এই ছোট floating pill-টা দেখায় কে login করা আছে এবং
   এক ক্লিকে index.html-এর Dashboard-এ ফিরিয়ে নিয়ে যায়।
   একই Supabase project ব্যবহার করা হয়েছে যেটা script.js-এ আছে। */
(function () {
    const SUPABASE_URL = 'https://borglnmrvjafodkqhhhv.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_Q3WcdMEHLJO7SkO3Sd7BDQ_Ohu8xAp9';
    const ADMIN_TRIGGER_EMAIL = '702640Shamil@admin.com';

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    ready(function () {
        if (typeof supabase === 'undefined') return; // supabase-js লোড না হলে চুপচাপ কিছু না দেখানো
        const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        const style = document.createElement('style');
        style.textContent = `
            #bmAuthWidget {
                position: fixed; top: 14px; right: 14px; z-index: 99999;
                display: flex; align-items: center; gap: 8px;
                background: rgba(15,17,23,0.92); border: 1px solid rgba(255,255,255,0.12);
                border-radius: 999px; padding: 6px 8px 6px 14px;
                font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
                color: #e2e8f0; box-shadow: 0 6px 18px rgba(0,0,0,0.35);
            }
            #bmAuthWidget a, #bmAuthWidget button {
                font: inherit; text-decoration: none; cursor: pointer; border: none;
                border-radius: 999px; padding: 6px 12px; font-weight: 700;
            }
            #bmAuthWidget .bm-signin { background: transparent; color: #cbd5e0; border: 1px solid rgba(255,255,255,0.18) !important; }
            #bmAuthWidget .bm-dashboard { background: #2563eb; color: #fff; }
            #bmAuthWidget .bm-signout { background: transparent; color: #94a3b8; border: 1px solid rgba(255,255,255,0.18) !important; }
            #bmAuthWidget .bm-email { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            @media (max-width: 640px) { #bmAuthWidget .bm-email { display: none; } }
        `;
        document.head.appendChild(style);

        const box = document.createElement('div');
        box.id = 'bmAuthWidget';
        document.body.appendChild(box);

        function render(session) {
            box.innerHTML = '';
            if (session && session.user) {
                const isAdmin = (session.user.email || '').toLowerCase() === ADMIN_TRIGGER_EMAIL.toLowerCase();
                const uname = session.user.user_metadata?.username || (session.user.email || '').split('@')[0];
                const emailSpan = document.createElement('span');
                emailSpan.className = 'bm-email';
                emailSpan.textContent = (isAdmin ? '👑 ' : '👤 ') + uname;
                box.appendChild(emailSpan);

                const dashLink = document.createElement('a');
                dashLink.className = 'bm-dashboard';
                dashLink.href = 'index.html?dashboard=1';
                dashLink.textContent = 'Dashboard';
                box.appendChild(dashLink);
                // Sign Out বাটন এখানে না রেখে Dashboard/Admin panel এর ভেতরে রাখা হয়েছে
            } else {
                const signInLink = document.createElement('a');
                signInLink.className = 'bm-signin';
                signInLink.href = 'index.html?auth=1';
                signInLink.textContent = 'Login';
                box.appendChild(signInLink);
            }
        }

        sb.auth.getSession().then(function (res) { render(res.data.session); });
        sb.auth.onAuthStateChange(function (_event, session) { render(session); });
    });
})();
