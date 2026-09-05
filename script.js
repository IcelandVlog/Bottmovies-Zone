const OMDB_API_KEY = "d246cca2"; 
const TMDB_API_KEY = "ffa63099e82a2b25d082dcd0c040c8fb"; 
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// একই মুভির TMDB/OMDb ডিটেইলস বারবার fetch না করে ক্যাশ করে রাখার জন্য -
// দেখুন getFullTMDBDetails() / getOMDbDetails() এর কমেন্ট
const tmdbDetailsCache = new Map();
const omdbDetailsCache = new Map();

// দ্রুত একটার পর একটা কল হওয়া আটকায় (যেমন search বক্সে টাইপ করার সময়
// প্রতিটা key press) - শেষ কলটার `wait` মিলিসেকেন্ড পরে আসল ফাংশনটা চলে
function debounce(fn, wait) {
    let t;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// ==================== DATABASE CONFIG & INITIALIZATION ====================

// Supabase Project Config
const SUPABASE_URL = 'https://borglnmrvjafodkqhhhv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Q3WcdMEHLJO7SkO3Sd7BDQ_Ohu8xAp9';     

// Supabase Client Initialize
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const DOWNLOAD_HEADER_ICON = '⚡';

const DEFAULT_FAST_SERVERS = [
    { label: "Server 01: Terabox Link To Fast Downloader WEB", link: "https://1024teradownloader.com/" },
    { label: "Server 02: Terabox Link To Fast Downloader WEB", link: "https://teraboxdl.site/" }
];

const CATEGORY_ALIAS_MAP = {
    'netlfix': 'netflix',
    'netlfix-series': 'netflix',
    'bnagla': 'bangla',
    'bangla-dubed': 'bangla-dubbed',
    'bangla-dub': 'bangla-dubbed',
    'english-sereis': 'english-series',
    'hbo-box': 'hbo-max'
};
function normalizeCategorySlug(slug) {
    const s = String(slug || '').trim().toLowerCase();
    return CATEGORY_ALIAS_MAP[s] || s;
}

var allMovies = []; 
var moviesDataLoaded = false; // Supabase থেকে movies data একবার সফলভাবে লোড হয়ে গেলে true হয়ে যায়
var allDeletedMovies = [];
var allLinkAlerts = [];
const TRASH_RETENTION_DAYS = 30;
let moviesList = []; 
let currentPage = 1;
let moviesPerPage = 10; // recalculated responsively before every render - see getMoviesPerPage()
let currentFilteredMovies = [];
let sentRequests = new Set(); 

const EMAILJS_SERVICE_ID = "service_59gb31f";   
const EMAILJS_TEMPLATE_ID = "template_vpa657n"; 

const ADMIN_TRIGGER_EMAIL = "702640Shamil@admin.com";
const ADMIN_POSTER_BUCKET = "posters";
const AVATAR_BUCKET = "avatars";
const DEFAULT_AVATAR_PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76"><rect width="76" height="76" fill="#1a1c23"/><circle cx="38" cy="29" r="14" fill="#3a4457"/><path d="M12 66c4-16 18-24 26-24s22 8 26 24" fill="#3a4457"/></svg>'
);
const ADMIN_POSTER_PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" rx="8" fill="#1a1c23"/><path d="M12 30l6-7 5 5 6-8 5 6" stroke="#475569" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="15" r="3" fill="#475569"/></svg>'
);

// via.placeholder.com is dead/unreliable in 2026 (SSL/DNS issues) - use a local SVG instead
// so poster boxes never end up blank when there's no real poster to show.
function makePosterPlaceholder(label) {
    const safeLabel = escapeHtml(label || 'No Poster');
    return "data:image/svg+xml;utf8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#1a1c23"/><path d="M55 140l25-32 22 22 27-36 23 27" stroke="#475569" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="72" cy="105" r="10" fill="#475569"/><text x="100" y="230" font-family="sans-serif" font-size="14" fill="#64748b" text-anchor="middle">${safeLabel}</text></svg>`
    );
}
const POSTER_PLACEHOLDER_LOADING = makePosterPlaceholder('Loading...');
const POSTER_PLACEHOLDER_MISSING = makePosterPlaceholder('No Poster');

// A poster <img> can fail to load once on a "cold" first visit (DNS/TLS not
// warmed up yet, slow first connection to image.tmdb.org / OMDb's poster
// host) even though the URL is perfectly valid - a plain reload fixes it
// because the connection is warm the second time. Retrying once in-place
// covers that case automatically instead of making the user reload.
function handlePosterImgError(imgEl) {
    if (!imgEl) return;
    if (imgEl.dataset.posterRetried === '1') {
        imgEl.onerror = null;
        imgEl.src = POSTER_PLACEHOLDER_MISSING;
        return;
    }
    imgEl.dataset.posterRetried = '1';
    const originalSrc = imgEl.src;
    setTimeout(() => {
        if (imgEl.isConnected) imgEl.src = originalSrc;
    }, 800);
}

async function fetchMoviesFromSupabase() {
    try {
        const { data: movies, error } = await supabaseClient
            .from('movies')
            .select('*')
            .order('id', { ascending: false });

        if (error) {
            console.error('Error fetching movies from Supabase:', error.message);
            return;
        }

        if (movies && movies.length > 0) {
            console.log('Database Movies Loaded:', movies);

            function parseBlocksField(str) {
                if (!str) return [];
                if (Array.isArray(str)) return str;
                try {
                    const j = JSON.parse(str);
                    if (Array.isArray(j)) return j;
                } catch (e) {}

                return str.split(';;').map(part => {
                    const [label, link] = part.split('=>');
                    return {
                        label: label ? label.trim() : '',
                        link: link ? link.trim() : ''
                    };
                }).filter(b => b.label && b.link);
            }

            function parseCategoryField(val) {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                try {
                    const j = JSON.parse(val);
                    if (Array.isArray(val)) return val;
                } catch (e) { /* JSON না */ }
                return String(val).split('|').map(s => normalizeCategorySlug(s)).filter(Boolean);
            }

            const parsedAll = movies.map(m => {
                const parsed = { ...m };
                parsed.downloadBlocks = parseBlocksField(parsed.downloadBlocks);
                parsed.fastServers = parseBlocksField(parsed.fastServers);
                parsed.category = parseCategoryField(parsed.category);
                return parsed;
            });

            // Split into active content and soft-deleted (recycle bin) content
            allMovies = parsedAll.filter(m => !m.deleted_at);
            allDeletedMovies = parsedAll.filter(m => !!m.deleted_at);
            moviesDataLoaded = true; // data সফলভাবে লোড হয়ে গেছে — এরপর থেকে "No content found" দেখানো যাবে

            // Auto-purge items that have been in the recycle bin longer than the retention period
            purgeExpiredTrash();
            updateAdminTrashBadge();
            
            const oldMoviesCount = 387;
            
            if (allMovies.length > oldMoviesCount) {
                const newMoviesCount = allMovies.length - oldMoviesCount;
                
                const recentMovies = allMovies.slice(0, newMoviesCount); 
                
                const restMovies = allMovies.slice(newMoviesCount).reverse(); 
                
                allMovies = [...recentMovies, ...restMovies];
            } else {
                allMovies = allMovies.reverse();
            }
            // category নামের ঠিক পরে ?page= বসানো থাকে (যেমন #anime?page=2),
            // তাই hash কে category আর page — এই দুই ভাগে ভেঙে পড়া হচ্ছে
            let initialCategory = window.location.hash.replace('#', '');
            let initialPage = 1;
            const initialQIndex = initialCategory.indexOf('?');
            if (initialQIndex !== -1) {
                const hashPageParams = new URLSearchParams(initialCategory.substring(initialQIndex + 1));
                const p = parseInt(hashPageParams.get('page'), 10);
                if (p && p > 0) initialPage = p;
                initialCategory = initialCategory.substring(0, initialQIndex);
            }
            if (!initialCategory) {
                initialCategory = document.body.getAttribute('data-category') || 'all';
            }
            switchCategory(initialCategory, initialPage);

            // page refresh এ যদি Admin Panel আগে থেকেই খোলা থাকে (URL এ ?dashboard=1),
            // তাহলে movies data লোড হওয়ার আগেই ঐ ট্যাবের কন্টেন্ট রেন্ডার হয়ে "No content found" /
            // stats 0 দেখাচ্ছিল — data লোড শেষ হওয়ার পর যেই ট্যাব খোলা আছে সেটাই আবার রিফ্রেশ করে দাও
            const adminOverlayEl = document.getElementById('adminOverlay');
            if (adminOverlayEl && adminOverlayEl.style.display !== 'none') {
                if (currentAdminTab === 'dashboard') {
                    loadAdminDashboardStats();
                } else if (currentAdminTab === 'manage') {
                    const searchInput = document.getElementById('adminSearchInput');
                    renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'banner') {
                    const searchInput = document.getElementById('adminBannerSearchInput');
                    renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'trash') {
                    renderAdminTrashList();
                }
            }
        } else {
            console.warn('No movies found in database.');
            moviesDataLoaded = true; // এই কল সফল হয়েছে, শুধু ডাটাবেজ খালি — তাই এখন থেকে "No content found" ঠিক দেখানো যাবে
        }
    } catch (err) {
        console.error('Unexpected error loading database:', err);
    }
}

// ==================== HOME HERO BANNER FUNCTIONS ====================
// হোমপেজের উপরে "Featured" ক্যারুসেল/স্লাইডার। Admin চাইলে movies টেবিলে
// `featured` (boolean) + `featured_order` (integer) + `featured_image` (text, optional)
// কলাম বসিয়ে নির্দিষ্ট কিছু movie বেছে নিতে পারে (SUPABASE_SETUP.sql দেখুন)। কিছু
// বেছে না নিলে সবচেয়ে সাম্প্রতিক কয়েকটা movie/series এমনিতেই দেখানো হয় - ব্যানার
// কখনো খালি থাকে না। শুধু Home ("all") ক্যাটাগরিতে দেখা যায়, অন্য ক্যাটাগরিতে গেলে
// হাইড হয়ে যায় এবং autoplay টাইমার বন্ধ হয়ে যায় (অযথা network call বন্ধ রাখতে)।
let heroSlidesData = [];
let heroCurrentIndex = 0; // real/logical slide index (0..N-1) - drives the dots
let heroPos = 1;          // actual position inside the extended DOM track (clone-of-last, slide0..slideN-1, clone-of-first)
let heroAutoplayTimer = null;
let heroWrapTimeout = null;
let heroInitialized = false;
const heroBackdropCache = new Map();

function clearHeroWrapTimeout() {
    if (heroWrapTimeout) { clearTimeout(heroWrapTimeout); heroWrapTimeout = null; }
}

function getFeaturedMoviesForHero() {
    if (!Array.isArray(allMovies) || allMovies.length === 0) return [];

    const manuallyFeatured = allMovies
        .filter(m => m.featured === true)
        .sort((a, b) => (a.featured_order ?? 999) - (b.featured_order ?? 999));

    if (manuallyFeatured.length > 0) return manuallyFeatured.slice(0, 8);

    // Admin কিছু বেছে না নিলে - সবচেয়ে সাম্প্রতিক ৬টা content fallback হিসেবে দেখানো হয়
    return allMovies.slice(0, 6);
}

function getHeroCategoryLabel(movie) {
    const cats = Array.isArray(movie.category) ? movie.category : [];
    if (!cats.length) return '';
    const link = document.querySelector(`.nav-link[data-target="${cats[0]}"]`);
    if (link) return link.textContent.trim();
    return String(cats[0]).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getYearFromTitle(title) {
    const m = String(title || '').match(/\((\d{4}(?:-\d{2,4})?)\)\s*$/);
    return m ? m[1] : '';
}

function formatHeroDateLabel(movie, isoDate) {
    if (isoDate) {
        const d = new Date(isoDate);
        if (!isNaN(d.getTime())) return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    }
    if (movie.year) return String(movie.year);
    return getYearFromTitle(movie.title);
}

// প্রতিটা slide-এর জন্য widescreen "backdrop" ছবি আলাদাভাবে fetch হয় (grid এর পোর্ট্রেট
// poster থেকে সম্পূর্ণ আলাদা ক্যাশ - getFullTMDBDetails/getOMDbDetails এ হাত দেওয়া হয়নি)
async function fetchHeroBackdrop(movie) {
    const cacheKey = movie && (movie.id != null ? `id:${movie.id}` : `title:${(movie.searchName || movie.title || '').toLowerCase()}`);
    if (cacheKey && heroBackdropCache.has(cacheKey)) return heroBackdropCache.get(cacheKey);

    const promise = (async () => {
        if (movie.featured_image) return { backdrop: movie.featured_image, releaseDate: null };
        if (!TMDB_API_KEY) return { backdrop: movie.poster || null, releaseDate: null };
        try {
            let mediaType = movie.tmdbType || 'movie';
            let matchId = movie.tmdbId || null;
            const cleanImdbId = extractImdbId(movie.imdbId);

            if (!matchId && cleanImdbId) {
                const findRes = await fetchWithTimeout(`${TMDB_BASE_URL}/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 6000);
                if (findRes.ok) {
                    const findData = await findRes.json();
                    if (findData.movie_results && findData.movie_results.length > 0) {
                        matchId = findData.movie_results[0].id; mediaType = 'movie';
                    } else if (findData.tv_results && findData.tv_results.length > 0) {
                        matchId = findData.tv_results[0].id; mediaType = 'tv';
                    }
                }
            }

            if (!matchId && (movie.title || movie.searchName)) {
                const cleanQuery = (movie.searchName || movie.title).replace(/\s*\([\d\-]+\)/g, '').trim();
                const searchRes = await fetchWithTimeout(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}`, {}, 6000);
                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const match = searchData?.results?.find(item => item.media_type === 'movie' || item.media_type === 'tv') || searchData?.results?.[0];
                    if (match) { matchId = match.id; mediaType = match.media_type === 'tv' ? 'tv' : 'movie'; }
                }
            }

            if (!matchId) return { backdrop: movie.poster || null, releaseDate: null };

            const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${mediaType}/${matchId}?api_key=${TMDB_API_KEY}`, {}, 6000);
            if (!detailRes.ok) return { backdrop: movie.poster || null, releaseDate: null };
            const detailData = await detailRes.json();

            return {
                backdrop: detailData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${detailData.backdrop_path}` : (movie.poster || null),
                releaseDate: detailData.release_date || detailData.first_air_date || null
            };
        } catch (e) {
            return { backdrop: movie.poster || null, releaseDate: null };
        }
    })();

    if (cacheKey) heroBackdropCache.set(cacheKey, promise);
    return promise;
}

function renderHeroSlides() {
    const heroSection = document.getElementById('heroBanner');
    const track = document.getElementById('heroTrack');
    const dotsWrap = document.getElementById('heroDots');
    if (!heroSection || !track || !dotsWrap) return;

    stopHeroAutoplay();
    clearHeroWrapTimeout();
    heroSlidesData = getFeaturedMoviesForHero();

    if (heroSlidesData.length === 0) {
        heroSection.style.display = 'none';
        track.innerHTML = '';
        dotsWrap.innerHTML = '';
        return;
    }

    heroCurrentIndex = 0;
    heroPos = 1; // position 0 রাখা থাকে "শেষ slide"-এর clone-এর জন্য, তাই আসল slide0 শুরু হয় position 1 থেকে
    track.innerHTML = '';
    dotsWrap.innerHTML = '';

    const N = heroSlidesData.length;

    // idSuffix না দিলে আসল slide (id="heroBg-0" ইত্যাদি), দিলে সেটা শুধু ভিজ্যুয়াল clone (seamless loop-এর জন্য)
    function buildSlideEl(movie, i, idSuffix) {
        const catLabel = getHeroCategoryLabel(movie);
        const fullTitle = movie.title || '';
        const cleanTitle = fullTitle.replace(/\s*\([\d\-]+\)\s*$/, '').trim() || fullTitle;
        const isClone = idSuffix != null;
        const domId = isClone ? idSuffix : i;
        const slide = document.createElement('div');
        slide.className = 'hero-slide';
        if (isClone) slide.setAttribute('aria-hidden', 'true');
        slide.innerHTML = `
            <div class="hero-slide-bg" id="heroBg-${domId}" style="background-image:url('${movie.poster || POSTER_PLACEHOLDER_LOADING}')"></div>
            <div class="hero-slide-shade"></div>
            <div class="hero-slide-top">
                <span class="hero-badge hero-badge-featured">Featured</span>
                ${catLabel ? `<span class="hero-badge hero-badge-cat">${catLabel}</span>` : ''}
            </div>
            <div class="hero-slide-info">
                <h2 class="hero-slide-title">${cleanTitle}</h2>
                <p class="hero-slide-subtitle">${fullTitle}</p>
                <div class="hero-slide-meta-row">
                    <span class="hero-meta-hd">HD</span>
                    <span class="hero-meta-date" id="heroDate-${domId}">${movie.year ? movie.year : getYearFromTitle(fullTitle)}</span>
                </div>
                <button type="button" class="hero-watch-btn" id="heroWatchBtn-${domId}" ${isClone ? 'tabindex="-1"' : ''}>▶ Watch Now</button>
            </div>
        `;
        const watchBtn = slide.querySelector(`#heroWatchBtn-${domId}`);
        if (watchBtn) watchBtn.addEventListener('click', () => openMovieModal(heroSlidesData[i]));
        return slide;
    }

    // ১. শুরুতে শেষ real slide-এর একটা clone বসানো হয় (prev করে প্রথম থেকে শেষে seamless যাওয়ার জন্য)
    track.appendChild(buildSlideEl(heroSlidesData[N - 1], N - 1, 'cloneLast'));

    // ২. তারপর আসল সব slide + dot
    heroSlidesData.forEach((movie, i) => {
        track.appendChild(buildSlideEl(movie, i));

        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
        dot.setAttribute('aria-label', `Slide ${i + 1}`);
        dot.addEventListener('click', () => goToHeroSlide(i));
        dotsWrap.appendChild(dot);
    });

    // ৩. শেষে প্রথম real slide-এর একটা clone বসানো হয় (next করে শেষ থেকে প্রথমে seamless যাওয়ার জন্য - মূল bug fix)
    track.appendChild(buildSlideEl(heroSlidesData[0], 0, 'cloneFirst'));

    heroSection.style.display = '';
    updateHeroTrackPosition(false);
    startHeroAutoplay();

    // real backdrop + release date গুলো background এ lazy লোড হয় (poster দিয়ে instant দেখা যায়)
    // clone slide-গুলোতেও (cloneFirst/cloneLast) একই ছবি বসিয়ে দেওয়া হয়, নাহলে seamless loop-এর সময়
    // clone-টা পুরনো poster placeholder দেখাবে আর আসল slide নতুন backdrop - মিসম্যাচ চোখে পড়বে
    heroSlidesData.forEach((movie, i) => {
        fetchHeroBackdrop(movie).then(data => {
            const targetIds = [i];
            if (i === 0) targetIds.push('cloneFirst');
            if (i === N - 1) targetIds.push('cloneLast');
            targetIds.forEach(id => {
                const bgEl = document.getElementById(`heroBg-${id}`);
                if (bgEl && data && data.backdrop) bgEl.style.backgroundImage = `url('${data.backdrop}')`;
                const dateEl = document.getElementById(`heroDate-${id}`);
                if (dateEl) {
                    const label = formatHeroDateLabel(movie, data && data.releaseDate);
                    dateEl.textContent = label ? `${label}` : '';
                }
            });
        });
    });
}

function updateHeroTrackPosition(animate = true) {
    const track = document.getElementById('heroTrack');
    if (!track) return;
    track.style.transition = animate ? 'transform 0.6s cubic-bezier(.4,0,.2,1)' : 'none';
    track.style.transform = `translate3d(-${heroPos * 100}%, 0, 0)`;
    document.querySelectorAll('#heroDots .hero-dot').forEach((d, i) => d.classList.toggle('active', i === heroCurrentIndex));
}

// dot ক্লিক করলে সরাসরি সেই slide-এ (নিজের real position-এ) চলে যায়
function goToHeroSlide(i) {
    if (!heroSlidesData.length) return;
    clearHeroWrapTimeout();
    heroCurrentIndex = ((i % heroSlidesData.length) + heroSlidesData.length) % heroSlidesData.length;
    heroPos = heroCurrentIndex + 1;
    updateHeroTrackPosition(true);
    startHeroAutoplay();
}

// শেষ slide থেকে next করলে বাকি সবগুলোর মতোই একটা ধাপ smoothly slide করে clone-first এ যায়,
// clone-টা দেখতে হুবহু আসল প্রথম slide-এর (img1) মতোই, তাই transition শেষ হতেই কোনো animation ছাড়া
// (snap) আসল slide0-এ বসিয়ে দেওয়া হয় - দর্শকের চোখে img1 একই থেকে যায়, কোনো ধাক্কা/jump দেখা যায় না
function heroGoNext() {
    if (!heroSlidesData.length) return;
    clearHeroWrapTimeout();
    const N = heroSlidesData.length;
    if (heroCurrentIndex === N - 1) {
        heroPos = N + 1; // clone-first এর position
        heroCurrentIndex = 0;
        updateHeroTrackPosition(true);
        heroWrapTimeout = setTimeout(() => {
            heroPos = 1; // আসল slide0
            updateHeroTrackPosition(false); // no animation - clone আর আসল slide0 দেখতে same
        }, 620);
    } else {
        heroCurrentIndex += 1;
        heroPos += 1;
        updateHeroTrackPosition(true);
    }
    startHeroAutoplay();
}

// একইভাবে প্রথম slide থেকে prev করলে clone-last দিয়ে seamless ভাবে শেষ slide-এ যায়
function heroGoPrev() {
    if (!heroSlidesData.length) return;
    clearHeroWrapTimeout();
    const N = heroSlidesData.length;
    if (heroCurrentIndex === 0) {
        heroPos = 0; // clone-last এর position
        heroCurrentIndex = N - 1;
        updateHeroTrackPosition(true);
        heroWrapTimeout = setTimeout(() => {
            heroPos = N; // আসল শেষ slide
            updateHeroTrackPosition(false);
        }, 620);
    } else {
        heroCurrentIndex -= 1;
        heroPos -= 1;
        updateHeroTrackPosition(true);
    }
    startHeroAutoplay();
}

function startHeroAutoplay() {
    stopHeroAutoplay();
    if (heroSlidesData.length <= 1) return;
    heroAutoplayTimer = setInterval(heroGoNext, 6000);
}
function stopHeroAutoplay() {
    if (heroAutoplayTimer) { clearInterval(heroAutoplayTimer); heroAutoplayTimer = null; }
}

// শুধু একবারই button click/swipe listener বসানো হয় - প্রতিটা slide re-render এ না
function setupHeroBannerControls() {
    if (heroInitialized) return;
    heroInitialized = true;

    const heroSection = document.getElementById('heroBanner');
    const prevBtn = document.getElementById('heroPrevBtn');
    const nextBtn = document.getElementById('heroNextBtn');
    if (prevBtn) prevBtn.addEventListener('click', heroGoPrev);
    if (nextBtn) nextBtn.addEventListener('click', heroGoNext);
    if (!heroSection) return;

    heroSection.addEventListener('mouseenter', stopHeroAutoplay);
    heroSection.addEventListener('mouseleave', startHeroAutoplay);

    let touchStartX = 0, touchDeltaX = 0, isTouching = false, touchSectionWidth = 0;
    let dragRafId = null;
    const track = document.getElementById('heroTrack');

    // touchmove প্রতি ফ্রেমে বহুবার ফায়ার করতে পারে - প্রতিবার সরাসরি style লেখার
    // বদলে requestAnimationFrame দিয়ে ব্যাচ করা হয়, আর offsetWidth (layout read) একবারই
    // touchstart এ মাপা হয় - প্রতি touchmove এ measure করলে forced-reflow হয়ে বাড়তি lag হয়
    function applyDragTransform(deltaX, sectionWidth) {
        if (dragRafId) return;
        dragRafId = requestAnimationFrame(() => {
            dragRafId = null;
            if (!track) return;
            const percent = (deltaX / sectionWidth) * 100;
            track.style.transform = `translate3d(calc(-${heroPos * 100}% + ${percent}%), 0, 0)`;
        });
    }

    heroSection.addEventListener('touchstart', (e) => {
        isTouching = true; touchDeltaX = 0;
        touchStartX = e.touches[0].clientX;
        touchSectionWidth = heroSection.offsetWidth;
        stopHeroAutoplay();
        clearHeroWrapTimeout();
        if (track) { track.style.transition = 'none'; track.style.willChange = 'transform'; }
    }, { passive: true });
    heroSection.addEventListener('touchmove', (e) => {
        if (!isTouching || !track) return;
        touchDeltaX = e.touches[0].clientX - touchStartX;
        // আঙুলের সাথে সাথে সাথে সাথে slide-টা লাইভ drag হবে (শুধু threshold পার হলে jump না)
        applyDragTransform(touchDeltaX, touchSectionWidth);
    }, { passive: true });
    heroSection.addEventListener('touchend', () => {
        if (!isTouching) return;
        isTouching = false;
        if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
        if (track) track.style.willChange = '';
        if (Math.abs(touchDeltaX) > 40) {
            touchDeltaX < 0 ? heroGoNext() : heroGoPrev();
        } else {
            updateHeroTrackPosition(true); // যথেষ্ট swipe না হলে smoothly আগের slide-এ ফিরে যাবে
            startHeroAutoplay();
        }
        touchDeltaX = 0;
    });

    // ---- মাউস/ট্র্যাকপ্যাড দিয়েও drag করা যাবে (বড় ডিভাইস/ল্যাপটপ) ----
    const heroViewportEl = heroSection.querySelector('.hero-viewport');
    let mouseStartX = 0, mouseDeltaX = 0, isMouseDragging = false, mouseSectionWidth = 0;
    heroSection.addEventListener('mousedown', (e) => {
        isMouseDragging = true; mouseDeltaX = 0;
        mouseStartX = e.clientX;
        mouseSectionWidth = heroSection.offsetWidth;
        stopHeroAutoplay();
        clearHeroWrapTimeout();
        if (track) { track.style.transition = 'none'; track.style.willChange = 'transform'; }
        if (heroViewportEl) heroViewportEl.style.cursor = 'grabbing';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!isMouseDragging || !track) return;
        mouseDeltaX = e.clientX - mouseStartX;
        applyDragTransform(mouseDeltaX, mouseSectionWidth);
    });
    window.addEventListener('mouseup', () => {
        if (!isMouseDragging) return;
        isMouseDragging = false;
        if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
        if (track) track.style.willChange = '';
        if (heroViewportEl) heroViewportEl.style.cursor = '';
        if (Math.abs(mouseDeltaX) > 40) {
            mouseDeltaX < 0 ? heroGoNext() : heroGoPrev();
        } else {
            updateHeroTrackPosition(true);
            startHeroAutoplay();
        }
        mouseDeltaX = 0;
    });
}

// Home ("all") ছাড়া অন্য কোনো ক্যাটাগরিতে গেলে ব্যানার হাইড হয়ে যায় ও autoplay বন্ধ হয়
function updateHeroVisibilityForCategory(category) {
    const heroSection = document.getElementById('heroBanner');
    if (!heroSection) return;

    if (category !== 'all') {
        heroSection.style.display = 'none';
        stopHeroAutoplay();
        return;
    }

    if (heroSlidesData.length === 0) {
        renderHeroSlides();
    } else {
        heroSection.style.display = '';
        startHeroAutoplay();
    }
}

// ==================== HELPER FUNCTIONS ====================

async function fetchWithTimeout(url, options = {}, timeout = 2500) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// একসাথে অনেকগুলো মুভির TMDB/OMDb fetch একবারে পাঠালে ব্রাউজারের
// per-domain connection limit (~৬টা) এ আটকে যায়, আর fetchWithTimeout এর
// টাইমার request queue তে বসে থাকা অবস্থাতেই কাউন্ট হতে থাকে - ফলে
// প্রথম কয়েকটা বাদে বাকি সবগুলো AbortError দিয়ে ফেইল করে (poster কালো/ফাঁকা
// থেকে যায়)। এই হেল্পার দিয়ে একবারে সর্বোচ্চ `limit` সংখ্যক আইটেম প্রসেস
// করা হয়, বাকিগুলো একটা শেষ হলে পরেরটা শুরু হয় - কানেকশন লিমিটের মধ্যে থেকে।
async function runWithConcurrencyLimit(items, limit, worker) {
    let cursor = 0;
    const workerCount = Math.min(limit, items.length);
    const runners = new Array(workerCount).fill(0).map(async () => {
        while (cursor < items.length) {
            const currentIndex = cursor++;
            try {
                await worker(items[currentIndex], currentIndex);
            } catch (e) {
                console.error("Card detail fetch error:", e);
            }
        }
    });
    await Promise.all(runners);
}

function extractImdbId(input) {
    if (!input) return null;
    const match = String(input).match(/tt\d+/);
    return match ? match[0] : null;
}

function formatCurrency(amount) {
    if (!amount || amount === 0 || amount === "0" || amount === "N/A") return "N/A";
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) return "N/A";

    if (num >= 1000000000) return `$${(num / 1000000000).toFixed(1).replace(/\.0$/, '')}B`;
    if (num >= 1000000) return `$${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `$${num}`;
}

function convertRuntimeToHours(runtimeStr) {
    if (!runtimeStr || runtimeStr === "N/A") return "N/A";
    const minutes = parseInt(runtimeStr, 10);
    if (isNaN(minutes)) return runtimeStr;
    
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m`;
    if (hrs > 0) return `${hrs}h`;
    return `${mins}m`;
}

function formatViewCount(num) {
    const n = Number(num) || 0;
    if (n < 1000) return `${n} views`;
    if (n < 1000000) return `${(n / 1000).toFixed(1)}K views`;
    let m = (n / 1000000).toFixed(1);
    if (m.endsWith('.0')) m = m.slice(0, -2);
    return `${m}M views`;
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr).getTime();
    if (isNaN(then)) return '';

    const diffSec = Math.floor((Date.now() - then) / 1000);
    if (diffSec < 60) return 'Just now';

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr ago`;

    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} day ago`;

    const diffWeek = Math.floor(diffDay / 7);
    if (diffWeek < 4) return `${diffWeek} week ago`;

    return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

let currentModalMovie = null;

// ==================== COMMENTS: STATE ====================
let commentsCurrentMovieId = null;
let commentsSortMode = 'newest';   // 'newest' | 'top'

async function incrementMovieViews(movie) {
    if (!movie || movie.id === undefined || movie.id === null) return;

    const newViews = (Number(movie.views) || 0) + 1;
    movie.views = newViews; 

    const viewsEl = document.getElementById('modalViewsVal');
    if (viewsEl) viewsEl.textContent = formatViewCount(newViews);

    try {
        const { error } = await supabaseClient
            .from('movies')
            .update({ views: newViews })
            .eq('id', movie.id);
        if (error) console.error('Error updating views:', error.message);
    } catch (err) {
        console.error('Unexpected error updating views:', err);
    }
}

function closeNotice() { 
    const banner = document.getElementById('noticeBanner');
    if (banner) banner.style.display = 'none'; 
}

function closeMovieModal() {
    document.getElementById('movieModalOverlay').style.display = 'none';
    document.body.classList.remove('modal-open');
    commentsCurrentMovieId = null;
}

function copyDownloadLink(linkId, btnElement) {
    const linkElement = document.getElementById(linkId);
    if (linkElement && linkElement.href) {
        incrementMovieViews(currentModalMovie); // লিংক কপি করলে ভিউ কাউন্ট বাড়বে

        // ডাউনলোড বাটনের মতোই, লিংক কপি করলেও সেটা Download History তে যোগ হবে
        // (ইউজার লিংকটা কপি করে নিজে ব্রাউজার/ডাউনলোডার দিয়ে ডাউনলোড করবে ধরে নিয়ে)
        const headerEl = linkElement.closest('.season-box-item')?.querySelector('.season-box-header');
        const linkLabel = headerEl?.dataset.label || '';
        logDownloadHistory(currentModalMovie, linkLabel);

        navigator.clipboard.writeText(linkElement.href).then(() => {
            const originalText = btnElement.innerText;
            btnElement.innerText = 'Copied!';
            btnElement.style.borderColor = '#8bc34a';
            btnElement.style.color = '#8bc34a';
            setTimeout(() => {
                btnElement.innerText = originalText;
                btnElement.style.borderColor = '';
                btnElement.style.color = '';
            }, 2000);
        }).catch(err => console.error('Failed to copy: ', err));
    }
}

// ==================== BROKEN LINK ALERTS ====================
// The admin panel's 🔔 Alerts tab is fed by a best-effort background check
// (autoCheckDownloadLinks below), which only catches links whose domain/server
// is completely unreachable. Browsers cannot read the response of a cross-origin
// Terabox page (CORS), so this CANNOT detect "file removed, page still loads".
// Visitors now report that kind of dead link through the dedicated
// report-broken-links.html comment page instead of an in-modal button.

async function flagAutoCheckAlert(movie, label, link) {
    try {
        const { data: existing } = await supabaseClient
            .from('link_alerts')
            .select('id')
            .eq('movie_id', movie.id)
            .eq('link_url', link)
            .eq('status', 'open')
            .limit(1);
        if (existing && existing.length > 0) return; // already flagged — don't duplicate

        await supabaseClient.from('link_alerts').insert([{
            movie_id: movie.id,
            movie_title: movie.title || '',
            link_label: label,
            link_url: link,
            source: 'auto_check',
            status: 'open'
        }]);
    } catch (err) {
        console.error('Auto-check alert insert failed:', err);
    }
}

// Best-effort automatic check — runs at most once per movie per browser per day.
// It can only detect a link whose domain is completely dead (DNS/connection failure);
// it cannot see whether a Terabox share itself was removed, since cross-origin responses
// are opaque to the browser (CORS). Real "content deleted on Terabox" detection relies on
// visitor reports posted through report-broken-links.html.
async function autoCheckDownloadLinks(movie) {
    if (!movie || !movie.id || !Array.isArray(movie.downloadBlocks)) return;

    const throttleKey = `bottmovies_autocheck_${movie.id}`;
    const lastCheck = Number(localStorage.getItem(throttleKey) || 0);
    if (Date.now() - lastCheck < 24 * 60 * 60 * 1000) return;
    localStorage.setItem(throttleKey, String(Date.now()));

    const linkItems = [];
    movie.downloadBlocks.forEach(sec => {
        if (Array.isArray(sec.items) && sec.items.length > 0) {
            sec.items.forEach(it => { if (it.link) linkItems.push({ label: sec.label || 'Episode', link: it.link }); });
        } else if (sec.link) {
            linkItems.push({ label: sec.label || 'Download Link', link: sec.link });
        }
    });

    for (const item of linkItems) {
        try {
            await fetchWithTimeout(item.link, { mode: 'no-cors', method: 'HEAD' }, 6000);
        } catch (err) {
            flagAutoCheckAlert(movie, item.label, item.link);
        }
    }
}

// ==================== API DETAILS FETCHING ====================

async function getFullTMDBDetails(movie) {
    // একই মুভির জন্য বারবার TMDB কল না করে ক্যাশ করে রাখা হয় - না হলে
    // search box এ প্রতিটা key press এ grid re-render হয় আর প্রতিটা card
    // এর জন্য আবার নতুন করে fetch শুরু হয়, স্লো মোবাইল কানেকশনে এটা
    // request জ্যাম তৈরি করে ফেলে (তখন মুভি খুললেও poster/rating "N/A"
    // দেখায়, কারণ ততক্ষণে network এ ভিড় জমে থাকে বা rate-limit হয়ে যায়)।
    const cacheKey = movie && (movie.id != null ? `id:${movie.id}` : `title:${(movie.searchName || movie.title || '').toLowerCase()}`);
    if (cacheKey && tmdbDetailsCache.has(cacheKey)) return tmdbDetailsCache.get(cacheKey);
    const promise = fetchFullTMDBDetailsUncached(movie);
    if (cacheKey) tmdbDetailsCache.set(cacheKey, promise);
    return promise;
}

async function fetchFullTMDBDetailsUncached(movie) {
    if (!TMDB_API_KEY) return null;
    try {
        let mediaType = movie.tmdbType || 'movie';
        let matchId = movie.tmdbId || null;
        const cleanImdbId = extractImdbId(movie.imdbId);

        if (!matchId && cleanImdbId) {
            const findRes = await fetchWithTimeout(`${TMDB_BASE_URL}/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 6000);
            if (findRes.ok) {
                const findData = await findRes.json();
                if (findData.movie_results && findData.movie_results.length > 0) {
                    matchId = findData.movie_results[0].id;
                    mediaType = 'movie';
                } else if (findData.tv_results && findData.tv_results.length > 0) {
                    matchId = findData.tv_results[0].id;
                    mediaType = 'tv';
                }
            }
        }

        if (!matchId && (movie.title || movie.searchName)) {
            const cleanQuery = (movie.searchName || movie.title).replace(/\s*\([\d\-]+\)/g, '').trim();
            const searchRes = await fetchWithTimeout(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}`, {}, 6000);
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                if (searchData && searchData.results && searchData.results.length > 0) {
                    const match = searchData.results.find(item => item.media_type === 'movie' || item.media_type === 'tv') || searchData.results[0];
                    matchId = match.id;
                    mediaType = match.media_type === 'tv' ? 'tv' : 'movie';
                }
            }
        }

        if (!matchId) return null;

        const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${mediaType}/${matchId}?api_key=${TMDB_API_KEY}&append_to_response=credits,external_ids,release_dates,content_ratings`, {}, 6000);
        if (!detailRes.ok) return null;
        const detailData = await detailRes.json();

        let directorsList = [];
        let writersList = [];
        let cast = "N/A";

        if (detailData.created_by && detailData.created_by.length > 0) {
            directorsList.push(...detailData.created_by.map(c => c.name));
        }

        if (detailData.credits && detailData.credits.crew) {
            detailData.credits.crew.forEach(person => {
                const job = person.job ? person.job.toLowerCase() : '';
                const dept = person.department ? person.department.toLowerCase() : '';

                if (job === 'director' || dept === 'directing') {
                    if (!directorsList.includes(person.name)) directorsList.push(person.name);
                }
                if (job === 'writer' || job === 'screenplay' || job === 'story' || job === 'creator' || dept === 'writing') {
                    if (!writersList.includes(person.name)) writersList.push(person.name);
                }
            });
        }

        if (detailData.credits && detailData.credits.cast) {
            cast = detailData.credits.cast.slice(0, 5).map(c => c.name).join(", ");
        }

        const director = directorsList.length > 0 ? directorsList.slice(0, 3).join(", ") : "N/A";
        const writer = writersList.length > 0 ? writersList.slice(0, 3).join(", ") : "N/A";

        const releaseDate = detailData.release_date || detailData.first_air_date || "N/A";
        const year = releaseDate !== "N/A" ? releaseDate.split("-")[0] : "N/A";
        const genres = detailData.genres ? detailData.genres.map(g => g.name).join(", ") : "N/A";
        const runtime = detailData.runtime ? `${detailData.runtime} min` : (detailData.episode_run_time && detailData.episode_run_time.length ? `${detailData.episode_run_time[0]} min` : "N/A");

        let extractedTagline = detailData.tagline ? detailData.tagline.trim() : "";
        if (!extractedTagline && detailData.overview) {
            const firstSentenceMatch = detailData.overview.match(/[^.!?]+[.!?]/);
            if (firstSentenceMatch) extractedTagline = firstSentenceMatch[0].trim();
        }

        const tmdbRating = detailData.vote_average ? detailData.vote_average.toFixed(1) : "N/A";
        let contentRating = "NR"; 
        
        if (mediaType === 'movie' && detailData.release_dates && detailData.release_dates.results) {
            const usRelease = detailData.release_dates.results.find(r => r.iso_3166_1 === 'US');
            if (usRelease && usRelease.release_dates && usRelease.release_dates.length > 0) {
                const certObj = usRelease.release_dates.find(d => d.certification !== '');
                if (certObj) contentRating = certObj.certification;
            }
        } else if (mediaType === 'tv' && detailData.content_ratings && detailData.content_ratings.results) {
            const usRating = detailData.content_ratings.results.find(r => r.iso_3166_1 === 'US');
            if (usRating && usRating.rating) contentRating = usRating.rating;
        }
        
        const finalImdbId = cleanImdbId || (detailData.external_ids && detailData.external_ids.imdb_id) || null;

        return {
            id: matchId,
            mediaType: mediaType,
            title: detailData.title || detailData.name || movie.title,
            poster: detailData.poster_path ? `https://image.tmdb.org/t/p/w500${detailData.poster_path}` : null,
            plot: detailData.overview || "",
            year: year,
            releaseDate: releaseDate,
            runtime: runtime,
            numberOfSeasons: detailData.number_of_seasons || null, 
            genre: genres,
            tagline: extractedTagline,
            director: director,
            writer: writer,
            cast: cast,
            tmdbRating: tmdbRating,
            imdbId: finalImdbId,
            contentRating: contentRating,
            budget: detailData.budget || 0,
            revenue: detailData.revenue || 0
        };
    } catch(e) {
        console.error("TMDB Details Error or Timeout:", e);
    }
    return null;
}

async function getOMDbDetails(movie) {
    // TMDB এর মতো এটাতেও ক্যাশ - বারবার একই মুভির জন্য OMDb কল এড়াতে
    // (OMDb এর free key তে rate limit আছে, বারবার কল করলে সেটাও ফুরিয়ে যেতে পারে)
    const cacheKey = movie && (movie.id != null ? `id:${movie.id}` : `title:${(movie.searchName || movie.title || '').toLowerCase()}`);
    if (cacheKey && omdbDetailsCache.has(cacheKey)) return omdbDetailsCache.get(cacheKey);
    const promise = fetchOMDbDetailsUncached(movie);
    if (cacheKey) omdbDetailsCache.set(cacheKey, promise);
    return promise;
}

async function fetchOMDbDetailsUncached(movie) {
    try {
        const cleanImdb = extractImdbId(movie.imdbId);
        const cleanName = (movie.searchName || movie.title).replace(/\s*\([\d\-]+\)/g, '').trim();
        const omdbQuery = cleanImdb ? `i=${encodeURIComponent(cleanImdb)}` : `t=${encodeURIComponent(cleanName)}`;
        const res = await fetchWithTimeout(`https://www.omdbapi.com/?${omdbQuery}&apikey=${OMDB_API_KEY}`, {}, 6000);
        const data = await res.json();
        if (data && data.Response === "True") {
            return {
                title: data.Title || null,
                imdbRating: (data.imdbRating && data.imdbRating !== "N/A") ? data.imdbRating : null,
                awards: (data.Awards && data.Awards !== "N/A") ? data.Awards : "N/A",
                director: (data.Director && data.Director !== "N/A") ? data.Director : "N/A",
                writer: (data.Writer && data.Writer !== "N/A") ? data.Writer : "N/A",
                cast: (data.Actors && data.Actors !== "N/A") ? data.Actors : "N/A",
                plot: (data.Plot && data.Plot !== "N/A") ? data.Plot : "",
                poster: (data.Poster && data.Poster !== "N/A") ? data.Poster : null,
                year: data.Year || "N/A",
                genre: data.Genre || "N/A",
                imdbID: data.imdbID || cleanImdb || null
            };
        }
    } catch(e) {
        console.error("OMDb Details Error or Timeout:", e);
    }
    return null;
}

function getSmartRating(tmdbData, omdbData) {
 if (omdbData && omdbData.imdbRating && omdbData.imdbRating !== "N/A") return omdbData.imdbRating;
 if (tmdbData && tmdbData.tmdbRating && tmdbData.tmdbRating !== "N/A") return tmdbData.tmdbRating;
 return "N/A";
}

function sendMissingMovieEmail(movieName) {
    const cleanName = movieName.trim();
    if (cleanName.length < 2 || sentRequests.has(cleanName.toLowerCase())) return;
    sentRequests.add(cleanName.toLowerCase()); 

    const templateParams = { movie_title: cleanName, status: "Movie Not Found Request" };
    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams);
}

// ==================== RENDERING & PAGINATION ====================

// প্রতি লাইনে (row) আসলে কয়টা কন্টেন্ট বসছে সেটা .movie-grid এর
// computed grid-template-columns থেকে গুনে বের করে - CSS ব্রেকপয়েন্ট
// পাল্টালে ম্যানুয়ালি সিঙ্ক করার দরকার হয় না।
function getGridColumnsCount() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return 5;
    const cols = window.getComputedStyle(grid).getPropertyValue('grid-template-columns')
        .split(' ')
        .filter(Boolean).length;
    return cols || 5;
}

// ফোনে ব্রাউজারের "Request Desktop Site" চালু থাকলে ভিউপোর্ট width বড় দেখানো হয়
// (তাই ৫-কলাম গ্রিড বসে যায়, নিচের max-width মিডিয়া কোয়েরিগুলো আর ধরে না) কিন্তু
// ফোনের আসল স্ক্রিন তো তখনও লম্বা (portrait) - zoom-out করে পুরো পেজ দেখানোর কারণে
// effective viewport height অনেক বেশি হয়ে যায়। normal desktop monitor-এর জন্য ঠিক
// করা "৫ কলাম = ২ row = ১০টা" নিয়মে তখন পেজের নিচের অনেকটা অংশ ফাঁকা থেকে যায় -
// screen.width/height ব্রাউজার viewport স্পুফ করলেও বদলায় না (আসল ডিভাইসের
// রেজোলিউশনই দেখায়), তাই touch + ছোট আসল স্ক্রিন + ৫-কলাম গ্রিড এই কম্বিনেশন
// দেখলে বোঝা যায় এটা আসলে ফোনেই জোর করে "desktop site" চালু করা হয়েছে।
function isForcedDesktopOnPhone(cols) {
    if (cols !== 5) return false;
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (!isTouch) return false;
    const realScreenNarrow = Math.min(window.screen.width || 0, window.screen.height || 0) < 500;
    return realScreenNarrow;
}

// নিয়ম: যেকোনো ডিভাইসে ১ লাইনে সর্বোচ্চ ৫টা কন্টেন্ট।
// ১ লাইনে ৩ বা ৪টা কন্টেন্ট থাকলে প্রতি পেজে ১২টা কন্টেন্ট,
// বাকি সব ক্ষেত্রে (২ বা ৫টা) প্রতি পেজে ১০টা কন্টেন্ট।
// ব্যতিক্রম: ফোনে জোর করে "desktop site" চালু থাকলে (isForcedDesktopOnPhone) সেই
// ফাঁকা জায়গার সমস্যা এড়াতে row সংখ্যা visible viewport-এর height/width অনুপাত
// মেপে বাড়ানো হয়, যাতে zoom-out করা লম্বা ভার্চুয়াল পেজটা যথেষ্ট কন্টেন্ট দিয়ে ভরে
// যায় - স্বাভাবিক ডেস্কটপ/মোবাইলে (এই কন্ডিশন false থাকলে) আচরণ আগের মতোই থাকে।
function getMoviesPerPage() {
    let cols = getGridColumnsCount();
    if (cols > 5) cols = 5;

    if (isForcedDesktopOnPhone(cols)) {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const vh = window.innerHeight || document.documentElement.clientHeight || 1;
        const aspect = vh / vw; // সাধারণ ডেস্কটপে এটা মোটামুটি ০.৫-০.৭, ফোনে ভুয়া ডেস্কটপ মোডে অনেক বেশি (লম্বা)
        const rows = Math.max(2, Math.round(2 * aspect)) + 1; // +১ এক্সট্রা লাইন, যাতে নিচে সামান্য ফাঁকা থাকলেও পুরোপুরি ভরাট মনে হয়
        return cols * rows;
    }

    if (cols === 3 || cols === 4) return 12;
    return 10;
}

let _lastGridColsForResize = null;
function handleResponsiveGridResize() {
    const cols = getGridColumnsCount();
    if (cols === _lastGridColsForResize) return;
    _lastGridColsForResize = cols;
    if (currentFilteredMovies && currentFilteredMovies.length) {
        renderMoviesByPage(currentFilteredMovies, 1);
    }
}
(function initResponsiveGridWatcher() {
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(handleResponsiveGridResize, 200);
    });
})();

function renderPaginationControls(movies, page) {
    const container = document.getElementById('paginationContainer');
    if (!container) return;
    container.innerHTML = '';

    const totalPages = Math.ceil(movies.length / moviesPerPage);
    if (totalPages <= 1) return;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-num prev-next' + (page === 1 ? ' disabled' : '');
    prevBtn.innerHTML = '&laquo; Prev';
    prevBtn.addEventListener('click', () => {
        if (page > 1) renderMoviesByPage(movies, page - 1);
    });
    container.appendChild(prevBtn);

    let pagesToShow = [];
    if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pagesToShow.push(i);
    } else {
        pagesToShow.push(1);
        if (page > 3) pagesToShow.push('...');
        let start = Math.max(2, page - 1);
        let end = Math.min(totalPages - 1, page + 1);
        for (let i = start; i <= end; i++) {
            if (!pagesToShow.includes(i)) pagesToShow.push(i);
        }
        if (page < totalPages - 2) pagesToShow.push('...');
        if (!pagesToShow.includes(totalPages)) pagesToShow.push(totalPages);
    }

    pagesToShow.forEach(p => {
        if (p === '...') {
            const dots = document.createElement('span');
            dots.className = 'page-dots';
            dots.innerText = '...';
            container.appendChild(dots);
        } else {
            const btn = document.createElement('button');
            btn.className = 'page-num' + (p === page ? ' active' : '');
            btn.innerText = p;
            btn.addEventListener('click', () => {
                if (p !== page) renderMoviesByPage(movies, p);
            });
            container.appendChild(btn);
        }
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-num prev-next' + (page === totalPages ? ' disabled' : '');
    nextBtn.innerHTML = 'Next &raquo;';
    nextBtn.addEventListener('click', () => {
        if (page < totalPages) renderMoviesByPage(movies, page + 1);
    });
    container.appendChild(nextBtn);
}

function renderMoviesByPage(movies, page) {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    grid.innerHTML = '';
    currentPage = page;

    // Refresh দিলেও যে page (1, 2, 3...) এ ছিলাম সেখানেই থাকার জন্য URL এর hash এ
    // category নামের ঠিক পরে ?page= বসিয়ে রাখা হয় (যেমন #anime?page=2)
    // (dashboard/auth মোডাল URL এ খোলা থাকলে সেটাতে হাত দেওয়া হয় না)
    const pageUrlParams = new URLSearchParams(window.location.search);
    if (!pageUrlParams.has('dashboard') && !pageUrlParams.has('auth')) {
        const rawHash = window.location.hash.replace('#', '');
        const hashQIndex = rawHash.indexOf('?');
        const hashCategory = hashQIndex === -1 ? rawHash : rawHash.substring(0, hashQIndex);
        const newHash = page > 1
            ? '#' + hashCategory + '?page=' + page
            : (hashCategory ? '#' + hashCategory : '');
        const newUrl = window.location.pathname + window.location.search + newHash;
        history.replaceState(null, '', newUrl);
    }

    if (movies.length === 0) {
        grid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #888; padding: 50px 0;">No content found!</p>`;
        const paginationContainer = document.getElementById('paginationContainer');
        if (paginationContainer) paginationContainer.innerHTML = '';
        return;
    }

    moviesPerPage = getMoviesPerPage();
    _lastGridColsForResize = getGridColumnsCount() > 5 ? 5 : getGridColumnsCount();

    const startIndex = (page - 1) * moviesPerPage;
    const endIndex = startIndex + moviesPerPage;
    const paginatedMovies = movies.slice(startIndex, endIndex);

    paginatedMovies.forEach((movie, index) => {
        const serialNumber = ((currentPage - 1) * moviesPerPage) + index + 1;
        const card = document.createElement('div');
        card.className = 'movie-card';

        const isFav = isMovieFavorited(movie.id);
        card.innerHTML = `
        <div class="poster-wrapper">
            <div class="poster-rating-badge" id="card-rating-${index}">
                <span>★</span> N/A
            </div>
            <button type="button" class="card-fav-btn${isFav ? ' active' : ''}" id="card-fav-${index}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">${isFav ? '❤️' : '🤍'}</button>
            <img src="${movie.poster || POSTER_PLACEHOLDER_LOADING}" id="card-poster-${index}" alt="${movie.title}" referrerpolicy="no-referrer" decoding="async" onerror="handlePosterImgError(this)">
        </div>
        <div class="movie-details"><p class="movie-title">${serialNumber}. ${movie.title}</p></div>
        `;

        card.addEventListener('click', () => openMovieModal(movie));
        const favBtn = card.querySelector(`#card-fav-${index}`);
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavoriteMovie(movie, favBtn);
            });
        }
        grid.appendChild(card);
    });

    // সব কার্ড DOM এ বসানো হয়ে গেছে - এখন পোস্টার/রেটিং fetch করা হচ্ছে,
    // কিন্তু একবারে সবগুলো না পাঠিয়ে ব্যাচে ব্যাচে (দেখুন runWithConcurrencyLimit
    // এর কমেন্ট - কেন এটা দরকার)।
    runWithConcurrencyLimit(paginatedMovies, 4, async (movie, index) => {
        const imgEl = document.getElementById(`card-poster-${index}`);
        const ratingEl = document.getElementById(`card-rating-${index}`);

        const [tmdb, omdb] = await Promise.all([
            getFullTMDBDetails(movie),
            getOMDbDetails(movie)
        ]);

        const resolvedPoster = movie.poster || (tmdb && tmdb.poster) || (omdb && omdb.poster) || null;
        if (imgEl && resolvedPoster) {
            imgEl.src = resolvedPoster;
        }

        const finalRating = getSmartRating(tmdb, omdb);
        if (ratingEl && finalRating !== "N/A") {
            ratingEl.innerHTML = `<span>★</span> ${finalRating}`;
        }
    });

    renderPaginationControls(movies, page);
}

function getFileTypeBadge(link, label = '') {
    const fullText = (String(link || '') + ' ' + String(label || '')).toLowerCase();

    if (fullText.includes('mkv')) return 'MKV';
    if (fullText.includes('rar')) return 'RAR';
    if (fullText.includes('7z'))  return '7Z';
    if (fullText.includes('mp4')) return 'MP4';

    return 'ZIP';
}

// ==================== MODAL WINDOW (BULLETPROOF & NON-BLOCKING) ====================

async function openMovieModal(movie) {
    const modalOverlay = document.getElementById('movieModalOverlay');
    const modalBox = document.getElementById('modalDynamicBox');

    currentModalMovie = movie; 

    modalOverlay.style.display = 'flex';
    document.body.classList.add('modal-open');

    modalBox.innerHTML = `
        <span class="modal-close-btn" onclick="closeMovieModal()">✖</span>
        <div style="text-align: center; padding: 24px 20px; color: #fff;">
            <h2 style="font-size: 20px; margin-bottom: 8px;">🔄 Fetching Data...</h2>
            <p style="color: #aaa; margin: 0;">Please wait while we load the movie details.</p>
        </div>
    `;

    let title = movie.title || "N/A";
    let poster = movie.poster || POSTER_PLACEHOLDER_MISSING;
    let year = movie.year || "N/A";
    let genre = movie.genre || "Drama";
    let plot = movie.plot || "No plot description available.";
    let director = movie.director || "N/A";
    let writer = movie.writer || "N/A";
    let cast = movie.cast || "N/A";
    let tagline = movie.tagline || "";
    let releaseDate = "N/A";
    let contentRating = "NR"; 
    let tmdbUrl = `https://www.themoviedb.org/search?query=${encodeURIComponent(title)}`;
    let budgetFormatted = "N/A";
    let revenueFormatted = "N/A";
    
    let fetchedImdbId = extractImdbId(movie.imdbId) || null;
    let smartRating = "N/A";
    let awards = "N/A";

    const isTV = movie.tmdbType === 'tv';
    let durationOrSeasonPill = movie.runtime || "N/A";

    if (isTV) {
        let seasonsCount = (movie.downloadBlocks ? movie.downloadBlocks.length : 1);
        durationOrSeasonPill = seasonsCount > 1 ? `${seasonsCount} Seasons` : `${seasonsCount} Season`;
    }

    if (!tagline && title.includes(":")) tagline = title.split(":").slice(1).join(":").trim();
    if (!tagline) tagline = genre;

    const metaSubtitle = `${genre} ${releaseDate !== "N/A" ? '| ' + releaseDate : ''}`;
    let imdbUrl = fetchedImdbId ? `https://www.imdb.com/title/${fetchedImdbId}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(title)}`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(title)}`;

    // ভিউ কাউন্ট এবং আপলোড টাইম
    const viewsCount = Number(movie.views) || 0;
    const uploadedAt = movie.created_at || movie.createdAt || null;
    const uploadedAtLabel = formatTimeAgo(uploadedAt);

let downloadHTML = '';
    if (Array.isArray(movie.downloadBlocks) && movie.downloadBlocks.length > 0) {
        movie.downloadBlocks.forEach((sec, idx) => {
            
            // 1. (Multiple Items in Season)
        if (Array.isArray(sec.items) && sec.items.length > 0) {
            sec.items.forEach((it, iIdx) => {
                const uid = `${idx}-${iIdx}`;
                
                const seasonLabel = sec.label || `Season ${sec.season || idx + 1} Complete 720p`;
                const rawHeader = it.quality ? `${seasonLabel} ${it.quality}` : seasonLabel;
                
                // Strip any size already baked into the label (e.g. "...720p [350MB]") so it can't be shown twice
                // Also strip a leading "Download Link" prefix — series/season headers shouldn't show it
                const cleanHeaderLabel = rawHeader.replace(/^⚡\s*/g, '').replace(/^Download Link\s*/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
                
                const sizeText = it.size ? ` [${it.size}]` : '';
                
                const fileTypeLabel = getFileTypeBadge(it.link, `${sec.label || ''} ${it.quality || ''}`);

                downloadHTML += `
                <div class="season-box-item">
                    <div class="season-box-header" data-label="${escapeAttr(cleanHeaderLabel + sizeText)}" onclick="toggleAccordion('dl-body-${uid}')">
                        <span>${DOWNLOAD_HEADER_ICON} ${cleanHeaderLabel}${sizeText}</span>
                        <div class="season-badges-right">
                            <span class="badge-icon-list">${fileTypeLabel}</span>
                        </div>
                    </div>
                    <div class="season-download-body" id="dl-body-${uid}">
                        <div class="download-button-group">
                            <a href="${it.link}" target="_blank" class="btn-zip-download" id="dl-link-${uid}" onclick="incrementMovieViews(currentModalMovie); logDownloadHistory(currentModalMovie, '${jsAttrStr(cleanHeaderLabel + sizeText)}')">Download ${fileTypeLabel}</a>
                            <button type="button" class="btn-copy-link" onclick="copyDownloadLink('dl-link-${uid}', this)">Copy Link</button>
                        </div>
                    </div>
                </div>
                `;
            });
        }
            
            // 2. (Single Movie Link)
            else if (sec.link) {
                // Strip any size already baked into the label (e.g. "720p [517MB]") so it can't be shown twice
                let cleanLabel = (sec.label || '').replace(/^⚡\s*/g, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
                if (isTV) {
                    // Series/season entries should never show a "Download Link" prefix
                    cleanLabel = cleanLabel.replace(/^Download Link\s*/i, '').trim();
                } else {
                    // Backfill "Download Link " prefix for older movie entries saved before this was added
                    if (cleanLabel && !/^Download Link/i.test(cleanLabel)) {
                        cleanLabel = `Download Link ${cleanLabel}`;
                    }
                }
                const sizeText = sec.size ? ` [${sec.size}]` : '';
   
                const fileTypeLabel = getFileTypeBadge(sec.link, sec.label || '');

                downloadHTML += `
                <div class="season-box-item">
                    <div class="season-box-header" data-label="${escapeAttr(cleanLabel + sizeText)}" onclick="toggleAccordion('dl-body-${idx}')">
                        <span>${DOWNLOAD_HEADER_ICON} ${cleanLabel}${sizeText}</span>
                        <div class="season-badges-right">
                            <span class="badge-icon-list">${fileTypeLabel}</span>
                        </div>
                    </div>
                    <div class="season-download-body" id="dl-body-${idx}">
                        <div class="download-button-group">
                            <a href="${sec.link}" target="_blank" class="btn-zip-download" id="dl-link-${idx}" onclick="incrementMovieViews(currentModalMovie); logDownloadHistory(currentModalMovie, '${jsAttrStr(cleanLabel + sizeText)}')">Download ${fileTypeLabel}</a>
                            <button type="button" class="btn-copy-link" onclick="copyDownloadLink('dl-link-${idx}', this)">Copy Link</button>
                        </div>
                    </div>
                </div>
                `;
            }
        });
    }

    // Best-effort background check — fires and forgets, doesn't block the modal
    autoCheckDownloadLinks(movie);

    const fastServersList = (Array.isArray(movie.fastServers) && movie.fastServers.length > 0) 
        ? movie.fastServers 
        : DEFAULT_FAST_SERVERS;

let fastServersHTML = '';
fastServersList.forEach((fs, fIdx) => {
    const cleanFsLabel = (fs.label || '').replace(/^⚡\s*/g, '');

    fastServersHTML += `
    <div class="season-box-item fast-server-box">
        <div class="season-box-header" onclick="toggleAccordion('fs-body-${fIdx}')">
            <span>⚡ ${cleanFsLabel}</span>
            <div class="season-badges-right"><span class="badge-icon-list">WEB</span></div>
        </div>
        <div class="season-download-body" id="fs-body-${fIdx}">
            <div class="download-button-group">
                <a href="${fs.link}" target="_blank" class="btn-zip-download" id="fs-link-${fIdx}">Downloader Online</a>
            </div>
        </div>
    </div>
    `;
});

    function renderModalContent(finalRating = "N/A") {
        if (document.getElementById('movieModalOverlay').style.display !== 'flex') return;

        // N/A / khali thakle shei row/field ta hide kore dao (auto-detect na hole dekhabe na)
        const hasVal = (v) => v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim().toUpperCase() !== "N/A";

        const directorRow = hasVal(director) ? `<div id="modalDirectorDiv"><strong>DIRECTOR</strong> ${director}</div>` : '';
        const writerRow = hasVal(writer) ? `<div id="modalWriterDiv"><strong>WRITER</strong> ${writer}</div>` : '';
        const castRow = hasVal(cast) ? `<div id="modalCastDiv"><strong>CAST</strong> ${cast}</div>` : '';
        const awardsRow = hasVal(awards) ? `<div><strong>AWARDS</strong> <span id="modalAwardsVal">${awards}</span></div>` : '';
        const budgetRow = hasVal(budgetFormatted) ? `<div class="meta-inline-item" id="modalBudgetDiv"><strong>BUDGET</strong> ${budgetFormatted}</div>` : '';
        const revenueRow = hasVal(revenueFormatted) ? `<div class="meta-inline-item" id="modalRevenueDiv"><strong>REVENUE</strong> ${revenueFormatted}</div>` : '';
        const budgetRevenueGroup = (budgetRow || revenueRow) ? `<div class="meta-inline-group">${budgetRow}${revenueRow}</div>` : '';

        modalBox.innerHTML = `
        <span class="modal-close-btn" onclick="closeMovieModal()">✖</span>
        <div class="movie-summary-card">
            <div class="card-poster-side">
                <div class="card-rating-badge-overlay" id="modalRatingBadge">
                    <span class="star-icon">★</span>
                    <span id="modalRatingVal">${finalRating}</span>/10
                </div>
                <img src="${poster}" id="modalPosterImg" alt="${title}" referrerpolicy="no-referrer" onerror="handlePosterImgError(this)">
            </div>
            <div class="card-header-info">
                <h1 class="card-movie-title">${title}</h1>
                <p class="card-tagline" id="modalTagline">${tagline}</p>
                <p class="card-meta-subtitle">${genre} ${releaseDate !== "N/A" ? '| ' + releaseDate : ''}</p>                <div class="card-stats-row">
                    ${uploadedAtLabel ? `
                    <span class="stat-item">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 7V12L15.5 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        ${uploadedAtLabel}
                    </span>
                    <span class="stat-dot">•</span>` : ''}
                    <span class="stat-item stat-item-comments" id="modalCommentsBtn" onclick="scrollToComments()">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
                        <span id="modalCommentsCountVal">Comments</span>
                    </span>
                    <span class="stat-dot">•</span>
                    <span class="stat-item">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12C2 12 5.5 5.5 12 5.5C18.5 5.5 22 12 22 12C22 12 18.5 18.5 12 18.5C5.5 18.5 2 12 2 12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.75" stroke="currentColor" stroke-width="1.6"/></svg>
                        <span id="modalViewsVal">${formatViewCount(viewsCount)}</span>
                    </span>
                </div>
                <div class="card-pills-row">
                    <span class="card-pill">${year}</span>
                    <span class="card-pill" id="modalContentRating">${contentRating}</span>
                    <span class="card-pill">${durationOrSeasonPill}</span>
                </div>
            </div>
            <div class="card-body-info">
                <p class="card-plot-text" id="modalPlotText">${plot}</p>
                <div class="card-meta-list">
                    ${directorRow}
                    ${writerRow}
                    ${castRow}
                    ${awardsRow}
                    ${budgetRevenueGroup}
                </div>
                <div class="card-actions-row">
                    <button type="button" id="modalFavoriteBtn" class="btn-favorite-action${isMovieFavorited(movie.id) ? ' active' : ''}" onclick="toggleFavoriteMovie(currentModalMovie, document.getElementById('modalFavoriteBtn'))">${isMovieFavorited(movie.id) ? '❤️ In Favorites' : '🤍 Add to Favorites'}</button>
                    <a href="${imdbUrl}" id="modalImdbBtn" target="_blank" class="btn-imdb-action">IMDb</a>
                    <a href="${tmdbUrl}" id="modalTmdbBtn" target="_blank" class="btn-tmdb-action">TMDb</a>
                    <a href="${googleUrl}" target="_blank" class="btn-google-action">Google it!</a>
                    <span class="hide-modal-link" onclick="closeMovieModal()">Hide</span>
                </div>
            </div>
        </div>
        <div class="download-info-section">
            <div class="section-green-heading">Download ${title} Info:</div>
            <ul class="series-info-list">
                <li>• <strong>Full Name:</strong> ${title}</li>
                <li>
                    <div class="clamped-text-box" id="audioLangText">• <strong>Audio:</strong> ${movie.languages || 'N/A'}</div>
                    <button type="button" class="toggle-more-btn" id="audioLangToggleBtn" onclick="toggleMoreLess('audioLangText','audioLangToggleBtn')">More</button>
                </li>
                <li>
                    <div class="clamped-text-box" id="subsLangText">• <strong>Subtitles:</strong> ${movie.Subtitles || movie.subtitles || 'N/A'}</div>
                    <button type="button" class="toggle-more-btn" id="subsLangToggleBtn" onclick="toggleMoreLess('subsLangText','subsLangToggleBtn')">More</button>
                </li>
                <li>• <strong>Quality:</strong> <span class="badge-quality">720p</span></li>
            </ul>
        </div>
        <div class="season-accordion-group">
            ${downloadHTML}
            ${fastServersHTML}
        </div>
        ${renderCommentsSectionShell()}
        `;
        setupExpandableText('audioLangText', 'audioLangToggleBtn');
        setupExpandableText('subsLangText', 'subsLangToggleBtn');
        initCommentsSection(movie);
    }

    let isRendered = false;
    const forceTimeout = setTimeout(() => {
        if (!isRendered) {
            isRendered = true;
            renderModalContent("N/A");
        }
    }, 1500);

    try {
        const [tmdb, omdb] = await Promise.all([
            getFullTMDBDetails(movie).catch(() => null),
            getOMDbDetails(movie).catch(() => null)
        ]);

        if (!isRendered) {
            isRendered = true;
            clearTimeout(forceTimeout);

        if (tmdb) {
            // Tumi poster link dile TMDB seta r overwrite korbe na
            if (tmdb.poster && !movie.poster) poster = tmdb.poster;
            if (tmdb.plot) plot = tmdb.plot;
            if (tmdb.tagline) tagline = tmdb.tagline;
            if (tmdb.contentRating) contentRating = tmdb.contentRating;
            if (tmdb.director && tmdb.director !== "N/A") director = tmdb.director;
            if (tmdb.writer && tmdb.writer !== "N/A") writer = tmdb.writer;
            if (tmdb.cast && tmdb.cast !== "N/A") cast = tmdb.cast;
            if (tmdb.budget) budgetFormatted = formatCurrency(tmdb.budget);
            if (tmdb.revenue) revenueFormatted = formatCurrency(tmdb.revenue);
            if (tmdb.id) tmdbUrl = `https://www.themoviedb.org/${tmdb.mediaType}/${tmdb.id}`;
            if (!fetchedImdbId && tmdb.imdbId) {
                fetchedImdbId = tmdb.imdbId;
                imdbUrl = `https://www.imdb.com/title/${fetchedImdbId}/`;
            }

            // --- NEW FIXES FOR GENRES, YEAR, AND RUNTIME/SEASONS ---
            if (tmdb.genre && tmdb.genre !== "N/A") genre = tmdb.genre;
            if (tmdb.year && tmdb.year !== "N/A") year = tmdb.year;
            if (tmdb.releaseDate && tmdb.releaseDate !== "N/A") releaseDate = tmdb.releaseDate;

            if (tmdb.mediaType === 'tv' || isTV) {
                if (tmdb.numberOfSeasons) {
                    durationOrSeasonPill = tmdb.numberOfSeasons > 1 ? `${tmdb.numberOfSeasons} Seasons` : `1 Season`;
                }
            } else {
                if (tmdb.runtime && tmdb.runtime !== "N/A") {
                    durationOrSeasonPill = convertRuntimeToHours(tmdb.runtime);
                }
            }
            // -------------------------------------------------------
        }

        if (omdb) {
                if (omdb.awards && omdb.awards !== "N/A") awards = omdb.awards;
                // TMDB-e match na paile OMDb (IMDb ID diye) er poster use koro
                if (omdb.poster && !movie.poster && !(tmdb && tmdb.poster)) poster = omdb.poster;
            }

            smartRating = getSmartRating(tmdb, omdb);

            // --- EXCEPTION FOR MONEY HEIST ---
            if (title.toLowerCase().includes("money heist") || title.toLowerCase().includes("la casa de papel")) {
                durationOrSeasonPill = "5 Seasons";
            }
            // ---------------------------------

            renderModalContent(smartRating);
        }
    } catch (err) {
        console.error("Modal fetch error:", err);
        if (!isRendered) {
            isRendered = true;
            clearTimeout(forceTimeout);
            renderModalContent("N/A");
        }
    }
}

function toggleMoreLess(textId, btnId) {
    const textEl = document.getElementById(textId);
    const btnEl = document.getElementById(btnId);
    if (!textEl || !btnEl) return;
    const isExpanded = textEl.classList.toggle('expanded');
    btnEl.textContent = isExpanded ? 'Less' : 'More';
}

function setupExpandableText(textId, btnId) {
    const textEl = document.getElementById(textId);
    const btnEl = document.getElementById(btnId);
    if (!textEl || !btnEl) return;

    textEl.classList.remove('expanded');
    btnEl.textContent = 'More';
    btnEl.style.display = 'none';

    const OVERFLOW_TOLERANCE = 2; 
    function checkOverflow() {
        const wasExpanded = textEl.classList.contains('expanded');
        if (wasExpanded) textEl.classList.remove('expanded');
        const isOverflowing = textEl.scrollHeight > textEl.clientHeight + OVERFLOW_TOLERANCE;
        btnEl.style.display = isOverflowing ? 'inline-block' : 'none';
        if (wasExpanded) textEl.classList.add('expanded');
    }

    requestAnimationFrame(() => { requestAnimationFrame(checkOverflow); });
    window.addEventListener('load', checkOverflow, { once: true });
}

function toggleAccordion(id) {
    console.log('toggleAccordion CALLED with id:', id);
    const el = document.getElementById(id);
    if (!el) {
        console.warn('toggleAccordion: element NOT found for id:', id);
        return;
    }
    const isOpen = el.style.display === 'block';
    document.querySelectorAll('.season-download-body').forEach(item => item.style.display = 'none');
    if (!isOpen) el.style.display = 'block';
    console.log('toggleAccordion: element found, now display =', el.style.display);
}

// ==================== SEARCH & FUZZY MATCH ====================

function levenshteinDistance(a, b) {
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const row = new Array(al + 1);
    for (let j = 0; j <= al; j++) row[j] = j;
    for (let i = 1; i <= bl; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= al; j++) {
            const temp = row[j];
            row[j] = (a.charAt(j - 1) === b.charAt(i - 1)) ? prev : Math.min(prev + 1, row[j] + 1, row[j - 1] + 1);
            prev = temp;
        }
    }
    return row[al];
}

function normalizeSearchText(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordSimilarity(qWord, tWord) {
    if (!qWord || !tWord) return 0;
    if (tWord === qWord) return 1;
    if (tWord.startsWith(qWord) || tWord.includes(qWord) || qWord.includes(tWord)) return 0.9;
    const dist = levenshteinDistance(qWord, tWord);
    const maxLen = Math.max(qWord.length, tWord.length);
    const threshold = Math.max(1, Math.ceil(maxLen * 0.4));
    if (dist <= threshold) return 1 - (dist / maxLen);
    return 0;
}

function fuzzyMatchScore(query, target) {
    const q = normalizeSearchText(query);
    const t = normalizeSearchText(target);
    if (!q || !t) return 0;
    if (t.includes(q)) return 1;
    const qWords = q.split(' ');
    const tWords = t.split(' ');
    let totalScore = 0;
    qWords.forEach(qw => {
        let best = 0;
        tWords.forEach(tw => {
            const s = wordSimilarity(qw, tw);
            if (s > best) best = s;
        });
        totalScore += best;
    });
    return totalScore / qWords.length;
}

function getSmartMatches(query) {
    return moviesList
        .map(movie => {
            const score = Math.max(
                fuzzyMatchScore(query, movie.title),
                fuzzyMatchScore(query, movie.searchName),
                fuzzyMatchScore(query, movie.languages)
            );
            return { movie, score };
        })
        .filter(entry => entry.score >= 0.55)
        .sort((a, b) => b.score - a.score)
        .map(entry => entry.movie);
}

function searchMovies() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    const searchSuggestions = document.getElementById('searchSuggestions');
    if (searchSuggestions) searchSuggestions.style.display = 'none';

    if (!query) {
        currentFilteredMovies = [...moviesList];
        renderMoviesByPage(currentFilteredMovies, 1);
        return;
    }

    currentFilteredMovies = getSmartMatches(query);
    renderMoviesByPage(currentFilteredMovies, 1);

    if (currentFilteredMovies.length === 0) {
        sendMissingMovieEmail(query);
    }
}

// ==================== NAVIGATION & CATEGORY SWITCH ====================

function switchCategory(category, initialPage) {
    if (!category) return;

    const targetLink = document.querySelector(`.nav-link[data-target="${category}"]`);

    document.querySelectorAll('.nav-link, .dropdown-toggle').forEach(el => el.classList.remove('active'));
    if (targetLink) {
        targetLink.classList.add('active');
        const parentDropdown = targetLink.closest('.has-dropdown');
        if (parentDropdown) {
            const toggle = parentDropdown.querySelector('.dropdown-toggle');
            if (toggle) toggle.classList.add('active');
        }
    }

    document.body.setAttribute('data-category', category);

    const noticeText = document.getElementById('noticeBannerText');
    const noticeBanner = document.getElementById('noticeBanner');
    const DEFAULT_NOTICE = "We have Changed our Official Domain to BOTTMOVIES.Bookmarks Now";

    if (noticeText) {
        if (category === 'all') {
            noticeText.innerText = DEFAULT_NOTICE;
        } else if (targetLink) {
            const customBanner = targetLink.getAttribute('data-banner');
            noticeText.innerText = customBanner || targetLink.innerText.trim();
        } else {
            noticeText.innerText = category;
        }
    }
    if (noticeBanner) noticeBanner.style.display = 'block';

    // Home ("all") এ থাকলে URL এ #all লেখা থাকবে না - পরিষ্কার URL এর জন্য
    // (hash এ "category?page=N" থাকতে পারে, তুলনা করার জন্য শুধু category অংশটুকু বের করা হচ্ছে)
    const currentHashCategory = window.location.hash.replace('#', '').split('?')[0];
    const targetHash = category === 'all' ? '' : `#${category}`;
    if (window.location.protocol === 'file:') {
        if (currentHashCategory !== (category === 'all' ? '' : category)) {
            if (category === 'all') {
                history.replaceState(null, '', window.location.pathname + window.location.search);
            } else {
                window.location.hash = category;
            }
        }
    } else {
        const cleanPath = window.location.pathname.replace(/index\.html$/, '');
        if (currentHashCategory !== (category === 'all' ? '' : category) || window.location.pathname.includes('index.html')) {
            history.pushState(null, '', cleanPath + targetHash);
        }
    }

    if (typeof allMovies !== 'undefined' && Array.isArray(allMovies)) {
        if (category === 'all') {
            moviesList = [...allMovies];
        } else {
            moviesList = allMovies.filter(movie => {
                if (!movie.category) return false;
                if (Array.isArray(movie.category)) {
                    return movie.category.includes(category);
                }
                return String(movie.category).includes(category);
            });
        }
        currentFilteredMovies = [...moviesList];

        const searchInput = document.getElementById('searchInput');
        const searchSuggestions = document.getElementById('searchSuggestions');
        if (searchInput) searchInput.value = '';
        if (searchSuggestions) searchSuggestions.style.display = 'none';

        renderMoviesByPage(currentFilteredMovies, initialPage || 1);
    }

    updateHeroVisibilityForCategory(category);
}

function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');

    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();

            const category = this.getAttribute('data-target');
            if (!category) return;

            switchCategory(category);

            document.querySelectorAll('.has-dropdown').forEach(li => li.classList.remove('open'));
            if (document.activeElement) document.activeElement.blur();

            const mainNav = document.getElementById('mainNav');
            if (mainNav) mainNav.classList.remove('show-menu');
            document.body.classList.remove('menu-open');

            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });

    window.addEventListener('popstate', function() {
        // hash এখন "category?page=N" ফরম্যাটে থাকে, তাই back/forward এ গেলে দুটোই আলাদা করে পড়া হচ্ছে
        let currentHash = window.location.hash.replace('#', '');
        let currentPageFromHash = 1;
        const qIndex = currentHash.indexOf('?');
        if (qIndex !== -1) {
            const hashParams = new URLSearchParams(currentHash.substring(qIndex + 1));
            const p = parseInt(hashParams.get('page'), 10);
            if (p && p > 0) currentPageFromHash = p;
            currentHash = currentHash.substring(0, qIndex);
        }
        switchCategory(currentHash || 'all', currentPageFromHash);
    });
}

function initApp() {

    loadAdminExtraCategories();

    initAuth();
    setupNavigation();
    setupHeroBannerControls();

    fetchMoviesFromSupabase();

    const modalOverlay = document.getElementById('movieModalOverlay');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeMovieModal();
        });
    }

    const dropdownToggles = document.querySelectorAll('.dropdown-toggle');
    dropdownToggles.forEach(toggle => {
        toggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const parentLi = this.parentElement;
            const isOpen = parentLi.classList.contains('open');
            document.querySelectorAll('.has-dropdown').forEach(li => li.classList.remove('open'));
            if (!isOpen) parentLi.classList.add('open');
        });
    });

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.has-dropdown')) {
            document.querySelectorAll('.has-dropdown').forEach(li => li.classList.remove('open'));
        }
        if (!e.target.closest('.search-container')) {
            const suggestions = document.getElementById('searchSuggestions');
            if (suggestions) suggestions.style.display = 'none';
        }
    });

    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    const searchSuggestions = document.getElementById('searchSuggestions');

    if (searchBtn) searchBtn.addEventListener('click', searchMovies);
    if (searchInput) {
        searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') searchMovies(); });
        const handleSearchInput = debounce(function() {
            const query = searchInput.value.trim();

            searchSuggestions.innerHTML = '';
            if (!query) {
                searchSuggestions.style.display = 'none';
                currentFilteredMovies = [...moviesList];
                renderMoviesByPage(currentFilteredMovies, 1);
                return;
            }
            const matches = getSmartMatches(query);
            currentFilteredMovies = matches;
            renderMoviesByPage(currentFilteredMovies, 1);
            if (matches.length === 0) {
                searchSuggestions.style.display = 'none';
                return;
            }
            matches.slice(0, 6).forEach(movie => {
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.innerText = movie.title;
                item.addEventListener('click', function() {
                    searchInput.value = movie.title;
                    searchSuggestions.style.display = 'none';
                    searchMovies();
                });
                searchSuggestions.appendChild(item);
            });
            searchSuggestions.style.display = 'block';
        }, 350);
        searchInput.addEventListener('input', handleSearchInput);
    }

    const menuToggleBtn = document.getElementById('menuToggleBtn');
    if (menuToggleBtn) {
        menuToggleBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            document.getElementById('mainNav').classList.toggle('show-menu');
            document.body.classList.toggle('menu-open');
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// ==================== CHAT WIDGET & REQUEST ====================

function generateYearOptions() {
    let options = `<option value="" disabled selected>Select Year</option>`;
    for (let y = 2026; y >= 1900; y--) {
        options += `<option value="${y}">${y}</option>`;
    }
    return options;
}


let chatActiveTab = 'request';

function switchChatTab(tab) {
    chatActiveTab = tab;
    const titleEl = document.getElementById('chatWidgetTitle');
    const statusEl = document.getElementById('chatWidgetStatus');
    const composeBar = document.getElementById('chatComposeBar');
    const supportBtn = document.getElementById('chatTabSupportBtn');
    const requestBtn = document.getElementById('chatTabRequestBtn');

    if (tab === 'support') {
        if (titleEl) titleEl.textContent = 'Chat with support';
        if (statusEl) statusEl.innerHTML = '🕐 Last active an hour ago.';
        if (composeBar) composeBar.style.display = 'flex';
        if (supportBtn) supportBtn.style.zIndex = 2;
        if (requestBtn) requestBtn.style.zIndex = 1;
        renderSupportChat();
    } else {
        if (titleEl) titleEl.textContent = 'Request Here';
        if (statusEl) statusEl.innerHTML = '';
        if (composeBar) composeBar.style.display = 'none';
        if (supportBtn) supportBtn.style.zIndex = 1;
        if (requestBtn) requestBtn.style.zIndex = 2;
        resetChatWidget();
    }
}

function renderSupportChat() {
    const body = document.getElementById('chatWidgetBody');
    if (!body) return;
    body.innerHTML = `
        <div class="chat-msg-row">
            <div class="chat-msg-icon"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></div>
            <div class="chat-msg-bubble">How can we help with BottMovies?</div>
        </div>
    `;
}

function sendSupportMessage() {
    const input = document.getElementById('chatComposeInput');
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;

    const body = document.getElementById('chatWidgetBody');
    if (body) {
        const row = document.createElement('div');
        row.className = 'chat-msg-row chat-msg-outgoing';
        row.innerHTML = `<div class="chat-msg-bubble">${escapeAttr(message)}</div>`;
        body.appendChild(row);
        body.scrollTop = body.scrollHeight;
    }
    input.value = '';

    supabaseClient.from('support_messages').insert([{ message: message, sender: 'visitor' }])
        .then(({ error }) => {
            if (error) {
                console.error('Support message save error:', error);
                alert('⚠️ Message could not be saved: ' + error.message);
            }
        });
}

function chatWidgetFormHTML() {
    return `
        <div class="chat-msg-row">
            <div class="chat-msg-icon">
                <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            </div>
            <div class="chat-msg-bubble">
                Hello! Which movie or series would you like to request?
            </div>
        </div>
        <div class="chat-card-container">
            <div class="chat-input-wrapper">
                <input type="text" id="chatMovieName" placeholder="Movie / Series Name (e.g. Inception)" autocomplete="off">
            </div>
            <div class="chat-input-wrapper">
                <input type="text" id="chatMovieLink" placeholder="TMDB / IMDb Link (Optional)" autocomplete="off">
            </div>
            <div class="chat-input-wrapper select-wrapper">
                <select id="chatMovieYear">
                    ${generateYearOptions()}
                </select>
            </div>
            <button class="chat-submit-btn" onclick="submitChatRequest()">Submit</button>
        </div>
        <div class="chat-branding">
            We run on <strong>BottMovies</strong>
        </div>
    `;
}

// ==================== LIGHT / DARK THEME TOGGLE ====================

const THEME_STORAGE_KEY = 'bottmovies_theme';

// আইকন লজিক: বাটনে সবসময় যেই মোডে ক্লিক করলে যাবে সেই মোডের আইকন দেখানো হয়।
// - এখন Light mode চলছে -> বাটনে Dark mode এর আইকন (চাঁদ, img2 এর মত) দেখাবে
// - এখন Dark mode চলছে  -> বাটনে Light mode এর আইকন (সূর্য, img1 এর মত) দেখাবে
const THEME_ICON_SUN = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="5" fill="#fbbf24"/>
    <g stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round">
        <line x1="12" y1="1" x2="12" y2="3.3"/>
        <line x1="12" y1="20.7" x2="12" y2="23"/>
        <line x1="1" y1="12" x2="3.3" y2="12"/>
        <line x1="20.7" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="4.22" x2="5.87" y2="5.87"/>
        <line x1="18.13" y1="18.13" x2="19.78" y2="19.78"/>
        <line x1="4.22" y1="19.78" x2="5.87" y2="18.13"/>
        <line x1="18.13" y1="5.87" x2="19.78" y2="4.22"/>
    </g>
</svg>`;

const THEME_ICON_MOON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20.5 13.6A8.5 8.5 0 1 1 10.4 3.5a6.8 6.8 0 0 0 10.1 10.1z" fill="#14161c"/>
</svg>`;

function getCurrentThemeMode() {
    return document.documentElement.classList.contains('light-mode') ? 'light' : 'dark';
}

function applyThemeToggleIcon() {
    const iconWrap = document.getElementById('themeToggleIcon');
    if (!iconWrap) return;
    // বর্তমানে যেই মোড চলছে সেটার বদলে, ক্লিক করলে যেই মোডে যাবে সেই আইকনটা দেখানো হচ্ছে
    iconWrap.innerHTML = getCurrentThemeMode() === 'light' ? THEME_ICON_MOON : THEME_ICON_SUN;
}

function setThemeMode(mode) {
    const isLight = mode === 'light';
    document.documentElement.classList.toggle('light-mode', isLight);
    try { localStorage.setItem(THEME_STORAGE_KEY, isLight ? 'light' : 'dark'); } catch (e) {}
    applyThemeToggleIcon();
}

function toggleThemeMode() {
    setThemeMode(getCurrentThemeMode() === 'light' ? 'dark' : 'light');
}

document.addEventListener('DOMContentLoaded', () => {
    // index.html এর head script এ localStorage চেক করে 'light-mode' ক্লাস আগেই বসিয়ে দেয় (flash এড়াতে),
    // এখানে শুধু বাটনের আইকনটা সেই অনুযায়ী সেট করে দেওয়া হচ্ছে
    applyThemeToggleIcon();
});

function resetChatWidget() {
    const body = document.getElementById('chatWidgetBody');
    if (body) body.innerHTML = chatWidgetFormHTML();
}

function toggleChatWidget() {
    const box = document.getElementById('chatWidgetBox');
    const btn = document.getElementById('chatWidgetBtn');
    if (!box) return;
    if (box.style.display === 'flex') {
        closeChatWidget();
    } else {
        switchChatTab('request');
        box.style.display = 'flex';
        btn.style.display = 'none';
    }
}

function closeChatWidget() {
    const box = document.getElementById('chatWidgetBox');
    const btn = document.getElementById('chatWidgetBtn');
    if (box) box.style.display = 'none';
    if (btn) btn.style.display = 'flex';
    switchChatTab('request');
}

function submitChatRequest() {
    const nameInput = document.getElementById('chatMovieName');
    const linkInput = document.getElementById('chatMovieLink');
    const yearSelect = document.getElementById('chatMovieYear');
    
    const name = nameInput ? nameInput.value.trim() : '';
    const link = linkInput ? linkInput.value.trim() : '';
    const year = yearSelect ? yearSelect.value : '';

    if (!name) {
        if (nameInput) nameInput.style.borderColor = '#ff3366';
        return;
    }

    let requestMsg = name;
    if (year) requestMsg += ` (${year})`;
    if (link) requestMsg += ` - Link: ${link}`;

    const templateParams = {
        movie_title: requestMsg,
        status: "Movie / Series Request"
    };

    supabaseClient.from('requests').insert([{ movie_title: name, reference_link: link || null, release_year: year || null, user_id: currentAuthSession?.user?.id || null }])
        .then(({ error }) => {
            if (error) {
                console.error('Request save error:', error);
                alert('⚠️ Request could not be saved to database: ' + error.message);
            }
        });

    emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams)
        .then(() => {
            const body = document.getElementById('chatWidgetBody');
            if (body) {
                body.innerHTML = `
                    <div class="chat-msg-row">
                        <div class="chat-msg-icon"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></div>
                        <div class="chat-msg-bubble">🎉 Thank you! Your request for <strong>${name}</strong> has been sent successfully. We will upload it soon!</div>
                    </div>
                    <div class="chat-branding" style="margin-top:20px;">We run on <strong>BottMovies</strong></div>
                `;
            }
        })
        .catch((error) => {
            console.error("EmailJS Error:", error);
            alert("Failed to send request. Please try again later.");
        });
}
// ==================== AUTHENTICATION (Sign In / Sign Up / Dashboard) ====================
// Supabase Auth ব্যবহার করা হয়েছে — session ডিফল্টভাবেই localStorage-এ persist হয়,
// তাই page refresh করলে বা site-এর অন্য পেজে গেলেও login state হারায় না।

let currentAuthSession = null;

function isCurrentUserAdmin(session) {
    const email = session?.user?.email;
    return !!email && email.toLowerCase() === ADMIN_TRIGGER_EMAIL.toLowerCase();
}

// user_metadata তে সাইনআপের সময় username সেভ করা থাকে - সেখান থেকেই দেখানো হয়,
// (পুরনো account যেগুলোর username নেই, যেমন Admin - সেগুলোর জন্য email এর @ এর আগের অংশ দেখানো হয়)
function getDisplayUsername(session) {
    const uname = session?.user?.user_metadata?.username;
    if (uname) return uname;
    const email = session?.user?.email || '';
    return email.split('@')[0] || email;
}

// Login/Forgot-Password ফিল্ডে username বা email - যা দেওয়া হয়েছে সেটা থেকে আসল email বের করে
async function resolveLoginEmail(identifier) {
    if (!identifier) return null;
    if (identifier.includes('@')) return identifier; // সরাসরি email দেওয়া হয়েছে
    try {
        const { data, error } = await supabaseClient.rpc('get_email_for_username', { uname: identifier });
        if (error) { console.error('Username lookup error:', error); return null; }
        return data || null;
    } catch (e) {
        console.error('Username lookup error:', e);
        return null;
    }
}

function updateAuthUI(session) {
    currentAuthSession = session;
    const loggedOutBox = document.getElementById('authActionsLoggedOut');
    const loggedInBox = document.getElementById('authActionsLoggedIn');
    const emailLabel = document.getElementById('authUserEmail');
    const mobileLabel = document.getElementById('authIconMobileLabel');
    const dashboardBtn = document.getElementById('btnAuthDashboard');
    if (!loggedOutBox || !loggedInBox) return;

    if (session && session.user) {
        loggedOutBox.style.display = 'none';
        loggedInBox.style.display = 'flex';
        if (emailLabel) {
            const uname = getDisplayUsername(session);
            emailLabel.textContent = isCurrentUserAdmin(session) ? `👑 ${uname}` : `👤 ${uname}`;
        }
        // Admin এর জন্য "Dashboard" (Admin Panel), সাধারণ ইউজারের জন্য "My Dashboard" — যাতে দুটো আলাদা বোঝা যায়
        const dashboardLabel = isCurrentUserAdmin(session) ? 'Dashboard' : 'My Dashboard';
        if (dashboardBtn) dashboardBtn.textContent = dashboardLabel;
        if (mobileLabel) mobileLabel.textContent = dashboardLabel;
        loadUserFavoriteIds(); // heart আইকনগুলো ঠিকমতো দেখানোর জন্য সাইনইন করার সাথে সাথেই favorites লোড করে নাও
    } else {
        loggedOutBox.style.display = 'flex';
        loggedInBox.style.display = 'none';
        if (emailLabel) emailLabel.textContent = '';
        if (mobileLabel) mobileLabel.textContent = 'Login';
        // sign out হয়ে গেলে dashboard/admin panel খোলা থাকলে বন্ধ করে দাও
        closeAdminPanel();
        closeUserDashboard();
        userFavoriteIds = new Set(); // sign out করলে favorites cache খালি করে দাও
    }
    myCommentIdentityCache = null; // login/logout হলে পুরনো identity cache বাতিল
    // comment box খোলা থাকলে login/logout এর সাথে সাথেই সেখানে avatar+নাম বা "please login" আপডেট হয়ে যাবে
    if (commentsCurrentMovieId !== null && commentsCurrentMovieId !== undefined) renderCommentComposer();
}

async function initAuth() {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        updateAuthUI(session);

        const params = new URLSearchParams(window.location.search);
        // dmca.html / report-broken-links.html ইত্যাদি পেজ থেকে "Dashboard" এ ক্লিক করলে
        // ?dashboard=1 নিয়ে index.html-এ ফেরত আসে — সাথে সাথেই dashboard খুলে যায়
        // (page refresh করলেও এই একই লজিকে Dashboard/Admin panel খোলা অবস্থাতেই থাকে, home এ ফিরে যায় না)
        if (session && params.get('dashboard') === '1') {
            openDashboard();
        } else if (!session && params.has('dashboard')) {
            clearDashboardUrlParam(); // session না থাকলে পুরনো ?dashboard=1 URL থেকে সরিয়ে দাও
        }
        // ?auth=signin বা ?auth=signup (পুরনো লিংকে ?auth=1 থাকলে সেটাও signin ধরে নেওয়া হয়) —
        // page refresh দিলেও Login/Register পেজেই থাকবে, home এ চলে যাবে না
        const authParam = params.get('auth');
        if (!session && authParam) {
            openAuthModal(authParam === 'signup' ? 'signup' : 'signin');
        }
    } catch (e) {
        console.error('Auth init error:', e);
    }

    supabaseClient.auth.onAuthStateChange((_event, newSession) => {
        updateAuthUI(newSession);
    });
}

function openAuthModal(tab) {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;
    overlay.style.display = 'block';
    document.body.classList.add('modal-open');
    switchAuthTab(tab || 'signin'); // এটাই URL সিঙ্ক করে দেয়, যাতে refresh এ এই পেজেই থাকে
}
function closeAuthModal() {
    const overlay = document.getElementById('authOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
    resetAuthForm(); // পেজ বন্ধ করার পর ফর্মে টাইপ করা কোনো লেখা যেন থেকে না যায়
    // URL থেকে ?auth সরিয়ে দাও, নাহলে পরের বার refresh দিলে আবার এই পেজ খুলে যাবে
    const params = new URLSearchParams(window.location.search);
    if (params.has('auth')) {
        params.delete('auth');
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
        history.replaceState(null, '', newUrl);
    }
}

// Login/Register মোডাল বন্ধ করলে দুটো ফর্মেরই সব input/message খালি করে দেয়,
// যাতে আবার খুললে আগের টাইপ করা ইমেইল/পাসওয়ার্ড/এরর মেসেজ দেখা না যায়
function resetAuthForm() {
    ['signinEmail', 'signinPassword', 'signupUsername', 'signupEmail', 'signupPassword', 'signupPasswordConfirm', 'signupCaptchaInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['authSigninMsg', 'authSignupMsg', 'signupUsernameMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    updateAuthPasswordStrength('');
}
function switchAuthTab(tab) {
    const signinTab = document.getElementById('authTabSignin');
    const signupTab = document.getElementById('authTabSignup');
    if (!signinTab || !signupTab) return;
    const isSignup = tab === 'signup';
    signinTab.style.display = isSignup ? 'none' : 'block';
    signupTab.style.display = isSignup ? 'block' : 'none';

    // উপরের Login/Register tab বাটন দুটোর active state সিঙ্ক করা
    const signinBtn = document.getElementById('authTabBtnSignin');
    const signupBtn = document.getElementById('authTabBtnSignup');
    if (signinBtn && signupBtn) {
        signinBtn.classList.toggle('active', !isSignup);
        signupBtn.classList.toggle('active', isSignup);
    }

    if (isSignup) generateAuthCaptcha(); // Register পেজে গেলেই নতুন captcha code বসিয়ে দাও

    // Auth পেজ এখন খোলা থাকলে URL এ ?auth=signin/signup বসিয়ে রাখো — page refresh এর পরও
    // এই পেজেই থাকবে, home এ চলে যাবে না
    const overlay = document.getElementById('authOverlay');
    if (overlay && overlay.style.display !== 'none') {
        const params = new URLSearchParams(window.location.search);
        params.set('auth', isSignup ? 'signup' : 'signin');
        params.delete('dashboard'); // auth আর dashboard একসাথে URL এ থাকবে না
        const newUrl = window.location.pathname + '?' + params.toString() + window.location.hash;
        history.replaceState(null, '', newUrl);
    }
}

// ছোট device-এ header-এ শুধু account icon দেখা যায় (img2 এর মতো) - সেটাতে ক্লিক করলে
// লগইন থাকলে Dashboard, না থাকলে Login page খুলে যায়
function handleMobileAuthIconClick() {
    if (currentAuthSession && currentAuthSession.user) {
        openDashboard();
    } else {
        openAuthModal('signin');
    }
}

// পাসওয়ার্ড ফিল্ডের চোখ আইকনে ক্লিক করলে টেক্সট show/hide হয়
const AUTH_EYE_ICON_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const AUTH_EYE_ICON_CLOSED = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.6 20.6 0 0 1 4.22-5.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a20.6 20.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>';
function toggleAuthPasswordVisibility(fieldId, btn) {
    const input = document.getElementById(fieldId);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('is-visible', !showing);
    btn.innerHTML = showing ? AUTH_EYE_ICON_OPEN : AUTH_EYE_ICON_CLOSED;
}

// "Forgot Password?" - ইউজারের দেওয়া username/email এ Supabase দিয়ে reset link পাঠায়
async function handleForgotPassword() {
    const identifierInput = document.getElementById('signinEmail');
    const identifier = (identifierInput?.value || '').trim();
    const msgEl = document.getElementById('authSigninMsg');
    if (!identifier) {
        if (msgEl) { msgEl.textContent = 'Please enter your Username/Email first to send the reset link.'; msgEl.className = 'admin-form-msg error'; }
        identifierInput?.focus();
        return;
    }
    if (msgEl) { msgEl.textContent = 'Sending...'; msgEl.className = 'admin-form-msg'; }
    try {
        const email = await resolveLoginEmail(identifier);
        if (!email) {
            if (msgEl) { msgEl.textContent = 'Incorrect Username or Password'; msgEl.className = 'admin-form-msg error'; }
            return;
        }
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
        if (error) {
            if (msgEl) { msgEl.textContent = error.message; msgEl.className = 'admin-form-msg error'; }
            return;
        }
        if (msgEl) { msgEl.textContent = 'A password reset link has been sent to your email ✅'; msgEl.className = 'admin-form-msg success'; }
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
    }
}

// ==================== REGISTER CAPTCHA ====================
// প্রতিবার Register ট্যাব খুললে বা রিফ্রেশ আইকনে ক্লিক করলে নতুন র‍্যান্ডম সংখ্যা দেখায়।
let currentAuthCaptcha = '';
function generateAuthCaptcha() {
    let code = '';
    for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10);
    currentAuthCaptcha = code;
    const codeEl = document.getElementById('authCaptchaCode');
    if (codeEl) codeEl.textContent = code.split('').join('  ');
    const captchaInput = document.getElementById('signupCaptchaInput');
    if (captchaInput) captchaInput.value = '';
}

// ==================== USERNAME LIVE AVAILABILITY CHECK ====================
// টাইপ করার সাথে সাথে (debounce করে) চেক করে এই username অন্য কেউ আগে থেকেই নিয়ে রেখেছে কিনা
const usernameCheckTimers = {};
async function checkUsernameLive(inputEl, msgElId, isDashboard) {
    const msgEl = document.getElementById(msgElId);
    if (!inputEl || !msgEl) return;
    const value = (inputEl.value || '').trim();
    clearTimeout(usernameCheckTimers[msgElId]);

    if (!value) { msgEl.textContent = ''; msgEl.className = 'auth-field-msg'; return; }
    if (!/^[a-z0-9_]{3,20}$/.test(value)) {
        msgEl.textContent = 'Username: 3-20 chars, lowercase letters/numbers/_ only.';
        msgEl.className = 'auth-field-msg taken';
        return;
    }

    msgEl.textContent = 'Checking availability...';
    msgEl.className = 'auth-field-msg checking';

    usernameCheckTimers[msgElId] = setTimeout(async () => {
        try {
            let query = supabaseClient.from('profiles').select('id').ilike('username', value);
            if (isDashboard && currentAuthSession?.user?.id) query = query.neq('id', currentAuthSession.user.id);
            const { data, error } = await query.maybeSingle();
            if (inputEl.value.trim() !== value) return; // ততক্ষণে ইউজার আরও টাইপ করেছে, পুরনো ফলাফল বাতিল
            if (error) { msgEl.textContent = ''; msgEl.className = 'auth-field-msg'; return; }
            if (data) {
                msgEl.textContent = '✖ This username is already taken.';
                msgEl.className = 'auth-field-msg taken';
            } else {
                msgEl.textContent = '✓ This username is available.';
                msgEl.className = 'auth-field-msg available';
            }
        } catch (e) {
            msgEl.textContent = '';
            msgEl.className = 'auth-field-msg';
        }
    }, 450);
}

// ---------- Username suggestions (refresh icon, img6-style regenerate) ----------
// শুধু lowercase letter/number রেখে বাকি সব বাদ দিয়ে একটা slug বানায়। খালি string ফেরত
// দিতে পারে (fallback 'user' দেওয়া হয় না) যাতে caller বুঝতে পারে input আসলে খালি ছিল।
function slugifyForUsername(name) {
    return (name || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // accent বাদ দাও
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 14);
}

// Full Name আর Email এর মধ্যে মিল রেখে username এর বেস (mool অংশ) বানানো হয়:
// - Full Name দেওয়া থাকলে সেটাই ব্যবহার হয়, যেমন "The Rain" -> "therain"
// - Full Name খালি থাকলে Email এর @ চিহ্নের আগের অংশ ব্যবহার হয়, যেমন "john.doe@gmail.com" -> "johndoe"
// - দুটোই খালি থাকলে খালি string ফেরত দেওয়া হয় (আর "user" এর মতো random fallback বসানো হয় না,
//   যাতে Full Name/Email কিছু না দিলে username auto আসবে না)
function getUsernameBase(fullName, email) {
    const nameBase = slugifyForUsername(fullName);
    if (nameBase) return nameBase;
    const emailLocalPart = (email || '').split('@')[0];
    return slugifyForUsername(emailLocalPart);
}

// বেস username (যেমন "therain") থেকে শুরু করে ক্রমান্বয়ে সংখ্যা যোগ করে (therain, therain1,
// therain2, ...) প্রথম যেটা available পাওয়া যায় সেটা সাজেস্ট করে - এলোমেলো random সংখ্যার
// বদলে predictable, নাম/ইমেইলের সাথে মিলযুক্ত username দেখানোর জন্য।
// Full Name এবং Email দুটোই খালি থাকলে খালি string ('') ফেরত দেয় - অর্থাৎ কোনো suggestion দেয় না।
async function generateAvailableUsername(fullName, excludeUserId, email) {
    const base = getUsernameBase(fullName, email);
    if (!base) return ''; // Full Name/Email কিছুই নেই - suggest করার মতো কিছু নেই
    for (let suffix = 0; suffix <= 50; suffix++) {
        let candidate = suffix === 0 ? base : (base + suffix);
        candidate = candidate.slice(0, 20);
        if (candidate.length < 3) candidate = (candidate + '000').slice(0, 3); // মিনিমাম ৩ ক্যারেক্টার
        try {
            let query = supabaseClient.from('profiles').select('id').ilike('username', candidate);
            if (excludeUserId) query = query.neq('id', excludeUserId);
            const { data } = await query.maybeSingle();
            if (!data) return candidate;
        } catch (e) {
            return candidate; // চেক ব্যর্থ হলেও একটা সাজেশন দিয়ে দাও, সাবমিটের সময় আবার যাচাই হবেই
        }
    }
    return (base + Date.now().toString().slice(-4)).slice(0, 20);
}

function suggestUsernameFromNameIfEmpty() {
    const usernameInput = document.getElementById('signupUsername');
    if (!usernameInput || usernameInput.value.trim()) return; // ইউজার নিজে কিছু লিখলে ওভাররাইট করবে না
    const nameInput = document.getElementById('signupName');
    const emailInput = document.getElementById('signupEmail');
    // Full Name আর Email দুটোই খালি থাকলে auto-suggest করার কিছু নেই, চুপচাপ ফিরে যাও
    if (!(nameInput?.value || '').trim() && !(emailInput?.value || '').trim()) return;
    regenerateSignupUsername(null);
}

async function regenerateSignupUsername(btn) {
    const nameInput = document.getElementById('signupName');
    const emailInput = document.getElementById('signupEmail');
    const usernameInput = document.getElementById('signupUsername');
    const msgEl = document.getElementById('signupUsernameMsg');
    if (!usernameInput) return;
    // Full Name আর Email দুটোই খালি থাকলে suggest করার মতো কিছু নেই - "user123" এর মতো
    // ভিত্তিহীন random নাম না বসিয়ে ইউজারকে জানিয়ে দাও
    if (!(nameInput?.value || '').trim() && !(emailInput?.value || '').trim()) {
        if (msgEl) { msgEl.textContent = 'Username সাজেস্ট করতে আগে Full Name অথবা Email লিখুন।'; msgEl.className = 'auth-field-msg'; }
        return;
    }
    if (btn) btn.classList.add('spinning');
    const suggestion = await generateAvailableUsername(nameInput?.value || '', null, emailInput?.value || '');
    if (suggestion) {
        usernameInput.value = suggestion;
        checkUsernameLive(usernameInput, 'signupUsernameMsg');
    }
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 300);
}

async function regenerateDashboardUsername(btn) {
    const nameInput = document.getElementById('userDashFullNameInput');
    const emailInput = document.getElementById('userDashEmail');
    const usernameInput = document.getElementById('userDashUsernameInput');
    const msgEl = document.getElementById('userDashUsernameMsg');
    if (!usernameInput) return;
    if (!(nameInput?.value || '').trim() && !(emailInput?.value || '').trim()) {
        if (msgEl) { msgEl.textContent = 'Username সাজেস্ট করতে আগে Full Name অথবা Email লিখুন।'; msgEl.className = 'auth-field-msg'; }
        return;
    }
    if (btn) btn.classList.add('spinning');
    const suggestion = await generateAvailableUsername(nameInput?.value || '', currentAuthSession?.user?.id, emailInput?.value || '');
    if (suggestion) {
        usernameInput.value = suggestion;
        checkUsernameLive(usernameInput, 'userDashUsernameMsg', true);
    }
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 300);
}

// ---------- Password strength meter (Register form, img3-style) ----------
function computePasswordStrength(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return Math.min(score, 4);
}
const PW_STRENGTH_LABELS = ['Enter a password to check strength', 'Weak', 'Fair', 'Good', 'Strong'];
const PW_STRENGTH_CLASSES = ['', 'on-weak', 'on-fair', 'on-good', 'on-strong'];
function updateAuthPasswordStrength(pw) {
    const track = document.getElementById('authPwStrengthTrack');
    const label = document.getElementById('authPwStrengthLabel');
    if (!track || !label) return;
    const score = computePasswordStrength(pw);
    const segs = track.querySelectorAll('.auth-pw-strength-seg');
    segs.forEach((seg, i) => {
        seg.className = 'auth-pw-strength-seg' + (i < score ? ' ' + PW_STRENGTH_CLASSES[score] : '');
    });
    label.textContent = pw ? PW_STRENGTH_LABELS[score] : PW_STRENGTH_LABELS[0];
}

async function handleSignIn() {
    const identifier = (document.getElementById('signinEmail')?.value || '').trim();
    const password = document.getElementById('signinPassword')?.value || '';
    const msgEl = document.getElementById('authSigninMsg');
    const btn = document.getElementById('signinSubmitBtn');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'admin-form-msg'; }

    if (!identifier || !password) {
        if (msgEl) { msgEl.textContent = 'Please enter both Username/Email and Password.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
    try {
        const email = await resolveLoginEmail(identifier);
        if (!email) {
            if (msgEl) { msgEl.textContent = 'Incorrect Username or Password'; msgEl.className = 'admin-form-msg error'; }
            return;
        }
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            // Supabase নিরাপত্তার কারণে email/password এর মধ্যে কোনটা ভুল বলে না —
            // তাই "Invalid login credentials" কে সহজ বাংলায় দেখানো হচ্ছে
            const isBadCredentials = /invalid login credentials/i.test(error.message || '');
            if (msgEl) {
                msgEl.textContent = isBadCredentials ? 'Incorrect Username or Password' : error.message;
                msgEl.className = 'admin-form-msg error';
            }
            return;
        }
        document.getElementById('signinEmail').value = '';
        document.getElementById('signinPassword').value = '';
        closeAuthModal(); // মোডাল বন্ধ হলে নিচের Home পেজ দেখা যাবে - Dashboard আর auto-open হবে না
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Login'; }
    }
}

async function handleSignUp() {
    const fullName = (document.getElementById('signupName')?.value || '').trim();
    const username = (document.getElementById('signupUsername')?.value || '').trim().toLowerCase().replace(/\s+/g, '');
    const email = (document.getElementById('signupEmail')?.value || '').trim();
    const password = document.getElementById('signupPassword')?.value || '';
    const confirmPassword = document.getElementById('signupPasswordConfirm')?.value || '';
    const captchaInput = (document.getElementById('signupCaptchaInput')?.value || '').trim();
    const msgEl = document.getElementById('authSignupMsg');
    const btn = document.getElementById('signupSubmitBtn');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'admin-form-msg'; }

    if (!fullName || !username || !email || !password) {
        if (msgEl) { msgEl.textContent = 'Please fill in Full Name, Username, Email and Password.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (fullName.length < 2 || fullName.length > 60 || !/^[a-zA-Z\u0980-\u09FF .'-]+$/.test(fullName)) {
        if (msgEl) { msgEl.textContent = 'Please enter a valid Full Name.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    // Username এ শুধু lowercase অক্ষর, সংখ্যা আর আন্ডারস্কোর থাকতে পারবে — স্পেস বা বড় হাতের অক্ষর নয়
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        if (msgEl) { msgEl.textContent = 'Username must be 3-20 characters: lowercase letters, numbers, and _ only (no spaces or capital letters).'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    // Email শুধুমাত্র পরিচিত provider (gmail, yahoo, outlook ইত্যাদি) থেকেই নেওয়া হবে —
    // ভুয়া/এলোমেলো domain দিয়ে account খোলা আটকানোর জন্য
    const ALLOWED_EMAIL_DOMAINS = [
        'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
        'icloud.com', 'protonmail.com', 'proton.me', 'aol.com', 'msn.com', 'yandex.com'
    ];
    const emailDomain = email.toLowerCase().split('@')[1] || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !ALLOWED_EMAIL_DOMAINS.includes(emailDomain)) {
        if (msgEl) { msgEl.textContent = 'Please use a valid email from Gmail, Yahoo, Outlook, or another major provider.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (password.length < 6) {
        if (msgEl) { msgEl.textContent = 'Password must be at least 6 characters.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (password !== confirmPassword) {
        if (msgEl) { msgEl.textContent = 'Passwords do not match.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    // Captcha check - উপরে দেখানো সংখ্যার সাথে হুবহু মিলতে হবে
    if (!captchaInput || captchaInput !== currentAuthCaptcha) {
        if (msgEl) { msgEl.textContent = 'Please enter the code shown above correctly.'; msgEl.className = 'admin-form-msg error'; }
        generateAuthCaptcha(); // ভুল হলে নতুন code দেখাও
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }
    try {
        // একই username আগে থেকে কেউ নিয়ে থাকলে আটকে দাও (case-insensitive)
        const { data: existingUser, error: checkErr } = await supabaseClient
            .from('profiles')
            .select('id')
            .ilike('username', username)
            .maybeSingle();
        if (checkErr) console.error('Username check error:', checkErr);
        if (existingUser) {
            if (msgEl) { msgEl.textContent = 'This Username is already taken, please choose another.'; msgEl.className = 'admin-form-msg error'; }
            generateAuthCaptcha();
            return;
        }

        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { username, full_name: fullName } }
        });
        if (error) {
            const isUsernameConflict = /username_taken|Database error/i.test(error.message || '');
            if (msgEl) {
                msgEl.textContent = isUsernameConflict
                    ? 'This Username is already taken, please choose another.'
                    : error.message;
                msgEl.className = 'admin-form-msg error';
            }
            generateAuthCaptcha();
            return;
        }

        document.getElementById('signupName').value = '';
        document.getElementById('signupUsername').value = '';
        document.getElementById('signupEmail').value = '';
        document.getElementById('signupPassword').value = '';
        document.getElementById('signupPasswordConfirm').value = '';
        generateAuthCaptcha();

        if (data.session) {
            // Supabase project-এ "Confirm email" বন্ধ থাকলে সাইনআপের সাথে সাথেই লগইন হয়ে যায়।
            // Dashboard auto-open না করে Home পেজেই থাকতে দেওয়া হচ্ছে (মোডাল বন্ধ করলেই হয়)।
            closeAuthModal();
        } else {
            if (msgEl) {
                msgEl.textContent = 'Account created ✅ — please Sign In now.';
                msgEl.className = 'admin-form-msg success';
            }
            switchAuthTab('signin');
        }
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
        generateAuthCaptcha();
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign Up'; }
    }
}

async function signOutUser() {
    try {
        await supabaseClient.auth.signOut();
    } catch (e) {
        console.error('Sign out error:', e);
    }
    // onAuthStateChange updateAuthUI(null) কল করবে, যেটা dashboard/admin panel বন্ধ করে দেবে
}

// Header-এর "Dashboard" বাটন — role অনুযায়ী Admin Panel বা সাধারণ User Dashboard খোলে
function openDashboard() {
    if (!currentAuthSession || !currentAuthSession.user) {
        openAuthModal('signin');
        return;
    }
    if (isCurrentUserAdmin(currentAuthSession)) {
        openAdminPanel();
    } else {
        openUserDashboard();
    }
}

function openUserDashboard() {
    const overlay = document.getElementById('userDashboardOverlay');
    if (!overlay || !currentAuthSession?.user) return;

    const usernameInput = document.getElementById('userDashUsernameInput');
    const emailEl = document.getElementById('userDashEmail');
    const joinedEl = document.getElementById('userDashJoined');
    const avatarEl = document.getElementById('userDashAvatarPreview');
    const fullNameInput = document.getElementById('userDashFullNameInput');
    if (usernameInput) usernameInput.value = getDisplayUsername(currentAuthSession);
    if (emailEl) emailEl.value = currentAuthSession.user.email;
    if (fullNameInput) fullNameInput.value = currentAuthSession.user.user_metadata?.full_name || '';
    const usernameMsgEl = document.getElementById('userDashUsernameMsg');
    if (usernameMsgEl) { usernameMsgEl.textContent = ''; usernameMsgEl.className = 'auth-field-msg'; }
    if (joinedEl) {
        const created = currentAuthSession.user.created_at ? new Date(currentAuthSession.user.created_at) : null;
        joinedEl.textContent = created ? created.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    }
    if (avatarEl) avatarEl.src = DEFAULT_AVATAR_PLACEHOLDER;
    overlay.style.display = 'flex';
    document.body.classList.add('modal-open');
    setDashboardUrlParam(); // page refresh দিলেও এই ড্যাশবোর্ডেই থাকবে, home এ চলে যাবে না

    switchUserTab('profile');
    loadUserProfileExtras(); // avatar_url নিয়ে আসে (profiles টেবিল থেকে)
    ['userProfileMsg', 'userAvatarMsg', 'userPasswordMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ''; el.className = 'admin-form-msg'; }
    });
    const oldPassEl = document.getElementById('userOldPasswordInput');
    const newPassEl = document.getElementById('userNewPasswordInput');
    const confirmPassEl = document.getElementById('userConfirmPasswordInput');
    if (oldPassEl) oldPassEl.value = '';
    if (newPassEl) newPassEl.value = '';
    if (confirmPassEl) confirmPassEl.value = '';
}
function closeUserDashboard() {
    const overlay = document.getElementById('userDashboardOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
    clearDashboardUrlParam();
}

// ---------- User Dashboard: tab switching (Profile / Favorites / My Requests / Security) ----------

const USER_TAB_TITLES = { profile: 'Profile', favorites: 'Favorites', requests: 'My Requests', downloads: 'Download History' };

function switchUserTab(tab) {
    const tabs = ['profile', 'favorites', 'requests', 'downloads'];
    const validTab = tabs.includes(tab) ? tab : 'profile';

    tabs.forEach(function (t) {
        const content = document.getElementById('userTab' + t.charAt(0).toUpperCase() + t.slice(1));
        const navBtn = document.getElementById('userNavBtn' + t.charAt(0).toUpperCase() + t.slice(1));
        if (content) content.style.display = (t === validTab) ? 'block' : 'none';
        if (navBtn) navBtn.classList.toggle('active', t === validTab);
    });

    const titleEl = document.getElementById('userDashTopbarTitle');
    if (titleEl) titleEl.textContent = USER_TAB_TITLES[validTab] || 'Profile';

    if (validTab === 'favorites') {
        fetchUserFavorites().then(() => {
            const searchInput = document.getElementById('userFavoriteSearchInput');
            renderUserFavoritesList(searchInput ? searchInput.value.trim() : '');
        });
    } else if (validTab === 'requests') {
        fetchUserRequests().then(() => {
            const searchInput = document.getElementById('userRequestSearchInput');
            renderUserRequestsList(searchInput ? searchInput.value.trim() : '');
        });
    } else if (validTab === 'downloads') {
        fetchUserDownloadHistory().then(() => {
            const searchInput = document.getElementById('userDownloadSearchInput');
            renderUserDownloadsList(searchInput ? searchInput.value.trim() : '');
        });
    }
}

// ---------- Profile tab: load avatar_url + keep username input in sync with profiles table ----------

async function loadUserProfileExtras() {
    if (!currentAuthSession?.user) return;
    try {
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('username, avatar_url, full_name')
            .eq('id', currentAuthSession.user.id)
            .maybeSingle();

        if (error) { console.error('Error loading profile:', error.message); return; }

        const avatarEl = document.getElementById('userDashAvatarPreview');
        if (avatarEl) avatarEl.src = (data && data.avatar_url) ? data.avatar_url : DEFAULT_AVATAR_PLACEHOLDER;

        const usernameInput = document.getElementById('userDashUsernameInput');
        if (usernameInput && data && data.username) usernameInput.value = data.username;

        const fullNameInput = document.getElementById('userDashFullNameInput');
        if (fullNameInput && data && data.full_name) fullNameInput.value = data.full_name;

        myCommentIdentityCache = null; // ফ্রেশ ডেটা এলো, comment composer এর cache invalidate করে দাও
    } catch (e) {
        console.error('Unexpected error loading profile:', e);
    }
}

// ---------- Profile edit/update (full name + username + profiles table sync) ----------

async function handleUpdateProfile() {
    const msgEl = document.getElementById('userProfileMsg');
    const usernameInput = document.getElementById('userDashUsernameInput');
    const fullNameInput = document.getElementById('userDashFullNameInput');
    const newUsername = (usernameInput?.value || '').trim().toLowerCase().replace(/\s+/g, '');
    const newFullName = (fullNameInput?.value || '').trim();
    if (usernameInput) usernameInput.value = newUsername;

    if (!currentAuthSession?.user) return;
    if (!newFullName || newFullName.length < 2 || newFullName.length > 60 || !/^[a-zA-Z\u0980-\u09FF .'-]+$/.test(newFullName)) {
        if (msgEl) { msgEl.textContent = 'Please enter a valid Full Name.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (!newUsername) {
        if (msgEl) { msgEl.textContent = 'Username cannot be empty.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    // Username এ শুধু lowercase অক্ষর, সংখ্যা আর আন্ডারস্কোর থাকতে পারবে — স্পেস বা বড় হাতের অক্ষর নয়
    if (!/^[a-z0-9_]{3,20}$/.test(newUsername)) {
        if (msgEl) { msgEl.textContent = 'Username must be 3-20 characters: lowercase letters, numbers, and _ only (no spaces or capital letters).'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (msgEl) { msgEl.textContent = 'Saving...'; msgEl.className = 'admin-form-msg'; }

    try {
        // একই username (case-insensitive) অন্য কেউ আগে থেকে নিয়ে রেখেছে কিনা চেক করে নাও
        const { data: existing, error: checkError } = await supabaseClient
            .from('profiles')
            .select('id')
            .ilike('username', newUsername)
            .neq('id', currentAuthSession.user.id)
            .maybeSingle();

        if (checkError) throw checkError;
        if (existing) {
            if (msgEl) { msgEl.textContent = 'This username is already taken.'; msgEl.className = 'admin-form-msg error'; }
            return;
        }

        const { error: profileError } = await supabaseClient
            .from('profiles')
            .update({ username: newUsername, full_name: newFullName })
            .eq('id', currentAuthSession.user.id);
        if (profileError) throw profileError;

        const { data: updatedUser, error: authError } = await supabaseClient.auth.updateUser({ data: { username: newUsername, full_name: newFullName } });
        if (authError) throw authError;

        if (updatedUser?.user) {
            currentAuthSession = { ...currentAuthSession, user: updatedUser.user };
            updateAuthUI(currentAuthSession);
        }

        const usernameMsgEl = document.getElementById('userDashUsernameMsg');
        if (usernameMsgEl) { usernameMsgEl.textContent = ''; usernameMsgEl.className = 'auth-field-msg'; }

        if (msgEl) { msgEl.textContent = 'Profile updated successfully ✅'; msgEl.className = 'admin-form-msg success'; }
    } catch (err) {
        console.error('Update profile error:', err);
        if (msgEl) { msgEl.textContent = '❌ Could not update profile: ' + (err?.message || 'Unknown error'); msgEl.className = 'admin-form-msg error'; }
    }
}

// ---------- Profile picture upload (Supabase Storage: "avatars" bucket) ----------

document.addEventListener('DOMContentLoaded', function () {
    const avatarInput = document.getElementById('userAvatarFileInput');
    if (avatarInput) {
        avatarInput.addEventListener('change', function () {
            const file = this.files && this.files[0];
            this.value = ''; // একই ফাইল আবার সিলেক্ট করলেও change event যেন আবার ফায়ার হয়
            if (file) openAvatarCropper(file);
        });
    }
});

async function uploadAvatarFile(file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `avatar_${currentAuthSession.user.id}_${Date.now()}.${ext}`;

    const { error } = await supabaseClient.storage.from(AVATAR_BUCKET).upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined
    });

    if (error) {
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('bucket not found')) {
            throw new Error(`Storage bucket "${AVATAR_BUCKET}" does not exist in Supabase. See user-dashboard-schema.sql for setup steps.`);
        }
        if (msg.includes('row-level security') || msg.includes('policy') || msg.includes('permission') || msg.includes('unauthorized')) {
            throw new Error(`Upload blocked by Supabase Storage policy. See user-dashboard-schema.sql for the required policies.`);
        }
        throw error;
    }

    const { data } = supabaseClient.storage.from(AVATAR_BUCKET).getPublicUrl(fileName);
    if (!data || !data.publicUrl) {
        throw new Error('Upload succeeded but no public URL was returned. Check that the "avatars" bucket is set to Public.');
    }
    return data.publicUrl;
}

async function handleAvatarChange(file) {
    const msgEl = document.getElementById('userAvatarMsg');
    const avatarEl = document.getElementById('userDashAvatarPreview');
    if (!currentAuthSession?.user) return;

    if (!file.type || !file.type.startsWith('image/')) {
        if (msgEl) { msgEl.textContent = 'Please choose an image file.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }

    if (msgEl) { msgEl.textContent = 'Uploading...'; msgEl.className = 'admin-form-msg'; }

    try {
        const publicUrl = await uploadAvatarFile(file);

        const { error } = await supabaseClient
            .from('profiles')
            .update({ avatar_url: publicUrl })
            .eq('id', currentAuthSession.user.id);
        if (error) throw error;

        if (avatarEl) avatarEl.src = publicUrl;
        myCommentIdentityCache = null; // নতুন ছবি সেভ হলো, comment identity cache বাতিল করো — যাতে পরের কমেন্টেই নতুন ছবি ব্যবহার হয়, লগআউট করা না লাগে
        if (commentsCurrentMovieId !== null && commentsCurrentMovieId !== undefined) renderCommentComposer(); // comment box খোলা থাকলে সাথে সাথেই নতুন ছবি বসিয়ে দাও
        if (msgEl) { msgEl.textContent = 'Profile picture updated ✅'; msgEl.className = 'admin-form-msg success'; }
    } catch (err) {
        console.error('Avatar upload error:', err);
        if (msgEl) { msgEl.textContent = '❌ ' + (err?.message || 'Could not upload profile picture'); msgEl.className = 'admin-form-msg error'; }
    }
}

// ---------- Facebook-style avatar cropper (zoom + drag, circular crop) ----------
// ফাইল সিলেক্ট করার সাথে সাথে সরাসরি আপলোড না করে আগে এই মোডালে zoom in/out আর drag করে
// পজিশন ঠিক করে নেওয়া যায়, তারপর Save চাপলে গোল আকারে crop হয়ে আপলোড হয়।
const avatarCrop = {
    naturalW: 0, naturalH: 0, coverScale: 1, stageSize: 0,
    panX: 0, panY: 0, zoom: 1,
    dragging: false, startClientX: 0, startClientY: 0, startPanX: 0, startPanY: 0
};

function openAvatarCropper(file) {
    if (!file.type || !file.type.startsWith('image/')) {
        const msgEl = document.getElementById('userAvatarMsg');
        if (msgEl) { msgEl.textContent = 'Please choose an image file.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        const img = document.getElementById('avatarCropImg');
        const overlay = document.getElementById('avatarCropOverlay');
        const zoomSlider = document.getElementById('avatarCropZoomSlider');
        if (!img || !overlay) return;
        img.onload = function () {
            const stage = document.getElementById('avatarCropStage');
            avatarCrop.naturalW = img.naturalWidth;
            avatarCrop.naturalH = img.naturalHeight;
            avatarCrop.stageSize = stage.clientWidth || 300;
            avatarCrop.coverScale = Math.max(avatarCrop.stageSize / avatarCrop.naturalW, avatarCrop.stageSize / avatarCrop.naturalH);
            avatarCrop.zoom = 1;
            avatarCrop.panX = (avatarCrop.stageSize - avatarCrop.naturalW * avatarCrop.coverScale) / 2;
            avatarCrop.panY = (avatarCrop.stageSize - avatarCrop.naturalH * avatarCrop.coverScale) / 2;
            if (zoomSlider) zoomSlider.value = 100;
            applyAvatarCropTransform();
        };
        img.src = e.target.result;
        avatarCrop._pendingFile = file;
        overlay.style.display = 'flex';
        document.body.classList.add('modal-open');
    };
    reader.readAsDataURL(file);
}

function closeAvatarCropper() {
    const overlay = document.getElementById('avatarCropOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
    avatarCrop._pendingFile = null;
}

function clampAvatarPan() {
    const w = avatarCrop.naturalW * avatarCrop.coverScale * avatarCrop.zoom;
    const h = avatarCrop.naturalH * avatarCrop.coverScale * avatarCrop.zoom;
    const minX = avatarCrop.stageSize - w, minY = avatarCrop.stageSize - h;
    avatarCrop.panX = Math.min(0, Math.max(minX, avatarCrop.panX));
    avatarCrop.panY = Math.min(0, Math.max(minY, avatarCrop.panY));
}

function applyAvatarCropTransform() {
    clampAvatarPan();
    const img = document.getElementById('avatarCropImg');
    if (!img) return;
    const w = avatarCrop.naturalW * avatarCrop.coverScale * avatarCrop.zoom;
    const h = avatarCrop.naturalH * avatarCrop.coverScale * avatarCrop.zoom;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    img.style.transform = `translate(${avatarCrop.panX}px, ${avatarCrop.panY}px)`;
}

// slider 100-300 => zoom 1x - 3x; zoom বদলালে center point ঠিক রাখতে pan সমানুপাতিক হারে adjust করা হয়
function setAvatarZoom(newZoom) {
    newZoom = Math.min(3, Math.max(1, newZoom));
    const oldZoom = avatarCrop.zoom;
    const cx = avatarCrop.stageSize / 2, cy = avatarCrop.stageSize / 2;
    avatarCrop.panX = cx - ((cx - avatarCrop.panX) / oldZoom) * newZoom;
    avatarCrop.panY = cy - ((cy - avatarCrop.panY) / oldZoom) * newZoom;
    avatarCrop.zoom = newZoom;
    const zoomSlider = document.getElementById('avatarCropZoomSlider');
    if (zoomSlider) zoomSlider.value = Math.round(newZoom * 100);
    applyAvatarCropTransform();
}

// − / + বাটনে ক্লিক করলে ধাপে ধাপে zoom in/out করে (slider drag না করেও)
function stepAvatarZoom(deltaPercent) {
    setAvatarZoom(avatarCrop.zoom + deltaPercent / 100);
}

document.addEventListener('DOMContentLoaded', function () {
    const zoomSlider = document.getElementById('avatarCropZoomSlider');
    const stage = document.getElementById('avatarCropStage');
    if (zoomSlider) {
        zoomSlider.addEventListener('input', function () {
            setAvatarZoom(Number(this.value) / 100);
        });
    }
    if (stage) {
        const startDrag = (clientX, clientY) => {
            avatarCrop.dragging = true;
            avatarCrop.startClientX = clientX;
            avatarCrop.startClientY = clientY;
            avatarCrop.startPanX = avatarCrop.panX;
            avatarCrop.startPanY = avatarCrop.panY;
            stage.classList.add('dragging');
        };
        const moveDrag = (clientX, clientY) => {
            if (!avatarCrop.dragging) return;
            avatarCrop.panX = avatarCrop.startPanX + (clientX - avatarCrop.startClientX);
            avatarCrop.panY = avatarCrop.startPanY + (clientY - avatarCrop.startClientY);
            applyAvatarCropTransform();
        };
        const endDrag = () => { avatarCrop.dragging = false; stage.classList.remove('dragging'); };

        stage.addEventListener('mousedown', e => { startDrag(e.clientX, e.clientY); e.preventDefault(); });
        window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
        window.addEventListener('mouseup', endDrag);

        stage.addEventListener('touchstart', e => { const t = e.touches[0]; startDrag(t.clientX, t.clientY); }, { passive: true });
        stage.addEventListener('touchmove', e => { const t = e.touches[0]; moveDrag(t.clientX, t.clientY); }, { passive: true });
        stage.addEventListener('touchend', endDrag);
    }
});

async function saveAvatarCrop() {
    const file = avatarCrop._pendingFile;
    if (!file) return;
    const saveBtn = document.getElementById('avatarCropSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
    try {
        const img = document.getElementById('avatarCropImg');
        const OUT = 400; // আউটপুট গোল ছবির সাইজ (px)
        const canvas = document.createElement('canvas');
        canvas.width = OUT; canvas.height = OUT;
        const ctx = canvas.getContext('2d');
        ctx.beginPath();
        ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip(); // গোল আকারে ক্লিপ করে রাখা, বাইরের অংশ transparent থাকবে

        const displayScale = avatarCrop.coverScale * avatarCrop.zoom;
        const sourceX = -avatarCrop.panX / displayScale;
        const sourceY = -avatarCrop.panY / displayScale;
        const sourceSize = avatarCrop.stageSize / displayScale;
        ctx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUT, OUT);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92));
        if (!blob) throw new Error('Could not process the image, please try another photo.');
        const croppedFile = new File([blob], 'avatar.png', { type: 'image/png' });

        closeAvatarCropper();
        await handleAvatarChange(croppedFile);
    } catch (err) {
        console.error('Avatar crop error:', err);
        const msgEl = document.getElementById('userAvatarMsg');
        if (msgEl) { msgEl.textContent = '❌ ' + (err?.message || 'Could not process the image'); msgEl.className = 'admin-form-msg error'; }
        closeAvatarCropper();
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
}

// ---------- Change Password ----------

async function handleChangePassword() {
    const msgEl = document.getElementById('userPasswordMsg');
    const oldPass = document.getElementById('userOldPasswordInput')?.value || '';
    const newPass = document.getElementById('userNewPasswordInput')?.value || '';
    const confirmPass = document.getElementById('userConfirmPasswordInput')?.value || '';

    if (!oldPass) {
        if (msgEl) { msgEl.textContent = 'Please enter your old password.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (newPass.length < 6) {
        if (msgEl) { msgEl.textContent = 'New password must be at least 6 characters.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (newPass !== confirmPass) {
        if (msgEl) { msgEl.textContent = 'New passwords do not match.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (!currentAuthSession?.user?.email) return;

    if (msgEl) { msgEl.textContent = 'Verifying old password...'; msgEl.className = 'admin-form-msg'; }
    try {
        // আগে old password টা ঠিক কিনা যাচাই করে নাও — ভুল হলে password change হবে না
        const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
            email: currentAuthSession.user.email,
            password: oldPass
        });
        if (verifyError) {
            if (msgEl) { msgEl.textContent = '❌ Old password is incorrect.'; msgEl.className = 'admin-form-msg error'; }
            return;
        }

        if (msgEl) { msgEl.textContent = 'Updating...'; msgEl.className = 'admin-form-msg'; }
        const { error } = await supabaseClient.auth.updateUser({ password: newPass });
        if (error) throw error;

        if (msgEl) { msgEl.textContent = 'Password updated successfully ✅'; msgEl.className = 'admin-form-msg success'; }
        document.getElementById('userOldPasswordInput').value = '';
        document.getElementById('userNewPasswordInput').value = '';
        document.getElementById('userConfirmPasswordInput').value = '';
    } catch (err) {
        console.error('Change password error:', err);
        if (msgEl) { msgEl.textContent = '❌ ' + (err?.message || 'Could not update password'); msgEl.className = 'admin-form-msg error'; }
    }
}

// ==================== FAVORITES / WATCHLIST ====================

let userFavoriteIds = new Set();   // দ্রুত heart আইকন দেখানোর জন্য শুধু movie_id গুলো ক্যাশ করা থাকে
let userFavoritesFull = [];        // Favorites ট্যাবে পুরো লিস্ট দেখানোর জন্য (title/poster/type সহ)
let lastUserFavoritesFetchError = null;

function isMovieFavorited(movieId) {
    return movieId !== undefined && movieId !== null && userFavoriteIds.has(String(movieId));
}

// সাইন-ইন করার সাথে সাথেই শুধু id গুলো লোড করে নেয় (movie grid/modal এ heart আইকন ঠিকমতো দেখানোর জন্য)
async function loadUserFavoriteIds() {
    if (!currentAuthSession?.user) { userFavoriteIds = new Set(); return; }
    try {
        const { data, error } = await supabaseClient
            .from('favorites')
            .select('movie_id')
            .eq('user_id', currentAuthSession.user.id);
        if (error) { console.error('Error loading favorite ids:', error.message); return; }
        userFavoriteIds = new Set((data || []).map(row => String(row.movie_id)));
    } catch (e) {
        console.error('Unexpected error loading favorite ids:', e);
    }
}

async function fetchUserFavorites() {
    if (!currentAuthSession?.user) { userFavoritesFull = []; return; }
    try {
        const { data, error } = await supabaseClient
            .from('favorites')
            .select('*')
            .eq('user_id', currentAuthSession.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching favorites:', error.message);
            lastUserFavoritesFetchError = error.message;
            userFavoritesFull = [];
            return;
        }
        lastUserFavoritesFetchError = null;
        userFavoritesFull = data || [];
    } catch (err) {
        console.error('Unexpected error loading favorites:', err);
        lastUserFavoritesFetchError = err?.message || 'Unknown error';
        userFavoritesFull = [];
    }
}

// হার্ট বাটনে ক্লিক করলে (movie card বা modal থেকে) favorite যোগ/মুছে ফেলে
async function toggleFavoriteMovie(movie, btnEl) {
    if (!currentAuthSession?.user) {
        openAuthModal('signin');
        return;
    }
    if (!movie || movie.id === undefined || movie.id === null) return;

    const movieIdStr = String(movie.id);
    const alreadyFav = isMovieFavorited(movieIdStr);

    try {
        if (alreadyFav) {
            const { error } = await supabaseClient
                .from('favorites')
                .delete()
                .eq('user_id', currentAuthSession.user.id)
                .eq('movie_id', movieIdStr);
            if (error) throw error;
            userFavoriteIds.delete(movieIdStr);
        } else {
            const { error } = await supabaseClient
                .from('favorites')
                .insert([{
                    user_id: currentAuthSession.user.id,
                    movie_id: movieIdStr,
                    movie_title: movie.title || null,
                    movie_poster: movie.poster || null,
                    movie_type: movie.tmdbType || 'movie',
                    movie_year: movie.year || null
                }]);
            if (error) throw error;
            userFavoriteIds.add(movieIdStr);
        }

        // যেকোনো heart বাটন (card বা modal) এই মুভির জন্য থাকলে সাথে সাথেই আপডেট করে দাও
        const nowFav = isMovieFavorited(movieIdStr);
        if (btnEl) {
            btnEl.classList.toggle('active', nowFav);
            if (btnEl.id === 'modalFavoriteBtn') {
                btnEl.textContent = nowFav ? '❤️ In Favorites' : '🤍 Add to Favorites';
                btnEl.title = '';
            } else {
                btnEl.textContent = nowFav ? '❤️' : '🤍';
                btnEl.title = nowFav ? 'Remove from Favorites' : 'Add to Favorites';
            }
        }
    } catch (err) {
        console.error('Toggle favorite error:', err);
        showNoticeModal('❌ Could not update favorites: ' + (err?.message || 'Unknown error'));
    }
}

function renderUserFavoritesList(filter) {
    const container = document.getElementById('userFavoritesList');
    if (!container) return;
    container.innerHTML = '';

    if (lastUserFavoritesFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load favorites (${escapeHtml(lastUserFavoritesFetchError)}).</div>`;
        return;
    }

    const q = (filter || '').trim().toLowerCase();
    const source = (Array.isArray(userFavoritesFull) ? userFavoritesFull : []).filter(f =>
        !q || (f.movie_title || '').toLowerCase().includes(q)
    );

    if (source.length === 0) {
        container.innerHTML = `<div class="admin-db-empty">${q ? 'No matching favorites found.' : 'You have not added any favorites yet. Tap the 🤍 icon on any title to save it here.'}</div>`;
        return;
    }

    source.forEach(fav => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const typeLabel = fav.movie_type === 'tv' ? 'TV Series' : 'Movie';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${fav.movie_poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info admin-db-info-clickable">
                <div class="admin-db-title">${escapeHtml(fav.movie_title || 'Untitled')}${fav.movie_year ? ` (${escapeHtml(String(fav.movie_year))})` : ''}</div>
                <div class="admin-db-meta">${typeLabel}</div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-delete-btn">🗑 Remove</button>
            </div>
        `;
        const liveMovie = Array.isArray(allMovies) ? allMovies.find(m => String(m.id) === String(fav.movie_id)) : null;

        // যখন favorite করার সময় poster সেভ হয়নি (movie.poster খালি ছিল, TMDB থেকে live আসতো),
        // তখন এখানে সেই একই মুভির জন্য TMDB থেকে আবার poster টা এনে thumbnail বসিয়ে দাও
        if (!fav.movie_poster && liveMovie) {
            const imgEl = card.querySelector('.admin-db-thumb');
            if (liveMovie.poster) {
                if (imgEl) imgEl.src = liveMovie.poster;
            } else {
                fetchTmdbPosterQuick(liveMovie).then(url => {
                    if (url && imgEl && imgEl.isConnected) imgEl.src = url;
                });
            }
        }

        card.querySelector('.admin-db-info').addEventListener('click', () => {
            if (liveMovie) {
                closeUserDashboard();
                openMovieModal(liveMovie);
            } else {
                showNoticeModal('This title is no longer available on the site.');
            }
        });
        card.querySelector('.admin-db-delete-btn').addEventListener('click', async () => {
            try {
                const { error } = await supabaseClient
                    .from('favorites')
                    .delete()
                    .eq('user_id', currentAuthSession.user.id)
                    .eq('movie_id', fav.movie_id);
                if (error) throw error;
                userFavoriteIds.delete(String(fav.movie_id));
                userFavoritesFull = userFavoritesFull.filter(f => f.id !== fav.id);
                const searchInput = document.getElementById('userFavoriteSearchInput');
                renderUserFavoritesList(searchInput ? searchInput.value.trim() : '');
            } catch (err) {
                console.error('Remove favorite error:', err);
                showNoticeModal('❌ Could not remove favorite: ' + (err?.message || 'Unknown error'));
            }
        });
        container.appendChild(card);
    });
}

// ==================== MY REQUESTS (একজন ইউজারের নিজের করা movie/series request গুলো) ====================

let userRequestsFull = [];
let lastUserRequestsFetchError = null;

async function fetchUserRequests() {
    if (!currentAuthSession?.user) { userRequestsFull = []; return; }
    try {
        const { data, error } = await supabaseClient
            .from('requests')
            .select('*')
            .eq('user_id', currentAuthSession.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching my requests:', error.message);
            lastUserRequestsFetchError = error.message;
            userRequestsFull = [];
            return;
        }
        lastUserRequestsFetchError = null;
        userRequestsFull = data || [];
    } catch (err) {
        console.error('Unexpected error loading my requests:', err);
        lastUserRequestsFetchError = err?.message || 'Unknown error';
        userRequestsFull = [];
    }
}

function renderUserRequestsList(filter) {
    const container = document.getElementById('userRequestsList');
    if (!container) return;
    container.innerHTML = '';

    if (lastUserRequestsFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load your requests (${escapeHtml(lastUserRequestsFetchError)}).</div>`;
        return;
    }

    const q = (filter || '').trim().toLowerCase();
    const source = (Array.isArray(userRequestsFull) ? userRequestsFull : []).filter(r =>
        !q || (r.movie_title || '').toLowerCase().includes(q)
    );

    if (source.length === 0) {
        container.innerHTML = `<div class="admin-db-empty">${q ? 'No matching requests found.' : 'You have not requested any movie/series yet. Use the "Request Here" widget to submit one.'}</div>`;
        return;
    }

    source.forEach(reqItem => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const timeAgo = formatTimeAgo(reqItem.created_at) || '';
        const yearPart = reqItem.release_year ? ` (${escapeHtml(String(reqItem.release_year))})` : '';
        const alreadyOnSite = !!findMatchingMovieForRequest(reqItem.movie_title);
        const liveMovie = alreadyOnSite ? allMovies.find(m => {
            const normalize = (s) => String(s || '').toLowerCase().replace(/\(\d{4}(-\d{2,4})?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
            return normalize(m.title) === normalize(reqItem.movie_title);
        }) : null;
        card.innerHTML = `
            <div class="admin-db-info${alreadyOnSite ? ' admin-db-info-clickable' : ''}">
                <div class="admin-db-title">${escapeHtml(reqItem.movie_title || 'Untitled')}${yearPart}</div>
                <div class="admin-alert-meta-row">${alreadyOnSite ? '<span class="admin-alert-source-tag auto">✅ Already on Site</span>' : '<span class="admin-alert-source-tag">⏳ Pending</span>'}<span class="admin-alert-time">${timeAgo}</span></div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-delete-btn">🗑 Remove</button>
            </div>
        `;
        // অ্যাডমিন যদি এই রিকোয়েস্ট করা মুভি/সিরিজটা ইতিমধ্যে সাইটে আপলোড করে দিয়ে থাকে, তাহলে ক্লিক করলেই সরাসরি সেটা ওপেন হয়ে যাবে
        if (alreadyOnSite && liveMovie) {
            card.querySelector('.admin-db-info').addEventListener('click', () => {
                closeUserDashboard();
                openMovieModal(liveMovie);
            });
        }
        card.querySelector('.admin-db-delete-btn').addEventListener('click', () => deleteUserRequest(reqItem));
        container.appendChild(card);
    });
}

// নিজের করা request নিজেই dashboard থেকে remove করতে পারে
async function deleteUserRequest(reqItem) {
    if (!reqItem || !reqItem.id || !currentAuthSession?.user) return;
    try {
        const { error } = await supabaseClient
            .from('requests')
            .delete()
            .eq('id', reqItem.id)
            .eq('user_id', currentAuthSession.user.id);
        if (error) throw error;
        userRequestsFull = userRequestsFull.filter(r => r.id !== reqItem.id);
        const searchInput = document.getElementById('userRequestSearchInput');
        renderUserRequestsList(searchInput ? searchInput.value.trim() : '');
    } catch (err) {
        console.error('Delete my request error:', err);
        showNoticeModal('❌ Could not remove request: ' + (err?.message || 'Unknown error'));
    }
}

// ==================== DOWNLOAD HISTORY (লগইন করা ইউজার যা যা ডাউনলোড করেছে তার লিস্ট) ====================
// প্রতিবার "Download ..." বাটনে ক্লিক করলে download_history টেবিলে একটা রো সেভ হয় (শুধু লগইন করা থাকলে)।
// ইউজার নিজের Dashboard > Download History ট্যাব থেকে পুরো লিস্ট দেখতে এবং যেকোনো এন্ট্রি নিজে মুছে ফেলতে পারবে।

let userDownloadsFull = [];
let lastUserDownloadsFetchError = null;

function logDownloadHistory(movie, linkLabel) {
    if (!currentAuthSession?.user || !movie || movie.id === undefined || movie.id === null) return;
    supabaseClient.from('download_history').insert([{
        user_id: currentAuthSession.user.id,
        movie_id: String(movie.id),
        movie_title: movie.title || null,
        movie_poster: movie.poster || null,
        movie_type: movie.tmdbType || 'movie',
        movie_year: movie.year || null,
        link_label: linkLabel || null
    }]).then(({ error }) => {
        if (error) console.error('Download history save error:', error.message);
    });
}

async function fetchUserDownloadHistory() {
    if (!currentAuthSession?.user) { userDownloadsFull = []; return; }
    try {
        const { data, error } = await supabaseClient
            .from('download_history')
            .select('*')
            .eq('user_id', currentAuthSession.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching download history:', error.message);
            lastUserDownloadsFetchError = error.message;
            userDownloadsFull = [];
            return;
        }
        lastUserDownloadsFetchError = null;
        userDownloadsFull = data || [];
    } catch (err) {
        console.error('Unexpected error loading download history:', err);
        lastUserDownloadsFetchError = err?.message || 'Unknown error';
        userDownloadsFull = [];
    }
}

function renderUserDownloadsList(filter) {
    const container = document.getElementById('userDownloadsList');
    if (!container) return;
    container.innerHTML = '';

    if (lastUserDownloadsFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load download history (${escapeHtml(lastUserDownloadsFetchError)}).</div>`;
        return;
    }

    const q = (filter || '').trim().toLowerCase();
    const source = (Array.isArray(userDownloadsFull) ? userDownloadsFull : []).filter(d =>
        !q || (d.movie_title || '').toLowerCase().includes(q)
    );

    if (source.length === 0) {
        container.innerHTML = `<div class="admin-db-empty">${q ? 'No matching downloads found.' : 'You have not downloaded anything yet. Titles you download will show up here.'}</div>`;
        return;
    }

    source.forEach(dl => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const typeLabel = dl.movie_type === 'tv' ? 'TV Series' : 'Movie';
        const timeAgo = formatTimeAgo(dl.created_at) || '';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${dl.movie_poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info admin-db-info-clickable">
                <div class="admin-db-title">${escapeHtml(dl.movie_title || 'Untitled')}${dl.movie_year ? ` (${escapeHtml(String(dl.movie_year))})` : ''}</div>
                <div class="admin-db-meta">${typeLabel}${dl.link_label ? ' · ' + escapeHtml(dl.link_label) : ''}</div>
                <div class="admin-alert-meta-row"><span class="admin-alert-time">${timeAgo}</span></div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-delete-btn">🗑 Remove</button>
            </div>
        `;
        const liveMovie = Array.isArray(allMovies) ? allMovies.find(m => String(m.id) === String(dl.movie_id)) : null;

        if (!dl.movie_poster && liveMovie) {
            const imgEl = card.querySelector('.admin-db-thumb');
            if (liveMovie.poster) {
                if (imgEl) imgEl.src = liveMovie.poster;
            } else {
                fetchTmdbPosterQuick(liveMovie).then(url => {
                    if (url && imgEl && imgEl.isConnected) imgEl.src = url;
                });
            }
        }

        card.querySelector('.admin-db-info').addEventListener('click', () => {
            if (liveMovie) {
                closeUserDashboard();
                openMovieModal(liveMovie);
            } else {
                showNoticeModal('This title is no longer available on the site.');
            }
        });
        card.querySelector('.admin-db-delete-btn').addEventListener('click', () => deleteUserDownloadHistory(dl));
        container.appendChild(card);
    });
}

// নিজের download history থেকে যেকোনো এন্ট্রি নিজেই remove করতে পারবে
async function deleteUserDownloadHistory(dl) {
    if (!dl || !dl.id || !currentAuthSession?.user) return;
    try {
        const { error } = await supabaseClient
            .from('download_history')
            .delete()
            .eq('id', dl.id)
            .eq('user_id', currentAuthSession.user.id);
        if (error) throw error;
        userDownloadsFull = userDownloadsFull.filter(d => d.id !== dl.id);
        const searchInput = document.getElementById('userDownloadSearchInput');
        renderUserDownloadsList(searchInput ? searchInput.value.trim() : '');
    } catch (err) {
        console.error('Delete download history error:', err);
        showNoticeModal('❌ Could not remove from download history: ' + (err?.message || 'Unknown error'));
    }
}

// URL এ ?dashboard=1 বসিয়ে রাখে (auth param থাকলে সরিয়ে) — refresh করলেও dashboard/admin
// panel খোলা অবস্থাতেই থাকবে, home পেজে ফিরে যাবে না
function setDashboardUrlParam() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('dashboard') === '1' && !params.has('auth')) return; // ইতিমধ্যেই ঠিক আছে
    params.set('dashboard', '1');
    params.delete('auth');
    const newUrl = window.location.pathname + '?' + params.toString() + window.location.hash;
    history.replaceState(null, '', newUrl);
}
function clearDashboardUrlParam() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('dashboard') && !params.has('tab')) return;
    params.delete('dashboard');
    params.delete('tab'); // panel বন্ধ হলে কোন ট্যাব খোলা ছিল সেই তথ্যও মুছে দাও
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    history.replaceState(null, '', newUrl);
}

// বর্তমানে কোন admin ট্যাব খোলা আছে সেটা URL এ সংরক্ষণ করে রাখে (?tab=alerts ইত্যাদি) —
// page refresh করলে dashboard tab এ ফিরে না গিয়ে ঠিক এই একই ট্যাবেই থাকবে
function setAdminTabUrlParam(tab) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('dashboard') !== '1') return; // admin panel URL এ খোলা অবস্থায় চিহ্নিত না থাকলে কিছু করার দরকার নেই
    if (tab === 'dashboard') {
        if (!params.has('tab')) return;
        params.delete('tab');
    } else {
        if (params.get('tab') === tab) return;
        params.set('tab', tab);
    }
    const newUrl = window.location.pathname + '?' + params.toString() + window.location.hash;
    history.replaceState(null, '', newUrl);
}

// ==================== ADMIN PANEL (Hidden Content Manager) ====================

let adminPanelInitialized = false;
let adminSelectedCategories = new Set();
let currentAdminTab = 'dashboard'; // movies data লোড হওয়ার পর dashboard খোলা থাকলে stats রিফ্রেশ করতে ব্যবহার হয়

let adminExtraCategories = new Set();
let adminTmdbType = 'movie';
let adminPosterMode = 'link';
let adminCategoriesLoaded = false;

async function loadAdminExtraCategories() {
    try {
        const { data, error } = await supabaseClient
            .from('categories')
            .select('slug');

        if (error) {
            console.error('Error loading categories from Supabase:', error.message, error);
            return;
        }

        console.log('Categories loaded from Supabase:', data);

        adminExtraCategories = new Set((data || []).map(row => row.slug).filter(Boolean));
        adminCategoriesLoaded = true;
        renderAdminCategoryBox();
    } catch (e) {
        console.error('Unexpected error loading categories:', e);
    }
}

async function saveNewCategoryToDb(slug) {
    try {
        const { error } = await supabaseClient
            .from('categories')
            .insert([{ slug: slug }]);

        if (error && error.code !== '23505') { // ignore duplicate-slug errors
            console.error('Error saving category to Supabase:', error.message);
        }
    } catch (e) {
        console.error('Unexpected error saving category:', e);
    }
}

// ---------- Open / Close / Tabs ----------

function openAdminPanel() {
    if (!isCurrentUserAdmin(currentAuthSession)) {
        // admin না হলে (বা login-ই না থাকলে) admin panel খুলবে না — sign-in প্রম্পট দেখাও
        openAuthModal('signin');
        return;
    }

    if (!adminPanelInitialized) {
        setupAdminPanel();
        adminPanelInitialized = true;
    }
    const overlay = document.getElementById('adminOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.body.classList.add('modal-open');
    setDashboardUrlParam(); // page refresh দিলেও admin panel খোলা অবস্থাতেই থাকবে, home এ চলে যাবে না

    // refresh করার আগে যে ট্যাবে ছিলে (URL এর ?tab=...), সেই একই ট্যাবেই ফিরিয়ে আনো —
    // নাহলে প্রতিবার Dashboard ট্যাবে চলে যেত
    const savedTabParams = new URLSearchParams(window.location.search);
    const savedTab = savedTabParams.get('tab') || 'dashboard';
    switchAdminTab(savedTab);
    resetAdminForm();
    renderAdminDatabaseList('');
    fetchLinkAlerts().then(updateAdminAlertsBadge); // sidebar badge count রিফ্রেশ
    fetchAdminRequests().then(updateAdminRequestsBadge);
    fetchAdminMessages().then(updateAdminMessagesBadge);

    if (!adminCategoriesLoaded) {
        loadAdminExtraCategories();
    }
}

function closeAdminPanel() {
    const overlay = document.getElementById('adminOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
    clearDashboardUrlParam();
}

const ADMIN_TAB_TITLES = {
    dashboard: 'Dashboard',
    add: 'Add / Edit Content',
    manage: 'Database',
    banner: 'Hero Banner',
    comments: 'Comments',
    requests: 'Request Here',
    messages: 'Messages',
    alerts: 'Broken Link Reports',
    trash: 'Recycle Bin'
};

function switchAdminTab(tab) {
    const tabs = ['dashboard', 'add', 'manage', 'banner', 'comments', 'requests', 'messages', 'alerts', 'trash'];
    const validTab = tabs.includes(tab) ? tab : 'dashboard';
    currentAdminTab = validTab;
    setAdminTabUrlParam(validTab); // URL এ ট্যাব সেভ করে রাখো, refresh করলেও এই ট্যাবেই থাকবে

    tabs.forEach(function (t) {
        const content = document.getElementById('adminTab' + t.charAt(0).toUpperCase() + t.slice(1));
        const navBtn = document.getElementById('adminNavBtn' + t.charAt(0).toUpperCase() + t.slice(1));
        if (content) content.style.display = (t === validTab) ? 'block' : 'none';
        if (navBtn) navBtn.classList.toggle('active', t === validTab);
    });

    const titleEl = document.getElementById('adminTopbarTitle');
    if (titleEl) titleEl.textContent = ADMIN_TAB_TITLES[validTab] || 'Dashboard';

    if (validTab === 'dashboard') {
        loadAdminDashboardStats();
    } else if (validTab === 'manage') {
        const searchInput = document.getElementById('adminSearchInput');
        renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
    } else if (validTab === 'banner') {
        const searchInput = document.getElementById('adminBannerSearchInput');
        renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
    } else if (validTab === 'comments') {
        const searchInput = document.getElementById('adminCommentSearchInput');
        renderAdminCommentsList(searchInput ? searchInput.value.trim() : '');
    } else if (validTab === 'requests') {
        fetchAdminRequests().then(() => {
            const searchInput = document.getElementById('adminRequestSearchInput');
            renderAdminRequestsList(searchInput ? searchInput.value.trim() : '');
        });
    } else if (validTab === 'messages') {
        fetchAdminMessages().then(renderAdminMessagesList);
    } else if (validTab === 'alerts') {
        fetchLinkAlerts().then(renderAdminAlertsList);
    } else if (validTab === 'trash') {
        renderAdminTrashList();
    }
}

// ---------- Dashboard tab: real stats from the site's own database (no fake earning/premium numbers) ----------
async function loadAdminDashboardStats() {
    const movies = Array.isArray(allMovies) ? allMovies : [];
    const movieCount = movies.filter(m => m.tmdbType !== 'tv').length;
    const seriesCount = movies.filter(m => m.tmdbType === 'tv').length;

    const catSet = new Set();
    const catCounts = {};
    movies.forEach(m => {
        const cats = Array.isArray(m.category) ? m.category : (m.category ? String(m.category).split('|') : []);
        cats.forEach(c => {
            const name = (c || '').trim();
            if (!name || name.toLowerCase() === 'all') return;
            catSet.add(name);
            catCounts[name] = (catCounts[name] || 0) + 1;
        });
    });

    const totalViews = movies.reduce((sum, m) => sum + (Number(m.views) || 0), 0);

    setAdminStat('adminStatTotalContent', movies.length);
    setAdminStat('adminStatMovies', movieCount);
    setAdminStat('adminStatSeries', seriesCount);
    setAdminStat('adminStatTotalViews', totalViews.toLocaleString());
    setAdminStat('adminStatCategories', catSet.size);
    setAdminStat('adminStatTrash', Array.isArray(allDeletedMovies) ? allDeletedMovies.length : 0);
    setAdminStat('adminStatAlerts', Array.isArray(allLinkAlerts) ? allLinkAlerts.length : '…');
    setAdminStat('adminStatRequests', Array.isArray(allAdminRequests) ? allAdminRequests.length : '…');
    setAdminStat('adminStatMessages', Array.isArray(allAdminMessages) ? allAdminMessages.length : '…');

    // Recently Added (top 5 by created_at)
    const recentEl = document.getElementById('adminDashRecent');
    if (recentEl) {
        const sorted = [...movies].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        recentEl.innerHTML = sorted.length ? sorted.map(m => `
            <div class="admin-dash-row">
                <span class="admin-dash-row-title">${escapeHtml(m.title || 'Untitled')}</span>
                <span class="admin-dash-row-meta">${m.tmdbType === 'tv' ? 'TV' : 'Movie'} · ${formatTimeAgo(m.created_at) || ''}</span>
            </div>
        `).join('') : '<div class="admin-db-empty">No content yet.</div>';
    }

    // Top Views (top 5 by views, highest to lowest)
    const topViewsEl = document.getElementById('adminDashTopViews');
    if (topViewsEl) {
        const byViews = [...movies].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
        topViewsEl.innerHTML = byViews.length ? byViews.map(m => `
            <div class="admin-dash-row">
                <span class="admin-dash-row-title">${escapeHtml(m.title || 'Untitled')}</span>
                <span class="admin-dash-row-meta">${(Number(m.views) || 0).toLocaleString()} views</span>
            </div>
        `).join('') : '<div class="admin-db-empty">No content yet.</div>';
    }

    // Top Categories (top 5 by count)
    const catsEl = document.getElementById('adminDashCategories');
    if (catsEl) {
        const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
        const maxCount = topCats.length ? topCats[0][1] : 1;
        catsEl.innerHTML = topCats.length ? topCats.map(([name, count]) => `
            <div class="admin-dash-row admin-dash-cat-row">
                <span class="admin-dash-row-title">${escapeHtml(name)}</span>
                <span class="admin-dash-row-meta">${count}</span>
                <div class="admin-dash-bar-track"><div class="admin-dash-bar-fill" style="width:${Math.round((count / maxCount) * 100)}%;"></div></div>
            </div>
        `).join('') : '<div class="admin-db-empty">No categories yet.</div>';
    }

    // Comments count + Registered Users count (live DB counts, non-blocking)
    supabaseClient.from('comments').select('*', { count: 'exact', head: true })
        .then(({ count, error }) => { if (!error) setAdminStat('adminStatComments', count || 0); });
    supabaseClient.from('profiles').select('*', { count: 'exact', head: true })
        .then(({ count, error }) => { if (!error) setAdminStat('adminStatUsers', count || 0); });

    // Alerts / Requests / Messages counts need their own fetch (not loaded until now)
    fetchLinkAlerts().then(() => setAdminStat('adminStatAlerts', Array.isArray(allLinkAlerts) ? allLinkAlerts.length : 0));
    fetchAdminRequests().then(() => setAdminStat('adminStatRequests', Array.isArray(allAdminRequests) ? allAdminRequests.length : 0));
    fetchAdminMessages().then(() => setAdminStat('adminStatMessages', Array.isArray(allAdminMessages) ? allAdminMessages.length : 0));
}

function setAdminStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// ---------- One-time wiring ----------

function setupAdminPanel() {
    const titleInput = document.getElementById('adminTitle');
    if (titleInput) {
        titleInput.addEventListener('input', function() {
            document.getElementById('adminSearchName').value = generateSearchNameFromTitle(this.value);
        });
    }

    const posterLinkInput = document.getElementById('adminPosterLink');
    if (posterLinkInput) posterLinkInput.addEventListener('input', updateAdminPosterPreview);

    const posterFileInput = document.getElementById('adminPosterFile');
    if (posterFileInput) {
        posterFileInput.addEventListener('change', function() {
            if (this.files && this.files[0]) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const prev = document.getElementById('adminPosterPreview');
                    const wrap = document.getElementById('adminPosterPreviewWrap');
                    if (prev && wrap) { prev.src = e.target.result; wrap.style.display = 'block'; }
                };
                reader.readAsDataURL(this.files[0]);
            }
        });
    }

    const mediaScanFileInput = document.getElementById('adminMediaScanFile');
    if (mediaScanFileInput) {
        mediaScanFileInput.addEventListener('change', function() {
            if (this.files && this.files[0]) {
                handleMediaScanFile(this.files[0]);
            }
        });
    }

    const adminSearchInput = document.getElementById('adminSearchInput');
    if (adminSearchInput) {
        adminSearchInput.addEventListener('input', function() {
            renderAdminDatabaseList(this.value.trim());
        });
    }

    const adminBannerSearchInput = document.getElementById('adminBannerSearchInput');
    if (adminBannerSearchInput) {
        adminBannerSearchInput.addEventListener('input', function() {
            renderAdminBannerList(this.value.trim());
        });
    }

    const adminCommentSearchInput = document.getElementById('adminCommentSearchInput');
    if (adminCommentSearchInput) {
        adminCommentSearchInput.addEventListener('input', function() {
            renderAdminCommentsList(this.value.trim());
        });
    }

    const adminRequestSearchInput = document.getElementById('adminRequestSearchInput');
    if (adminRequestSearchInput) {
        adminRequestSearchInput.addEventListener('input', function() {
            renderAdminRequestsList(this.value.trim());
        });
    }

    const newCategoryInput = document.getElementById('adminNewCategoryInput');
    if (newCategoryInput) {
        newCategoryInput.addEventListener('keyup', function(e) {
            if (e.key === 'Enter') addNewAdminCategory();
        });
    }

    const overlay = document.getElementById('adminOverlay');
    if (overlay) {
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) closeAdminPanel();
        });
    }
}

// ---------- Media Scan: Video (mkv/mp4) -> Audio & Subtitle Auto-Detect ----------
// ব্রাউজারেই (কোনো external server ছাড়া) ffmpeg.wasm দিয়ে ফাইলটা লোকালি স্ক্যান হয়,
// audio/subtitle এর ভাষা ডিটেক্ট করে Audio/Subtitles ফিল্ডে বসিয়ে দেয়। এরপর যখন
// এডমিন সাবমিট করে, ওই ফিল্ড দুটোর ভ্যালুই database এ save হয়ে যায় (আলাদা কিছু লাগে না)।

const MEDIA_SCAN_LANGUAGE_MAP = {
    en: 'English', eng: 'English',
    hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
    bn: 'Bangla', ben: 'Bangla', bangla: 'Bangla', bengali: 'Bangla',
    ta: 'Tamil', tam: 'Tamil', tamil: 'Tamil',
    te: 'Telugu', tel: 'Telugu', telugu: 'Telugu',
    ko: 'Korean', kor: 'Korean', korean: 'Korean',
    ja: 'Japanese', jpn: 'Japanese', japanese: 'Japanese',
    de: 'German', ger: 'German', deu: 'German', german: 'German',
    ar: 'Arabic', ara: 'Arabic', arabic: 'Arabic',
    cs: 'Czech', cze: 'Czech', ces: 'Czech', czech: 'Czech',
    ru: 'Russian', rus: 'Russian', russian: 'Russian',
    it: 'Italian', ita: 'Italian', italian: 'Italian',
    tr: 'Turkish', tur: 'Turkish', turkish: 'Turkish',
    ms: 'Malay', may: 'Malay', msa: 'Malay', malay: 'Malay',
    id: 'Indonesian', ind: 'Indonesian', indonesian: 'Indonesian',
    th: 'Thai', tha: 'Thai', thai: 'Thai',
    vi: 'Vietnamese', vie: 'Vietnamese', vietnamese: 'Vietnamese',
    pl: 'Polish', pol: 'Polish', polish: 'Polish',
    nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', dutch: 'Dutch',
    sv: 'Swedish', swe: 'Swedish', swedish: 'Swedish',
    no: 'Norwegian', nor: 'Norwegian', norwegian: 'Norwegian',
    nb: 'Norwegian (Norsk Bokmål)', nob: 'Norwegian (Norsk Bokmål)',
    da: 'Danish', dan: 'Danish', danish: 'Danish',
    fi: 'Finnish', fin: 'Finnish', finnish: 'Finnish',
    el: 'Greek', gre: 'Greek', ell: 'Greek', greek: 'Greek',
    he: 'Hebrew', heb: 'Hebrew', hebrew: 'Hebrew',
    hu: 'Hungarian', hun: 'Hungarian', hungarian: 'Hungarian',
    ro: 'Romanian', rum: 'Romanian', ron: 'Romanian', romanian: 'Romanian',
    uk: 'Ukrainian', ukr: 'Ukrainian', ukrainian: 'Ukrainian',
    fa: 'Persian', per: 'Persian', fas: 'Persian', persian: 'Persian',
    ur: 'Urdu', urd: 'Urdu', urdu: 'Urdu',
    pa: 'Punjabi', pan: 'Punjabi', punjabi: 'Punjabi',
    mr: 'Marathi', mar: 'Marathi', marathi: 'Marathi',
    gu: 'Gujarati', guj: 'Gujarati', gujarati: 'Gujarati',
    kn: 'Kannada', kan: 'Kannada', kannada: 'Kannada',
    ml: 'Malayalam', mal: 'Malayalam', malayalam: 'Malayalam',
    ne: 'Nepali', nep: 'Nepali', nepali: 'Nepali',
    si: 'Sinhala', sin: 'Sinhala', sinhala: 'Sinhala',
    hr: 'Croatian', hrv: 'Croatian', croatian: 'Croatian',
    sr: 'Serbian', srp: 'Serbian', serbian: 'Serbian',
    bg: 'Bulgarian', bul: 'Bulgarian', bulgarian: 'Bulgarian',
    sk: 'Slovak', slo: 'Slovak', slk: 'Slovak', slovak: 'Slovak',
    sl: 'Slovenian', slv: 'Slovenian', slovenian: 'Slovenian',
    lt: 'Lithuanian', lit: 'Lithuanian', lithuanian: 'Lithuanian',
    lv: 'Latvian', lav: 'Latvian', latvian: 'Latvian',
    et: 'Estonian', est: 'Estonian', estonian: 'Estonian',
    is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic', icelandic: 'Icelandic',
    tl: 'Filipino', fil: 'Filipino', filipino: 'Filipino', tagalog: 'Filipino',
    sw: 'Swahili', swa: 'Swahili', swahili: 'Swahili',
    af: 'Afrikaans', afr: 'Afrikaans', afrikaans: 'Afrikaans',
    am: 'Amharic', amh: 'Amharic', amharic: 'Amharic',
    so: 'Somali', som: 'Somali', somali: 'Somali',
    zu: 'Zulu', zul: 'Zulu', zulu: 'Zulu',
    xh: 'Xhosa', xho: 'Xhosa', xhosa: 'Xhosa',
    yo: 'Yoruba', yor: 'Yoruba', yoruba: 'Yoruba',
    ig: 'Igbo', ibo: 'Igbo', igbo: 'Igbo',
    ha: 'Hausa', hau: 'Hausa', hausa: 'Hausa',
    my: 'Burmese', bur: 'Burmese', mya: 'Burmese', burmese: 'Burmese',
    km: 'Khmer', khm: 'Khmer', khmer: 'Khmer',
    lo: 'Lao', lao: 'Lao',
    mn: 'Mongolian', mon: 'Mongolian', mongolian: 'Mongolian',
    kk: 'Kazakh', kaz: 'Kazakh', kazakh: 'Kazakh',
    uz: 'Uzbek', uzb: 'Uzbek', uzbek: 'Uzbek',
    az: 'Azerbaijani', aze: 'Azerbaijani', azerbaijani: 'Azerbaijani',
    ka: 'Georgian', geo: 'Georgian', kat: 'Georgian', georgian: 'Georgian',
    hy: 'Armenian', arm: 'Armenian', hye: 'Armenian', armenian: 'Armenian',
    sq: 'Albanian', alb: 'Albanian', sqi: 'Albanian', albanian: 'Albanian',
    mk: 'Macedonian', mac: 'Macedonian', mkd: 'Macedonian', macedonian: 'Macedonian',
    bs: 'Bosnian', bos: 'Bosnian', bosnian: 'Bosnian',
    mt: 'Maltese', mlt: 'Maltese', maltese: 'Maltese',
    cy: 'Welsh', wel: 'Welsh', cym: 'Welsh', welsh: 'Welsh',
    ga: 'Irish', gle: 'Irish', irish: 'Irish',
    eu: 'Basque', baq: 'Basque', eus: 'Basque', basque: 'Basque',
    ca: 'Catalan', cat: 'Catalan', catalan: 'Catalan',
    gl: 'Galician', glg: 'Galician', galician: 'Galician',
    und: 'Unknown',
    ht: 'Haitian Creole', hat: 'Haitian Creole',

    // ---- Spanish (es) — generic code + regional/locale variants ----
    es: 'Spanish', spa: 'Spanish', spanish: 'Spanish',
    'es-es': 'Spanish (Spain)', 'es-419': 'Spanish (Latin American)',
    'es-la': 'Spanish (Latin American)', 'es-mx': 'Spanish (Mexico)',
    'es-ar': 'Spanish (Argentina)', 'es-us': 'Spanish (US)',

    // ---- French (fr) — generic code + regional/locale variants ----
    fr: 'French', fre: 'French', fra: 'French', french: 'French',
    'fr-fr': 'French (France)', 'fr-ca': 'French (Canada)',
    'fr-be': 'French (Belgium)', 'fr-ch': 'French (Switzerland)',

    // ---- Portuguese (pt) — generic code + regional/locale variants ----
    pt: 'Portuguese', por: 'Portuguese', portuguese: 'Portuguese',
    'pt-br': 'Portuguese (Brazil)', 'pt-pt': 'Portuguese (Portugal)',

    // ---- Chinese (zh) — generic code + regional/script variants ----
    zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', chinese: 'Chinese',
    'zh-cn': 'Chinese (Simplified)', 'zh-sg': 'Chinese (Simplified)',
    'zh-hans': 'Chinese (Simplified)',
    'zh-tw': 'Chinese (Traditional)', 'zh-hk': 'Chinese (Traditional)',
    'zh-mo': 'Chinese (Traditional)', 'zh-hant': 'Chinese (Traditional)',
    // cmn (ISO 639-3) is specifically Mandarin — kept distinct from generic 'zh'/'Chinese'
    cmn: 'Mandarin', mandarin: 'Mandarin',
    yue: 'Cantonese', cantonese: 'Cantonese',

    // ---- English (en) — a few common locale variants ----
    'en-us': 'English (US)', 'en-gb': 'English (UK)',
    'en-au': 'English (Australia)', 'en-in': 'English (India)',

    // ---- German (de) / Italian (it) / Russian (ru) / Arabic (ar) locale variants ----
    'de-de': 'German (Germany)', 'de-at': 'German (Austria)', 'de-ch': 'German (Switzerland)',
    'it-it': 'Italian (Italy)', 'it-ch': 'Italian (Switzerland)',
    'ru-ru': 'Russian (Russia)',
    'ar-sa': 'Arabic (Saudi Arabia)', 'ar-eg': 'Arabic (Egypt)',

    la: 'Latin American'
};

// অনেক MKV uploader/muxer regional info একদম hyphenated code (es-LA) হিসেবে
// track title-এ রাখে না - বরং সাধারণ বর্ণনামূলক শব্দ রাখে, যেমন title="Latin American",
// "Spain", "Brazil", "Portugal", "Simplified", "Traditional"। এই লিস্টটা উপরের
// MEDIA_SCAN_LANGUAGE_MAP-এর প্রতিটা "Base (Qualifier)" ভ্যালু থেকে qualifier অংশটা
// আলাদা করে রাখে, যাতে base language code (spa/por/chi...) + title-এর শব্দ মিলিয়ে
// সঠিক regional label বানানো যায়।
const MEDIA_SCAN_REGIONAL_QUALIFIERS = (() => {
    const list = [];
    const seen = new Set();
    for (const key in MEDIA_SCAN_LANGUAGE_MAP) {
        const val = MEDIA_SCAN_LANGUAGE_MAP[key];
        const m = val.match(/^(.*) \(([^)]+)\)$/);
        if (m && !seen.has(val)) {
            seen.add(val);
            list.push({ base: m[1], qualifier: m[2].toLowerCase(), full: val });
        }
    }
    return list;
})();

function mediaScanResolveRegionalFromTitle(baseName, title) {
    if (!baseName || !title) return null;
    const t = title.toLowerCase().trim();
    if (!t) return null;
    for (const entry of MEDIA_SCAN_REGIONAL_QUALIFIERS) {
        if (entry.base !== baseName) continue;
        if (t === entry.qualifier || t.includes(entry.qualifier)) return entry.full;
    }
    return null;
}

let mediaScanFFmpegInstance = null;
let mediaScanFFmpegLoadingPromise = null;

function mediaScanGuessLanguageFromToken(token) {
    if (!token) return null;
    let norm = String(token).toLowerCase().trim();
    if (!norm) return null;

    // Some tools/filenames use underscores instead of hyphens for locale codes
    // (e.g. "pt_br" instead of "pt-br") — normalize before lookups below.
    norm = norm.replace(/_/g, '-');

    // 1. Exact match — covers plain codes (eng, spa, cmn...) as well as full
    //    region/locale codes like "es-es", "pt-br", "zh-tw", "fr-ca" etc.
    if (MEDIA_SCAN_LANGUAGE_MAP[norm]) return MEDIA_SCAN_LANGUAGE_MAP[norm];

    // 2. Primary-subtag fallback — if the exact region code isn't in the map
    //    (e.g. "es-cl", "zh-xx"), fall back to the base language before the
    //    hyphen ("es" -> Spanish, "pt" -> Portuguese, "zh" -> Chinese, ...).
    //    Note this never fires for codes like "cmn" (no hyphen), so Mandarin
    //    stays distinct from the generic "zh"/Chinese mapping.
    if (norm.includes('-')) {
        const primary = norm.split('-')[0];
        if (MEDIA_SCAN_LANGUAGE_MAP[primary]) return MEDIA_SCAN_LANGUAGE_MAP[primary];
    }

    // 3. Loose substring match against longer known keys (last resort, kept
    //    for odd/verbose tags that embed a language name somewhere in them).
    for (const key in MEDIA_SCAN_LANGUAGE_MAP) {
        if (key.length > 3 && norm.includes(key)) return MEDIA_SCAN_LANGUAGE_MAP[key];
    }
    return null;
}

async function mediaScanEnsureFFmpeg(onProgress) {
    if (mediaScanFFmpegInstance) return mediaScanFFmpegInstance;
    if (mediaScanFFmpegLoadingPromise) return mediaScanFFmpegLoadingPromise;
    mediaScanFFmpegLoadingPromise = (async () => {
        if (!window.FFmpeg || !window.FFmpeg.createFFmpeg) {
            throw new Error('Scan engine could not load (check your internet connection).');
        }
        if (onProgress) onProgress('Loading scan engine...');
        const { createFFmpeg } = window.FFmpeg;
        const ffmpeg = createFFmpeg({
            log: false,
            corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js'
        });
        await ffmpeg.load();
        mediaScanFFmpegInstance = ffmpeg;
        return ffmpeg;
    })();
    return mediaScanFFmpegLoadingPromise;
}

function mediaScanParseStreamLogs(lines) {
    const audio = new Set();
    const subtitle = new Set();
    const streamRe = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]+)\))?:\s*(Audio|Subtitle)/i;
    const metaLangRe = /^\s*language(-ietf)?\s*:\s*(\S+)/i;
    const metaTitleRe = /^\s*title\s*:\s*(.+?)\s*$/i;
    // মিলবে "es-LA", "pt-BR", "zh-TW" ইত্যাদি — কিন্তু কোয়ালিটি/কোডেক টোকেন
    // (যেমন "5.1", "AAC-LC") ভুলভাবে ধরা এড়াতে দ্বিতীয় অংশটাও letters-only রাখা হলো।
    const localeTokenRe = /\b([a-z]{2,3}-[a-z]{2,4})\b/gi;

    const audioTracks = [];
    const subtitleTracks = [];
    let current = null; // { kind, code (generic 639-2/639-1), ietf, title }

    function flush() {
        if (!current) return;
        (current.kind === 'audio' ? audioTracks : subtitleTracks).push(current);
        current = null;
    }

    lines.forEach(line => {
        const m = line.match(streamRe);
        if (m) {
            flush();
            const codeRaw = (m[1] || '').toLowerCase().trim();
            current = {
                kind: m[2].toLowerCase(),
                code: (codeRaw && codeRaw !== 'und') ? codeRaw : null,
                ietf: null,
                title: null
            };
            return;
        }
        if (!current) return;
        const lm = line.match(metaLangRe);
        if (lm) {
            const isIetf = !!lm[1];
            const val = (lm[2] || '').toLowerCase().trim();
            if (val && val !== 'und') {
                if (isIetf) current.ietf = val;
                else if (!current.code) current.code = val;
            }
            return;
        }
        const tm = line.match(metaTitleRe);
        if (tm) current.title = tm[1];
    });
    flush();

    // FFmpeg-এর demuxer আসলে Matroska-র নতুন LanguageIETF element পার্সই করে না
    // (এটা FFmpeg-এর নিজেরই একটা known limitation, ffmpeg.wasm-এর সীমাবদ্ধতা না) -
    // তাই es-LA/es-ES/pt-BR-এর মতো regional কোড কখনোই "language" মেটাডেটা লাইনে
    // আসে না। বাস্তব ফাইলে দেখা গেছে regional তথ্যটা track "title"-এ থাকে, তবে
    // hyphenated code হিসেবে না - সাধারণ বর্ণনামূলক শব্দ হিসেবে (title="Latin American",
    // "Spain", "Brazil", "Simplified"...)। তাই দুই ধাপে চেষ্টা করা হচ্ছে:
    // ১) title-এ সরাসরি hyphenated locale code (es-LA) থাকলে সেটা, ২) না থাকলে
    // base language + title-এর qualifier শব্দ মিলিয়ে regional label বানানো।
    function resolveTrack(t) {
        const baseName = mediaScanGuessLanguageFromToken(t.ietf || t.code);
        if (t.title) {
            const matches = t.title.match(localeTokenRe);
            if (matches) {
                for (const tok of matches) {
                    const name = mediaScanGuessLanguageFromToken(tok);
                    if (name) return name;
                }
            }
            const regional = mediaScanResolveRegionalFromTitle(baseName, t.title);
            if (regional) return regional;
        }
        return baseName;
    }

    audioTracks.forEach(t => { const n = resolveTrack(t); if (n) audio.add(n); });
    subtitleTracks.forEach(t => { const n = resolveTrack(t); if (n) subtitle.add(n); });

    return { audio: Array.from(audio), subtitle: Array.from(subtitle) };
}

// ffmpeg.wasm's own fetchFile() reads the whole file through the old
// FileReader API. On big movie files (or low-memory/mobile browsers) that
// read can silently fail with "File could not be read! Code=0" - FileReader
// throws a generic error with no real error code when it can't allocate the
// buffer. Reading the Blob natively via .arrayBuffer() uses the browser's
// streaming Blob pipeline instead and is far less likely to fail, and when
// it does fail it throws a real, more descriptive error.
async function mediaScanReadFileAsUint8Array(blob) {
    try {
        const buf = await blob.arrayBuffer();
        return new Uint8Array(buf);
    } catch (e) {
        throw new Error('Could not load the file into memory. It may be too large for in-browser scanning, or your browser/device ran out of memory. Try a smaller file, close other tabs, or scan from a desktop browser.');
    }
}

// Audio/subtitle track info lives in the container's header (EBML/Tracks
// element for MKV, moov atom for MP4) which sits at or near the start of the
// file - ffmpeg never needs to touch the actual video payload to list
// streams. So instead of loading the whole (possibly multi-GB) file into
// memory, we only read a leading chunk. This uses a tiny, fixed amount of
// memory no matter how large the source file is, which is what was actually
// causing "Could not load the file into memory" on big files. If nothing
// turns up in the first chunk (rare - e.g. unusually large embedded
// attachments/chapters before the Tracks element) we retry once with a
// bigger chunk before giving up.
const MEDIA_SCAN_CHUNK_BYTES = [64 * 1024 * 1024, 300 * 1024 * 1024]; // 64MB, then 300MB

// "-i file" (output ছাড়া) দিলে ffmpeg ইনপুটের সব স্ট্রিম ইনফো প্রিন্ট করা শেষ করেই এই
// লাইনটা দিয়ে error করে - মানে এই লাইনটা এলে বোঝা যায় হেডার সম্পূর্ণ পার্স হয়েছে,
// মাঝপথে কাটা পড়েনি।
const MEDIA_SCAN_HEADER_COMPLETE_RE = /at least one output file must be specified/i;

function mediaScanHeaderFullyParsed(logLines) {
    return logLines.some(l => MEDIA_SCAN_HEADER_COMPLETE_RE.test(l));
}

async function mediaScanProbeVideoFile(file, onProgress) {
    const ffmpeg = await mediaScanEnsureFFmpeg(onProgress);
    const extMatch = file.name.match(/\.[a-zA-Z0-9]+$/);
    const safeName = 'probe_input' + (extMatch ? extMatch[0] : '.mkv');

    let bestResult = { audio: [], subtitle: [] };

    for (let i = 0; i < MEDIA_SCAN_CHUNK_BYTES.length; i++) {
        const chunkBytes = MEDIA_SCAN_CHUNK_BYTES[i];
        const probeBlob = file.size > chunkBytes ? file.slice(0, chunkBytes) : file;

        if (onProgress) onProgress(i === 0 ? 'Reading file header into scanner...' : 'Header not found yet — reading a larger chunk...');

        const logLines = [];
        ffmpeg.setLogger(({ message }) => { if (message) logLines.push(message); });

        ffmpeg.FS('writeFile', safeName, await mediaScanReadFileAsUint8Array(probeBlob));

        if (onProgress) onProgress('Detecting audio & subtitle tracks...');
        try {
            await ffmpeg.run('-hide_banner', '-i', safeName);
        } catch (e) {
            // এখানে কোনো output file দেওয়া হয়নি বলে (এবং chunk-এ ফাইল কাটা থাকায়) ffmpeg error দেবে -
            // এটাই expected, কারণ error দেওয়ার আগেই স্ট্রিম ইনফো লগ হয়ে যায়।
        }
        try { ffmpeg.FS('unlink', safeName); } catch (e) {}

        const result = mediaScanParseStreamLogs(logLines);
        const foundSomething = result.audio.length > 0 || result.subtitle.length > 0;
        if (foundSomething) bestResult = result; // partial হলেও এখন পর্যন্ত পাওয়া সেরা ফলাফল রাখা হচ্ছে

        // শুধু "কিছু একটা পাওয়া গেছে" দেখেই থেমে যাওয়া যাবে না - বড় ফাইলে ছোট chunk-এ
        // audio ট্র্যাকগুলো পাওয়ার পরপরই chunk শেষ হয়ে যেতে পারে, তখন পরের subtitle
        // ট্র্যাকগুলো এখনও না-পড়া অবস্থায় থেকে যায় (ffmpeg header সম্পূর্ণ পড়ার আগেই
        // চাঙ্ক ফুরিয়ে যায় বলে ভিন্ন error দেয়) - ফলে সেই ফাইলের কিছু ভাষা মিস হয়ে
        // যেত, যদিও merge history-তে সেটাকে "সম্পূর্ণ স্ক্যান" ধরে নেওয়া হতো। তাই এখন
        // হেডার পুরোপুরি পার্স হয়েছে এটা নিশ্চিত না হলে (headerComplete) থামা হয় না -
        // পুরো ফাইল পড়া হয়ে গেলে বা এটাই শেষ/বড় chunk হলে যা পাওয়া গেছে তাই ফাইনাল।
        const headerComplete = mediaScanHeaderFullyParsed(logLines);
        if ((foundSomething && headerComplete) || probeBlob === file || i === MEDIA_SCAN_CHUNK_BYTES.length - 1) {
            return foundSomething ? result : bestResult;
        }
    }
    return bestResult;
}

function mediaScanFormatList(list) {
    const clean = list.filter(Boolean);
    if (clean.length === 0) return '';
    return `(${clean.length})- ${clean.join(', ')}`;
}

// অ্যাডমিন যদি পেজ রিফ্রেশ না করে একের পর এক একাধিক ফাইল (যেমন: আলাদা আলাদা সিজন)
// স্ক্যান করে, তাহলে প্রতিটা স্ক্যানের audio/subtitle রেজাল্ট এখানে জমা থাকে। নতুন
// স্ক্যান হলে আগের ফলাফল মুছে না গিয়ে সব স্ক্যানের ইউনিক ভাষাগুলো একসাথে মার্জ হয়ে
// Audio/Subtitles ফিল্ডে বসে - যে ভাষাগুলো সবগুলো ফাইলে নেই (কোনো একটাতে/কয়েকটাতে
// আছে), সেগুলোর পাশে কোন স্ক্যান নাম্বারে পাওয়া গেছে সেটা "(S01,02 Only)" স্টাইলে
// ট্যাগ হয়ে বাকি ভাষাগুলোর সাথেই বসে যায়। resetAdminForm() / নতুন এডিট ওপেন করলে
// এই হিস্ট্রি খালি হয়ে যায়, যাতে ভিন্ন ভিন্ন কনটেন্টের স্ক্যান একসাথে মিশে না যায়।
let mediaScanHistory = [];

function mediaScanResetHistory() {
    mediaScanHistory = [];
}

// কতগুলো ফাইল স্ক্যান করা হবে তার কোনো লিমিট নেই (২টা সিজন না, ২০+ সিজন প্যাকও
// হতে পারে) - তাই এখানে "S01,02" স্টাইলে ফিক্সড ফরম্যাটের বদলে "/" দিয়ে জোড়া লাগানো
// প্লেইন নাম্বার ব্যবহার করা হয় (যেমন: 12/20/21/27)। স্ক্যান সংখ্যা বেশি হয়ে গেলে
// ট্যাগ যেন বিশাল লম্বা না হয়ে যায়, তাই MEDIA_SCAN_TAG_MAX_SHOWN-এর বেশি হলে বাকিগুলো
// ".." দিয়ে সংক্ষেপ করে দেখানো হয়।
const MEDIA_SCAN_TAG_MAX_SHOWN = 4;

function mediaScanFormatScanTag(scanNums) {
    const sorted = Array.from(scanNums).sort((a, b) => a - b);
    const shown = sorted.slice(0, MEDIA_SCAN_TAG_MAX_SHOWN).map(n => String(n).padStart(2, '0'));
    const truncated = sorted.length > MEDIA_SCAN_TAG_MAX_SHOWN ? '..' : '';
    return `(${shown.join('/')}${truncated} Only)`;
}

// একাধিক স্ক্যানের ফলাফল মিলিয়ে একটাই ইউনিক লিস্ট বানায়। প্রতিটা আইটেম কোন কোন
// স্ক্যানে (1-indexed) পাওয়া গেছে সেটা ট্র্যাক করে - সব স্ক্যানে থাকলে ট্যাগ ছাড়া,
// নাহলে "Only" ট্যাগসহ বসে। প্রথমবার যে ক্রমে ভাষাগুলো পাওয়া গেছে সেই ক্রমই বজায় থাকে।
function mediaScanMergeHistory(historyKey) {
    const totalScans = mediaScanHistory.length;
    if (totalScans === 0) return { labels: [], count: 0, commonCount: 0 };

    const presence = new Map(); // item -> Set(scanNum)
    mediaScanHistory.forEach((scan, idx) => {
        const scanNum = idx + 1;
        (scan[historyKey] || []).forEach(item => {
            if (!presence.has(item)) presence.set(item, new Set());
            presence.get(item).add(scanNum);
        });
    });

    let commonCount = 0;
    const labels = Array.from(presence.entries()).map(([item, scanSet]) => {
        const isCommon = scanSet.size === totalScans;
        if (isCommon) { commonCount++; return item; }
        return `${item} ${mediaScanFormatScanTag(scanSet)}`;
    });

    return { labels, count: labels.length, commonCount };
}

function mediaScanFormatMergedList(historyKey) {
    const { labels, count, commonCount } = mediaScanMergeHistory(historyKey);
    if (labels.length === 0) return '';
    // সব স্ক্যানে যদি কোনো অমিল না থাকে (সবগুলো ভাষাই সব ফাইলে কমন), তাহলে আগের
    // মতোই সাধারণ "(count)-" ফরম্যাট দেখাবে। "total/common" রেশিও শুধু তখনই দেখাবে
    // যখন সত্যিই কোনো ভাষা এক বা কয়েকটা ফাইলে "Only" ট্যাগ নিয়ে আলাদা পড়ে আছে।
    if (count === commonCount) return `(${count})- ${labels.join(', ')}`;
    return `(${count}/${commonCount})- ${labels.join(', ')}`;
}

async function handleMediaScanFile(file) {
    const statusEl = document.getElementById('adminMediaScanStatus');
    const resultEl = document.getElementById('adminMediaScanResult');
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }

    const setStatus = (msg, mode) => {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.className = 'admin-media-scan-status' + (mode ? ' admin-media-scan-' + mode : '');
    };

    const isSupported = /\.(mkv|mp4)$/i.test(file.name);
    if (!isSupported) {
        setStatus('Only .mkv or .mp4 files are supported for scanning.', 'error');
        return;
    }

    const bigFileWarnBytes = 2 * 1024 * 1024 * 1024;
    if (file.size > bigFileWarnBytes) {
        setStatus(`Large file (${(file.size / (1024 * 1024 * 1024)).toFixed(2)}GB) — scanning just the file header, this should still be quick...`);
    } else {
        setStatus('Starting scan...');
    }

    try {
        const result = await mediaScanProbeVideoFile(file, setStatus);

        if (result.audio.length === 0 && result.subtitle.length === 0) {
            setStatus('No audio or subtitle language tags were detected in this file.', 'error');
            return;
        }

        // এই ফাইলের রেজাল্ট আগের স্ক্যানগুলোর সাথে যোগ হলো (ওভাররাইট না করে) -
        // পেজ রিফ্রেশ না করা পর্যন্ত এই হিস্ট্রি জমা থাকতে থাকবে।
        mediaScanHistory.push({ audio: result.audio, subtitle: result.subtitle });

        const audioStr = mediaScanFormatMergedList('audio');
        const subStr = mediaScanFormatMergedList('subtitle');

        const audioInput = document.getElementById('adminAudio');
        const subInput = document.getElementById('adminSubtitles');
        if (audioStr && audioInput) audioInput.value = audioStr;
        if (subStr && subInput) subInput.value = subStr;

        if (resultEl) {
            resultEl.style.display = 'grid';
            resultEl.innerHTML = `
                <div class="admin-media-scan-pill">${escapeAttr(audioStr || 'No audio tracks detected')}</div>
                <div class="admin-media-scan-pill">${escapeAttr(subStr || 'No subtitles detected')}</div>
            `;
        }

        const mergeNote = mediaScanHistory.length > 1 ? ` (merged from ${mediaScanHistory.length} files scanned)` : '';
        setStatus(`Scan complete — Audio and Subtitles fields updated${mergeNote}.`, 'ok');
    } catch (err) {
        console.error('Media scan failed:', err);
        setStatus('Scan failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
    }
}

// ---------- Title -> Search Name (বছর বাদ দিয়ে) ----------

function generateSearchNameFromTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*\(\d{4}\)\s*$/, '')   // "Inception (2010)" -> "Inception"
        .replace(/\s+\d{4}\s*$/, '')       // "Inception 2010"   -> "Inception"
        .trim();
}

// ---------- Category management ----------

function getAllKnownCategories() {
    const set = new Set();
    if (Array.isArray(allMovies)) {
        allMovies.forEach(m => {
            const cats = Array.isArray(m.category) ? m.category : (m.category ? String(m.category).split('|') : []);
            cats.forEach(c => { const cc = c.trim(); if (cc && cc !== 'all') set.add(cc); });
        });
    }
    adminExtraCategories.forEach(c => set.add(c));
    return Array.from(set).sort();
}

function renderAdminCategoryBox() {
    const box = document.getElementById('adminCategoryBox');
    if (!box) return;
    box.innerHTML = '';
    const cats = getAllKnownCategories();

    if (cats.length === 0) {
        box.innerHTML = '<span style="color:#64748b;font-size:12px;">No categories yet — add one below.</span>';
        return;
    }

    cats.forEach(cat => {
        const pill = document.createElement('div');
        pill.className = 'admin-category-pill' + (adminSelectedCategories.has(cat) ? ' selected' : '');
        pill.textContent = cat;
        pill.onclick = function() {
            if (adminSelectedCategories.has(cat)) adminSelectedCategories.delete(cat);
            else adminSelectedCategories.add(cat);
            renderAdminCategoryBox();
        };
        box.appendChild(pill);
    });
}

function slugifyCategory(name) {
    return String(name).toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}

function addNewAdminCategory() {
    const input = document.getElementById('adminNewCategoryInput');
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) return;
    const slug = normalizeCategorySlug(slugifyCategory(raw));
    if (!slug) return;
    adminExtraCategories.add(slug);
    adminSelectedCategories.add(slug);
    input.value = '';
    renderAdminCategoryBox();
    saveNewCategoryToDb(slug);
}

// ---------- TMDB Type / Poster mode toggles ----------

function selectTmdbType(value) {
    adminTmdbType = value;
    document.querySelectorAll('#adminTmdbTypeGroup .admin-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });
    const movieField = document.getElementById('adminMovieLinksField');
    const seasonsField = document.getElementById('adminSeasonsField');
    if (movieField) movieField.style.display = value === 'movie' ? 'flex' : 'none';
    if (seasonsField) seasonsField.style.display = value === 'tv' ? 'flex' : 'none';
}

function setPosterMode(mode) {
    adminPosterMode = mode;
    document.querySelectorAll('#adminPosterModeGroup .admin-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === mode);
    });
    const linkInput = document.getElementById('adminPosterLink');
    const fileInput = document.getElementById('adminPosterFile');
    if (linkInput) linkInput.style.display = mode === 'link' ? 'block' : 'none';
    if (fileInput) fileInput.style.display = mode === 'file' ? 'block' : 'none';
}

function updateAdminPosterPreview() {
    const linkInput = document.getElementById('adminPosterLink');
    const prev = document.getElementById('adminPosterPreview');
    const wrap = document.getElementById('adminPosterPreviewWrap');
    if (!linkInput || !prev || !wrap) return;
    const link = linkInput.value.trim();
    if (link) {
        prev.src = link;
        wrap.style.display = 'block';
    } else {
        wrap.style.display = 'none';
    }
}

// ---------- Movie download link rows ----------

// ---------- Movie download link rows ----------

function addMovieLinkRow(data) {
    data = data || {};
    const list = document.getElementById('adminMovieLinksList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'admin-link-row';

    row.innerHTML = `
        <input type="text" class="admin-link-url" placeholder="Download link" value="${escapeAttr(data.link)}">
        <input type="text" class="admin-link-size" placeholder="Size (e.g. 1.2GB)" value="${escapeAttr(data.size)}">
        <button type="button" class="admin-row-remove-btn" onclick="this.closest('.admin-link-row').remove()">✕</button>
    `;
    list.appendChild(row);
}

// ---------- Collect form data ----------

function collectMovieLinks() {
    const rows = document.querySelectorAll('#adminMovieLinksList .admin-link-row');
    const result = [];
    rows.forEach(row => {
        const link = row.querySelector('.admin-link-url').value.trim();
        if (!link) return;
        const size = row.querySelector('.admin-link-size').value.trim();
        
        const label = size ? `Download Link 720p [${size}]` : 'Download Link 720p';
        result.push({ label, link, size });
    });
    return result;
}

// ---------- TMDB Type Select Logic (Auto 720p Auto-fill) ----------

function selectTmdbType(value) {
    adminTmdbType = value;
    document.querySelectorAll('#adminTmdbTypeGroup .admin-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-value') === value);
    });
    const movieField = document.getElementById('adminMovieLinksField');
    const seasonsField = document.getElementById('adminSeasonsField');
    if (movieField) movieField.style.display = value === 'movie' ? 'flex' : 'none';
    if (seasonsField) seasonsField.style.display = value === 'tv' ? 'flex' : 'none';

    if (value === 'movie') {
        const list = document.getElementById('adminMovieLinksList');
        if (list && list.children.length === 0) {
            addMovieLinkRow();
        }
    }
}

// ---------- Season blocks (TV) ----------

function addSeasonBlock(data) {
    data = data || {};
    const list = document.getElementById('adminSeasonsList');
    if (!list) return;
    const block = document.createElement('div');
    block.className = 'admin-season-block';
    
    const defaultLabel = data.label || `Season ${list.children.length + 1} Complete 720p`;
    
    block.innerHTML = `
        <div class="admin-season-header">
            <input type="text" class="admin-season-label" value="${escapeAttr(defaultLabel)}">
            <button type="button" class="admin-row-remove-btn" onclick="this.closest('.admin-season-block').remove()">✕ Remove Season</button>
        </div>
        <div class="admin-season-links"></div>
        <button type="button" class="admin-add-row-btn admin-add-season-link-btn">+ Add File Link</button>
    `;
    list.appendChild(block);

    const linksContainer = block.querySelector('.admin-season-links');
    const addBtn = block.querySelector('.admin-add-season-link-btn');
    addBtn.addEventListener('click', () => addSeasonLinkRow(linksContainer));

    if (Array.isArray(data.items) && data.items.length > 0) {
        data.items.forEach(it => addSeasonLinkRow(linksContainer, it));
    } else {
        addSeasonLinkRow(linksContainer);
    }
}

function addSeasonLinkRow(container, data) {
    data = data || {};
    const row = document.createElement('div');
    row.className = 'admin-link-row';
    row.innerHTML = `
        <input type="text" class="admin-link-url" placeholder="Download link" value="${escapeAttr(data.link)}">
        <input type="text" class="admin-link-size" placeholder="Size (e.g. 350MB)" value="${escapeAttr(data.size)}">
        <button type="button" class="admin-row-remove-btn" onclick="this.closest('.admin-link-row').remove()">✕</button>
    `;
    container.appendChild(row);
}

function escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;');
}

// download history তে সেভ করার জন্য লিংক-লেবেলটাকে HTML attribute + inline JS string — দুই জায়গাতেই নিরাপদভাবে বসানোর জন্য
function jsAttrStr(str) {
    const jsSafe = String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return escapeAttr(jsSafe);
}

function collectSeasons() {
    const blocks = document.querySelectorAll('#adminSeasonsList .admin-season-block');
    const result = [];
    blocks.forEach((block, idx) => {
        const labelInput = block.querySelector('.admin-season-label');
        
        const label = (labelInput.value.trim()) || `Season ${idx + 1} Complete 720p`;
        
        const items = [];
        block.querySelectorAll('.admin-season-links .admin-link-row').forEach(row => {
            const link = row.querySelector('.admin-link-url').value.trim();
            if (!link) return;
            const size = row.querySelector('.admin-link-size').value.trim();
            items.push({ link, size });
        });
        if (items.length > 0) result.push({ label, season: idx + 1, items });
    });
    return result;
}

function extractTmdbIdFromInput(input) {
    if (!input) return null;
    const linkMatch = String(input).match(/\/(movie|tv)\/(\d+)/);
    if (linkMatch) return linkMatch[2];
    const numMatch = String(input).match(/\d+/);
    return numMatch ? numMatch[0] : null;
}

// ---------- Poster upload (Supabase Storage) ----------

async function uploadPosterFile(file) {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `poster_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;

    const { error } = await supabaseClient.storage.from(ADMIN_POSTER_BUCKET).upload(fileName, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined
    });

    if (error) {
        // Surface the real Supabase error instead of a silent/generic failure so the
        // actual cause (missing bucket, RLS policy, etc.) is visible to the admin.
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('bucket not found')) {
            throw new Error(`Storage bucket "${ADMIN_POSTER_BUCKET}" does not exist in Supabase. Create it under Storage → New Bucket and mark it Public.`);
        }
        if (msg.includes('row-level security') || msg.includes('policy') || msg.includes('permission') || msg.includes('unauthorized')) {
            throw new Error(`Upload blocked by Supabase Storage policy. Add an INSERT policy for the "${ADMIN_POSTER_BUCKET}" bucket that allows the anon/public role to upload.`);
        }
        throw error;
    }

    const { data } = supabaseClient.storage.from(ADMIN_POSTER_BUCKET).getPublicUrl(fileName);
    if (!data || !data.publicUrl) {
        throw new Error('Upload succeeded but no public URL was returned. Check that the bucket is set to Public.');
    }
    return data.publicUrl;
}

// Quick check that an uploaded poster URL is actually reachable (bucket public + object exists).
// If this fails it almost always means the bucket is Private or missing a public SELECT policy.
function verifyPosterUrlReachable(url) {
    return new Promise((resolve) => {
        if (!url) { resolve(false); return; }
        const testImg = new Image();
        testImg.onload = () => resolve(true);
        testImg.onerror = () => resolve(false);
        testImg.src = url;
    });
}

// ---------- Reset / Load into form ----------

function resetAdminForm() {
    document.getElementById('adminEditingId').value = '';
    document.getElementById('adminTitle').value = '';
    document.getElementById('adminSearchName').value = '';
    document.getElementById('adminImdbId').value = '';
    document.getElementById('adminTmdbId').value = '';
    document.getElementById('adminAudio').value = '';
    document.getElementById('adminSubtitles').value = '';
    document.getElementById('adminPosterLink').value = '';
    const fileInput = document.getElementById('adminPosterFile');
    if (fileInput) fileInput.value = '';
    updateAdminPosterPreview();
    setPosterMode('link');

    const mediaScanFileInput = document.getElementById('adminMediaScanFile');
    if (mediaScanFileInput) mediaScanFileInput.value = '';
    const mediaScanStatus = document.getElementById('adminMediaScanStatus');
    if (mediaScanStatus) { mediaScanStatus.textContent = ''; mediaScanStatus.className = 'admin-media-scan-status'; }
    const mediaScanResult = document.getElementById('adminMediaScanResult');
    if (mediaScanResult) { mediaScanResult.style.display = 'none'; mediaScanResult.innerHTML = ''; }
    mediaScanResetHistory();

    adminSelectedCategories = new Set();
    renderAdminCategoryBox();

    selectTmdbType('movie');

    document.getElementById('adminMovieLinksList').innerHTML = '';
    document.getElementById('adminSeasonsList').innerHTML = '';
    addMovieLinkRow();

    document.getElementById('adminSubmitBtn').textContent = 'Add Content';
    document.getElementById('adminCancelEditBtn').style.display = 'none';

    const msgEl = document.getElementById('adminFormMsg');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'admin-form-msg'; }
}

function loadMovieIntoAdminForm(movie) {
    switchAdminTab('add');
    mediaScanResetHistory();

    document.getElementById('adminEditingId').value = movie.id;
    document.getElementById('adminTitle').value = movie.title || '';
    document.getElementById('adminSearchName').value = movie.searchName || generateSearchNameFromTitle(movie.title || '');
    document.getElementById('adminImdbId').value = movie.imdbId || '';
    document.getElementById('adminTmdbId').value = movie.tmdbId || '';
    document.getElementById('adminAudio').value = movie.languages || '';
    document.getElementById('adminSubtitles').value = movie.Subtitles || movie.subtitles || '';

    adminSelectedCategories = new Set(
        Array.isArray(movie.category) ? movie.category : (movie.category ? String(movie.category).split('|').map(s => s.trim()).filter(Boolean) : [])
    );
    renderAdminCategoryBox();

    selectTmdbType(movie.tmdbType === 'tv' ? 'tv' : 'movie');

    setPosterMode('link');
    document.getElementById('adminPosterLink').value = movie.poster || '';
    updateAdminPosterPreview();

    document.getElementById('adminMovieLinksList').innerHTML = '';
    document.getElementById('adminSeasonsList').innerHTML = '';

    const blocks = Array.isArray(movie.downloadBlocks) ? movie.downloadBlocks : [];
    if (movie.tmdbType === 'tv') {
        if (blocks.length > 0) {
            blocks.forEach(sec => {
                addSeasonBlock({
                    label: sec.label,
                    items: Array.isArray(sec.items) ? sec.items : (sec.link ? [{ link: sec.link, size: sec.size || '' }] : [])
                });
            });
        } else {
            addSeasonBlock();
        }
    } else {
        if (blocks.length > 0) {
            blocks.forEach(sec => addMovieLinkRow({ label: sec.label || '', link: sec.link || '', size: sec.size || '' }));
        } else {
            addMovieLinkRow();
        }
    }

    document.getElementById('adminSubmitBtn').textContent = 'Update Content';
    document.getElementById('adminCancelEditBtn').style.display = 'block';

    const msgEl = document.getElementById('adminFormMsg');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'admin-form-msg'; }

    const panelBody = document.querySelector('.admin-panel-body');
    if (panelBody) panelBody.scrollTop = 0;
}

// ---------- Submit (Add / Update) ----------

async function submitAdminContent() {
    const msgEl = document.getElementById('adminFormMsg');
    msgEl.textContent = '';
    msgEl.className = 'admin-form-msg';

    const title = document.getElementById('adminTitle').value.trim();
    if (!title) {
        msgEl.textContent = 'Title লেখা আবশ্যক (Title is required).';
        msgEl.className = 'admin-form-msg error';
        return;
    }

    const searchName = document.getElementById('adminSearchName').value.trim() || generateSearchNameFromTitle(title);
    const categories = Array.from(adminSelectedCategories);
    const imdbRaw = document.getElementById('adminImdbId').value.trim();
    const tmdbRaw = document.getElementById('adminTmdbId').value.trim();
    const imdbId = extractImdbId(imdbRaw) || (imdbRaw || null);
    const tmdbId = extractTmdbIdFromInput(tmdbRaw);
    const audio = document.getElementById('adminAudio').value.trim();
    const subtitles = document.getElementById('adminSubtitles').value.trim();

    const submitBtn = document.getElementById('adminSubmitBtn');
    const editingId = document.getElementById('adminEditingId').value;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
        let posterUrl = document.getElementById('adminPosterLink').value.trim() || null;
        if (adminPosterMode === 'file') {
            const fileInput = document.getElementById('adminPosterFile');
            if (fileInput && fileInput.files && fileInput.files[0]) {
                submitBtn.textContent = 'Uploading poster...';
                posterUrl = await uploadPosterFile(fileInput.files[0]);

                const reachable = await verifyPosterUrlReachable(posterUrl);
                if (!reachable) {
                    throw new Error(
                        'Poster uploaded to Storage, but the public URL is not loading in the browser. ' +
                        'This means the "' + ADMIN_POSTER_BUCKET + '" bucket is Private or missing a public read policy. ' +
                        'Go to Supabase → Storage → posters → make the bucket Public (or add a public SELECT policy), then try again.'
                    );
                }
                submitBtn.textContent = 'Saving...';
            }
        }

        const downloadBlocks = (adminTmdbType === 'tv') ? collectSeasons() : collectMovieLinks();

        const payload = {
            title: title,
            searchName: searchName,
            category: categories.join('|'),
            imdbId: imdbId,
            tmdbId: tmdbId,
            tmdbType: adminTmdbType,
            languages: audio,
            Subtitles: subtitles,
            poster: posterUrl,
            downloadBlocks: JSON.stringify(downloadBlocks)
        };

        let error;
        if (editingId) {
            ({ error } = await supabaseClient.from('movies').update(payload).eq('id', editingId));
        } else {
            ({ error } = await supabaseClient.from('movies').insert([payload]));
        }

        if (error) throw error;

        msgEl.textContent = editingId ? '✅ Content updated successfully!' : '✅ Content added successfully!';
        msgEl.className = 'admin-form-msg success';

        await fetchMoviesFromSupabase();
        const adminSearchInput = document.getElementById('adminSearchInput');
        renderAdminDatabaseList(adminSearchInput ? adminSearchInput.value.trim() : '');
        resetAdminForm();

    } catch (err) {
        console.error('Admin submit error:', err);
        msgEl.textContent = '❌ Error: ' + (err && err.message ? err.message : 'Failed to save content.');
        msgEl.className = 'admin-form-msg error';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = document.getElementById('adminEditingId').value ? 'Update Content' : 'Add Content';
    }
}

// ---------- Manage / Database list ----------

// Poster cache for the admin database list thumbnails (avoids refetching on every search keystroke)
const adminPosterCache = {};

async function fetchTmdbPosterQuick(movie) {
    if (!TMDB_API_KEY) return null;

    const cacheKey = movie.id ?? movie.tmdbId ?? movie.imdbId ?? movie.searchName ?? movie.title;
    if (cacheKey !== undefined && adminPosterCache.hasOwnProperty(cacheKey)) {
        return adminPosterCache[cacheKey];
    }

    let posterUrl = null;
    try {
        const mediaType = movie.tmdbType === 'tv' ? 'tv' : 'movie';
        let matchId = movie.tmdbId || null;
        const cleanImdbId = extractImdbId(movie.imdbId);

        if (!matchId && cleanImdbId) {
            const findRes = await fetchWithTimeout(`${TMDB_BASE_URL}/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 2500);
            if (findRes.ok) {
                const findData = await findRes.json();
                const hit = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
                if (hit) {
                    matchId = hit.id;
                    if (hit.poster_path) posterUrl = `https://image.tmdb.org/t/p/w92${hit.poster_path}`;
                }
            }
        }

        if (!posterUrl && matchId) {
            const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${mediaType}/${matchId}?api_key=${TMDB_API_KEY}`, {}, 2500);
            if (detailRes.ok) {
                const detailData = await detailRes.json();
                if (detailData.poster_path) posterUrl = `https://image.tmdb.org/t/p/w92${detailData.poster_path}`;
            }
        }

        if (!posterUrl && !matchId && (movie.title || movie.searchName)) {
            const cleanQuery = (movie.searchName || movie.title).replace(/\s*\([\d\-]+\)/g, '').trim();
            const searchRes = await fetchWithTimeout(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}`, {}, 2500);
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                if (searchData && searchData.results && searchData.results.length > 0) {
                    const match = searchData.results.find(item => item.media_type === 'movie' || item.media_type === 'tv') || searchData.results[0];
                    if (match.poster_path) posterUrl = `https://image.tmdb.org/t/p/w92${match.poster_path}`;
                }
            }
        }

        // TMDB-e kono match/poster na paile, IMDb ID (othoba title) diye OMDb-o try koro
        if (!posterUrl && (cleanImdbId || movie.title || movie.searchName)) {
            const omdbQuery = cleanImdbId
                ? `i=${encodeURIComponent(cleanImdbId)}`
                : `t=${encodeURIComponent((movie.searchName || movie.title).replace(/\s*\([\d\-]+\)/g, '').trim())}`;
            const omdbRes = await fetchWithTimeout(`https://www.omdbapi.com/?${omdbQuery}&apikey=${OMDB_API_KEY}`, {}, 2500);
            if (omdbRes.ok) {
                const omdbData = await omdbRes.json();
                if (omdbData && omdbData.Response === "True" && omdbData.Poster && omdbData.Poster !== "N/A") {
                    posterUrl = omdbData.Poster;
                }
            }
        }
    } catch (err) {
        console.warn('TMDB poster quick-fetch failed for', movie.title, err);
    }

    if (cacheKey !== undefined) adminPosterCache[cacheKey] = posterUrl;
    return posterUrl;
}

function renderAdminDatabaseList(filter) {
    const container = document.getElementById('adminDatabaseList');
    if (!container) return;
    container.innerHTML = '';

    const q = (filter || '').toLowerCase().trim();
    const source = Array.isArray(allMovies) ? allMovies : [];
    const filtered = q ? source.filter(m => {
        const t = (m.title || '').toLowerCase();
        const sn = (m.searchName || '').toLowerCase();
        return t.includes(q) || sn.includes(q);
    }) : source;

    if (filtered.length === 0) {
        // movies data এখনো Supabase থেকে লোড হয়নি (page refresh এর ঠিক পরপর) —
        // তখন "No content found" না দেখিয়ে loading দেখাও, data চলে আসলে আবার রেন্ডার হবে
        container.innerHTML = moviesDataLoaded
            ? '<div class="admin-db-empty">No content found.</div>'
            : '<div class="admin-db-empty">Loading content...</div>';
        return;
    }

    filtered.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const cats = Array.isArray(movie.category) ? movie.category.join(', ') : (movie.category || '');
        const typeLabel = movie.tmdbType === 'tv' ? 'TV Series' : 'Movie';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-db-title">${movie.title || 'Untitled'}</div>
                <div class="admin-db-meta">${typeLabel} · ${cats || 'No category'}</div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-edit-btn">Edit</button>
                <button type="button" class="admin-db-delete-btn">Delete</button>
            </div>
        `;
        card.querySelector('.admin-db-edit-btn').addEventListener('click', () => loadMovieIntoAdminForm(movie));
        card.querySelector('.admin-db-delete-btn').addEventListener('click', () => deleteMovieToTrash(movie));
        container.appendChild(card);

        // No poster saved manually — auto-fetch a small poster thumbnail from TMDB
        if (!movie.poster) {
            const imgEl = card.querySelector('.admin-db-thumb');
            fetchTmdbPosterQuick(movie).then(url => {
                if (url && imgEl && imgEl.isConnected) {
                    imgEl.src = url;
                }
            });
        }
    });
}

// ---------- Hero Banner tab (choose which titles show in the homepage auto-slide banner) ----------

function getFeaturedSortedMovies() {
    const source = Array.isArray(allMovies) ? allMovies : [];
    return source
        .filter(m => m.featured === true)
        .sort((a, b) => (a.featured_order ?? 999) - (b.featured_order ?? 999));
}

function renderAdminBannerList(filter) {
    const container = document.getElementById('adminBannerList');
    if (!container) return;
    container.innerHTML = '';

    const q = (filter || '').toLowerCase().trim();
    const source = Array.isArray(allMovies) ? allMovies : [];
    const filtered = q ? source.filter(m => {
        const t = (m.title || '').toLowerCase();
        const sn = (m.searchName || '').toLowerCase();
        return t.includes(q) || sn.includes(q);
    }) : source;

    if (filtered.length === 0) {
        container.innerHTML = moviesDataLoaded
            ? '<div class="admin-db-empty">No content found.</div>'
            : '<div class="admin-db-empty">Loading content...</div>';
        return;
    }

    // যেগুলো এখন banner-এ featured আছে সেগুলো order অনুযায়ী উপরে, বাকিগুলো নিচে
    const sorted = [...filtered].sort((a, b) => {
        const af = a.featured === true, bf = b.featured === true;
        if (af && !bf) return -1;
        if (!af && bf) return 1;
        if (af && bf) return (a.featured_order ?? 999) - (b.featured_order ?? 999);
        return 0;
    });

    const featuredList = getFeaturedSortedMovies();

    sorted.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-banner-card';
        const typeLabel = movie.tmdbType === 'tv' ? 'TV Series' : 'Movie';
        const isFeatured = movie.featured === true;
        const posIndex = isFeatured ? featuredList.findIndex(m => m.id === movie.id) : -1;
        const posLabel = posIndex >= 0 ? `#${posIndex + 1}` : '';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-db-title">${escapeHtml(movie.title || 'Untitled')}</div>
                <div class="admin-db-meta">${typeLabel}</div>
                <div class="admin-banner-fields">
                    <label class="admin-banner-toggle">
                        <input type="checkbox" class="admin-banner-featured-cb" ${isFeatured ? 'checked' : ''}>
                        <span>Show in Banner</span>
                    </label>
                    ${isFeatured ? `
                    <span class="admin-banner-position">${posLabel}</span>
                    <button type="button" class="admin-banner-move-btn" data-dir="up" ${posIndex <= 0 ? 'disabled' : ''} title="Move earlier">▲</button>
                    <button type="button" class="admin-banner-move-btn" data-dir="down" ${posIndex >= featuredList.length - 1 ? 'disabled' : ''} title="Move later">▼</button>
                    ` : ''}
                    <input type="text" class="admin-banner-image-input" placeholder="Custom banner image URL (optional — overrides TMDB backdrop)" value="${movie.featured_image || ''}">
                </div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-mini-btn admin-banner-save-btn">Save</button>
            </div>
        `;
        card.querySelector('.admin-banner-save-btn').addEventListener('click', () => {
            const cb = card.querySelector('.admin-banner-featured-cb');
            const imageInput = card.querySelector('.admin-banner-image-input');
            saveBannerSettings(movie, {
                featured: cb.checked,
                featured_image: imageInput.value.trim() || null
            });
        });
        const upBtn = card.querySelector('.admin-banner-move-btn[data-dir="up"]');
        const downBtn = card.querySelector('.admin-banner-move-btn[data-dir="down"]');
        if (upBtn) upBtn.addEventListener('click', () => moveBannerItem(movie, -1));
        if (downBtn) downBtn.addEventListener('click', () => moveBannerItem(movie, 1));
        container.appendChild(card);

        if (!movie.poster) {
            const imgEl = card.querySelector('.admin-db-thumb');
            fetchTmdbPosterQuick(movie).then(url => {
                if (url && imgEl && imgEl.isConnected) imgEl.src = url;
            });
        }
    });
}

// ✔ order নাম্বার এখন অ্যাডমিনকে ম্যানুয়ালি টাইপ করতে হয় না (duplicate/ভুল নাম্বার বসার
// সুযোগ ছিল) — Save করার সাথে সাথে auto পরের available number বসে যায়, আর
// ▲ / ▼ বাটন দিয়ে পজিশন বদলালে বাকি সবগুলোর নাম্বার automatically re-sequence হয়ে যায়।
async function saveBannerSettings(movie, changes) {
    if (!movie || !movie.id) return;
    try {
        let featuredOrder = movie.featured_order ?? null;

        if (changes.featured) {
            if (movie.featured !== true) {
                // নতুন করে banner-এ যোগ হচ্ছে - সবার শেষে (পরের available number) বসবে
                const featuredList = getFeaturedSortedMovies().filter(m => m.id !== movie.id);
                const maxOrder = featuredList.reduce((max, m) => Math.max(max, m.featured_order ?? -1), -1);
                featuredOrder = maxOrder + 1;
            }
        } else {
            featuredOrder = null;
        }

        const { error } = await supabaseClient
            .from('movies')
            .update({
                featured: changes.featured,
                featured_order: featuredOrder,
                featured_image: changes.featured_image
            })
            .eq('id', movie.id);
        if (error) throw error;

        movie.featured = changes.featured;
        movie.featured_order = featuredOrder;
        movie.featured_image = changes.featured_image;

        // remove করার পর বাকিগুলোর নাম্বার gap ছাড়া 0,1,2... করে re-sequence করে দাও
        if (!changes.featured) {
            await resequenceBannerOrder();
        }

        const searchInput = document.getElementById('adminBannerSearchInput');
        renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
        if (typeof renderHeroSlides === 'function') renderHeroSlides();
        showNoticeModal('✅ Banner settings saved for "' + (movie.title || 'this item') + '"');
    } catch (err) {
        console.error('Save banner settings error:', err);
        showNoticeModal('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

// ▲/▼ চাপলে নির্দিষ্ট movie-টা তার পাশের movie-র সাথে position swap করে (নাম্বার swap)
async function moveBannerItem(movie, direction) {
    const list = getFeaturedSortedMovies();
    const index = list.findIndex(m => m.id === movie.id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= list.length) return;

    const other = list[targetIndex];
    const thisOrder = movie.featured_order ?? index;
    const otherOrder = other.featured_order ?? targetIndex;

    try {
        const [{ error: err1 }, { error: err2 }] = await Promise.all([
            supabaseClient.from('movies').update({ featured_order: otherOrder }).eq('id', movie.id),
            supabaseClient.from('movies').update({ featured_order: thisOrder }).eq('id', other.id)
        ]);
        if (err1 || err2) throw (err1 || err2);

        movie.featured_order = otherOrder;
        other.featured_order = thisOrder;

        const searchInput = document.getElementById('adminBannerSearchInput');
        renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
        if (typeof renderHeroSlides === 'function') renderHeroSlides();
    } catch (err) {
        console.error('Reorder banner error:', err);
        showNoticeModal('❌ Reorder failed: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

// Banner থেকে বাদ পড়ার পর বাকি featured item গুলোর নাম্বার 0,1,2... ধারাবাহিকভাবে বসিয়ে দাও
// (যাতে gap বা duplicate না থাকে)
async function resequenceBannerOrder() {
    const list = getFeaturedSortedMovies();
    const updates = [];
    list.forEach((m, i) => {
        if (m.featured_order !== i) {
            m.featured_order = i;
            updates.push(supabaseClient.from('movies').update({ featured_order: i }).eq('id', m.id));
        }
    });
    if (updates.length) {
        try { await Promise.all(updates); } catch (e) { console.error('Resequence error:', e); }
    }
}

// ---------- Recycle Bin (soft delete / restore / purge) ----------

function updateAdminTrashBadge() {
    const badge = document.getElementById('adminTrashCount');
    if (!badge) return;
    const count = Array.isArray(allDeletedMovies) ? allDeletedMovies.length : 0;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// ---------- Custom in-page confirm modal (replaces native browser confirm()) ----------

function showConfirmModal(message, options) {
    options = options || {};
    const confirmText = options.confirmText || 'OK';
    const cancelText = options.cancelText || 'Cancel';
    const danger = options.danger !== false;

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-confirm-overlay';
        overlay.innerHTML = `
            <div class="custom-confirm-box">
                <div class="custom-confirm-message">${message}</div>
                <div class="custom-confirm-actions">
                    <button type="button" class="custom-confirm-cancel-btn">${cancelText}</button>
                    <button type="button" class="custom-confirm-ok-btn${danger ? ' danger' : ''}">${confirmText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cleanup = (result) => {
            overlay.remove();
            resolve(result);
        };

        overlay.querySelector('.custom-confirm-ok-btn').addEventListener('click', () => cleanup(true));
        overlay.querySelector('.custom-confirm-cancel-btn').addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        });

        requestAnimationFrame(() => overlay.classList.add('open'));
    });
}

function showNoticeModal(message, options) {
    options = options || {};
    const confirmText = options.confirmText || 'OK';

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-confirm-overlay';
        overlay.innerHTML = `
            <div class="custom-confirm-box">
                <div class="custom-confirm-message">${message}</div>
                <div class="custom-confirm-actions">
                    <button type="button" class="custom-confirm-ok-btn">${confirmText}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cleanup = () => {
            overlay.remove();
            resolve();
        };

        overlay.querySelector('.custom-confirm-ok-btn').addEventListener('click', cleanup);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup();
        });

        requestAnimationFrame(() => overlay.classList.add('open'));
    });
}

async function deleteMovieToTrash(movie) {
    if (!movie || !movie.id) return;
    const ok = await showConfirmModal(`Delete "${movie.title || 'this item'}"? It will stay in the Recycle Bin for 30 days.`, { confirmText: 'Delete' });
    if (!ok) return;

    try {
        const nowIso = new Date().toISOString();
        const { error } = await supabaseClient.from('movies').update({ deleted_at: nowIso }).eq('id', movie.id);
        if (error) throw error;

        // Move locally without a full refetch
        allMovies = allMovies.filter(m => m.id !== movie.id);
        movie.deleted_at = nowIso;
        allDeletedMovies.unshift(movie);

        const searchInput = document.getElementById('adminSearchInput');
        renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
        updateAdminTrashBadge();
    } catch (err) {
        console.error('Delete error:', err);
        showNoticeModal('❌ Delete failed: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

async function restoreMovieFromTrash(movie) {
    if (!movie || !movie.id) return;
    try {
        const { error } = await supabaseClient.from('movies').update({ deleted_at: null }).eq('id', movie.id);
        if (error) throw error;

        allDeletedMovies = allDeletedMovies.filter(m => m.id !== movie.id);
        delete movie.deleted_at;
        allMovies.unshift(movie);

        renderAdminTrashList();
        updateAdminTrashBadge();
    } catch (err) {
        console.error('Restore error:', err);
        showNoticeModal('❌ Restore failed: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

async function permanentlyDeleteMovie(movie, skipConfirm) {
    if (!movie || !movie.id) return;
    if (!skipConfirm) {
        const ok = await showConfirmModal(`Permanently delete "${movie.title || 'this item'}"? This cannot be undone.`, { confirmText: 'Delete Forever' });
        if (!ok) return;
    }

    try {
        const { error } = await supabaseClient.from('movies').delete().eq('id', movie.id);
        if (error) throw error;

        allDeletedMovies = allDeletedMovies.filter(m => m.id !== movie.id);
        if (!skipConfirm) {
            renderAdminTrashList();
            updateAdminTrashBadge();
        }
    } catch (err) {
        console.error('Permanent delete error:', err);
        if (!skipConfirm) showNoticeModal('❌ Permanent delete failed: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

// Silently hard-deletes any recycle bin item older than TRASH_RETENTION_DAYS
function purgeExpiredTrash() {
    if (!Array.isArray(allDeletedMovies) || allDeletedMovies.length === 0) return;
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const expired = allDeletedMovies.filter(m => {
        const t = m.deleted_at ? new Date(m.deleted_at).getTime() : 0;
        return t && t <= cutoff;
    });
    if (expired.length === 0) return;

    expired.forEach(movie => permanentlyDeleteMovie(movie, true));
    allDeletedMovies = allDeletedMovies.filter(m => {
        const t = m.deleted_at ? new Date(m.deleted_at).getTime() : 0;
        return !(t && t <= cutoff);
    });
    updateAdminTrashBadge();
}

function daysLeftInTrash(movie) {
    if (!movie.deleted_at) return TRASH_RETENTION_DAYS;
    const deletedTime = new Date(movie.deleted_at).getTime();
    const elapsedDays = (Date.now() - deletedTime) / (24 * 60 * 60 * 1000);
    return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsedDays));
}

function renderAdminTrashList() {
    const container = document.getElementById('adminTrashList');
    if (!container) return;
    container.innerHTML = '';

    updateAdminTrashBadge();

    const source = Array.isArray(allDeletedMovies) ? allDeletedMovies : [];
    if (source.length === 0) {
        container.innerHTML = moviesDataLoaded
            ? '<div class="admin-db-empty">Recycle Bin is empty.</div>'
            : '<div class="admin-db-empty">Loading content...</div>';
        return;
    }

    source.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const cats = Array.isArray(movie.category) ? movie.category.join(', ') : (movie.category || '');
        const typeLabel = movie.tmdbType === 'tv' ? 'TV Series' : 'Movie';
        const daysLeft = daysLeftInTrash(movie);
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-db-title">${movie.title || 'Untitled'}</div>
                <div class="admin-db-meta">${typeLabel} · ${cats || 'No category'}</div>
                <div class="admin-db-days-left">🗑 ${daysLeft} day${daysLeft === 1 ? '' : 's'} left before permanent deletion</div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-restore-btn">Restore</button>
                <button type="button" class="admin-db-perma-delete-btn">Delete Forever</button>
            </div>
        `;
        card.querySelector('.admin-db-restore-btn').addEventListener('click', () => restoreMovieFromTrash(movie));
        card.querySelector('.admin-db-perma-delete-btn').addEventListener('click', () => permanentlyDeleteMovie(movie));
        container.appendChild(card);

        // No poster saved manually — auto-fetch a small poster thumbnail from TMDB
        if (!movie.poster) {
            const imgEl = card.querySelector('.admin-db-thumb');
            fetchTmdbPosterQuick(movie).then(url => {
                if (url && imgEl && imgEl.isConnected) {
                    imgEl.src = url;
                }
            });
        }
    });
}

// ---------- 📥 Request Here (admin panel) ----------
// Reads the "requests" table, populated by the floating "Request Here" widget's submitChatRequest().
let allAdminRequests = [];
let lastAdminRequestsFetchError = null;

async function fetchAdminRequests() {
    try {
        const { data, error } = await supabaseClient
            .from('requests')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching requests:', error.message);
            lastAdminRequestsFetchError = error.message;
            allAdminRequests = [];
            return;
        }
        lastAdminRequestsFetchError = null;
        allAdminRequests = data || [];
        updateAdminRequestsBadge();
    } catch (err) {
        console.error('Unexpected error loading requests:', err);
        lastAdminRequestsFetchError = err?.message || 'Unknown error';
        allAdminRequests = [];
    }
}

function updateAdminRequestsBadge() {
    const badge = document.getElementById('adminRequestsCount');
    if (!badge) return;
    const count = Array.isArray(allAdminRequests) ? allAdminRequests.length : 0;
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
}

// রিকোয়েস্ট করা নামটা সাইটে আগে থেকেই আপলোড করা আছে কিনা — টাইটেল মিলিয়ে (বছর/স্পেস/কেস উপেক্ষা করে) auto-detect করে
function findMatchingMovieForRequest(requestTitle) {
    if (!requestTitle || !Array.isArray(allMovies)) return null;
    const normalize = (s) => String(s || '').toLowerCase().replace(/\(\d{4}(-\d{2,4})?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const target = normalize(requestTitle);
    if (!target) return null;
    return allMovies.find(m => normalize(m.title) === target) || null;
}

// রিকোয়েস্টে দেওয়া reference_link ফিল্ডটা অনেক সময় শুধু IMDb/TMDB ID (যেমন tt8416494) অথবা প্লেইন লিংক হতে পারে।
// এই ফাংশনটা যেটাই থাকুক না কেন সেটাকে একটা ক্লিকযোগ্য, ওপেন করা যায় এমন URL-এ বদলে দেয়, যাতে অ্যাডমিন
// এক ক্লিকেই মুভি/সিরিজটা IMDb/TMDB-তে গিয়ে ভালোভাবে যাচাই করে নিতে পারে কোনটা রিকোয়েস্ট করা হয়েছে।
function buildRequestReferenceUrl(rawLink) {
    const link = String(rawLink || '').trim();
    if (!link) return null;

    // ইতিমধ্যে একটা পূর্ণ লিংক (IMDb/TMDB/অন্য যেকোনো URL) দেওয়া থাকলে সরাসরি সেটাই ব্যবহার হবে
    if (/^https?:\/\//i.test(link)) return link;

    // শুধু IMDb ID দেওয়া থাকলে (যেমন: tt8416494) সরাসরি IMDb টাইটেল পেজে নিয়ে যাবে
    const imdbMatch = link.match(/^(tt\d{5,9})$/i);
    if (imdbMatch) return `https://www.imdb.com/title/${imdbMatch[1].toLowerCase()}/`;

    // www./ছাড়া ডোমেইন-এর মত কিছু দেওয়া থাকলে (যেমন themoviedb.org/movie/...) তার আগে https:// বসিয়ে দেওয়া হবে
    if (/^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(link)) return `https://${link}`;

    // শুধু সংখ্যা দেওয়া থাকলে (TMDB ID) — মুভি নাকি সিরিজ নিশ্চিত না হওয়ায় TMDB সার্চ পেজে নিয়ে যাবে
    if (/^\d+$/.test(link)) return `https://www.themoviedb.org/search?query=${encodeURIComponent(link)}`;

    // অন্য যেকোনো টেক্সট হলে সেটা দিয়ে IMDb-তে সার্চ করে দেখাবে
    return `https://www.imdb.com/find/?q=${encodeURIComponent(link)}`;
}

function renderAdminRequestsList(filter) {
    const container = document.getElementById('adminRequestsList');
    if (!container) return;
    container.innerHTML = '';
    updateAdminRequestsBadge();

    if (lastAdminRequestsFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load requests (${escapeHtml(lastAdminRequestsFetchError)}). This is usually a database permissions (RLS) issue — see fix-database-permissions.sql </div>`;
        return;
    }

    const q = (filter || '').trim().toLowerCase();
    const source = (Array.isArray(allAdminRequests) ? allAdminRequests : []).filter(r =>
        !q || (r.movie_title || '').toLowerCase().includes(q)
    );

    if (source.length === 0) {
        container.innerHTML = `<div class="admin-db-empty">${q ? 'No matching requests found.' : 'No requests yet.'}</div>`;
        return;
    }

    source.forEach(reqItem => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const timeAgo = formatTimeAgo(reqItem.created_at) || '';
        const yearPart = reqItem.release_year ? ` (${escapeHtml(String(reqItem.release_year))})` : '';
        const alreadyOnSite = !!findMatchingMovieForRequest(reqItem.movie_title); // টাইটেল মিলে গেলে auto-detect করে দেখায়
        const referenceUrl = buildRequestReferenceUrl(reqItem.reference_link); // IMDb/TMDB id/link -> ওপেন করা যায় এমন URL
        card.innerHTML = `
            <div class="admin-db-info">
                <div class="admin-db-title">${escapeHtml(reqItem.movie_title || 'Untitled')}${yearPart}</div>
                ${reqItem.reference_link ? `
                <div class="admin-alert-url admin-request-link-row">
                    <span class="admin-request-link-text">${escapeHtml(reqItem.reference_link)}</span>
                    ${referenceUrl ? `<button type="button" class="admin-request-link-btn" title="IMDb/TMDB-তে ওপেন করে দেখুন">🔗 Open Link</button>` : ''}
                </div>` : ''}
                <div class="admin-alert-meta-row">${alreadyOnSite ? '<span class="admin-alert-source-tag auto">✅ Already on Site</span>' : ''}<span class="admin-alert-time">${timeAgo}</span></div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-edit-btn admin-request-add-btn">🎬 Add to Site</button>
                <button type="button" class="admin-db-restore-btn admin-request-uploaded-btn">✅ Already Uploaded</button>
                <button type="button" class="admin-db-delete-btn admin-request-delete-btn">🗑 Delete</button>
            </div>
        `;
        const linkBtn = card.querySelector('.admin-request-link-btn');
        if (linkBtn) linkBtn.addEventListener('click', () => window.open(referenceUrl, '_blank', 'noopener'));
        card.querySelector('.admin-request-add-btn').addEventListener('click', () => addRequestToSite(reqItem));
        card.querySelector('.admin-request-uploaded-btn').addEventListener('click', () => deleteAdminRequest(reqItem));
        card.querySelector('.admin-request-delete-btn').addEventListener('click', () => deleteAdminRequest(reqItem));
        container.appendChild(card);
    });
}

// রিকোয়েস্ট করা নামটা সরাসরি Add/Edit Content ফর্মে বসিয়ে দেয়, যাতে দ্রুত আপলোড করা যায়
function addRequestToSite(reqItem) {
    switchAdminTab('add');
    resetAdminForm();
    const titleInput = document.getElementById('adminTitle');
    if (titleInput) {
        let prefill = reqItem.movie_title || '';
        if (reqItem.release_year) prefill += ` (${reqItem.release_year})`;
        titleInput.value = prefill;
        titleInput.focus();
    }
}

async function deleteAdminRequest(reqItem) {
    if (!reqItem || !reqItem.id) return;
    try {
        const { error } = await supabaseClient.from('requests').delete().eq('id', reqItem.id);
        if (error) throw error;
        allAdminRequests = allAdminRequests.filter(r => r.id !== reqItem.id);
        const searchInput = document.getElementById('adminRequestSearchInput');
        renderAdminRequestsList(searchInput ? searchInput.value.trim() : '');
    } catch (err) {
        console.error('Delete request error:', err);
        showNoticeModal('❌ Request ডিলিট করা যায়নি: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

// ---------- ✉️ Messages (admin panel) ----------
// Reads the "support_messages" table, populated by the floating widget's "Chat with support" tab.
let allAdminMessages = [];
let lastAdminMessagesFetchError = null;

async function fetchAdminMessages() {
    try {
        const { data, error } = await supabaseClient
            .from('support_messages')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching messages:', error.message);
            lastAdminMessagesFetchError = error.message;
            allAdminMessages = [];
            return;
        }
        lastAdminMessagesFetchError = null;
        allAdminMessages = data || [];
        updateAdminMessagesBadge();
    } catch (err) {
        console.error('Unexpected error loading messages:', err);
        lastAdminMessagesFetchError = err?.message || 'Unknown error';
        allAdminMessages = [];
    }
}

function updateAdminMessagesBadge() {
    const badge = document.getElementById('adminMessagesCount');
    if (!badge) return;
    const count = Array.isArray(allAdminMessages) ? allAdminMessages.filter(m => m.sender !== 'admin').length : 0;
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
}

function renderAdminMessagesList() {
    const container = document.getElementById('adminMessagesList');
    if (!container) return;
    container.innerHTML = '';
    updateAdminMessagesBadge();

    if (lastAdminMessagesFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load messages (${escapeHtml(lastAdminMessagesFetchError)}). This is usually a database permissions (RLS) issue — see fix-database-permissions.sql </div>`;
        return;
    }

    const source = Array.isArray(allAdminMessages) ? allAdminMessages : [];
    if (source.length === 0) {
        container.innerHTML = '<div class="admin-db-empty">No messages yet.</div>';
        return;
    }

    source.forEach(msg => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const isAdminMsg = msg.sender === 'admin';
        const timeAgo = formatTimeAgo(msg.created_at) || '';
        card.innerHTML = `
            <div class="admin-db-info">
                <div class="admin-db-title">${isAdminMsg ? '🛠 Admin (You)' : '👤 Visitor'}</div>
                <div class="admin-db-meta">${escapeHtml(msg.message || '')}</div>
                ${msg.image_url ? `<a href="${escapeHtml(msg.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(msg.image_url)}" alt="Attached image" loading="lazy" style="max-width:180px;max-height:180px;border-radius:8px;margin-top:8px;display:block;"></a>` : ''}
                <div class="admin-alert-meta-row"><span class="admin-alert-time">${timeAgo}</span></div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-delete-btn admin-message-delete-btn">🗑 Delete</button>
            </div>
        `;
        card.querySelector('.admin-message-delete-btn').addEventListener('click', () => deleteAdminMessage(msg));
        container.appendChild(card);
    });
}

async function deleteAdminMessage(msg) {
    if (!msg || !msg.id) return;
    try {
        const { error } = await supabaseClient.from('support_messages').delete().eq('id', msg.id);
        if (error) throw error;
        allAdminMessages = allAdminMessages.filter(m => m.id !== msg.id);
        renderAdminMessagesList();
    } catch (err) {
        console.error('Delete message error:', err);
        showNoticeModal('❌ Message ডিলিট করা যায়নি: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

// ---------- 🔔 Broken Link Alerts (admin panel) ----------
// Requires the "link_alerts" table. See link_alerts_schema.sql for the one-time database setup.

let lastLinkAlertsFetchError = null; // fetch সত্যিই ফেইল করলে সেটা যেন "সব ঠিক আছে ✅" থেকে আলাদা দেখায়

async function fetchLinkAlerts() {
    try {
        const { data, error } = await supabaseClient
            .from('link_alerts')
            .select('*')
            .eq('status', 'open')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching link alerts:', error.message);
            lastLinkAlertsFetchError = error.message;
            allLinkAlerts = [];
            return;
        }
        lastLinkAlertsFetchError = null;
        allLinkAlerts = data || [];
        updateAdminAlertsBadge();
    } catch (err) {
        console.error('Unexpected error loading link alerts:', err);
        lastLinkAlertsFetchError = err?.message || 'Unknown error';
        allLinkAlerts = [];
    }
}

function updateAdminAlertsBadge() {
    const badge = document.getElementById('adminAlertsCount');
    if (!badge) return;
    const count = Array.isArray(allLinkAlerts) ? allLinkAlerts.length : 0;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

function renderAdminAlertsList() {
    const container = document.getElementById('adminAlertsList');
    if (!container) return;
    container.innerHTML = '';

    updateAdminAlertsBadge();

    // fetch টাই ব্যর্থ হলে (যেমন RLS SELECT policy না থাকলে) সেটা "সব ঠিক আছে ✅" এর
    // বদলে স্পষ্ট এরর হিসেবে দেখাও, নাহলে আসল রিপোর্ট থাকলেও admin বুঝতে পারবে না
    if (lastLinkAlertsFetchError) {
        container.innerHTML = `<div class="admin-db-empty" style="color:#f87171;">⚠️ Could not load reports (${escapeHtml(lastLinkAlertsFetchError)}). This is usually a database permissions (RLS) issue — see fix-database-permissions.sql.</div>`;
        return;
    }

    const source = Array.isArray(allLinkAlerts) ? allLinkAlerts : [];
    if (source.length === 0) {
        container.innerHTML = '<div class="admin-db-empty">No Broken Link Alerts. All links are working fine ✅</div>';
        return;
    }

    source.forEach(alert => {
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-alert-card';
        const isAuto = alert.source === 'auto_check';
        const sourceTag = isAuto ? '<span class="admin-alert-source-tag auto">🤖 Auto-Check</span>' : '<span class="admin-alert-source-tag">👤 Visitor Report</span>';
        const timeAgo = formatTimeAgo(alert.created_at) || '';
        const reporterAvatar = alert.reporter_avatar_url
            ? `<img class="admin-db-thumb" src="${escapeHtml(alert.reporter_avatar_url)}" referrerpolicy="no-referrer" style="border-radius:50%;" onerror="this.style.display='none';">`
            : '';
        card.innerHTML = `
            ${reporterAvatar}
            <div class="admin-db-info">
                <div class="admin-db-title">${escapeHtml(alert.movie_title || 'Untitled')}</div>
                <div class="admin-db-meta">${escapeHtml(alert.link_label || 'Download Link')}</div>
                <div class="admin-alert-url">${escapeHtml(alert.link_url || '')}</div>
                <div class="admin-alert-meta-row">${sourceTag}<span class="admin-alert-time">${timeAgo}</span></div>
            </div>
            <div class="admin-db-actions admin-alert-actions">
                <button type="button" class="admin-db-edit-btn admin-alert-update-btn">🖊 Update Link</button>
                <button type="button" class="admin-db-restore-btn admin-alert-resolve-btn">✅ Resolved</button>
                <button type="button" class="admin-db-delete-btn admin-alert-dismiss-btn">🗑 Dismiss</button>
            </div>
        `;
        card.querySelector('.admin-alert-update-btn').addEventListener('click', () => openLinkAlertInEditor(alert));
        card.querySelector('.admin-alert-resolve-btn').addEventListener('click', () => resolveLinkAlert(alert));
        card.querySelector('.admin-alert-dismiss-btn').addEventListener('click', () => resolveLinkAlert(alert, true));
        container.appendChild(card);
    });
}

async function resolveLinkAlert(alert, isDismiss) {
    if (!alert || !alert.id) return;
    try {
        const nowIso = new Date().toISOString();
        const { error } = await supabaseClient.from('link_alerts').update({ status: 'resolved', resolved_at: nowIso }).eq('id', alert.id);
        if (error) throw error;

        allLinkAlerts = allLinkAlerts.filter(a => a.id !== alert.id);
        renderAdminAlertsList();
    } catch (err) {
        console.error('Resolve alert error:', err);
        showNoticeModal('❌ Alert আপডেট করা যায়নি: ' + (err && err.message ? err.message : 'Unknown error'));
    }
}

function openLinkAlertInEditor(alert) {
    if (!alert || !alert.movie_id) return;
    const movie = (Array.isArray(allMovies) ? allMovies.find(m => m.id === alert.movie_id) : null)
        || (Array.isArray(allDeletedMovies) ? allDeletedMovies.find(m => m.id === alert.movie_id) : null);

    if (!movie) {
        showNoticeModal('এই কন্টেন্টটি ডাটাবেজে খুঁজে পাওয়া যায়নি — সম্ভবত এটি স্থায়ীভাবে ডিলিট হয়ে গেছে।');
        return;
    }

    switchAdminTab('add');
    loadMovieIntoAdminForm(movie);

    const msgEl = document.getElementById('adminFormMsg');
    if (msgEl) {
        msgEl.textContent = `🔔 রিপোর্ট হওয়া লিংক: "${alert.link_label || 'Download Link'}" — নিচের লিংকগুলো চেক করে নতুন লিংক দিন, তারপর Update Content চাপুন।`;
        msgEl.className = 'admin-form-msg error';
    }
}

// ==================== COMMENTS SYSTEM ====================
// No login required — everything (name + comment) is typed straight
// into the box and saved to the database. Nothing is kept in the
// browser (no localStorage) — the name field is just remembered
// in memory for this page view so replies don't need retyping it.
// Requires the "comments" table. See comments_schema_v2_no_login.sql
// for the one-time database setup.

const QUICK_EMOJIS = ['😀','😂','😍','😮','😢','😡','👍','🔥','❤️','🎬'];
const REACTION_OPTIONS = ['❤️','👍','😂','😮','🔥'];
let myCommentIdentityCache = null; // লগইন করা ইউজারের নাম+ছবি ক্যাশ করে রাখে, বারবার প্রোফাইল ফেচ করতে হয় না

// লগইন করা ইউজার থাকলে তার আসল নাম আর প্রোফাইল ছবি (profiles টেবিল থেকে) নিয়ে আসে -
// comment box এ এখন আর কেউ নিজের নাম টাইপ করে না, এখান থেকেই বসে যায়
async function getMyCommentIdentity() {
    if (!currentAuthSession?.user) return null;
    if (myCommentIdentityCache && myCommentIdentityCache.userId === currentAuthSession.user.id) return myCommentIdentityCache;

    const isAdmin = isCurrentUserAdmin(currentAuthSession);
    // Admin logs in with a synthetic "702640shamil@admin.com" address that has no real
    // profile — falling back to the email's local-part would show "702640shamil" as the
    // name, so admin always displays simply as "Admin" instead.
    let name = isAdmin ? 'Admin' : (currentAuthSession.user.user_metadata?.full_name || getDisplayUsername(currentAuthSession));
    let avatarUrl = '';
    if (!isAdmin) {
        try {
            const { data, error } = await supabaseClient
                .from('profiles')
                .select('username, full_name, avatar_url')
                .eq('id', currentAuthSession.user.id)
                .maybeSingle();
            if (!error && data) {
                name = data.full_name || data.username || name;
                avatarUrl = data.avatar_url || '';
            }
        } catch (e) {
            console.error('Could not load comment identity:', e);
        }
    }

    myCommentIdentityCache = { userId: currentAuthSession.user.id, name, avatarUrl, isAdmin };
    return myCommentIdentityCache;
}

function renderCommentsSectionShell() {
    const isCollapsed = localStorage.getItem('commentsCollapsed') === 'true';
    return `
    <div class="comments-section${isCollapsed ? ' collapsed' : ''}" id="commentsSectionWrap">
        <div class="comments-header" id="commentsHeaderToggle" onclick="toggleCommentsSection()">
            <div class="comments-header-left">
                <span class="comments-title">Comments</span>
                <span class="comments-count-badge" id="commentsCountBadge">0</span>
            </div>
            <div class="comments-header-right">
                <div class="comments-sort-tabs" id="commentsSortTabs" onclick="event.stopPropagation()">
                    <button type="button" class="comments-sort-btn" data-sort="top" onclick="setCommentsSortMode('top')">Top</button>
                    <button type="button" class="comments-sort-btn active" data-sort="newest" onclick="setCommentsSortMode('newest')">Newest</button>
                </div>
                <span class="comments-collapse-chevron">▾</span>
            </div>
        </div>
        <div class="comments-body" id="commentsBody">
            <div class="comment-composer" id="commentComposerWrap"></div>
            <div class="comments-list" id="commentsList">
                <div class="comments-loading">Loading comments…</div>
            </div>
        </div>
    </div>`;
}

function toggleCommentsSection() {
    const wrap = document.getElementById('commentsSectionWrap');
    if (!wrap) return;
    const collapsedNow = wrap.classList.toggle('collapsed');
    localStorage.setItem('commentsCollapsed', collapsedNow ? 'true' : 'false');
}

function initCommentsSection(movie) {
    if (!movie || movie.id === undefined || movie.id === null) return;
    commentsCurrentMovieId = movie.id;
    renderCommentComposer();
    loadComments(movie.id);
}

function scrollToComments() {
    const wrap = document.getElementById('commentsSectionWrap');
    if (!wrap) return;
    if (wrap.classList.contains('collapsed')) toggleCommentsSection();
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- Composer (top comment box) ----------------
// কমেন্ট করতে হলে অবশ্যই লগইন থাকতে হবে - লগইন না থাকলে "Please login" prompt দেখায়,
// লগইন থাকলে ইউজারের আসল প্রোফাইল ছবি আর নাম বসিয়ে দেয় (আর কোনো নাম টাইপ করার বক্স থাকে না)।
function renderCommentComposer() {
    const wrap = document.getElementById('commentComposerWrap');
    if (!wrap) return;

    if (!currentAuthSession?.user) {
        wrap.innerHTML = `
        <div class="comment-login-prompt">
            <span>Please login to leave a comment.</span>
            <button type="button" onclick="openAuthModal('signin')">Login</button>
        </div>`;
        return;
    }

    // আগে একটা lightweight loading state দেখাও, প্রোফাইল ফেচ শেষ হলে আসল avatar+নাম বসবে
    wrap.innerHTML = `
    <div class="comment-input-row">
        <div class="comment-avatar" id="commentComposerAvatar">…</div>
        <div class="comment-input-box">
            <div class="comment-composer-identity">
                <span class="comment-composer-name" id="commentComposerName">Loading…</span>
            </div>
            <textarea id="commentMainInput" class="comment-textarea" placeholder="Share your thoughts..." rows="1" oninput="autoGrowTextarea(this)"></textarea>
            <div class="comment-input-actions">
                <span class="comment-emoji-btn" onclick="toggleEmojiPicker('commentMainInput', this)">🙂</span>
                <span></span>
                <button type="button" class="comment-submit-btn" onclick="submitTopLevelComment()">COMMENT</button>
            </div>
        </div>
    </div>`;

    getMyCommentIdentity().then(identity => {
        if (!identity) return; // ততক্ষণে হয়তো sign out হয়ে গেছে
        renderComposerIdentity('commentComposerAvatar', 'commentComposerName', identity);
    });
}

// অ্যাভাটার box টাকে ছবি (থাকলে) অথবা নামের প্রথম অক্ষর দিয়ে ভরে দেয়, আর পাশে আসল নাম বসায়
function renderComposerIdentity(avatarElId, nameElId, identity) {
    const avatarEl = document.getElementById(avatarElId);
    const nameEl = document.getElementById(nameElId);
    if (avatarEl) {
        avatarEl.innerHTML = identity.avatarUrl
            ? `<img src="${escapeHtml(identity.avatarUrl)}" class="comment-composer-avatar-img" alt="">`
            : '';
        if (!identity.avatarUrl) avatarEl.textContent = commentInitial(identity.name);
        avatarEl.classList.toggle('admin-avatar', !!identity.isAdmin);
    }
    if (nameEl) {
        nameEl.textContent = identity.name;
        const existingBadge = nameEl.parentElement?.querySelector('.comment-admin-badge');
        if (existingBadge) existingBadge.remove();
        if (identity.isAdmin) {
            nameEl.insertAdjacentHTML('afterend', '<span class="comment-admin-badge">👑 Admin</span>');
        }
    }
}

// ---------------- Fetching & rendering comments ----------------

function commentInitial(name) {
    return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

async function loadComments(movieId) {
    if (movieId === undefined || movieId === null) return;
    const listEl = document.getElementById('commentsList');
    if (!listEl) return;

    const { data, error } = await supabaseClient
        .from('comments')
        .select('*')
        .eq('movie_id', movieId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Load comments error:', error);
        listEl.innerHTML = `<div class="comments-loading">Couldn't load comments.</div>`;
        return;
    }

    const all = data || [];
    const topLevel = all.filter(c => !c.parent_id);
    const repliesByParent = {};
    all.filter(c => c.parent_id).forEach(r => {
        (repliesByParent[r.parent_id] = repliesByParent[r.parent_id] || []).push(r);
    });
    Object.values(repliesByParent).forEach(arr => arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));

    const countBadge = document.getElementById('commentsCountBadge');
    if (countBadge) countBadge.textContent = all.length;

    const commentsStatVal = document.getElementById('modalCommentsCountVal');
    if (commentsStatVal) commentsStatVal.textContent = `${all.length} comment${all.length === 1 ? '' : 's'}`;

    let sorted;
    if (commentsSortMode === 'top') {
        sorted = [...topLevel].sort((a, b) => {
            const aScore = (repliesByParent[a.id] ? repliesByParent[a.id].length : 0) + totalReactionCount(a);
            const bScore = (repliesByParent[b.id] ? repliesByParent[b.id].length : 0) + totalReactionCount(b);
            if (bScore !== aScore) return bScore - aScore;
            return new Date(b.created_at) - new Date(a.created_at);
        });
    } else {
        sorted = [...topLevel].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    if (sorted.length === 0) {
        listEl.innerHTML = `<div class="comments-empty">No comments yet. Be the first to share your thoughts!</div>`;
        return;
    }

    listEl.innerHTML = sorted.map(c => renderCommentNode(c, repliesByParent[c.id] || [])).join('');
}

function setCommentsSortMode(mode) {
    commentsSortMode = mode;
    document.querySelectorAll('.comments-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
    loadComments(commentsCurrentMovieId);
}

function totalReactionCount(comment) {
    const r = comment.reactions || {};
    return Object.values(r).reduce((sum, n) => sum + (n || 0), 0);
}

function myReactionFor(commentId) {
    return localStorage.getItem(`commentReaction_${commentId}`);
}

function renderReactionControls(comment) {
    const entries = Object.entries(comment.reactions || {}).filter(([, count]) => count > 0);
    const reactionBadge = entries.length ? `
        <div class="comment-reactions-row" onclick="toggleReactionPicker(${comment.id})">
            ${entries
                .sort((a, b) => b[1] - a[1])
                .map(([emoji, count]) => `<span class="comment-reaction-pill${myReactionFor(comment.id) === emoji ? ' picked' : ''}">${emoji} ${count}</span>`)
                .join('')}
        </div>` : '';

    const myEmoji = myReactionFor(comment.id);
    const reactPicker = `
        <span class="comment-react-btn${myEmoji ? ' picked' : ''}" onclick="toggleReactionPicker(${comment.id})" title="React">🙂+</span>
        <div class="comment-reaction-picker" id="reactionPicker-${comment.id}" style="display:none;">
            ${REACTION_OPTIONS.map(e => `<span class="${myEmoji === e ? 'picked' : ''}" onclick="setCommentReaction(${comment.id}, '${e}')">${e}</span>`).join('')}
        </div>`;

    return { reactionBadge, reactPicker };
}

function renderSingleCommentHTML(comment, isReply) {
    const isAdminViewer = isCurrentUserAdmin(currentAuthSession);
    const name = comment.guest_name || 'Guest';
    const isAdminComment = !!comment.is_admin;
    const timeLabel = formatTimeAgo(comment.created_at) || 'just now';
    const { reactionBadge, reactPicker } = renderReactionControls(comment);
    const deleteBtn = isAdminViewer
        ? `<span class="comment-delete-btn" onclick="deleteCommentInline(${comment.id})" title="Delete comment">🗑</span>` : '';
    const avatarInner = comment.avatar_url
        ? `<img src="${escapeHtml(comment.avatar_url)}" class="comment-avatar-img" alt="">`
        : commentInitial(name);

    return `
        <div class="comment-avatar${isAdminComment ? ' admin-avatar' : ''}">${avatarInner}</div>
        <div class="comment-content-col">
            <div class="comment-meta-row">
                <span class="comment-author-name">${escapeHtml(name)}</span>
                ${isAdminComment ? '<span class="comment-admin-badge">👑 Admin</span>' : ''}
                <span class="comment-dot">•</span>
                <span class="comment-time">${timeLabel}</span>
            </div>
            <div class="comment-text">${escapeHtml(comment.content)}</div>
            ${reactionBadge}
            <div class="comment-actions-row">
                ${reactPicker}
                ${!isReply ? `<span class="comment-reply-link" onclick="toggleReplyBox(${comment.id})">Reply</span>` : ''}
                ${deleteBtn}
            </div>
        </div>`;
}

function renderCommentNode(comment, replies) {
    const repliesHTML = replies.map(r => `<div class="comment-node comment-reply-node">${renderSingleCommentHTML(r, true)}</div>`).join('');

    return `
    <div class="comment-node" id="comment-${comment.id}">
        ${renderSingleCommentHTML(comment, false)}
    </div>
    <div class="comment-reply-form-wrap" id="replyForm-${comment.id}" style="display:none;"></div>
    ${replies.length ? `<div class="comment-replies-list">${repliesHTML}</div>` : ''}
    `;
}

// ---------------- Posting comments & replies ----------------

function toggleReplyBox(commentId) {
    const wrap = document.getElementById(`replyForm-${commentId}`);
    if (!wrap) return;

    if (wrap.style.display === 'block') {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
    }

    if (!currentAuthSession?.user) {
        openAuthModal('signin'); // reply দিতে হলেও লগইন লাগবে
        return;
    }

    wrap.style.display = 'block';
    wrap.innerHTML = `
        <div class="comment-input-row reply-input-row">
            <div class="comment-avatar" id="replyAvatar-${commentId}">…</div>
            <div class="comment-input-box">
                <div class="comment-composer-identity">
                    <span class="comment-composer-name" id="replyName-${commentId}">Loading…</span>
                </div>
                <textarea id="replyInput-${commentId}" class="comment-textarea" placeholder="Reply…" rows="1" oninput="autoGrowTextarea(this)"></textarea>
                <div class="comment-input-actions">
                    <span class="comment-emoji-btn" onclick="toggleEmojiPicker('replyInput-${commentId}', this)">🙂</span>
                    <span></span>
                    <button type="button" class="comment-cancel-btn" onclick="toggleReplyBox(${commentId})">Cancel</button>
                    <button type="button" class="comment-submit-btn" onclick="submitReply(${commentId})">REPLY</button>
                </div>
            </div>
        </div>`;
    const input = document.getElementById(`replyInput-${commentId}`);
    if (input) input.focus();

    getMyCommentIdentity().then(identity => {
        if (!identity) return;
        renderComposerIdentity(`replyAvatar-${commentId}`, `replyName-${commentId}`, identity);
    });
}

async function submitTopLevelComment() {
    if (!currentAuthSession?.user) { openAuthModal('signin'); return; }
    const input = document.getElementById('commentMainInput');
    const text = (input?.value || '').trim();
    if (!text) return;
    const identity = await getMyCommentIdentity();
    if (!identity) { openAuthModal('signin'); return; }
    postComment(text, null, identity.name, identity.avatarUrl);
}

async function submitReply(parentId) {
    if (!currentAuthSession?.user) { openAuthModal('signin'); return; }
    const input = document.getElementById(`replyInput-${parentId}`);
    const text = (input?.value || '').trim();
    if (!text) return;
    const identity = await getMyCommentIdentity();
    if (!identity) { openAuthModal('signin'); return; }
    postComment(text, parentId, identity.name, identity.avatarUrl);
}

async function postComment(content, parentId, name, avatarUrl) {
    if (!currentAuthSession?.user) { openAuthModal('signin'); return; }
    if (!name || commentsCurrentMovieId === null) return;

    const { error } = await supabaseClient.from('comments').insert([{
        movie_id: commentsCurrentMovieId,
        parent_id: parentId || null,
        guest_name: name.slice(0, 40),
        content: content.slice(0, 1000),
        is_admin: isCurrentUserAdmin(currentAuthSession),
        avatar_url: avatarUrl || null
    }]);

    if (error) {
        console.error('Comment post error:', error);
        showNoticeModal('❌ Could not post comment: ' + error.message);
        return;
    }

    if (parentId) {
        const wrap = document.getElementById(`replyForm-${parentId}`);
        if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    } else {
        const input = document.getElementById('commentMainInput');
        if (input) { input.value = ''; input.style.height = 'auto'; }
    }
    loadComments(commentsCurrentMovieId);
}

// ---------------- Reactions (everyone: guests + admin) ----------------

function toggleReactionPicker(commentId) {
    document.querySelectorAll('.comment-reaction-picker').forEach(p => {
        if (p.id !== `reactionPicker-${commentId}`) p.style.display = 'none';
    });
    const picker = document.getElementById(`reactionPicker-${commentId}`);
    if (picker) picker.style.display = (picker.style.display === 'flex') ? 'none' : 'flex';
}

// Anyone (guest or admin) can react. One emoji per comment per browser —
// clicking the same emoji again removes it; clicking a different one swaps it.
// Reactions are stored as counts in a jsonb column (e.g. {"❤️": 3, "👍": 1}),
// matching the same open, no-login trust model as the rest of the comments
// system — there's no server-side check stopping someone from clearing
// localStorage and reacting again.
async function setCommentReaction(commentId, emoji) {
    const storageKey = `commentReaction_${commentId}`;
    const prevEmoji = localStorage.getItem(storageKey);
    const newEmoji = (prevEmoji === emoji) ? null : emoji;

    const { data: row, error: fetchError } = await supabaseClient
        .from('comments')
        .select('reactions')
        .eq('id', commentId)
        .single();

    if (fetchError) {
        console.error('Reaction fetch error:', fetchError);
        showNoticeModal('❌ Could not react: ' + fetchError.message);
        return;
    }

    const reactions = { ...(row.reactions || {}) };
    if (prevEmoji) reactions[prevEmoji] = Math.max(0, (reactions[prevEmoji] || 0) - 1);
    if (newEmoji) reactions[newEmoji] = (reactions[newEmoji] || 0) + 1;
    Object.keys(reactions).forEach(k => { if (!reactions[k]) delete reactions[k]; });

    const { error } = await supabaseClient.from('comments').update({ reactions }).eq('id', commentId);
    if (error) { console.error('Reaction error:', error); showNoticeModal('❌ Could not react: ' + error.message); return; }

    if (newEmoji) localStorage.setItem(storageKey, newEmoji); else localStorage.removeItem(storageKey);

    loadComments(commentsCurrentMovieId);
}

// ---------------- Admin: delete comments ----------------

async function deleteCommentInline(commentId) {
    if (!isCurrentUserAdmin(currentAuthSession)) return;
    const ok = await showConfirmModal('Delete this comment? This cannot be undone.', { confirmText: 'Delete' });
    if (!ok) return;

    const { error } = await supabaseClient.from('comments').delete().eq('id', commentId);
    if (error) { console.error('Delete comment error:', error); showNoticeModal('❌ Could not delete comment: ' + error.message); return; }

    loadComments(commentsCurrentMovieId);
    const commentsTab = document.getElementById('adminTabComments');
    if (commentsTab && commentsTab.style.display !== 'none') {
        const s = document.getElementById('adminCommentSearchInput');
        renderAdminCommentsList(s ? s.value.trim() : '');
    }
}

function findMovieTitleById(movieId) {
    const inLists = [].concat(allMovies || [], allDeletedMovies || []);
    const m = inLists.find(mv => mv.id === movieId);
    return m ? (m.title || 'Untitled') : `Movie #${movieId}`;
}

async function renderAdminCommentsList(filter) {
    const container = document.getElementById('adminCommentsList');
    if (!container) return;
    container.innerHTML = '<div class="admin-db-empty">Loading comments…</div>';

    const { data, error } = await supabaseClient
        .from('comments')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);

    if (error) {
        console.error('Admin comments load error:', error);
        container.innerHTML = '<div class="admin-db-empty">Could not load comments.</div>';
        return;
    }

    const q = (filter || '').toLowerCase().trim();
    let list = data || [];
    if (q) {
        list = list.filter(c =>
            (c.content || '').toLowerCase().includes(q) ||
            (c.guest_name || '').toLowerCase().includes(q) ||
            findMovieTitleById(c.movie_id).toLowerCase().includes(q)
        );
    }

    if (list.length === 0) {
        container.innerHTML = '<div class="admin-db-empty">No comments found.</div>';
        return;
    }

    // build a quick lookup so reply rows can show "Replying to <name>"
    const byId = {};
    (data || []).forEach(c => { byId[c.id] = c; });

    container.innerHTML = '';
    list.forEach(c => {
        const isReply = !!c.parent_id;
        const parent = isReply ? byId[c.parent_id] : null;

        const row = document.createElement('div');
        row.className = 'admin-db-card admin-comment-card';
        row.innerHTML = `
            <div class="admin-db-info">
                <div class="admin-db-title">
                    ${escapeHtml(c.guest_name || 'Guest')}${c.is_admin ? ' <span class="comment-admin-badge">👑 Admin</span>' : ''}
                    <span class="admin-comment-on">on ${escapeHtml(findMovieTitleById(c.movie_id))}</span>
                </div>
                ${parent ? `<div class="admin-comment-replying-to">↳ replying to ${escapeHtml(parent.guest_name || 'Guest')}</div>` : ''}
                <div class="admin-comment-text">${escapeHtml(c.content || '')}</div>
                <div class="admin-db-meta">${formatTimeAgo(c.created_at) || ''}</div>
                <div class="admin-comment-reply-box" id="adminReplyBox-${c.id}" style="display:none;">
                    <textarea id="adminReplyInput-${c.id}" class="comment-textarea" placeholder="Reply as Admin…" rows="1" oninput="autoGrowTextarea(this)"></textarea>
                    <div class="comment-form-actions">
                        <button type="button" class="comment-cancel-btn" onclick="toggleAdminReplyBox(${c.id})">Cancel</button>
                        <button type="button" class="comment-submit-btn">REPLY</button>
                    </div>
                </div>
            </div>
            <div class="admin-db-actions">
                ${!isReply ? '<button type="button" class="admin-db-reply-btn">Reply</button>' : ''}
                <button type="button" class="admin-db-delete-btn">Delete</button>
            </div>
        `;
        if (!isReply) {
            row.querySelector('.admin-db-reply-btn').addEventListener('click', () => toggleAdminReplyBox(c.id));
            row.querySelector('.comment-submit-btn').addEventListener('click', () => submitAdminReplyFromPanel(c.id, c.movie_id));
        }
        row.querySelector('.admin-db-delete-btn').addEventListener('click', () => deleteCommentFromAdminList(c.id));
        container.appendChild(row);
    });
}

function toggleAdminReplyBox(commentId) {
    document.querySelectorAll('.admin-comment-reply-box').forEach(b => {
        if (b.id !== `adminReplyBox-${commentId}`) b.style.display = 'none';
    });
    const box = document.getElementById(`adminReplyBox-${commentId}`);
    if (!box) return;
    box.style.display = (box.style.display === 'block') ? 'none' : 'block';
    if (box.style.display === 'block') {
        const input = document.getElementById(`adminReplyInput-${commentId}`);
        if (input) input.focus();
    }
}

async function submitAdminReplyFromPanel(parentId, movieId) {
    const input = document.getElementById(`adminReplyInput-${parentId}`);
    const text = (input && input.value || '').trim();
    if (!text) { if (input) input.focus(); return; }

    const { error } = await supabaseClient.from('comments').insert([{
        movie_id: movieId,
        parent_id: parentId,
        guest_name: 'Admin',
        content: text.slice(0, 1000),
        is_admin: true
    }]);

    if (error) {
        console.error('Admin reply error:', error);
        showNoticeModal('❌ Could not post reply: ' + error.message);
        return;
    }

    const s = document.getElementById('adminCommentSearchInput');
    renderAdminCommentsList(s ? s.value.trim() : '');
    if (commentsCurrentMovieId === movieId) loadComments(movieId);
}

async function deleteCommentFromAdminList(commentId) {
    const ok = await showConfirmModal('Delete this comment? This cannot be undone.', { confirmText: 'Delete' });
    if (!ok) return;

    const { error } = await supabaseClient.from('comments').delete().eq('id', commentId);
    if (error) { console.error('Delete comment error:', error); showNoticeModal('❌ Could not delete comment: ' + error.message); return; }

    const s = document.getElementById('adminCommentSearchInput');
    renderAdminCommentsList(s ? s.value.trim() : '');
    if (commentsCurrentMovieId !== null) loadComments(commentsCurrentMovieId);
}

// ---------------- Small helpers: textarea grow, emoji picker ----------------

function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function toggleEmojiPicker(targetInputId, btnEl) {
    const existing = document.getElementById('quickEmojiPicker');
    if (existing) {
        const wasForSameInput = existing.dataset.for === targetInputId;
        existing.remove();
        if (wasForSameInput) return;
    }
    const picker = document.createElement('div');
    picker.id = 'quickEmojiPicker';
    picker.className = 'comment-emoji-picker';
    picker.dataset.for = targetInputId;
    picker.innerHTML = QUICK_EMOJIS.map(e => `<span onclick="insertEmoji('${targetInputId}','${e}')">${e}</span>`).join('');
    btnEl.parentElement.style.position = 'relative';
    btnEl.parentElement.appendChild(picker);
}

function insertEmoji(inputId, emoji) {
    const input = document.getElementById(inputId);
    if (input) {
        input.value += emoji;
        input.focus();
        autoGrowTextarea(input);
    }
    const picker = document.getElementById('quickEmojiPicker');
    if (picker) picker.remove(); 
}

// Close open emoji/reaction pickers when clicking elsewhere
document.addEventListener('click', (e) => {
    if (!e.target.closest('.comment-emoji-btn') && !e.target.closest('.comment-emoji-picker')) {
        const p = document.getElementById('quickEmojiPicker');
        if (p) p.remove();
    }
    if (!e.target.closest('.comment-react-btn') && !e.target.closest('.comment-reaction-picker')) {
        document.querySelectorAll('.comment-reaction-picker').forEach(p => p.style.display = 'none');
    }
});

// ==================== VISITOR COUNTRY BADGE (auto, above logo) ====================
// Logo-r upore YouTube-style chhoto country badge dekhায়, visitor-er IP theke
// automatically desh detect kore. Fail hole ba API slow hole badge simply hidden
// thake - eta kono blocking call na, tai page/logo load-e kono delay hoy na.
(function () {
    function showBadge(countryCode) {
        // header-er logo + auth page-er logo - দুই জায়গাতেই একইসাথে বসিয়ে দেওয়া হয়
        const badges = document.querySelectorAll('.logo-country-badge');
        if (!badges.length || !countryCode) return;
        badges.forEach(function (badge) {
            badge.textContent = countryCode.toUpperCase();
            badge.classList.add('show');
        });
    }

    function tryFetchCountry(providers, index) {
        if (index >= providers.length) return;
        const provider = providers[index];
        const bustParam = (provider.url.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
        fetch(provider.url + bustParam, { cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
            .then(function (data) {
                const code = provider.extract(data);
                if (!code) { tryFetchCountry(providers, index + 1); return; }
                showBadge(code);
            })
            .catch(function () { tryFetchCountry(providers, index + 1); });
    }

    function init() {
        // প্রতিবার page load/refresh-এ fresh IP detect করা হয় (VPN দিয়ে test করার সময় যেন
        // পুরনো cached দেশ আটকে না থাকে)। কিছু free GeoIP provider - একটা fail/block হলে
        // পরেরটা try করা হয়।
        const providers = [
            { url: 'https://get.geojs.io/v1/ip/country.json', extract: function (d) { return d && d.country; } },
            { url: 'https://ipwho.is/', extract: function (d) { return d && d.country_code; } },
            { url: 'https://ipapi.co/json/', extract: function (d) { return d && d.country_code; } }
        ];
        tryFetchCountry(providers, 0);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
