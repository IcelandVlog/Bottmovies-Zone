const OMDB_API_KEY = "d246cca2"; 
const TMDB_API_KEY = "ffa63099e82a2b25d082dcd0c040c8fb"; 
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

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
            let initialCategory = window.location.hash.replace('#', '');
            if (!initialCategory) {
                initialCategory = document.body.getAttribute('data-category') || 'all';
            }
            switchCategory(initialCategory);
        } else {
            console.warn('No movies found in database.');
        }
    } catch (err) {
        console.error('Unexpected error loading database:', err);
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

// নিয়ম: যেকোনো ডিভাইসে ১ লাইনে সর্বোচ্চ ৫টা কন্টেন্ট।
// ১ লাইনে ৩ বা ৪টা কন্টেন্ট থাকলে প্রতি পেজে ১২টা কন্টেন্ট,
// বাকি সব ক্ষেত্রে (২ বা ৫টা) প্রতি পেজে ১০টা কন্টেন্ট।
function getMoviesPerPage() {
    let cols = getGridColumnsCount();
    if (cols > 5) cols = 5;
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

        card.innerHTML = `
        <div class="poster-wrapper">
            <div class="poster-rating-badge" id="card-rating-${index}">
                <span>★</span> N/A
            </div>
            <img src="${POSTER_PLACEHOLDER_LOADING}" id="card-poster-${index}" alt="${movie.title}" referrerpolicy="no-referrer" onerror="handlePosterImgError(this)">
        </div>
        <div class="movie-details"><p class="movie-title">${serialNumber}. ${movie.title}</p></div>
        `;

        card.addEventListener('click', () => openMovieModal(movie));
        grid.appendChild(card);

        getFullTMDBDetails(movie).then(tmdb => {
            const imgEl = document.getElementById(`card-poster-${index}`);
            const resolvedPoster = movie.poster || (tmdb && tmdb.poster) || null;
            if (imgEl && resolvedPoster) {
                imgEl.src = resolvedPoster;
            }
            const ratingEl = document.getElementById(`card-rating-${index}`);
            if (ratingEl && tmdb && tmdb.tmdbRating !== "N/A") {
                ratingEl.innerHTML = `<span>★</span> ${tmdb.tmdbRating}`;
            }

            getOMDbDetails(movie).then(omdb => {
                if (imgEl && !resolvedPoster && omdb && omdb.poster) {
                    imgEl.src = omdb.poster;
                }
                const finalRating = getSmartRating(tmdb, omdb);
                if (ratingEl && finalRating !== "N/A") {
                    ratingEl.innerHTML = `<span>★</span> ${finalRating}`;
                }
            });
        });
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
                            <a href="${it.link}" target="_blank" class="btn-zip-download" id="dl-link-${uid}" onclick="incrementMovieViews(currentModalMovie)">Download ${fileTypeLabel}</a>
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
                            <a href="${sec.link}" target="_blank" class="btn-zip-download" id="dl-link-${idx}" onclick="incrementMovieViews(currentModalMovie)">Download ${fileTypeLabel}</a>
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
                    <div id="modalDirectorDiv"><strong>DIRECTOR</strong> ${director}</div>
                    <div id="modalWriterDiv"><strong>WRITER</strong> ${writer}</div>
                    <div id="modalCastDiv"><strong>CAST</strong> ${cast}</div>
                    <div><strong>AWARDS</strong> <span id="modalAwardsVal">${awards}</span></div>
                    <div class="meta-inline-group">
                        <div class="meta-inline-item" id="modalBudgetDiv"><strong>BUDGET</strong> ${budgetFormatted}</div>
                        <div class="meta-inline-item" id="modalRevenueDiv"><strong>REVENUE</strong> ${revenueFormatted}</div>
                    </div>
                </div>
                <div class="card-actions-row">
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

function switchCategory(category) {
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

    const targetHash = `#${category}`;
    if (window.location.protocol === 'file:') {
        if (window.location.hash !== targetHash) {
            window.location.hash = category;
        }
    } else {
        const cleanPath = window.location.pathname.replace(/index\.html$/, '');
        if (window.location.hash !== targetHash || window.location.pathname.includes('index.html')) {
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

        renderMoviesByPage(currentFilteredMovies, 1);
    }
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
        const currentHash = window.location.hash.replace('#', '');
        switchCategory(currentHash || 'all');
    });
}

function initApp() {

    loadAdminExtraCategories();

    if (sessionStorage.getItem('isAdminLoggedIn') === 'true') {
        openAdminPanel();
    }
    setupNavigation();

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
        searchInput.addEventListener('input', function() {
            const query = this.value.trim();

            if (query.toLowerCase() === ADMIN_TRIGGER_EMAIL.toLowerCase()) {
                this.value = '';
                searchSuggestions.innerHTML = '';
                searchSuggestions.style.display = 'none';
                openAdminPanel();
                return;
            }

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
        });
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

    supabaseClient.from('requests').insert([{ movie_title: name, reference_link: link || null, release_year: year || null }])
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
// ==================== ADMIN PANEL (Hidden Content Manager) ====================

let adminPanelInitialized = false;
let adminSelectedCategories = new Set();

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
    sessionStorage.setItem('isAdminLoggedIn', 'true');

    if (!adminPanelInitialized) {
        setupAdminPanel();
        adminPanelInitialized = true;
    }
    const overlay = document.getElementById('adminOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.body.classList.add('modal-open');
    switchAdminTab('add');
    resetAdminForm();
    renderAdminDatabaseList('');

    if (!adminCategoriesLoaded) {
        loadAdminExtraCategories();
    }
}

function closeAdminPanel() {
    sessionStorage.removeItem('isAdminLoggedIn');

    const overlay = document.getElementById('adminOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
}

function switchAdminTab(tab) {
    const addTab = document.getElementById('adminTabAdd');
    const manageTab = document.getElementById('adminTabManage');
    const commentsTab = document.getElementById('adminTabComments');
    const trashTab = document.getElementById('adminTabTrash');
    const addBtn = document.getElementById('adminTabBtnAdd');
    const manageBtn = document.getElementById('adminTabBtnManage');
    const commentsBtn = document.getElementById('adminTabBtnComments');
    const trashBtn = document.getElementById('adminTabBtnTrash');
    if (!addTab || !manageTab || !commentsTab || !trashTab || !addBtn || !manageBtn || !commentsBtn || !trashBtn) return;

    addTab.style.display = 'none';
    manageTab.style.display = 'none';
    commentsTab.style.display = 'none';
    trashTab.style.display = 'none';
    addBtn.classList.remove('active');
    manageBtn.classList.remove('active');
    commentsBtn.classList.remove('active');
    trashBtn.classList.remove('active');

    if (tab === 'manage') {
        manageTab.style.display = 'block';
        manageBtn.classList.add('active');
        const searchInput = document.getElementById('adminSearchInput');
        renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
    } else if (tab === 'comments') {
        commentsTab.style.display = 'block';
        commentsBtn.classList.add('active');
        const searchInput = document.getElementById('adminCommentSearchInput');
        renderAdminCommentsList(searchInput ? searchInput.value.trim() : '');
    } else if (tab === 'trash') {
        trashTab.style.display = 'block';
        trashBtn.classList.add('active');
        renderAdminTrashList();
    } else {
        addTab.style.display = 'block';
        addBtn.classList.add('active');
    }
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

    const adminCommentSearchInput = document.getElementById('adminCommentSearchInput');
    if (adminCommentSearchInput) {
        adminCommentSearchInput.addEventListener('input', function() {
            renderAdminCommentsList(this.value.trim());
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

async function mediaScanProbeVideoFile(file, onProgress) {
    const ffmpeg = await mediaScanEnsureFFmpeg(onProgress);
    const extMatch = file.name.match(/\.[a-zA-Z0-9]+$/);
    const safeName = 'probe_input' + (extMatch ? extMatch[0] : '.mkv');

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

        // Probed the whole file already, or found tracks - either way, stop here.
        if (foundSomething || probeBlob === file || i === MEDIA_SCAN_CHUNK_BYTES.length - 1) {
            return result;
        }
    }
    return { audio: [], subtitle: [] };
}

function mediaScanFormatList(list) {
    const clean = list.filter(Boolean);
    if (clean.length === 0) return '';
    return `(${clean.length})- ${clean.join(', ')}`;
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

        const audioStr = mediaScanFormatList(result.audio);
        const subStr = mediaScanFormatList(result.subtitle);

        if (!audioStr && !subStr) {
            setStatus('No audio or subtitle language tags were detected in this file.', 'error');
            return;
        }

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
        setStatus('Scan complete — Audio and Subtitles fields updated.', 'ok');
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
        container.innerHTML = '<div class="admin-db-empty">No content found.</div>';
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
        container.innerHTML = '<div class="admin-db-empty">Recycle Bin is empty.</div>';
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

// ---------- 🔔 Broken Link Alerts (admin panel) ----------
// Requires the "link_alerts" table. See link_alerts_schema.sql for the one-time database setup.

async function fetchLinkAlerts() {
    try {
        const { data, error } = await supabaseClient
            .from('link_alerts')
            .select('*')
            .eq('status', 'open')
            .order('created_at', { ascending: false });

        if (error) { console.error('Error fetching link alerts:', error.message); return; }
        allLinkAlerts = data || [];
        updateAdminAlertsBadge();
    } catch (err) {
        console.error('Unexpected error loading link alerts:', err);
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

    const source = Array.isArray(allLinkAlerts) ? allLinkAlerts : [];
    if (source.length === 0) {
        container.innerHTML = '<div class="admin-db-empty">কোনো Broken Link Alert নেই। সব লিংক ঠিক আছে ✅</div>';
        return;
    }

    source.forEach(alert => {
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-alert-card';
        const isAuto = alert.source === 'auto_check';
        const sourceTag = isAuto ? '<span class="admin-alert-source-tag auto">🤖 Auto-Check</span>' : '<span class="admin-alert-source-tag">👤 Visitor Report</span>';
        const timeAgo = formatTimeAgo(alert.created_at) || '';
        card.innerHTML = `
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
let lastUsedGuestName = ''; // in-memory only, resets on page reload

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

function renderCommentComposer() {
    const wrap = document.getElementById('commentComposerWrap');
    if (!wrap) return;
    wrap.innerHTML = `
    <div class="comment-input-row">
        <div class="comment-avatar" id="commentComposerAvatar">${commentInitial(lastUsedGuestName || 'G')}</div>
        <div class="comment-input-box">
            <input type="text" id="commentNameInput" class="comment-name-input" placeholder="Your name" maxlength="40" value="${escapeHtml(lastUsedGuestName)}" oninput="updateComposerAvatar()">
            <textarea id="commentMainInput" class="comment-textarea" placeholder="Share your thoughts..." rows="1" oninput="autoGrowTextarea(this)"></textarea>
            <div class="comment-input-actions">
                <span class="comment-emoji-btn" onclick="toggleEmojiPicker('commentMainInput', this)">🙂</span>
                <span></span>
                <button type="button" class="comment-submit-btn" onclick="submitTopLevelComment()">COMMENT</button>
            </div>
        </div>
    </div>`;
}

function updateComposerAvatar() {
    const nameInput = document.getElementById('commentNameInput');
    const avatar = document.getElementById('commentComposerAvatar');
    if (nameInput && avatar) avatar.textContent = commentInitial(nameInput.value || 'G');
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
    const isAdminViewer = sessionStorage.getItem('isAdminLoggedIn') === 'true';
    const name = comment.guest_name || 'Guest';
    const isAdminComment = !!comment.is_admin;
    const timeLabel = formatTimeAgo(comment.created_at) || 'just now';
    const { reactionBadge, reactPicker } = renderReactionControls(comment);
    const deleteBtn = isAdminViewer
        ? `<span class="comment-delete-btn" onclick="deleteCommentInline(${comment.id})" title="Delete comment">🗑</span>` : '';

    return `
        <div class="comment-avatar${isAdminComment ? ' admin-avatar' : ''}">${commentInitial(name)}</div>
        <div class="comment-content-col">
            <div class="comment-meta-row">
                <span class="comment-author-name">${escapeHtml(name)}</span>
                ${isAdminComment ? '<span class="comment-admin-badge">Admin</span>' : ''}
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

    wrap.style.display = 'block';
    wrap.innerHTML = `
        <div class="comment-input-row reply-input-row">
            <div class="comment-avatar" id="replyAvatar-${commentId}">${commentInitial(lastUsedGuestName || 'G')}</div>
            <div class="comment-input-box">
                <input type="text" id="replyNameInput-${commentId}" class="comment-name-input" placeholder="Your name" maxlength="40" value="${escapeHtml(lastUsedGuestName)}" oninput="updateReplyAvatar(${commentId})">
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
}

function updateReplyAvatar(commentId) {
    const nameInput = document.getElementById(`replyNameInput-${commentId}`);
    const avatar = document.getElementById(`replyAvatar-${commentId}`);
    if (nameInput && avatar) avatar.textContent = commentInitial(nameInput.value || 'G');
}

function submitTopLevelComment() {
    const nameInput = document.getElementById('commentNameInput');
    const input = document.getElementById('commentMainInput');
    const name = (nameInput.value || '').trim();
    const text = (input.value || '').trim();
    if (!name) { nameInput.focus(); showNoticeModal('Please enter your name before commenting.'); return; }
    if (!text) return;
    postComment(text, null, name);
}

function submitReply(parentId) {
    const nameInput = document.getElementById(`replyNameInput-${parentId}`);
    const input = document.getElementById(`replyInput-${parentId}`);
    const name = (nameInput.value || '').trim();
    const text = (input.value || '').trim();
    if (!name) { nameInput.focus(); showNoticeModal('Please enter your name before replying.'); return; }
    if (!text) return;
    postComment(text, parentId, name);
}

async function postComment(content, parentId, name) {
    if (!name || commentsCurrentMovieId === null) return;

    const { error } = await supabaseClient.from('comments').insert([{
        movie_id: commentsCurrentMovieId,
        parent_id: parentId || null,
        guest_name: name.slice(0, 40),
        content: content.slice(0, 1000),
        is_admin: sessionStorage.getItem('isAdminLoggedIn') === 'true'
    }]);

    if (error) {
        console.error('Comment post error:', error);
        showNoticeModal('❌ Could not post comment: ' + error.message);
        return;
    }

    lastUsedGuestName = name; // remembered in memory only, for this page view

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
    if (sessionStorage.getItem('isAdminLoggedIn') !== 'true') return;
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
                    ${escapeHtml(c.guest_name || 'Guest')}${c.is_admin ? ' <span class="comment-admin-badge">Admin</span>' : ''}
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
        const badge = document.getElementById('logoCountryBadge');
        if (!badge || !countryCode) return;
        badge.textContent = countryCode.toUpperCase();
        badge.classList.add('show');
    }

    function tryFetchCountry(providers, index) {
        if (index >= providers.length) return;
        const provider = providers[index];
        fetch(provider.url)
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
