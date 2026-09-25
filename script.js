const OMDB_API_KEY = "d246cca2"; 
const TMDB_API_KEY = "ffa63099e82a2b25d082dcd0c040c8fb"; 
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const YOUTUBE_API_KEY = "AIzaSyDPOJwkO3l_5mCVm4iZw3qyrinryWckrG4";

const tmdbDetailsCache = new Map();
const omdbDetailsCache = new Map();
const youtubeTrailerCache = new Map();
let lastYoutubeTrailerError = null;

// --- Persistent (localStorage) trailer cache -------------------------------
// YouTube Data API free quota is small (100 search calls/day by default) and
// every uncached call costs quota, so resolved trailer keys - including
// "not found" results - are kept in localStorage across page loads/sessions.
// This is the main fix for the "Quota exceeded ... search_list" 429 error.
// v1 -> v2: title-matching logic strict kora hoyeche (age onek khetre vul
// trailer cache hoye giyechilo - naame mil na thakleo cache hoye jeto), tai
// version bariye purono (somvoto vul) cache-gula automatically invalidate
// kora hocche - shobar browser-e notun kore fresh/thik trailer khoja hobe.
const YT_TRAILER_STORAGE_KEY = 'bmz_yt_trailer_cache_v2';
const YT_TRAILER_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days for a found trailer
const YT_TRAILER_MISS_TTL_MS = 24 * 60 * 60 * 1000;         // 1 day for "nothing found"

function loadYoutubeTrailerStore() {
    try {
        const raw = localStorage.getItem(YT_TRAILER_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}
function saveYoutubeTrailerStore(store) {
    try { localStorage.setItem(YT_TRAILER_STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* storage full/disabled - ignore */ }
}
function getPersistedTrailerKey(cacheKey) {
    const store = loadYoutubeTrailerStore();
    const entry = store[cacheKey];
    if (!entry) return undefined; // no entry at all
    const ttl = entry.videoId ? YT_TRAILER_FOUND_TTL_MS : YT_TRAILER_MISS_TTL_MS;
    if (Date.now() - entry.ts > ttl) return undefined; // expired
    return entry.videoId; // may be null (cached "not found")
}
function setPersistedTrailerKey(cacheKey, videoId) {
    const store = loadYoutubeTrailerStore();
    store[cacheKey] = { videoId: videoId || null, ts: Date.now() };
    saveYoutubeTrailerStore(store);
}

// TMDB nijer "videos" data-tei prai shob jonopriyo movie/show-r official
// trailer thake - eta ekdom free, kono YouTube quota lage na. Tai eta-i
// shobar age check kora hoy; shudhu eta na thakle YouTube Search API-e
// jawa hoy (seta quota-costly, tai last resort).
function pickTmdbTrailerKey(detailData) {
    const results = detailData && detailData.videos && Array.isArray(detailData.videos.results)
        ? detailData.videos.results
        : [];
    return pickBestTrailerFromResults(results);
}

function pickBestTrailerFromResults(results) {
    const onYoutube = (results || []).filter(v => v && v.site === 'YouTube' && v.key);
    if (!onYoutube.length) return null;

    const byType = (type) =>
        onYoutube.find(v => v.type === type && v.official) ||
        onYoutube.find(v => v.type === type);

    // Shudhu "Trailer" othoba "Teaser" type-i neya hobe - Clip/Featurette/
    // Behind the Scenes/Bloopers ইত্যাদি onno kono video type fallback
    // hishebe o neya hobe na. Kono Trailer/Teaser na thakle null return
    // hobe (caller tokhon YouTube Search-e giye khujbe).
    const pick = byType('Trailer') || byType('Teaser');
    return pick ? pick.key : null;
}

// Series-er khetre show-er "overall" trailer na dekhiye shobcheye latest/notun
// season-er trailer dekhano hoy - ar notun season TMDB-e add hole (number_of_seasons
// baarle) automatic-i shei notun season-er trailer dekhabe, karon cache key-tei
// season number dhora thake (nichey dekho).
const seasonTrailerCache = new Map();
async function getLatestSeasonTrailerKey(tvId, seasonNumber) {
    if (!TMDB_API_KEY || tvId == null || seasonNumber == null) return null;
    const cacheKey = `tv:${tvId}:s${seasonNumber}`;
    if (seasonTrailerCache.has(cacheKey)) return seasonTrailerCache.get(cacheKey);

    const promise = (async () => {
        try {
            const res = await fetchWithTimeout(`${TMDB_BASE_URL}/tv/${tvId}/season/${seasonNumber}/videos?api_key=${TMDB_API_KEY}`, {}, 6000);
            if (!res.ok) return null;
            const data = await res.json();
            return pickBestTrailerFromResults(data.results);
        } catch (e) {
            console.error('TMDB season videos error:', e);
            return null;
        }
    })();

    seasonTrailerCache.set(cacheKey, promise);
    return promise;
}

// Season-specific video na paoya gele (khub common - TMDB-e beshirbhag
// season-er jonno আলাদা video thake na, shudhu show/overall-level-e thake)
// eta fallback hishebe show-level (/tv/{id}/videos) trailer khoje - initial
// modal-load-er "pickTmdbTrailerKey(detailData)" step-er shathe consistent,
// jate season switch korar shomoy-o ekই fallback chain mena hoy.
const showTrailerCache = new Map();
async function getShowLevelTrailerKey(tvId) {
    if (!TMDB_API_KEY || tvId == null) return null;
    const cacheKey = `tv:${tvId}:show`;
    if (showTrailerCache.has(cacheKey)) return showTrailerCache.get(cacheKey);

    const promise = (async () => {
        try {
            const res = await fetchWithTimeout(`${TMDB_BASE_URL}/tv/${tvId}/videos?api_key=${TMDB_API_KEY}`, {}, 6000);
            if (!res.ok) return null;
            const data = await res.json();
            return pickBestTrailerFromResults(data.results);
        } catch (e) {
            console.error('TMDB show-level videos error:', e);
            return null;
        }
    })();

    showTrailerCache.set(cacheKey, promise);
    return promise;
}

function getLatestRealSeasonNumber(detailData) {
    if (!detailData || !Array.isArray(detailData.seasons) || !detailData.seasons.length) return null;
    // season_number 0 shadharonoto "Specials" - shei-ta baad diye asol shobcheye
    // notun season-take dhora hoy.
    const real = detailData.seasons.filter(s => s && typeof s.season_number === 'number' && s.season_number > 0);
    const pool = real.length ? real : detailData.seasons;
    return pool.reduce((max, s) => (s.season_number > max ? s.season_number : max), pool[0].season_number);
}

// Trailer na paoya gele (kono season-er trailer TMDB/YouTube kothao na thakle)
// age plain "No trailer found..." text dekhano hoto - ekhon eta-r bodole
// clock-icon soho ekta "Coming Soon" designed empty-state dekhano hoy, jate
// khali text-er bodole visually clear thake je trailer-ta pore add hobe.
function buildTrailerComingSoonHTML(subText) {
    return `
    <div class="trailer-empty-msg">
        <div class="trailer-empty-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/>
                <path d="M12 7.3V12l3.1 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <div class="trailer-empty-title">Coming Soon</div>
        <div class="trailer-empty-sub">${escapeAttr(subText || 'Trailer will be added soon')}</div>
    </div>`;
}

// Admin panel theke series-er kono ekta specific season-er jonno manually
// trailer link/thumbnail deya thakle (movie.seasonTrailers), seta returns kore.
// Na thakle null - tokhon caller auto (TMDB/YouTube) trailer khujbe.
function getManualSeasonTrailer(movie, seasonNumber) {
    if (!movie || seasonNumber == null || !Array.isArray(movie.seasonTrailers) || !movie.seasonTrailers.length) return null;
    const entry = movie.seasonTrailers.find(st => st && Number(st.season) === Number(seasonNumber));
    if (!entry) return null;
    // Admin shudhu Thumbnail dile-o (YouTube link na diyeও) eta kaje lage -
    // tokhon "key" null thake (mane video-r jonno auto/TMDB trailer-i use
    // hobe), kintu "thumb"-ta admin-er deya custom-ta-i priority pabe. Dutoi
    // (link ar thumb) khali/invalid hole shudhu-i null return kore, jate
    // caller purapuri auto-e chole jete pare.
    const ytId = entry.link ? extractYoutubeVideoId(entry.link) : null;
    if (!ytId && !entry.thumb) return null;
    return { key: ytId, thumb: entry.thumb || (ytId ? `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg` : null) };
}

// Admin manually koyta season-er trailer add koreche tar modhye shobcheye
// boro season number-ta ber kore dey (jemon: Money Heist-e 5 number season
// porjonto trailer add kora thakle 5 return korbe). Eta diye season
// pill/dropdown-er count TMDB-er upor 100% depend na kore admin nijer deya
// data-o respect kore - TMDB-e kono karone kom season dekhale (data mismatch,
// wrong match, ইত্যাদি) o admin-er manually add kora shob season trailer
// jeno miss na hoy.
function getMaxManualSeasonNumber(movie) {
    if (!movie || !Array.isArray(movie.seasonTrailers) || !movie.seasonTrailers.length) return 0;
    let max = 0;
    movie.seasonTrailers.forEach(st => {
        const num = Number(st && st.season);
        if (Number.isFinite(num) && num > max) max = num;
    });
    return max;
}

// TMDB call fail/slow/timeout hoile (ba TMDB-er latest season number movie.seasonTrailers-e
// deya kono season-er shathe match na khele) admin-er manually deya season trailer jeno
// tobuo miss na hoy - shei jonno ei universal fallback: age "preferredSeason" (TMDB theke
// paoa) try kora hoy, na thakle/match na khele movie.seasonTrailers-er modhye shobcheye
// boro (latest) season number-er entry-take use kora hoy.
function resolveManualSeasonTrailerFallback(movie, isTV, preferredSeason) {
    if (!isTV || !movie || !Array.isArray(movie.seasonTrailers) || !movie.seasonTrailers.length) return null;
    if (preferredSeason != null) {
        const direct = getManualSeasonTrailer(movie, preferredSeason);
        if (direct) return { key: direct.key, thumb: direct.thumb, season: preferredSeason };
    }
    let bestSeason = null;
    movie.seasonTrailers.forEach(st => {
        const num = Number(st && st.season);
        if (Number.isFinite(num) && (bestSeason == null || num > bestSeason)) bestSeason = num;
    });
    if (bestSeason == null) return null;
    const fallback = getManualSeasonTrailer(movie, bestSeason);
    return fallback ? { key: fallback.key, thumb: fallback.thumb, season: bestSeason } : null;
}

// ---- Watch button-er jonno-o series-er per-season manual link (nicher tin-ta
// function) - Trailer tab-er upore-r tin-ta function-er ekdom ekই pattern,
// shudhu YouTube video-ID ber kora lage na (Watch link jekono embed URL hote
// pare), tai shorashori raw link-i return kora hoy. ----

// Admin panel theke series-er kono ekta specific season-er jonno manually
// Watch link deya thakle (movie.watchSeasonLinks), seta return kore. Na thakle
// null - tokhon caller legacy flat "watchLink" field ba auto TMDB embed
// byabohar korbe.
function getManualSeasonWatchLink(movie, seasonNumber, episodeNumber) {
    if (!movie || seasonNumber == null || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return null;
    if (episodeNumber != null) {
        const exact = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && sw.episode != null && Number(sw.episode) === Number(episodeNumber));
        if (exact && exact.link) return exact.link;
    }
    const seasonWide = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && (sw.episode == null || sw.episode === ''));
    return (seasonWide && seasonWide.link) ? seasonWide.link : null;
}

// Admin manually koyta season-er Watch link add koreche tar modhye shobcheye
// boro season number-ta ber kore dey - Season dropdown-e "kotogula option
// dekhabe" ar "default-e kon-ta select thakbe" eta thik korte lage.
function getMaxManualWatchSeasonNumber(movie) {
    if (!movie || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return 0;
    let max = 0;
    movie.watchSeasonLinks.forEach(sw => {
        const num = Number(sw && sw.season);
        if (Number.isFinite(num) && num > max) max = num;
    });
    return max;
}

// Nirdishto ekta season-er jonno admin je-je EPISODE-er alada link diyeche,
// shegular EPISODE number-er sorted (choto theke boro) list return kore
// (link thaka episode-i shudhu) - Episode dropdown banano ar default episode
// thik korar jonno lage. Kono nirdishto episode na thakle (shudhu "gota
// season" entry thakle) - khali array return kore, tokhon caller Episode
// dropdown-i dekhabe na (season-wide link-e-i shob episode chole jay).
function getManualEpisodesForSeason(movie, seasonNumber) {
    if (!movie || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return [];
    return movie.watchSeasonLinks
        .filter(sw => sw && Number(sw.season) === Number(seasonNumber) && sw.link && sw.episode != null && Number.isFinite(Number(sw.episode)))
        .map(sw => Number(sw.episode))
        .sort((a, b) => a - b);
}

// Admin jodi "Episode" field-e shudhu number na diye nijer kono TEXT label
// (jemon "Finale", "EP 3 (Hindi)") likhe thake - shei lekha-ta ber kore dey.
// Na dile null (tokhon caller shadharon "Episode 3" / "EP-03" format byabohar
// korbe).
function getManualEpisodeLabel(movie, seasonNumber, episodeNumber) {
    if (!movie || !Array.isArray(movie.watchSeasonLinks) || episodeNumber == null) return null;
    const entry = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && sw.episode != null && Number(sw.episode) === Number(episodeNumber));
    const label = entry && entry.epLabel != null ? String(entry.epLabel).trim() : '';
    return label || null;
}

// Thik ek-i bhabe - admin jodi "Season" dropdown-er default "Season {N}"
// text-er bodole nijer kono custom nam (jemon "সিজন ৫", "Bachelor Point S5")
// diye thake - shei nam ber kore dey. Na dile null (tokhon caller shadharon
// "Season {N}" format byabohar korbe).
function getManualSeasonLabel(movie, seasonNumber) {
    if (!movie || !Array.isArray(movie.watchSeasonLinks) || seasonNumber == null) return null;
    const entry = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && sw.seasonLabel && String(sw.seasonLabel).trim());
    return entry ? String(entry.seasonLabel).trim() : null;
}

// Ekta season-er jonno "default" (shobcheye choto/prothom) manually-added
// episode number ber kore dey - kono nirdishto episode na thakle (shudhu
// gota-season entry) - null return kore (mane "shob episode-e-i ekই link").
function resolveDefaultEpisodeForSeason(movie, seasonNumber) {
    const episodes = getManualEpisodesForSeason(movie, seasonNumber);
    return episodes.length ? episodes[0] : null;
}

// preferredSeason (ar oi season-er default episode, thakle)-er jonno manual
// watch link thakle seta, na thakle shobcheye boro (latest) manually-added
// season-take (nijer default episode-shoho) fallback hishebe dey.
function resolveManualSeasonWatchLinkFallback(movie, isTV, preferredSeason) {
    if (!isTV || !movie || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return null;
    let bestSeason = null;
    if (preferredSeason != null) {
        const defaultEp = resolveDefaultEpisodeForSeason(movie, preferredSeason);
        if (getManualSeasonWatchLink(movie, preferredSeason, defaultEp)) bestSeason = preferredSeason;
    }
    if (bestSeason == null) {
        movie.watchSeasonLinks.forEach(sw => {
            const num = Number(sw && sw.season);
            if (Number.isFinite(num) && (bestSeason == null || num > bestSeason)) bestSeason = num;
        });
    }
    if (bestSeason == null) return null;
    const defaultEpisode = resolveDefaultEpisodeForSeason(movie, bestSeason);
    const fallbackLink = getManualSeasonWatchLink(movie, bestSeason, defaultEpisode);
    return fallbackLink ? { link: fallbackLink, season: bestSeason, episode: defaultEpisode } : null;
}

// Admin panel theke series-er kono ekta specific season-er Watch Link row-e
// (Season + Link-er pashe) manually ekta Thumbnail-o deya thakle, seta return
// kore. Na thakle null - tokhon caller "Custom watch thumbnail" (global,
// shob season-er jonno common) field ba auto poster/backdrop byabohar korbe.
function getManualSeasonWatchThumb(movie, seasonNumber, episodeNumber) {
    if (!movie || seasonNumber == null || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return null;
    if (episodeNumber != null) {
        const exact = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && sw.episode != null && Number(sw.episode) === Number(episodeNumber));
        if (exact && exact.thumb) return exact.thumb;
    }
    const seasonWide = movie.watchSeasonLinks.find(sw => sw && Number(sw.season) === Number(seasonNumber) && (sw.episode == null || sw.episode === ''));
    return (seasonWide && seasonWide.thumb) ? seasonWide.thumb : null;
}

// "Online Watch" thumbnail/poster-er upore dekhano "EP-(01-02)" style
// episode-range label ber kore dey - shei season-e admin-er nijer deya kono
// custom label (Watch Button admin panel-er "Poster label" field) thakle
// shei-ta-i priority pay, na hole (season-e 1-er beshi alada EPISODE-specific
// manual link thakle) min-max episode number diye auto ekta range-label
// generate kora hoy (admin panel-er computeAutoWatchSeasonBadge()-er ekই
// logic mirror kora ache). Shudhu 1-ta (ba 0-ta) episode-specific link thakle
// - kono label dekhano hoy na (khali string), karon tokhon "range" bolar
// kichu nei.
function getManualSeasonWatchBadge(movie, seasonNumber) {
    if (!movie || seasonNumber == null || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return '';
    const seasonEntries = movie.watchSeasonLinks.filter(sw => sw && Number(sw.season) === Number(seasonNumber));
    if (!seasonEntries.length) return '';

    const customEntry = seasonEntries.find(sw => sw.badge && String(sw.badge).trim());
    if (customEntry) return String(customEntry.badge).trim();

    const epNums = seasonEntries
        .filter(sw => sw.episode != null && sw.episode !== '' && Number.isFinite(Number(sw.episode)))
        .map(sw => Number(sw.episode));
    if (epNums.length < 2) return '';
    const min = Math.min(...epNums);
    const max = Math.max(...epNums);
    const pad = n => String(n).padStart(2, '0');
    return min === max ? `EP-${pad(min)}` : `EP-(${pad(min)}-${pad(max)})`;
}

// Poster/thumbnail-er upore ASHOLE kon label-ta boshbe - seta ei function thik
// kore dey. Age shudhu getManualSeasonWatchBadge() (season-level, purো RANGE
// label - jemon "EP-(01-02)") byabohar hoto, tai Episode dropdown-e Episode 2
// select korleও poster-er badge-ta age-r-i (jemon "EP-01") theke jeto - eta-i
// shei bug-er fix.
//
// Niyom:
//  - Kono nirdishto episode select kora na thakle (movie, ba gota-season ekta
//    link) => age-r season-level label-i (thakle) dekhabe.
//  - Shei season-e 1-er beshi episode-specific link thakle (mane Episode
//    dropdown dekha jacche) => SELECTED episode-er number diye "EP-02" style
//    label toiri hoy, tai dropdown change korar shathe shathe poster-er number-o
//    change hoy.
//  - Admin jodi "Poster label" field-e episode-number-er bodole nijer kono
//    onno rokom text (jemon "Hindi Dubbed") diye thake - tahole shei custom
//    text-take-i somman kora hoy, override kora hoy na. Shudhu label-ta jodi
//    "EP-01" / "EP-(01-02)" dhoroner episode-label hoy, tokhon-i seta selected
//    episode diye replace hoy.
function getWatchThumbBadgeText(movie, seasonNumber, episodeNumber) {
    const seasonBadge = getManualSeasonWatchBadge(movie, seasonNumber);
    const epNum = Number(episodeNumber);
    if (episodeNumber == null || episodeNumber === '' || !Number.isFinite(epNum)) return seasonBadge;
    // Episode dropdown-i jodi na thake (season-e 1-tar beshi episode link nei),
    // tahole age-r behavior-i thak - khamokha notun badge dekhano hobe na.
    if (getManualEpisodesForSeason(movie, seasonNumber).length < 2) return seasonBadge;
    const isEpisodeStyleLabel = !seasonBadge || /^ep[\s\-._]*\(?\s*\d/i.test(seasonBadge.trim());
    if (!isEpisodeStyleLabel) return seasonBadge;
    // Admin oi episode-er jonno nijer TEXT label likhe thakle - poster-er
    // badge-eও hubohu shei lekha-i boshe.
    const customEpLabel = getManualEpisodeLabel(movie, seasonNumber, epNum);
    if (customEpLabel) return customEpLabel;
    return `EP-${String(epNum).padStart(2, '0')}`;
}

// Video title-e thaka "reaction/review/recap" type shobdo dekhle shei video-take
// bad deya hoy - eigulote 'trailer' shobdo thaka sotteo eta আসল trailer na,
// third-party commentary/reaction video (jeta age bad porto na, karon age
// শুধু 'trailer'/'teaser' shobdo thakleই match hoye jeto).
const YT_NEGATIVE_KEYWORDS = ['reaction', 'react', 'review', 'recap', 'explained', 'breakdown', 'analysis', 'easter egg', 'parody', 'fan made', 'fanmade', 'fan-made', 'concept trailer', 'concept teaser', 'deleted scene', 'mashup', 'compilation', 'edit)', '(edit', 'top 10', 'top 5'];

// Movie/show-er title theke "the", "a", "of" ইত্যাদি common/stopword ar khub
// choto (<=2 character) shobdo বাদ diye শুধু meaningful shobdogula ber kora
// hoy - eigula diyeই YouTube video-r title-er shathe আসল mil ache kina
// check kora hoy (age eta শুধু bonus score chilo, mandatory chilo na - fole
// "trailer" shobdo thakleই jekono onno movie/show-er video-o match hoye jeto).
const YT_TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'season']);
function getSignificantTitleWords(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !YT_TITLE_STOPWORDS.has(w));
}

// TMDB-e trailer na paoya gele (ba kono video-i na thakle) YouTube-e সরাসরি search kore
// shobcheye relevant + notun official trailer-take niye ashe. Client-side exposed key,
// tai Google Cloud Console-e "Websites" restriction diye site-r domain-e lock kora ache.
// Quota bachate age localStorage-e cache kora result check kora hoy (found ba not-found
// dutai), tারপর tobe live API call kora hoy।
async function searchYoutubeTrailer(title, year) {
    if (!YOUTUBE_API_KEY || !title) return null;
    const cacheKey = `${title.toLowerCase()}|${year || ''}`;
    if (youtubeTrailerCache.has(cacheKey)) return youtubeTrailerCache.get(cacheKey);

    const persisted = getPersistedTrailerKey(cacheKey);
    if (persisted !== undefined) {
        youtubeTrailerCache.set(cacheKey, Promise.resolve(persisted));
        return persisted;
    }

    const promise = (async () => {
        try {
            const query = `${title} ${year || ''} official trailer`.trim();
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=10&order=relevance&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
            const res = await fetchWithTimeout(url, {}, 6000);
            if (!res.ok) {
                // Failure-r asol karon (403 referrer block, quotaExceeded, keyInvalid, ইত্যাদি)
                // console-e log kora hocche, jate DevTools-e giye exact reason dekha jay -
                // noile trailer chupchap disappear hoye jay ar bujhar upay thake na keno.
                // Note: eta ar user-facing UI-te dekhano hoy na (dekhle nijer error dekhabe
                // shobaike, quota-o bachbe na) - shudhu console-e thake developer-r jonno.
                let errBody = '';
                try { errBody = JSON.stringify(await res.json()); } catch (e2) {}
                console.error(`YouTube trailer search failed (HTTP ${res.status}):`, errBody);
                lastYoutubeTrailerError = `HTTP ${res.status}: ${errBody}`;
                // Quota/rate-limit (429) hole "not found" hishebe short-TTL cache kore rakha
                // hoy, jate ei session-e baar baar retry kore quota aro na noshto hoy।
                if (res.status === 429 || res.status === 403) setPersistedTrailerKey(cacheKey, null);
                return null;
            }
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) {
                setPersistedTrailerKey(cacheKey, null);
                return null;
            }

            // Video-r title-e "trailer" othoba "teaser" shobdo na thakle shei video-take
            // ekdom বাদ deya hocche - clip/reaction/review/fan-made ba onno kono
            // অপ্রাসঙ্গিক video kokhono fallback hishebe neya hobe na. Trailer-ke
            // teaser-er cheye beshi priority deya hoy, tারপর official/title-match diye
            // sheshbar tie-break kora hoy।
            const lowerTitle = title.toLowerCase();
            const titleWords = getSignificantTitleWords(title);
            const scored = items
                .filter(it => it.id && it.id.videoId)
                .map(it => {
                    const vTitle = (it.snippet && it.snippet.title || '').toLowerCase();
                    const isTrailer = vTitle.includes('trailer');
                    const isTeaser = vTitle.includes('teaser');
                    const hasNegative = YT_NEGATIVE_KEYWORDS.some(k => vTitle.includes(k));
                    // Title-er meaningful shobdogula theke koyta video-r title-e ache seta
                    // count kora hoy - kono ekta shobdo match na khele (titleWords thakle)
                    // eta pura অপ্রাসঙ্গিক video, বাদ deya hobe. Ekta shobdo-r (jemon "Cross")
                    // khetre shei ekta-i thik moto match korte hobe.
                    const matchedWordsCount = titleWords.filter(w => vTitle.includes(w)).length;
                    const titleMatches = titleWords.length === 0 || matchedWordsCount === titleWords.length || (titleWords.length > 2 && matchedWordsCount >= Math.ceil(titleWords.length * 0.7));
                    let score = 0;
                    if (isTrailer) score += 3;
                    else if (isTeaser) score += 2;
                    if (vTitle.includes(lowerTitle)) score += 1;
                    if (vTitle.includes('official')) score += 1;
                    score += matchedWordsCount;
                    return { videoId: it.id.videoId, publishedAt: it.snippet && it.snippet.publishedAt, score, isTrailer, isTeaser, hasNegative, titleMatches };
                })
                .filter(v => (v.isTrailer || v.isTeaser) && !v.hasNegative && v.titleMatches)
                .sort((a, b) => b.score - a.score || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

            const result = scored.length ? scored[0].videoId : null;
            setPersistedTrailerKey(cacheKey, result);
            return result;
        } catch (e) {
            console.error('YouTube trailer search error:', e);
            lastYoutubeTrailerError = `Network/JS error: ${e && e.message ? e.message : e}`;
            return null;
        }
    })();

    youtubeTrailerCache.set(cacheKey, promise);
    return promise;
}



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

// ==================== TERABOX PLAY & DOWNLOAD API ====================
// Terabox share link -> stream/download URL resolver. Content-er "Tera Play"
// toggle (Admin -> Watch Button tab, column: movies."teraPlayEnabled") ON thakle
// Terabox download link-er pashe "▶ Play" button ashe.
//
// API: PlayTeraBox  ->  GET https://api.playterabox.com/api/proxy?url=<terabox link>  +  header  secret: <API KEY>
// endpoint khali thakle Play button kokhono dekhano hoy na (site bhange na).
let TERA_API_KEY = 'pk_cltx4au47sqf03z97t9tl';
const TERA_API_CONFIG = {
    endpoint: 'https://api.playterabox.com/api/proxy',   // PlayTeraBox API Playground: GET /api/proxy
    method: 'GET',           // 'GET' ba 'POST' (POST hole JSON body-te link jay)
    linkParam: 'url',        // link-er param/field-er naam (docs: {"url": "terabox link"})
    keyMode: 'query',        // 'header' | 'query' | 'body'  (API: ?url=...&secret=KEY)
    keyName: 'secret',       // docs: header  secret: <API KEY>
    keyPrefix: '',           // Bearer token hole 'Bearer ' likho, keyName = 'Authorization'
    fallbackToPost: true,    // GET fail korle (CORS/4xx) ekbar POST + JSON body diye try korbe
    proxyEndpoint: '/api/tera', // Server-side proxy (api/tera.js). Age eta try hoy: CORS problem nei + key browser-e lage na. Na thakle direct API try hoy.
    debug: true              // true thakle error-er asol karon panel-e dekhay. Sob thik hole false koro.
};

// ---- Multi-API pool (Supabase table: tera_apis) ----
// Ekadhik Terabox-resolver API save rakha jay. Ekta-r credit/limit shesh hoye
// gele (401/403/429/quota error) proxy (api/tera.js) automatic porer active
// API-te switch kore dey - kono deploy/code change lage na. Admin -> Watch
// Button tab-e pura list, current active API, ar remaining play count dekha jay.
let teraApiPoolCache = null; // { ts, list } - list: sob API row, priority order-e

async function fetchTeraApiPool(force) {
    if (!force && teraApiPoolCache && Date.now() - teraApiPoolCache.ts < 15000) return teraApiPoolCache.list;
    const { data, error } = await supabaseClient
        .from('tera_apis')
        .select('*')
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true });
    if (error) { console.warn('[Tera Play] tera_apis load fail (SUPABASE_TERA_API_SETTINGS.sql run kora hoyeche to?):', error); return teraApiPoolCache ? teraApiPoolCache.list : []; }
    teraApiPoolCache = { ts: Date.now(), list: data || [] };
    return teraApiPoolCache.list;
}

// Client-side direct-fallback (proxy pura fail korle) er jonno shobcheye upore
// thaka "active" API-take TERA_API_CONFIG/TERA_API_KEY-e boshiye dey.
async function loadTeraApiConfig() {
    try {
        const list = await fetchTeraApiPool(true);
        const active = list.find(a => a.status === 'active');
        if (!active) return;
        TERA_API_CONFIG.endpoint = active.endpoint;
        TERA_API_CONFIG.keyName = active.key_name || 'secret';
        TERA_API_KEY = active.api_key;
        teraResolveCache.clear();
    } catch (e) {
        console.warn('[Tera Play] config load fail:', e);
    }
}

// Admin-only CRUD - notun API add, edit, delete, priority move, reset/reactivate
async function adminAddTeraApi({ name, endpoint, key, keyName, limit }) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const list = await fetchTeraApiPool(true);
    const maxPriority = list.reduce((m, a) => Math.max(m, a.priority || 0), -1);
    const { error } = await supabaseClient.from('tera_apis').insert({
        name: (name || '').trim() || 'API', endpoint: (endpoint || '').trim(),
        api_key: (key || '').trim(), key_name: (keyName || '').trim() || 'secret',
        credit_limit: limit ? parseInt(limit, 10) : null, priority: maxPriority + 1, status: 'active'
    });
    if (error) throw error;
    teraApiPoolCache = null; teraResolveCache.clear();
}
async function adminUpdateTeraApi(id, { name, endpoint, key, keyName, limit }) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const { error } = await supabaseClient.from('tera_apis').update({
        name: (name || '').trim() || 'API', endpoint: (endpoint || '').trim(),
        api_key: (key || '').trim(), key_name: (keyName || '').trim() || 'secret',
        credit_limit: limit ? parseInt(limit, 10) : null
    }).eq('id', id);
    if (error) throw error;
    teraApiPoolCache = null; teraResolveCache.clear();
}
async function adminDeleteTeraApi(id) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const { error } = await supabaseClient.from('tera_apis').delete().eq('id', id);
    if (error) throw error;
    teraApiPoolCache = null; teraResolveCache.clear();
}
// Exhausted API abar chalu (naya credit kine thakle) + used_count 0 kore dey
async function adminReactivateTeraApi(id) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const { error } = await supabaseClient.from('tera_apis').update({ status: 'active', used_count: 0 }).eq('id', id);
    if (error) throw error;
    teraApiPoolCache = null; teraResolveCache.clear();
}
async function adminToggleTeraApiDisabled(id, disable) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const { error } = await supabaseClient.from('tera_apis').update({ status: disable ? 'disabled' : 'active' }).eq('id', id);
    if (error) throw error;
    teraApiPoolCache = null; teraResolveCache.clear();
}
async function adminMoveTeraApiPriority(id, dir) {
    if (!isCurrentUserAdmin(currentAuthSession)) throw new Error('Admin only');
    const list = await fetchTeraApiPool(true);
    const idx = list.findIndex(a => a.id === id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
    const a = list[idx], b = list[swapIdx];
    const { error: e1 } = await supabaseClient.from('tera_apis').update({ priority: b.priority }).eq('id', a.id);
    const { error: e2 } = await supabaseClient.from('tera_apis').update({ priority: a.priority }).eq('id', b.id);
    if (e1 || e2) throw (e1 || e2);
    teraApiPoolCache = null; teraResolveCache.clear();
}

const TERA_LINK_REGEX = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;
const teraResolveCache = new Map(); // link -> { ts, data }  (stream URL expire hoy, tai 10 min TTL)
const TERA_CACHE_TTL_MS = 10 * 60 * 1000;

function isTeraboxLink(link) {
    return !!link && TERA_LINK_REGEX.test(String(link));
}
function isTeraPlayAvailable(movie, link) {
    return !!(TERA_API_CONFIG.endpoint && TERA_API_KEY && movie && movie.teraPlayEnabled === true && isTeraboxLink(link));
}
function teraPlayButtonHTML(movie, link, panelId) {
    if (!isTeraPlayAvailable(movie, link)) return '';
    return `<button type="button" class="btn-tera-play" data-link="${escapeAttr(link)}" data-panel="${escapeAttr(panelId)}" onclick="playTeraLink(this)">▶ Play</button>`;
}
function teraPanelHTML(movie, link, panelId) {
    return isTeraPlayAvailable(movie, link) ? `<div class="tera-play-panel" id="${escapeAttr(panelId)}"></div>` : '';
}

// API response shape provider-bhede alada hote pare, tai nested object-er moddhe
// known key-gulo khuje stream + download URL ber kora hoy.
function extractTeraUrlsGeneric(payload) {
    const streamKeys = ['stream_url', 'streaming_url', 'streamurl', 'stream', 'play_url', 'playurl', 'hls', 'hls_url', 'm3u8', 'm3u8_url', 'fast_stream_url', 'video_url', 'proxy_url', 'stream_link', 'streaming_link', 'play_link', 'fast_stream', 'fast_stream_link'];
    const dlKeys = ['download_link', 'download_url', 'downloadurl', 'dlink', 'direct_link', 'direct_url', 'dl_url', 'download', 'fast_download_link', 'fast_download_url'];
    const out = { stream: null, download: null, title: null, thumb: null };
    const seen = new Set();
    (function walk(node, depth) {
        if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
        for (const k of Object.keys(node)) {
            const v = node[k], lk = k.toLowerCase();
            if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
                if (!out.stream && streamKeys.includes(lk)) out.stream = v;
                else if (!out.download && dlKeys.includes(lk)) out.download = v;
                else if (!out.thumb && (lk === 'thumbnail' || lk === 'thumb' || lk === 'thumbs')) out.thumb = v;
            } else if (typeof v === 'string' && !out.title && (lk === 'file_name' || lk === 'filename' || lk === 'title' || lk === 'name')) {
                out.title = v;
            }
        }
        for (const k of Object.keys(node)) walk(node[k], depth + 1);
    })(payload, 0);
    return out;
}

// PlayTeraBox response: { status, total_files, list: [ { name, size_formatted, duration, quality,
//   download_link, fast_download_link, stream_url, fast_stream_url: {360p,480p,720p}, subtitle_url, thumbnail, is_dir, type } ] }
function extractTeraUrls(payload) {
    const list = payload && Array.isArray(payload.list) ? payload.list : null;
    if (list) {
        const files = list
            .filter(f => f && String(f.is_dir) !== '1' && String(f.is_dir).toLowerCase() !== 'true')
            .map(f => {
                const fast = (f.fast_stream_url && typeof f.fast_stream_url === 'object') ? f.fast_stream_url : {};
                const fastStr = typeof f.fast_stream_url === 'string' ? f.fast_stream_url : '';
                const qualities = Object.keys(fast)
                    .filter(k => typeof fast[k] === 'string' && /^https?:\/\//i.test(fast[k]) && parseInt(k, 10) !== 360) // 360p link kaj kore na, tai list-e dekhano hoy na
                    .sort((x, y) => (parseInt(x) || 0) - (parseInt(y) || 0));
                return {
                    name: f.name || 'Video',
                    size: f.size_formatted || '',
                    duration: f.duration || '',
                    type: f.type || '',
                    quality: f.quality || '',
                    stream: f.stream_url || fastStr || (qualities.length ? fast[qualities[qualities.length - 1]] : null),
                    fast: qualities.map(q => ({ q, url: fast[q] })),
                    download: f.fast_download_link || f.download_link || null,
                    subtitle: f.subtitle_url || null,
                    thumb: f.thumbnail || null
                };
            })
            .filter(f => f.stream || f.download);
        // video file age, baki (image/zip etc.) pore
        files.sort((x, y) => (y.type === 'video') - (x.type === 'video'));
        if (files.length) {
            return { files, stream: files[0].stream, download: files[0].download, thumb: files[0].thumb, title: files[0].name };
        }
    }
    // Onno shape hole generic walker
    const g = extractTeraUrlsGeneric(payload);
    g.files = (g.stream || g.download) ? [{ name: g.title || 'Video', size: '', duration: '', type: 'video', quality: '', stream: g.stream, fast: [], download: g.download, subtitle: null, thumb: g.thumb }] : [];
    return g;
}

async function teraApiRequest(link, method, viaProxy) {
    const c = TERA_API_CONFIG;
    const headers = { 'Accept': 'application/json' };
    let url = viaProxy ? new URL(c.proxyEndpoint, location.origin).toString() : c.endpoint, init = { method, headers };
    const keyVal = (c.keyPrefix || '') + TERA_API_KEY;

    if (method === 'POST') {
        const body = { [c.linkParam]: link };
        if (!viaProxy && c.keyMode === 'body') body[c.keyName] = keyVal;
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    } else {
        const u = new URL(url);
        u.searchParams.set(c.linkParam, link);
        if (!viaProxy && c.keyMode === 'query') u.searchParams.set(c.keyName, keyVal);
        url = u.toString();
    }
    if (!viaProxy && c.keyMode === 'header') headers[c.keyName] = keyVal;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 500); } catch (e) {}
            throw new Error('HTTP ' + res.status + (detail ? ' - ' + detail : ''));
        }
        const ct = res.headers.get('content-type') || '';
        if (!/json/i.test(ct)) throw new Error('JSON pai ni (content-type: ' + (ct || 'none') + ') - route ache ki?');
        const json = await res.json();
        const data = extractTeraUrls(json);
        if (!data.stream && !data.download) {
            console.warn('[Tera Play] API response-e playable URL pawa gelo na. Raw response:', json);
            throw new Error('No playable URL returned');
        }
        return data;
    } finally { clearTimeout(timer); }
}

async function resolveTeraLink(link) {
    const cached = teraResolveCache.get(link);
    if (cached && Date.now() - cached.ts < TERA_CACHE_TTL_MS) return cached.data;

    const c = TERA_API_CONFIG;
    const attempts = [];
    if (c.proxyEndpoint) attempts.push({ name: 'proxy GET', run: () => teraApiRequest(link, 'GET', true) });
    attempts.push({ name: 'direct ' + c.method, run: () => teraApiRequest(link, c.method, false) });
    if (c.fallbackToPost && c.method !== 'POST') attempts.push({ name: 'direct POST', run: () => teraApiRequest(link, 'POST', false) });

    const errors = [];
    for (const at of attempts) {
        try {
            const data = await at.run();
            teraResolveCache.set(link, { ts: Date.now(), data });
            return data;
        } catch (err) {
            const msg = (err && err.name === 'AbortError') ? 'timeout' : (err && err.message) || String(err);
            errors.push(at.name + ': ' + msg);
            console.warn('[Tera Play] ' + at.name + ' fail:', err);
        }
    }
    const e = new Error(errors.join(' | '));
    e.teraDetails = errors;
    throw e;
}

function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.15/hls.min.js';
        s.onload = () => resolve(window.Hls);
        s.onerror = () => reject(new Error('hls.js load failed'));
        document.head.appendChild(s);
    });
}

function teraSrtToVtt(text) {
    if (/^\s*WEBVTT/i.test(text)) return text;
    return 'WEBVTT\n\n' + text.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
async function attachTeraSubtitle(video, url) {
    if (!url) return;
    let src = url;
    try {
        const r = await fetch(url);
        if (r.ok) src = URL.createObjectURL(new Blob([teraSrtToVtt(await r.text())], { type: 'text/vtt' }));
    } catch (e) { /* CORS hole direct url try hobe */ }
    const t = document.createElement('track');
    t.kind = 'subtitles'; t.label = 'Subtitle'; t.srclang = 'en'; t.src = src;
    video.appendChild(t);
}
function teraShowError(panel, msg) {
    if (panel.querySelector('.tera-play-error')) return;
    const w = panel.querySelector('.tera-video-wrap');
    const html = '<div class="tera-play-status tera-play-error">' + msg + '</div>';
    if (w) w.insertAdjacentHTML('afterend', html); else panel.insertAdjacentHTML('beforeend', html);
}
// url attach: .m3u8 hole hls.js, na hole direct; direct fail korle ekbar hls.js try kore
async function attachTeraSource(panel, video, url, resumeAt) {
    if (panel._hls) { try { panel._hls.destroy(); } catch (e) {} panel._hls = null; }
    panel._triedHls = false;
    panel.querySelectorAll('.tera-play-error').forEach(e => e.remove());
    const useHls = async () => {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; return true; }
        const Hls = await loadHlsJs();
        if (!(Hls && Hls.isSupported())) return false;
        const h = new Hls();
        h.on(Hls.Events.ERROR, (_, d) => { if (d && d.fatal) teraShowError(panel, '⚠️ Video play hocche na. Onno quality ba Direct Download try korun.'); });
        h.loadSource(url); h.attachMedia(video);
        panel._hls = h;
        return true;
    };
    video.onerror = async () => {
        if (!panel._triedHls) {
            panel._triedHls = true;
            try { if (await useHls()) return; } catch (e) {}
        }
        teraShowError(panel, '⚠️ Video play hocche na. Onno quality ba Direct Download try korun.');
    };
    if (resumeAt > 0) video.addEventListener('loadedmetadata', () => { try { video.currentTime = resumeAt; } catch (e) {} }, { once: true });
    if (/\.m3u8(\?|$)/i.test(url)) { panel._triedHls = true; if (!(await useHls())) video.src = url; }
    else video.src = url;
    video.play().catch(() => {});
}

// ---------- Custom Tera video player (fullscreen / skip / progress / cc / quality / download) ----------
const TCP_ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>',
    fwd10: '<svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z" fill="currentColor"/><text x="12" y="15" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor">10</text></svg>',
    back10: '<svg viewBox="0 0 24 24"><g transform="translate(24,0) scale(-1,1)"><path d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z" fill="currentColor"/></g><text x="12" y="15" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor">10</text></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M4 4l6 6M20 9V4h-5M20 4l-6 6M4 15v5h5M4 20l6-6M20 15v5h-5M20 20l-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cc: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="15.5" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor">CC</text></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.14 7.14 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.65l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L1.71 8.83a.5.5 0 0 0 .12.65l2.03 1.58a7.14 7.14 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.65l1.92 3.32c.14.24.42.32.6.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96c.24.1.46 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.65l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" fill="currentColor"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 3v10m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    speed: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 13l4-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9 3h6M9 3l1.2 2M15 3l-1.2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
};
const TCP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
function tcpFmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
}
function tcpCustomControlsHTML() {
    return `
        <div class="tcp-center-controls">
            <button type="button" class="tcp-center-btn tcp-skip-btn" data-skip="-10" title="-10s" aria-label="Back 10 seconds">${TCP_ICON.back10}</button>
            <button type="button" class="tcp-center-btn tcp-play-btn" title="Play/Pause" aria-label="Play/Pause">${TCP_ICON.play}</button>
            <button type="button" class="tcp-center-btn tcp-skip-btn" data-skip="10" title="+10s" aria-label="Forward 10 seconds">${TCP_ICON.fwd10}</button>
        </div>
        <div class="tcp-bottom-bar">
            <input type="range" class="tcp-progress" min="0" max="100" step="0.1" value="0" aria-label="Seek">
            <div class="tcp-bottom-row">
                <span class="tcp-time">0:00 / 0:00</span>
            </div>
        </div>
        <div class="tcp-icons-bar">
            <div class="tcp-icons">
                <div class="tcp-settings-menu" hidden></div>
                <div class="tcp-speed-menu" hidden>
                    <div class="tcp-speed-value">1.00x</div>
                    <div class="tcp-speed-slider-row">
                        <button type="button" class="tcp-speed-minus" aria-label="Decrease speed">${TCP_ICON.minus}</button>
                        <input type="range" class="tcp-speed-range" min="0.25" max="3" step="0.05" value="1" aria-label="Playback speed">
                        <button type="button" class="tcp-speed-plus" aria-label="Increase speed">${TCP_ICON.plus}</button>
                    </div>
                    <div class="tcp-speed-presets">${TCP_SPEEDS.map(s => `<button type="button" data-speed="${s}" class="${s === 1 ? 'active' : ''}">${s}x</button>`).join('')}</div>
                </div>
                <button type="button" class="tcp-icon-btn tcp-cc-btn disabled" title="Subtitle" aria-label="Subtitle">${TCP_ICON.cc}</button>
                <button type="button" class="tcp-icon-btn tcp-speed-btn" title="Playback speed" aria-label="Playback speed">${TCP_ICON.speed}</button>
                <button type="button" class="tcp-icon-btn tcp-settings-btn" title="Quality" aria-label="Quality" hidden>${TCP_ICON.gear}</button>
                <button type="button" class="tcp-icon-btn tcp-download-btn" title="Download" aria-label="Download" hidden>${TCP_ICON.download}</button>
                <button type="button" class="tcp-icon-btn tcp-fullscreen-btn" title="Fullscreen" aria-label="Fullscreen">${TCP_ICON.expand}</button>
            </div>
        </div>
        <div class="tcp-download-overlay">
            <div class="tcp-download-box">
                <div class="tcp-download-count">3</div>
                <div class="tcp-download-label">Download shuru hocche...</div>
            </div>
        </div>`;
}
function initTeraCustomPlayer(panel, wrap, video, opts, hasSubtitle, downloadUrl) {
    const playBtn = wrap.querySelector('.tcp-play-btn');
    const progress = wrap.querySelector('.tcp-progress');
    const timeEl = wrap.querySelector('.tcp-time');
    const fsBtn = wrap.querySelector('.tcp-fullscreen-btn');
    const ccBtn = wrap.querySelector('.tcp-cc-btn');
    const settingsBtn = wrap.querySelector('.tcp-settings-btn');
    const settingsMenu = wrap.querySelector('.tcp-settings-menu');
    const dlBtn = wrap.querySelector('.tcp-download-btn');
    const speedBtn = wrap.querySelector('.tcp-speed-btn');
    const speedMenu = wrap.querySelector('.tcp-speed-menu');
    const speedRange = wrap.querySelector('.tcp-speed-range');
    const speedValueEl = wrap.querySelector('.tcp-speed-value');

    const syncPlayIcon = () => { playBtn.innerHTML = video.paused ? TCP_ICON.play : TCP_ICON.pause; };
    syncPlayIcon();
    const togglePlay = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    video.addEventListener('play', syncPlayIcon);
    video.addEventListener('pause', () => { syncPlayIcon(); wrap.classList.add('tcp-controls-visible'); });

    wrap.querySelectorAll('.tcp-skip-btn').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = parseFloat(b.getAttribute('data-skip'));
        video.currentTime = Math.min(Math.max(0, (video.currentTime || 0) + d), video.duration || 1e9);
    }));

    const updateProgress = () => {
        const dur = video.duration || 0;
        const pct = dur ? (video.currentTime / dur) * 100 : 0;
        if (!progress._dragging) { progress.value = pct; progress.style.setProperty('--tcp-pct', pct + '%'); }
        timeEl.textContent = tcpFmtTime(video.currentTime) + ' / ' + tcpFmtTime(dur);
    };
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('loadedmetadata', updateProgress);
    progress.addEventListener('input', () => { progress._dragging = true; progress.style.setProperty('--tcp-pct', progress.value + '%'); });
    progress.addEventListener('change', () => { video.currentTime = (progress.value / 100) * (video.duration || 0); progress._dragging = false; });

    fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.fullscreenElement === wrap) document.exitFullscreen && document.exitFullscreen();
        else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    });

    // CC button shobshomoy dekhay - subtitle thakle (detect kore) active/clickable,
    // na thakle disabled (dim) obosthay thake.
    if (hasSubtitle) {
        ccBtn.classList.remove('disabled');
        ccBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const track = video.textTracks && video.textTracks[0];
            if (!track) return;
            const on = track.mode === 'showing';
            track.mode = on ? 'hidden' : 'showing';
            ccBtn.classList.toggle('active', !on);
        });
    } else {
        ccBtn.classList.add('disabled');
        ccBtn.setAttribute('aria-disabled', 'true');
        ccBtn.title = 'No subtitle available';
    }

    if (opts && opts.length > 1) {
        settingsBtn.hidden = false;
        settingsMenu.innerHTML = opts.map((o, i) => `<button type="button" data-i="${i}" class="${i === 0 ? 'active' : ''}">${escapeHtml(o.label)}</button>`).join('');
        settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); speedMenu.hidden = true; settingsMenu.hidden = !settingsMenu.hidden; });
        settingsMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation();
            const o = opts[parseInt(b.getAttribute('data-i'), 10)];
            settingsMenu.querySelectorAll('button').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            settingsMenu.hidden = true;
            attachTeraSource(panel, video, o.url, video.currentTime || 0);
        }));
        document.addEventListener('click', (e) => { if (!settingsMenu.hidden && !settingsMenu.contains(e.target) && e.target !== settingsBtn) settingsMenu.hidden = true; });
    }

    if (downloadUrl) {
        dlBtn.hidden = false;
        const dlOverlay = wrap.querySelector('.tcp-download-overlay');
        const dlCountEl = wrap.querySelector('.tcp-download-count');
        let dlTimer = null;
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dlTimer) return; // countdown already cholche
            let n = 3;
            dlCountEl.textContent = n;
            dlOverlay.classList.add('show');
            dlTimer = setInterval(() => {
                n -= 1;
                if (n <= 0) {
                    clearInterval(dlTimer);
                    dlTimer = null;
                    dlOverlay.classList.remove('show');
                    window.open(downloadUrl, '_blank', 'noopener');
                } else {
                    dlCountEl.textContent = n;
                }
            }, 1000);
        });
    }

    // Playback speed: -/+ buttons, drag slider, ba preset chip (0.5x..2x)
    const setSpeed = (rate) => {
        rate = Math.min(3, Math.max(0.25, Math.round(rate * 20) / 20));
        video.playbackRate = rate;
        speedRange.value = rate;
        speedValueEl.textContent = rate.toFixed(2) + 'x';
        speedMenu.querySelectorAll('.tcp-speed-presets button').forEach(b => b.classList.toggle('active', parseFloat(b.getAttribute('data-speed')) === rate));
        speedBtn.classList.toggle('active', rate !== 1);
    };
    speedBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsMenu.hidden = true; speedMenu.hidden = !speedMenu.hidden; });
    speedRange.addEventListener('input', () => setSpeed(parseFloat(speedRange.value)));
    wrap.querySelector('.tcp-speed-minus').addEventListener('click', (e) => { e.stopPropagation(); setSpeed(video.playbackRate - 0.25); });
    wrap.querySelector('.tcp-speed-plus').addEventListener('click', (e) => { e.stopPropagation(); setSpeed(video.playbackRate + 0.25); });
    speedMenu.querySelectorAll('.tcp-speed-presets button').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); setSpeed(parseFloat(b.getAttribute('data-speed'))); }));
    document.addEventListener('click', (e) => { if (!speedMenu.hidden && !speedMenu.contains(e.target) && e.target !== speedBtn) speedMenu.hidden = true; });

    // Controls auto-hide (video chola obosthay mouse/touch na thakle lukiye jay)
    let hideTimer;
    const showControls = () => {
        wrap.classList.add('tcp-controls-visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (!video.paused && settingsMenu.hidden) wrap.classList.remove('tcp-controls-visible'); }, 2800);
    };
    wrap.addEventListener('mousemove', showControls);
    wrap.addEventListener('touchstart', showControls, { passive: true });
    wrap.addEventListener('mouseleave', () => { if (!video.paused) wrap.classList.remove('tcp-controls-visible'); });
    showControls();
}

// Choto gol {x} close button - video-r/status box-er thik upore-right corner-e
// bheshe thake (Online Watch box-er watch-close-btn-er moto), alada text bar na.
function teraCloseBtnHTML(panelId) {
    return `<button type="button" class="watch-close-btn tera-close-btn" aria-label="Close video" title="Close video" onclick="closeTeraPlayerPanel('${panelId}')"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button>`;
}
function closeTeraPlayerPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    closeTeraPanel(panel);
    const body = panel.closest('.tera-player-body');
    const tw = body ? body.querySelector('.tera-thumb-wrap') : null;
    if (tw) tw.style.display = '';
}

async function playTeraLink(btn) {
    const link = btn.getAttribute('data-link');
    const panel = document.getElementById(btn.getAttribute('data-panel'));
    const thumbWrap = document.getElementById(btn.getAttribute('data-thumb'));
    if (!link || !panel) return;

    // Onno panel-er video thamano (ek shomoy ekta-i cholbe) + oigulor thumbnail abar dekhano
    document.querySelectorAll('.tera-play-panel.open').forEach(p => {
        if (p === panel) return;
        closeTeraPanel(p);
        const body = p.closest('.tera-player-body');
        const tw = body ? body.querySelector('.tera-thumb-wrap') : null;
        if (tw) tw.style.display = '';
    });

    if (thumbWrap) thumbWrap.style.display = 'none';
    panel.classList.add('open');
    panel.innerHTML = '<div class="tera-play-status tera-status-box">' + teraCloseBtnHTML(panel.id) + '<span class="watch-loading-spinner spinner-lg" aria-hidden="true"></span></div>';
    btn.disabled = true;
    try {
        const data = await resolveTeraLink(link);
        if (!panel.classList.contains('open')) return; // ei shomoy user bondho kore diyeche
        const files = data.files || [];
        const cur = files[0];

        // Note: file/quality select dropdown-gulo r dekhano hoy na - custom player-er
        // settings (⚙) icon-e quality option thake, download button-o icon hishebe.
        panel.innerHTML = `<div class="tera-video-wrap tcp-player">${teraCloseBtnHTML(panel.id)}<video playsinline autoplay preload="metadata"></video>${tcpCustomControlsHTML()}</div>`;
        const wrap = panel.querySelector('.tera-video-wrap');
        const video = panel.querySelector('video');

        const load = (file) => {
            if (file.thumb) video.poster = file.thumb;
            const opts = [];
            if (file.stream) opts.push({ label: file.quality ? 'Default (' + file.quality + ')' : 'Default', url: file.stream });
            file.fast.forEach(f => opts.push({ label: f.q + ' (Fast)', url: f.url }));
            video.querySelectorAll('track').forEach(t => t.remove());
            const first = opts[0] ? opts[0].url : file.download;
            attachTeraSource(panel, video, first, 0);
            attachTeraSubtitle(video, file.subtitle);
            initTeraCustomPlayer(panel, wrap, video, opts, !!file.subtitle, file.download || null);
        };

        load(cur);
        incrementMovieViews(currentModalMovie);
    } catch (err) {
        console.error('Tera play error:', err);
        const why = (TERA_API_CONFIG.debug && err && err.message) ? '<br><small style="opacity:.85;word-break:break-all;">Reason: ' + escapeHtml(err.message) + '</small>' : '';
        panel.innerHTML = '<div class="tera-play-status tera-play-error tera-status-box">' + teraCloseBtnHTML(panel.id) + '⚠️ Ei mohurte video load kora gelo na. Pore abar try korun ba Download button use korun.' + why + '</div>';
    } finally {
        btn.disabled = false;
    }
}


// Content details modal-er upore-i (download accordion-er bahire) "🎬 Video
// Player" box - onno accordion-gulor moto-i show/hide (collapse) kora jay,
// header-e click korle.
function collectTeraLinks(movie) {
    const out = [];
    (Array.isArray(movie.downloadBlocks) ? movie.downloadBlocks : []).forEach(sec => {
        const base = (sec.label || '').replace(/^⚡\s*/g, '').replace(/^Download Link\s*/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
        if (Array.isArray(sec.items) && sec.items.length) {
            sec.items.forEach(it => { if (isTeraboxLink(it.link)) out.push({ label: [base, it.quality].filter(Boolean).join(' ') || 'Video', link: it.link }); });
        } else if (isTeraboxLink(sec.link)) {
            out.push({ label: base || 'Video', link: sec.link });
        }
    });
    return out;
}
function buildTeraPlayerBoxHTML(movie) {
    if (!movie || movie.teraPlayEnabled !== true) return '';
    const links = collectTeraLinks(movie);
    if (!links.length) return '';
    if (!TERA_API_CONFIG.endpoint || !TERA_API_KEY) {
        console.warn('[Tera Play] TERA_API_CONFIG.endpoint khali - script.js-e fill korun.');
        return isCurrentUserAdmin(currentAuthSession)
            ? '<div class="season-accordion-group"><div class="season-box-item"><div class="season-box-header" style="cursor:default;"><span>🎬 Video Player</span></div><div class="tera-play-status tera-play-error">⚠️ (Admin only) API endpoint set kora nei - script.js → TERA_API_CONFIG.endpoint fill korun.</div></div></div>'
            : '';
    }
    const select = links.length > 1
        ? `<select class="tera-link-select" onchange="teraBoxSelectChange(this)">${links.map((l, i) => `<option value="${i}" data-link="${escapeAttr(l.link)}">${escapeHtml(l.label)}</option>`).join('')}</select>`
        : '';
    const thumbSrc = movie.poster || POSTER_PLACEHOLDER_MISSING;
    return `<div class="season-accordion-group tera-player-group"><div class="season-box-item tera-player-box">
        <div class="season-box-header" onclick="toggleAccordion('tera-player-accordion-body')"><span><span class="tera-header-icon">🎬</span> Video Player</span><span class="dropdown-arrow">▼</span></div>
        <div class="season-download-body tera-player-body" id="tera-player-accordion-body">
            ${select}
            <div class="tera-thumb-wrap" id="teraThumbWrap">
                <img class="tera-thumb-img" src="${escapeAttr(thumbSrc)}" alt="${escapeAttr(movie.title || 'Thumbnail')}" referrerpolicy="no-referrer" decoding="async" onerror="handlePosterImgError(this)">
                <div class="tera-thumb-overlay"></div>
                <button type="button" class="btn-tera-play tera-thumb-play-btn" id="teraMainPlayBtn" data-link="${escapeAttr(links[0].link)}" data-panel="tera-panel-main" data-thumb="teraThumbWrap" onclick="playTeraLink(this)" title="Play">
                    <span class="tera-thumb-play-icon"></span>
                </button>
            </div>
            <div class="tera-play-panel" id="tera-panel-main"></div>
        </div></div></div>`;
}
function teraBoxSelectChange(sel) {
    const opt = sel.options[sel.selectedIndex];
    const btn = document.getElementById('teraMainPlayBtn');
    const panel = document.getElementById('tera-panel-main');
    if (!btn || !opt) return;
    closeTeraPlayerPanel(panel.id);
    btn.setAttribute('data-link', opt.getAttribute('data-link'));
}


function closeTeraPanel(panel) {
    if (!panel) return;
    const v = panel.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
    if (panel._hls) { try { panel._hls.destroy(); } catch (e) {} panel._hls = null; }
    panel.classList.remove('open');
    panel.innerHTML = '';
}

// Admin: content-wise "Tera Play" On/Off toggle save
async function saveTeraPlayToggle(movie, on) {
    const { error } = await supabaseClient.from('movies').update({ teraPlayEnabled: on }).eq('id', movie.id);
    if (error) throw error;
    movie.teraPlayEnabled = on;
}

// ---- Admin Watch Button tab: API pool manager (list + summary + add/edit/delete/reorder) ----
function toggleTeraSettingsBox() {
    const box = document.getElementById('adminTeraSettingsBox');
    const collapsible = document.getElementById('adminTeraSettingsCollapsible');
    const chevron = document.getElementById('adminTeraSettingsChevron');
    if (!box || !collapsible) return;
    const collapsed = box.classList.toggle('collapsed');
    collapsible.style.display = collapsed ? 'none' : '';
    if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
    try { localStorage.setItem('adminTeraSettingsCollapsed', collapsed ? '1' : '0'); } catch (e) {}
}

function escapeTeraAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

async function loadAdminTeraApiStats() {
    let list = [];
    try { list = await fetchTeraApiPool(false); } catch (e) {}
    setAdminStat('adminStatTeraApis', list.length);

    const totalRequests = list.reduce((sum, a) => sum + (Number(a.used_count) || 0), 0);
    setAdminStat('adminStatTeraRequests', totalRequests.toLocaleString());

    const activeApis = list.filter(a => a.status === 'active');
    const hasUnlimited = activeApis.some(a => !a.credit_limit);
    const remainingSum = activeApis.reduce((sum, a) => a.credit_limit ? sum + Math.max(0, a.credit_limit - (Number(a.used_count) || 0)) : sum, 0);
    setAdminStat('adminStatTeraRemaining', hasUnlimited ? (remainingSum ? remainingSum.toLocaleString() + ' + ∞' : '∞') : remainingSum.toLocaleString());
}

async function renderAdminTeraApiPool() {
    // Admin-er age-r choice (open/collapsed) mone rakhe
    try {
        const box = document.getElementById('adminTeraSettingsBox');
        const collapsible = document.getElementById('adminTeraSettingsCollapsible');
        const chevron = document.getElementById('adminTeraSettingsChevron');
        if (box && collapsible && localStorage.getItem('adminTeraSettingsCollapsed') === '1') {
            box.classList.add('collapsed'); collapsible.style.display = 'none'; if (chevron) chevron.textContent = '▸';
        }
    } catch (e) {}
    const summaryEl = document.getElementById('adminTeraApiSummary');
    const listEl = document.getElementById('adminTeraApiList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="admin-tera-api-loading">Loading...</div>';
    let list = [];
    try { list = await fetchTeraApiPool(true); } catch (e) { /* fetchTeraApiPool nijei warn kore */ }

    const active = list.find(a => a.status === 'active');
    if (summaryEl) {
        if (!list.length) {
            summaryEl.innerHTML = '⚠️ Kono API add kora nei. Neeche "+ Add New API" diye ekta add korun.';
        } else if (!active) {
            summaryEl.innerHTML = `❌ Total <b>${list.length}</b> API add kora ache, kintu <b>sob-guloi exhausted/disabled</b> — Play button kaj korbe na. Notun API add korun ba kono ekta reactivate korun.`;
        } else {
            const usedTxt = active.credit_limit
                ? `${active.used_count || 0} / ${active.credit_limit} use hoyeche (baki ${Math.max(0, active.credit_limit - (active.used_count || 0))})`
                : `${active.used_count || 0} bar use hoyeche (limit set kora nei)`;
            summaryEl.innerHTML = `✅ Ekhon active: <b>${escapeHtml(active.name)}</b> — ${usedTxt}<br><span style="opacity:.75">Total <b>${list.length}</b> API add kora ache eikhane.</span>`;
        }
    }

    if (!list.length) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = list.map((a, i) => {
        const badge = a.status === 'active' ? '<span class="tera-api-badge active">● Active</span>'
            : a.status === 'exhausted' ? '<span class="tera-api-badge exhausted">✖ Exhausted</span>'
            : '<span class="tera-api-badge disabled">⏸ Disabled</span>';
        const usedTxt = a.credit_limit ? `${a.used_count || 0} / ${a.credit_limit} used` : `${a.used_count || 0} used`;
        const inUseTxt = (a.status === 'active' && list.find(x => x.status === 'active') && list.find(x => x.status === 'active').id === a.id) ? ' <small style="opacity:.7">(currently serving)</small>' : '';
        return `
        <div class="admin-tera-api-row" data-id="${a.id}">
            <div class="admin-tera-api-row-main">
                <div class="admin-tera-api-row-title">${i + 1}. ${escapeHtml(a.name)} ${badge}${inUseTxt}</div>
                <div class="admin-tera-api-row-meta">${escapeHtml(a.endpoint)}<br>Key param: <code>${escapeHtml(a.key_name || 'secret')}</code> · ${usedTxt}</div>
            </div>
            <div class="admin-tera-api-row-actions">
                <button type="button" class="admin-mini-btn" onclick="moveTeraApiUI('${a.id}', -1)" title="Priority up">▲</button>
                <button type="button" class="admin-mini-btn" onclick="moveTeraApiUI('${a.id}', 1)" title="Priority down">▼</button>
                <button type="button" class="admin-mini-btn" onclick="editTeraApiUI('${a.id}')">✏️ Edit</button>
                ${a.status !== 'active' ? `<button type="button" class="admin-mini-btn" onclick="reactivateTeraApiUI('${a.id}')">♻️ Reactivate</button>` : `<button type="button" class="admin-mini-btn" onclick="toggleDisableTeraApiUI('${a.id}', true)">⏸ Disable</button>`}
                <button type="button" class="admin-mini-btn admin-mini-btn-danger" onclick="deleteTeraApiUI('${a.id}', '${escapeTeraAttr(a.name)}')">🗑 Delete</button>
            </div>
        </div>`;
    }).join('');
}

function clearTeraApiForm() {
    ['adminTeraApiEditId', 'adminTeraApiName', 'adminTeraEndpoint', 'adminTeraKey', 'adminTeraKeyName', 'adminTeraLimit'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    const knEl = document.getElementById('adminTeraKeyName'); if (knEl) knEl.value = 'secret';
    const saveBtn = document.getElementById('adminTeraSettingsSaveBtn'); if (saveBtn) saveBtn.textContent = '➕ Add API';
    const cancelBtn = document.getElementById('adminTeraApiCancelBtn'); if (cancelBtn) cancelBtn.style.display = 'none';
    const statusEl = document.getElementById('adminTeraSettingsStatus'); if (statusEl) statusEl.textContent = '';
}

async function editTeraApiUI(id) {
    const list = await fetchTeraApiPool(false);
    const a = list.find(x => x.id === id);
    if (!a) return;
    document.getElementById('adminTeraApiEditId').value = a.id;
    document.getElementById('adminTeraApiName').value = a.name || '';
    document.getElementById('adminTeraEndpoint').value = a.endpoint || '';
    document.getElementById('adminTeraKey').value = a.api_key || '';
    document.getElementById('adminTeraKeyName').value = a.key_name || 'secret';
    document.getElementById('adminTeraLimit').value = a.credit_limit || '';
    document.getElementById('adminTeraSettingsSaveBtn').textContent = '💾 Update API';
    document.getElementById('adminTeraApiCancelBtn').style.display = '';
    document.getElementById('adminTeraApiName').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveAdminTeraSettings() {
    const editId = document.getElementById('adminTeraApiEditId').value;
    const name = document.getElementById('adminTeraApiName').value;
    const endpoint = document.getElementById('adminTeraEndpoint').value.trim();
    const key = document.getElementById('adminTeraKey').value.trim();
    const keyName = document.getElementById('adminTeraKeyName').value;
    const limit = document.getElementById('adminTeraLimit').value;
    const statusEl = document.getElementById('adminTeraSettingsStatus');
    const btn = document.getElementById('adminTeraSettingsSaveBtn');
    if (!endpoint || !key) {
        if (statusEl) { statusEl.textContent = '⚠️ Endpoint ar API Key khali rakha jabe na.'; statusEl.className = 'admin-tera-settings-status err'; }
        return;
    }
    if (btn) btn.disabled = true;
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.className = 'admin-tera-settings-status'; }
    try {
        if (editId) await adminUpdateTeraApi(editId, { name, endpoint, key, keyName, limit });
        else await adminAddTeraApi({ name, endpoint, key, keyName, limit });
        clearTeraApiForm();
        if (statusEl) { statusEl.textContent = '✅ Saved!'; statusEl.className = 'admin-tera-settings-status ok'; }
        await loadTeraApiConfig();
        renderAdminTeraApiPool();
    } catch (err) {
        console.error('Tera API save error:', err);
        if (statusEl) { statusEl.textContent = '❌ Save fail holo: ' + (err && err.message ? err.message : 'Unknown error') + ' (SUPABASE_TERA_API_SETTINGS.sql run kora hoyeche to?)'; statusEl.className = 'admin-tera-settings-status err'; }
    } finally {
        if (btn) btn.disabled = false;
    }
}
async function deleteTeraApiUI(id, name) {
    if (!confirm(`"${name}" API-ta delete korte chan?`)) return;
    try { await adminDeleteTeraApi(id); await loadTeraApiConfig(); renderAdminTeraApiPool(); }
    catch (e) { alert('Delete fail: ' + (e && e.message)); }
}
async function reactivateTeraApiUI(id) {
    try { await adminReactivateTeraApi(id); await loadTeraApiConfig(); renderAdminTeraApiPool(); }
    catch (e) { alert('Reactivate fail: ' + (e && e.message)); }
}
async function toggleDisableTeraApiUI(id, disable) {
    try { await adminToggleTeraApiDisabled(id, disable); await loadTeraApiConfig(); renderAdminTeraApiPool(); }
    catch (e) { alert('Fail: ' + (e && e.message)); }
}
async function moveTeraApiUI(id, dir) {
    try { await adminMoveTeraApiPriority(id, dir); renderAdminTeraApiPool(); }
    catch (e) { alert('Fail: ' + (e && e.message)); }
}

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
var moviesDataLoaded = false;
var allDeletedMovies = [];
var allLinkAlerts = [];
const TRASH_RETENTION_DAYS = 30;
let moviesList = []; 
let currentPage = 1;

// admin panel-এ যাকে যে Serial (display_order) নাম্বার দেওয়া হয়, সে ঠিক সেই
// position-এই (1-indexed) বসবে - বাকি "Auto" (display_order না-দেওয়া) item গুলো
// নিজেদের আগের আপেক্ষিক ক্রম ঠিক রেখে ফাঁকা জায়গাগুলোয় বসে যাবে।
// একাধিক item-এ একই serial দিলে, ছোট id / আগে processed হওয়া item আগে বসবে।
function applyManualSerialPositions(list) {
    if (!Array.isArray(list)) return list;
    const autoItems = list.filter(m => m.display_order == null);
    const manualItems = list
        .filter(m => m.display_order != null)
        .map((m, idx) => ({ m, idx })) // stable tie-break এর জন্য আগের index মনে রাখা
        .sort((a, b) => (a.m.display_order - b.m.display_order) || (a.idx - b.idx))
        .map(entry => entry.m);

    const result = autoItems.slice();
    manualItems.forEach(item => {
        let pos = Math.round(item.display_order) - 1;
        if (Number.isNaN(pos) || pos < 0) pos = 0;
        if (pos > result.length) pos = result.length;
        result.splice(pos, 0, item);
    });
    return result;
}
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
            .order('display_order', { ascending: true, nullsFirst: false })
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
                parsed.seasonTrailers = parseBlocksField(parsed.seasonTrailers);
                parsed.watchSeasonLinks = parseBlocksField(parsed.watchSeasonLinks);
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
            // Serial (display_order) দেওয়া item গুলোকে ঠিক সেই নাম্বার position-এ বসানো
            allMovies = applyManualSerialPositions(allMovies);
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
            restoreMovieModalFromUrl(); // ?movie=<id> URL-e thakle (refresh) shei details page abar khule dao

            const adminOverlayEl = document.getElementById('adminOverlay');
            if (adminOverlayEl && adminOverlayEl.style.display !== 'none') {
                if (currentAdminTab === 'dashboard') {
                    loadAdminDashboardStats();
                } else if (currentAdminTab === 'manage') {
                    const searchInput = document.getElementById('adminSearchInput');
                    renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'trailer') {
                    // Trailer/Teaser tab-o Database tab-er moto-i ekই bug-e
                    // atkato - page refresh-er shathe shathe ei tab khola thakle
                    // (mane movies data load hওয়ar AGE-i tab-ta active thakle),
                    // "Loading content..." dekhiye আটকে thakto, karon data load
                    // shesh hওয়ar por eta re-render korar kono case-i chilo na.
                    const searchInput = document.getElementById('adminTrailerSearchInput');
                    renderAdminTrailerList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'watch') {
                    // Watch Button tab-eও ekই bug (upore-r comment dekho).
                    const searchInput = document.getElementById('adminWatchSearchInput');
                    renderAdminWatchList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'banner') {
                    const searchInput = document.getElementById('adminBannerSearchInput');
                    renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
                } else if (currentAdminTab === 'navigation') {
                    // Category banner list-টা allMovies-এর category tag থেকেও category বের করে,
                    // তাই movies load hওয়ার আগে Navigation tab খোলা থাকলে "No categories found"
                    // দেখায় আর data আসার পরও রিফ্রেশ হতো না — এখন movies load শেষ হলে এটাও রিফ্রেশ হবে
                    const catBannerSearchInput = document.getElementById('adminCategoryBannerSearchInput');
                    renderAdminCategoryBannerList(catBannerSearchInput ? catBannerSearchInput.value.trim() : '');
                } else if (currentAdminTab === 'trash') {
                    renderAdminTrashList();
                }
            }
        } else {
            console.warn('No movies found in database.');
            moviesDataLoaded = true; 
        }
    } catch (err) {
        console.error('Unexpected error loading database:', err);
    }
}

// ==================== HOME HERO BANNER FUNCTIONS ====================

let heroSlidesData = [];
let heroCurrentIndex = 0; // real/logical slide index (0..N-1) - drives the dots
let heroPos = 1;          // actual position inside the extended DOM track (clone-of-last, slide0..slideN-1, clone-of-first)
let heroAutoplayTimer = null;
let heroWrapTimeout = null;
let heroInitialized = false;
const heroBackdropCache = new Map();
let heroDotGroupStarts = []; // maps dot index -> starting slide index for that dot's group

function clearHeroWrapTimeout() {
    if (heroWrapTimeout) { clearTimeout(heroWrapTimeout); heroWrapTimeout = null; }
}

function getFeaturedMoviesForHero() {
    if (!Array.isArray(allMovies) || allMovies.length === 0) return [];

    const manuallyFeatured = allMovies
        .filter(m => m.featured === true)
        .sort((a, b) => (a.featured_order ?? 999) - (b.featured_order ?? 999));

    if (manuallyFeatured.length > 0) return manuallyFeatured;

    return allMovies;
}

function getHeroCategoryLabel(movie) {
    if (movie.featured_category_label) return movie.featured_category_label;
    if (movie.featured_category) {
        const overrideLink = document.querySelector(`.nav-link[data-target="${movie.featured_category}"]`);
        if (overrideLink) return overrideLink.textContent.trim();
        return String(movie.featured_category).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
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
    heroPos = 1; 
    track.innerHTML = '';
    dotsWrap.innerHTML = '';

    const N = heroSlidesData.length;

    function buildSlideEl(movie, i, idSuffix) {
        const catLabel = getHeroCategoryLabel(movie);
        const catSlug = movie.featured_category || (Array.isArray(movie.category) && movie.category.length ? movie.category[0] : '');
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
                ${catLabel ? `<span class="hero-badge hero-badge-cat" id="heroCat-${domId}">${catLabel}</span>` : ''}
            </div>
            <div class="hero-slide-info">
                <h2 class="hero-slide-title" id="heroTitle-${domId}">${cleanTitle}</h2>
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

        const titleEl = slide.querySelector(`#heroTitle-${domId}`);
        if (titleEl) titleEl.addEventListener('click', () => openMovieModal(heroSlidesData[i]));

        const catEl = slide.querySelector(`#heroCat-${domId}`);
        if (catEl && catSlug) {
            catEl.addEventListener('click', (e) => {
                e.stopPropagation();
                switchCategory(catSlug);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        }

        return slide;
    }

    track.appendChild(buildSlideEl(heroSlidesData[N - 1], N - 1, 'cloneLast'));

    heroSlidesData.forEach((movie, i) => {
        track.appendChild(buildSlideEl(movie, i));
    });

    track.appendChild(buildSlideEl(heroSlidesData[0], 0, 'cloneFirst'));

    // Dots are capped at MAX_HERO_DOTS regardless of how many slides exist.
    // When there are more slides than dots, each dot represents a group of
    // slides spread evenly across the total, and the active dot is derived
    // from whichever group the current slide falls into.
    const MAX_HERO_DOTS = 8;
    const dotCount = Math.min(N, MAX_HERO_DOTS);
    heroDotGroupStarts = Array.from({ length: dotCount }, (_, d) => Math.floor((d * N) / dotCount));

    for (let d = 0; d < dotCount; d++) {
        const startIndex = heroDotGroupStarts[d];
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'hero-dot' + (d === 0 ? ' active' : '');
        dot.setAttribute('aria-label', `Slide group ${d + 1}`);
        dot.addEventListener('click', () => goToHeroSlide(startIndex));
        dotsWrap.appendChild(dot);
    }

    const counterEl = document.getElementById('heroSlideCounter');
    if (counterEl) {
        if (N > MAX_HERO_DOTS) {
            counterEl.style.display = '';
            counterEl.textContent = `1 / ${N}`;
        } else {
            counterEl.style.display = 'none';
        }
    }

    heroSection.style.display = '';
    updateHeroTrackPosition(false);
    startHeroAutoplay();

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

    // Determine which dot's group the current slide belongs to (last group
    // whose start index is <= heroCurrentIndex).
    let activeDotIndex = 0;
    for (let d = 0; d < heroDotGroupStarts.length; d++) {
        if (heroDotGroupStarts[d] <= heroCurrentIndex) activeDotIndex = d;
        else break;
    }
    document.querySelectorAll('#heroDots .hero-dot').forEach((d, i) => d.classList.toggle('active', i === activeDotIndex));

    const counterEl = document.getElementById('heroSlideCounter');
    if (counterEl && counterEl.style.display !== 'none') {
        counterEl.textContent = `${heroCurrentIndex + 1} / ${heroSlidesData.length}`;
    }
}

function goToHeroSlide(i) {
    if (!heroSlidesData.length) return;
    clearHeroWrapTimeout();
    heroCurrentIndex = ((i % heroSlidesData.length) + heroSlidesData.length) % heroSlidesData.length;
    heroPos = heroCurrentIndex + 1;
    updateHeroTrackPosition(true);
    startHeroAutoplay();
}

function heroGoNext() {
    if (!heroSlidesData.length) return;
    clearHeroWrapTimeout();
    const N = heroSlidesData.length;
    if (heroCurrentIndex === N - 1) {
        heroPos = N + 1; // clone-first এর position
        heroCurrentIndex = 0;
        updateHeroTrackPosition(true);
        heroWrapTimeout = setTimeout(() => {
            heroPos = 1; 
            updateHeroTrackPosition(false); // no animation - clone আর আসল slide0 দেখতে same
        }, 620);
    } else {
        heroCurrentIndex += 1;
        heroPos += 1;
        updateHeroTrackPosition(true);
    }
    startHeroAutoplay();
}

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
            updateHeroTrackPosition(true); 
            startHeroAutoplay();
        }
        touchDeltaX = 0;
    });

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

function updateHeroVisibilityForSearch(hasQuery) {
    const heroSection = document.getElementById('heroBanner');
    if (!heroSection) return;

    if (hasQuery) {
        heroSection.style.display = 'none';
        stopHeroAutoplay();
        return;
    }

    const currentCategory = document.body.getAttribute('data-category') || 'all';
    updateHeroVisibilityForCategory(currentCategory);
}

function updateHeroVisibilityForCategory(category) {
    const heroSection = document.getElementById('heroBanner');
    if (!heroSection) return;

    if (category !== 'all') {
        heroSection.style.display = 'none';
        stopHeroAutoplay();
    } else if (heroSlidesData.length === 0) {
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
    stopModalTrailerPlayback();
    clearMovieModalUrlParam(); // URL theke ?movie= sorie dao, nahole porer refresh-e abar ei details page-i khule jabe
}

// ---------- Details page (movie modal) refresh persistence ----------
// Dashboard/Auth page-er jeta age-theke-i ache (?dashboard=1, ?auth=signin
// URL-e rekhe refresh-eo shei page-e thaka), thik shei-i pattern-e - kono
// content-er "Details" (Watch/Download) modal khola thakle URL-e
// "?movie=<id>" jure deya hoy, jate কেউ page REFRESH korleo shei details
// page-i thake, home-e ferot chole na jay. Modal bondho korle (closeMovieModal)
// ei param URL theke sorie deya hoy.
function setMovieModalUrlParam(movie) {
    if (!movie || movie.id == null) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('movie') === String(movie.id)) return; // already thik ache
    params.set('movie', String(movie.id));
    // Movie details modal ar dashboard/auth page - dutoi ekshathe URL-e rakha
    // hoy na (ekbar-e ekta-i "full page overlay" active thaka uchit).
    params.delete('dashboard');
    params.delete('auth');
    const newUrl = window.location.pathname + '?' + params.toString() + window.location.hash;
    history.replaceState(null, '', newUrl);
}
function clearMovieModalUrlParam() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('movie')) return;
    params.delete('movie');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    history.replaceState(null, '', newUrl);
}
// Movies data load hওয়ার পর ekbar call kora hoy (fetchMoviesFromSupabase theke) -
// URL-e "?movie=<id>" thakle (age kono details page khola obosthay refresh
// kora hoyeche), shei content-take khuje ber kore automatic-bhabe details
// modal-ta abar khule dey.
function restoreMovieModalFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        const movieIdParam = params.get('movie');
        if (!movieIdParam) return;
        const source = Array.isArray(allMovies) ? allMovies : [];
        const found = source.find(m => String(m.id) === String(movieIdParam));
        if (found) {
            openMovieModal(found);
        } else {
            // Content-ta khuje na paile (delete hoye geche, ba bhul id) - URL-e
            // atkano bhul "?movie=" thakle porer refresh-eo abar try korte
            // thakbe, tai eikhaneই sorie dewa hoy.
            clearMovieModalUrlParam();
        }
    } catch (e) {
        console.error('Restore movie modal from URL error:', e);
    }
}

// Modal-e kono video (Trailer-er YouTube iframe OTHOBA "Online Watch"
// box-er iframe) play hocche emon obosthay modal close korle - age shudhu
// Trailer-er iframe-i remove kora hoto, Watch box-er iframe-ta thekei
// jeto, fole modal bondho kora shotteo background-e shobdo/video chalu
// thakto. Ekhon overlay-r bhitorer shob "trailer-video-wrap" (Trailer +
// Watch, dutoi ekই class use kore) remove kora hoy, jate kono obosthateই
// modal bondho korar por r kono video/audio background-e na baje.
function stopModalTrailerPlayback() {
    const overlay = document.getElementById('movieModalOverlay');
    if (!overlay) return;
    overlay.querySelectorAll('.trailer-video-wrap, .watch-player-toolbar').forEach(el => el.remove());
    overlay.querySelectorAll('.tera-play-panel.open').forEach(closeTeraPanel);
}

// Kono kono khetre trailerKey resolve hoy (tai trailer-box render hoye jay),
// kintu shei YouTube video-ta আসলে thake na (delete/private/invalid id) -
// tokhon img.youtube.com thumbnail hishebe ekটা fixed 120x90 "no thumbnail"
// placeholder pathay (normal thumbnail onek boro hoy, jemon maxresdefault
// 1280x720 ba hqdefault 480x360).
// Amra "maxresdefault" (shobcheye high-quality HD thumbnail) age try kori -
// kintu shob purono/choto video-r jonno YouTube eta generate kore na, tokhon
// oi 120x90 placeholder ashe (video-ta bhanga na, shudhu HD thumbnail-i nei) -
// tokhon "hqdefault"-e (shob video-teই thake) fallback kora hoy. Duitai
// (maxres ar hq) fail korle - mane video-ta আসলেই bhanga/delete/private -
// tokhon pura .trailer-box-take hide kore dei, jate user ekta "load hocche na"
// emon khali/bhanga trailer box r dekhbe na.
function handleTrailerThumbLoad(imgEl) {
    if (imgEl.naturalWidth === 120 && imgEl.naturalHeight === 90) {
        if (imgEl.dataset.thumbTier === 'maxres' && imgEl.dataset.ytid) {
            imgEl.dataset.thumbTier = 'hq';
            imgEl.src = `https://img.youtube.com/vi/${encodeURIComponent(imgEl.dataset.ytid)}/hqdefault.jpg`;
            return;
        }
        hideBrokenTrailerBox(imgEl);
    }
}
function handleTrailerThumbError(imgEl) {
    // Shadharonoto img.youtube.com kokhono real error/404 dey na (maxresdefault
    // na thakleo 120x90 placeholder-i pathay, tai eta onload-e-i handle hoy) -
    // kintu kono network issue-e sotti error hole-o age hq-e try na kore direct
    // hide na kore, ekbar hq fallback try kora hocche safety hishebe.
    if (imgEl.dataset.thumbTier === 'maxres' && imgEl.dataset.ytid) {
        imgEl.dataset.thumbTier = 'hq';
        imgEl.src = `https://img.youtube.com/vi/${encodeURIComponent(imgEl.dataset.ytid)}/hqdefault.jpg`;
        return;
    }
    hideBrokenTrailerBox(imgEl);
}
function hideBrokenTrailerBox(imgEl) {
    const box = imgEl.closest('.trailer-box');
    if (box) box.remove();
}

function copyDownloadLink(linkId, btnElement) {
    const linkElement = document.getElementById(linkId);
    if (linkElement && linkElement.href) {
        incrementMovieViews(currentModalMovie); // লিংক কপি করলে ভিউ কাউন্ট বাড়বে

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

// Movie/series-r shathe shothik TMDB entry (id + media type) khoja hoy ei
// ekta shared function diye - age eta fetchFullTMDBDetailsUncached()-er
// vitor-e duplicate kora chilo (poster/rating/etc TMDB theke ana-r jonno
// ekhono ei function-i use hoy - "original title" search feature ekhon
// IMDb (OMDb)-er upor base kore, tai eta ar shei feature-e use hoy na).
async function resolveTmdbMatch(movie) {
    if (!TMDB_API_KEY) return null;
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
        const rawTitle = (movie.searchName || movie.title || '');
        // Title-e "(2017-20)" / "(2017-2020)" / "(2024)" type year hint thakle
        // seta age ber kore rakha hocche - eta search query theke bad deya
        // hoy (TMDB search year shoho query-te thakle onek shomoy kom result
        // dey), kintu niche result bachai korar shomoy ei year-take use kore
        // shothik entry-ta khoja hoy (age eta ekdom fele deya hoto, fole
        // "Dark", "Cross"-er moto common naam-er khetre TMDB-r first result-i
        // niye newa hoto - seta prai shomoyi onno kono ontirikto movie/show
        // hoye jeto, karon kono year/popularity check-i chilo na).
        const yearHintMatch = rawTitle.match(/\((\d{4})(?:[\-–](\d{2,4}))?\)/);
        const yearHint = yearHintMatch ? yearHintMatch[1] : null;
        const cleanQuery = rawTitle.replace(/\s*\([\d\-–]+\)/g, '').trim();
        const searchRes = await fetchWithTimeout(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}`, {}, 6000);
        if (searchRes.ok) {
            const searchData = await searchRes.json();
            const candidates = (searchData && Array.isArray(searchData.results) ? searchData.results : [])
                .filter(item => item.media_type === 'movie' || item.media_type === 'tv');
            if (candidates.length > 0) {
                const normalize = (s) => String(s || '').toLowerCase().trim();
                const cleanQueryNorm = normalize(cleanQuery);
                const match = candidates
                    .map(item => {
                        const itemTitle = item.media_type === 'tv' ? item.name : item.title;
                        const itemDate = item.media_type === 'tv' ? item.first_air_date : item.release_date;
                        const itemYear = itemDate ? itemDate.slice(0, 4) : null;
                        let matchScore = 0;
                        // Year hint (title-e deya thakle) match korle boro priority -
                        // eta-i "Dark (2024-er onno kichu)" vs "Dark (2017 আসল)"
                        // gulor moddhe thik-ta ber korte shobcheye kaj kore.
                        if (yearHint && itemYear === yearHint) matchScore += 100;
                        // Exact title match (case-insensitive) shomoyi priority pabe -
                        // partial/substring match-er cheye eta onek beshi reliable.
                        if (normalize(itemTitle) === cleanQueryNorm) matchScore += 20;
                        // Shesh-e TMDB-r nijer popularity diye tie-break kora hoy, jate
                        // shoman score-er modhye shobcheye পরিচিত/সঠিক entry-ta jite jay.
                        matchScore += Math.min(item.popularity || 0, 50) / 50 * 10;
                        return { item, matchScore };
                    })
                    .sort((a, b) => b.matchScore - a.matchScore)[0].item;
                matchId = match.id;
                mediaType = match.media_type === 'tv' ? 'tv' : 'movie';
            }
        }
    }

    return matchId ? { matchId, mediaType } : null;
}

// TMDB-e movie/series-er "Original Title" (jemon "Guardian: The Lonely and
// Great God"-er original title "쓸쓸하고 찬란하神-도깨비") niye ashe. Eta-i
// aslo "original title" (native/original-language title) data-r shobcheye
// reliable source - IMDb/OMDb-er "Title" field-e emon kono aksha thake na,
// OMDb khali IMDb-e dekhano (aksharai English/localized) title-i dey, tai
// OMDb-r upor shudhu bhorosha korle Korean/non-English content-er original
// title-gula miss hoye jay (jemonta ei feature-e age dhora poreche).
async function fetchTmdbOriginalTitle(movie) {
    if (!TMDB_API_KEY) return null;
    try {
        const resolved = await resolveTmdbMatch(movie);
        if (!resolved) return null;
        const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${resolved.mediaType}/${resolved.matchId}?api_key=${TMDB_API_KEY}`, {}, 6000);
        if (!detailRes.ok) return null;
        const detailData = await detailRes.json();
        const originalTitle = detailData.original_title || detailData.original_name || null;
        const currentTitle = detailData.title || detailData.name || null;
        if (originalTitle && currentTitle && originalTitle.trim().toLowerCase() === currentTitle.trim().toLowerCase()) {
            return null;
        }
        return originalTitle;
    } catch (e) {
        console.error('fetchTmdbOriginalTitle error:', e);
        return null;
    }
}

// IMDb (OMDb API diye) theke movie/series-er official Title ana hoy. Eta
// mostly TMDB-e match na paoya content-er jonno fallback hisebe use hoy -
// karon OMDb shudhu IMDb-e dekhano (English/localized) title-i dey, native
// original-language title na, tai eta diye ekla "original title diye
// search" feature-ta shothikvabe kaj kore na.
async function fetchImdbOriginalTitle(movie) {
    try {
        const omdb = await getOMDbDetails(movie);
        if (!omdb || !omdb.title) return null;
        const imdbTitle = omdb.title;
        const currentTitle = (movie.title || movie.searchName || '');
        if (currentTitle && imdbTitle.trim().toLowerCase() === currentTitle.trim().toLowerCase()) {
            return null;
        }
        return imdbTitle;
    } catch (e) {
        console.error('fetchImdbOriginalTitle error:', e);
        return null;
    }
}

// "Original title diye search" feature-er jonno actual title fetch kora
// hoy ekhane - age eta khali IMDb (OMDb) theke ashto, kintu OMDb-r "Title"
// field asholei non-English content-er native/original title dey na (jemon
// Korean drama "Guardian: The Lonely and Great God"-er original title
// "Sseulsseulhago Chanranhasin: Dokkaebi" IMDb/OMDb theke pawa jay na - IMDb
// khali English display title-i dekhay). Tai ekhon TMDB-r "Original Title"
// field-take primary source hisebe rakha hoyeche (eta-i asholei native/
// original-language title thik moto dey), ar IMDb (OMDb) shudhu fallback
// hisebe use hocche - jei content-er jonno TMDB-e kono match paoya jayni,
// shei khetre IMDb-er title-take original title hisebe rakha hocche.
async function fetchOriginalTitle(movie) {
    const tmdbOriginal = await fetchTmdbOriginalTitle(movie).catch(() => null);
    if (tmdbOriginal) return tmdbOriginal;
    return await fetchImdbOriginalTitle(movie).catch(() => null);
}

// Notun feature: "Original Title diye search" চালু howar age theke jei
// content-gula database-e add kora ache, segulor originalTitle field khali
// - eta admin panel theke ekbar run korle shob content-er jonno original
// title (TMDB primary, IMDb fallback) fetch kore database-e save kore dey,
// jate purono kono content-o baad na pore ei feature theke. API rate-limit-e
// giye jate quota shesh na hoy, tai ekta chhoto delay diye ekta ekta kore
// call kora hocche (parallel na kore).
async function backfillOriginalTitles() {
    const btn = document.getElementById('adminBackfillBtn');
    const statusEl = document.getElementById('adminBackfillStatus');
    if (!btn || !statusEl) return;

    const pending = (allMovies || []).filter(m => !m.deleted_at && !m.originalTitle);
    if (pending.length === 0) {
        statusEl.textContent = '✅ All content already has original titles checked.';
        return;
    }

    btn.disabled = true;
    let done = 0, updated = 0, failed = 0;

    for (const movie of pending) {
        done++;
        statusEl.textContent = `Checking ${done}/${pending.length} — "${movie.title || movie.searchName || ''}"...`;
        try {
            const originalTitle = await fetchOriginalTitle(movie);
            if (originalTitle) {
                const { error } = await supabaseClient.from('movies').update({ originalTitle }).eq('id', movie.id);
                if (error) throw error;
                movie.originalTitle = originalTitle;
                updated++;
            }
        } catch (e) {
            console.error('backfillOriginalTitles error for', movie && movie.title, e);
            failed++;
        }
        // TMDB API-r opor chaap kom rakhte proti call-er majhe ekta choto gap.
        await new Promise(r => setTimeout(r, 250));
    }

    btn.disabled = false;
    statusEl.textContent = `✅ Done. Checked ${done}, updated ${updated}${failed ? `, failed ${failed}` : ''}.`;
}

async function fetchFullTMDBDetailsUncached(movie) {
    if (!TMDB_API_KEY) return null;
    try {
        const resolved = await resolveTmdbMatch(movie);
        if (!resolved) return null;
        const matchId = resolved.matchId;
        const mediaType = resolved.mediaType;
        const cleanImdbId = extractImdbId(movie.imdbId);
        const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${mediaType}/${matchId}?api_key=${TMDB_API_KEY}&append_to_response=credits,external_ids,release_dates,content_ratings,videos`, {}, 6000);
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

        // Trailer - series/TV show hole shobsomoy shobcheye latest (notun) season-er
        // trailer dekhano hoy (overall show trailer na), r notun season TMDB-e add
        // hole automatic-i shei notun season-er trailer-e switch hobe. Priority:
        // 1) latest season-er TMDB video, 2) show-er overall TMDB video, 3) YouTube
        // search (quota-costly, tai last resort - eta-o season mention kore search kore).
        const ytTitle = detailData.title || detailData.name || movie.title;
        const latestSeasonNumber = mediaType === 'tv' ? getLatestRealSeasonNumber(detailData) : null;

        let trailerKey = null;
        let manualTrailerThumb = null;
        // Age eta strict getManualSeasonTrailer(movie, latestSeasonNumber) call korto -
        // fole TMDB-e kono series-er "notun" season announce/renew hoye placeholder
        // (episode/trailer chara) add hoye gele latestSeasonNumber sheta dhore nito,
        // ar admin-er deya aager season-er manual trailer match na kore bad pore jeto
        // (tokhon auto/YouTube search-o notun season-er kono trailer na peye trailer-i
        // dekhato na). resolveManualSeasonTrailerFallback() use kora hocche ekhon -
        // eta age latestSeasonNumber-e direct match try kore, na mile admin-er deya
        // seasonTrailers-er modhye shobcheye notun (highest) season-take fallback
        // hishebe use kore - jate real trailer thakle seta shobsomoy dekhay.
        const manualLatestSeasonTrailer = mediaType === 'tv' ? resolveManualSeasonTrailerFallback(movie, true, latestSeasonNumber) : null;
        if (manualLatestSeasonTrailer) {
            trailerKey = manualLatestSeasonTrailer.key;
            manualTrailerThumb = manualLatestSeasonTrailer.thumb;
        } else if (mediaType === 'tv' && latestSeasonNumber != null) {
            trailerKey = await getLatestSeasonTrailerKey(matchId, latestSeasonNumber);
        }
        if (!trailerKey) {
            trailerKey = pickTmdbTrailerKey(detailData);
        }
        if (!trailerKey && movie.trailerEnabled !== false) {
            // (Trailer "Off" thakle YouTube search-o kora hoy na - quota bachano jonno)
            const searchTitle = latestSeasonNumber != null ? `${ytTitle} Season ${latestSeasonNumber}` : ytTitle;
            trailerKey = await searchYoutubeTrailer(searchTitle, year !== "N/A" ? year : null);
        }

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
            revenue: detailData.revenue || 0,
            trailerKey: trailerKey,
            trailerThumb: manualTrailerThumb,
            originalTitle: (detailData.original_title || detailData.original_name || null),
            latestSeasonNumber: latestSeasonNumber
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

function getGridColumnsCount() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return 5;
    const cols = window.getComputedStyle(grid).getPropertyValue('grid-template-columns')
        .split(' ')
        .filter(Boolean).length;
    return cols || 5;
}


function isForcedDesktopOnPhone(cols) {
    if (cols !== 5) return false;
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (!isTouch) return false;
    const realScreenNarrow = Math.min(window.screen.width || 0, window.screen.height || 0) < 500;
    return realScreenNarrow;
}


function getMoviesPerPage() {
    let cols = getGridColumnsCount();
    if (cols > 5) cols = 5;

    if (isForcedDesktopOnPhone(cols)) {
        const vw = window.innerWidth || document.documentElement.clientWidth || 1;
        const vh = window.innerHeight || document.documentElement.clientHeight || 1;
        const aspect = vh / vw; 
        const rows = Math.max(2, Math.round(2 * aspect)) + 1;
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
        // নাম্বার সবসময় sequential (1, 2, 3...) দেখাবে - admin-এর Serial (display_order)
        // শুধু sort/order ঠিক করার জন্য ব্যবহার হয় (sortAllMoviesByDisplayOrder এ),
        // কার্ডে raw serial value হিসেবে দেখানো হয় না, যাতে gap (1, 8, 3...) না হয়
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
    // Homepage-er "500K+ Movies & TV Shows" search player-e (jodi kono
    // alada window/tab na, ei-i page-e) video chalu thakte thakte user onno
    // kono movie/series-er details page (ei modal) khulle - shei video-take
    // pause/stop kore deya hoy, jate background-e onno video-o baja-i na
    // thake. Notably eta shudhu video-take thumbnail-e ferot pathay, gোটা
    // massive-watch section-take hide/collapse kore na - eta jekhaneই thakuk
    // (page-e) shobshomoy dekha jabe.
    pauseMassiveWatchIfPlaying();

    const modalOverlay = document.getElementById('movieModalOverlay');
    const modalBox = document.getElementById('modalDynamicBox');

    currentModalMovie = movie; 

    modalOverlay.style.display = 'flex';
    document.body.classList.add('modal-open');
    setMovieModalUrlParam(movie); // URL-e ?movie=<id> - refresh dile-o ei details page-i thakbe

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

    // Admin panel-e TMDB ID field-e manually ID deya thakle shuru-te seta-i use kora
    // hoy, kintu deya na thakle - thik jevabe trailer/poster/original title-er jonno
    // TMDB-te auto-search (title/searchName ba IMDb ID diye) hoy, shei ekই auto-search
    // (resolveTmdbMatch(), niche tmdb.id hishebe result ashe) theke paoa ID-i Watch
    // Button-er jonno use kora hobe - admin-ke ID hate boshate hobe na.
    let resolvedTmdbId = movie.tmdbId || null;

    // Admin panel theke manually YouTube link/ID disol thakle seta-i shobar age priority
    // pabe - TMDB/YouTube auto-search shudhu tokhon-i chole jokhon eta deya nei ba
    // eta theke video ID ber kora jayni. Series-er khetre (isTV) proti-season manual
    // trailer (movie.seasonTrailers) thakle segula ei legacy shingle-link-er cheye
    // age priority pabe - shei check porer dike (tmdb resolve howar por) kora hoy.
    const manualTrailerId = extractYoutubeVideoId(movie.trailerLink);
    let trailerKey = manualTrailerId || null;
    let trailerThumbOverride = null; // manual per-season trailer thumbnail (series only)
    let trailerTvId = null;
    let trailerSeasonCount = getMaxManualSeasonNumber(movie) || null;
    let trailerSelectedSeason = null;

    let durationOrSeasonPill = movie.runtime || "N/A";

    if (isTV) {
        let seasonsCount = Math.max(
            (movie.downloadBlocks ? movie.downloadBlocks.length : 1),
            getMaxManualSeasonNumber(movie)
        );
        durationOrSeasonPill = seasonsCount > 1 ? `${seasonsCount} Seasons` : `${seasonsCount} Season`;
    }

    if (!tagline && title.includes(":")) tagline = title.split(":").slice(1).join(":").trim();
    if (!tagline) tagline = genre;

    const metaSubtitle = `${genre} ${releaseDate !== "N/A" ? '| ' + releaseDate : ''}`;
    let imdbUrl = fetchedImdbId ? `https://www.imdb.com/title/${fetchedImdbId}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(title)}`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(title)}`;

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
                            ${teraPlayButtonHTML(movie, it.link, 'tera-panel-' + uid)}
                        </div>
                        ${teraPanelHTML(movie, it.link, 'tera-panel-' + uid)}
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
                            ${teraPlayButtonHTML(movie, sec.link, 'tera-panel-' + idx)}
                        </div>
                        ${teraPanelHTML(movie, sec.link, 'tera-panel-' + idx)}
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

        const trailerThumbUrl = trailerThumbOverride || movie.trailerThumb || (trailerKey ? `https://img.youtube.com/vi/${trailerKey}/maxresdefault.jpg` : '');

        // Series-er khetre ekta Season dropdown dekhano hoy, jate user chaile onno
        // (age-r) season-er trailer-o dekhte pare - default-e latest season select kora thake.
        let trailerSeasonSelectorHTML = '';
        if (isTV && trailerTvId && trailerSeasonCount && trailerSeasonCount > 1) {
            let seasonOptionsHTML = '';
            for (let s = 1; s <= trailerSeasonCount; s++) {
                seasonOptionsHTML += `<option value="${s}" ${s === (trailerSelectedSeason || trailerSeasonCount) ? 'selected' : ''}>Season ${s}</option>`;
            }
            trailerSeasonSelectorHTML = `
            <div class="trailer-season-row">
                <label for="trailerSeasonSelect">Trailer:</label>
                <select id="trailerSeasonSelect" class="trailer-season-select" data-tvid="${trailerTvId}" onchange="changeModalTrailerSeason(this)">
                    ${seasonOptionsHTML}
                </select>
            </div>`;
        }

        const trailerBodyInnerHTML = trailerKey ? `
            <div class="trailer-thumb-wrap" onclick="playModalTrailer(this)">
                <img class="trailer-thumb-img" src="${trailerThumbUrl}" data-ytid="${trailerKey || ''}" data-thumb-tier="maxres" alt="${escapeAttr(title)} Trailer" loading="lazy" onload="handleTrailerThumbLoad(this)" onerror="handleTrailerThumbError(this)">
                <button type="button" class="trailer-play-btn" aria-label="Play trailer">▶</button>
            </div>
            <div class="trailer-label">Watch Trailer</div>
        ` : (trailerSeasonSelectorHTML ? buildTrailerComingSoonHTML('Trailer for this season will be added soon') : '');

        // Admin panel theke Trailer "Off" kora thakle (movie.trailerEnabled === false)
        // Trailer box-i dekhano hobe na (auto/manual kono trailer-i na). Column-er
        // value null/undefined/true hole age-r moto trailer dekhabe.
        const trailerIsOff = movie.trailerEnabled === false;
        const trailerHTML = (!trailerIsOff && (trailerKey || trailerSeasonSelectorHTML)) ? `
        <div class="trailer-box" id="trailerBox" data-ytid="${escapeAttr(trailerKey || '')}" data-thumb="${escapeAttr(trailerThumbUrl)}">
            ${trailerSeasonSelectorHTML}
            <div id="trailerBoxBody">${trailerBodyInnerHTML}</div>
        </div>
        ` : '';

        // "Watch Now" box - shudhu tokhon-i show hobe jokhon effective watch link
        // paoa jay. Series (TV)-er khetre admin panel-e (Watch Button tab) kono
        // season-er jonno manually "Custom Watch Link" add kora thakle
        // (movie.watchSeasonLinks) - segula-r modhye shobcheye notun (highest)
        // season-take default hishebe dhora hoy (user pore "Online Watch"
        // box-er Season dropdown diye onno season-o select korte parbe, Trailer
        // tab-er season dropdown-er ekdom ekই bhabe). Kono manual season-link
        // na thakle - purono (legacy) shingle "watchLink" field-i (thakle)
        // byabohar hoy, jate age-theke shet-up kora movie/series-o bhenge na
        // jay. Custom link (season-wise ba legacy, jekono-ta) shobar age
        // priority pabe. Na thakle, admin panel-e Watch Button "On" kora
        // thakle (movie.watchEnabled), TMDB-r ID diye embed.filmu.in-er URL
        // auto-generate hoy - eta trailer/poster/original title-er moto-i TMDB
        // theke auto-search kore paoa (resolvedTmdbId, title/IMDb ID diye khoja
        // hoy) - admin-ke TMDB ID field-e hate kore ID boshate hoy na (dile seta-o
        // priority pabe). Content type (Movie/TV Series) onujayi URL-er path-o
        // thik shei onujayi bosbe (movie hole "movie/{tmdbId}", series hole
        // "tv/{tmdbId}/1/1"). Watch Button Off thakle ba TMDB match-i na paile
        // (resolvedTmdbId na thakle) ei goto box-i render hobe na, mane Watch
        // button kokhono dekhabe na.
        const manualWatchFallback = isTV ? resolveManualSeasonWatchLinkFallback(movie, isTV, null) : null;
        const legacyWatchLink = (movie.watchLink && String(movie.watchLink).trim()) || null;
        const customWatchLink = (manualWatchFallback && manualWatchFallback.link) || legacyWatchLink;
        // Series (TV)-er khetre filmu.in-er embed URL-e season/episode-o dorkar hoy
        // (jemon: "tv/{tmdbId}/1/1"), shudhu "tv/{tmdbId}" dile embed kaj kore na.
        // Ei auto-embed URL-ta shudhu tokhon-i lage jokhon admin kono manual link
        // (season-wise ba legacy) deyni - tai eta shobshomoy Season 1, Episode 1
        // use kore (movie-r khetre age-r moto-i thake).
        const autoWatchLink = (!customWatchLink && movie.watchEnabled && resolvedTmdbId)
            ? (isTV
                ? `https://embed.filmu.in/tv/${encodeURIComponent(resolvedTmdbId)}/1/1`
                : `https://embed.filmu.in/movie/${encodeURIComponent(resolvedTmdbId)}`)
            : null;
        const effectiveWatchLink = customWatchLink || autoWatchLink;

        // Watch link paoa gele-o button-ta shathe shathe boshano hoy na - age
        // background-e ekta reachability check (verifyAndRenderWatchBox, "download
        // link auto-check"-er moto shudhu domain/server shompurno unreachable kina
        // dekhe) chalano hoy, seta pass korleই ei khali placeholder-er bhitore
        // asol Watch box boshe (nicher <script> chalanor por). Fole domain/server-i
        // jodi shompurno down thake, Watch button ekdom show-i hobe na.
        // NOTE (limitation): browser-er cross-origin (CORS) restriction-er karone
        // domain live thakle o oi nirdishto video/episode-ta আসলেই paoa jacche
        // kina (server "not found"/"content unavailable" HTML page dilewhole seta-o
        // ekta shadharon 200 response) seta client-side theke shotik bhabe dekha
        // shomvob na - tai shudhu "domain/server shomponno unreachable" case-e-i
        // best-effort-e button hide kora hoy, "wrong/missing video kintu domain live"
        // case-ta 100% dhora jabe na.
        // "Online Watch" ekhon nijer alada box-e thake (download list-er box theke
        // shomponno alada) - tai link/auto-embed kono-tai na paile eijonno wrapper
        // box-taই render kora hoy na (na hole khali box dekha jeto). Reachability
        // check cholte cholte (background-e, 2-3 minute porjonto shomoy lagte
        // pare) - age eituku shomoy-e box-ta ekdom khali/ফাঁকা dekhaতo (user
        // confuse hoye bhabto page bhanga), tai ekhon shuru-teই ekta "⚡ Online
        // Watch" header + choto spinner-shoho loading obostha dekhano hoy - check
        // shesh hole eta ashol interactive box diye (paওয়া gele) replace hoye
        // jay, na hole shompurno wrapper-take hide/remove kore deya hoy.
        const watchHTML = effectiveWatchLink
            ? '<div class="season-accordion-group watch-accordion-group"><div id="watchBoxContainer"><div class="season-box-item watch-box watch-box-loading"><div class="season-box-header" style="cursor:default;"><span>⚡ Online Watch</span><span class="watch-loading-spinner" aria-hidden="true"></span></div></div></div></div>'
            : '';
        // Note: trailer resolve na hole (TMDB-e video nei, YouTube quota shesh, etc.)
        // ekhon r kono user-facing error box dekhano hoy na - trailer box-ta chupchap
        // hide thake. Asol karon (HTTP status + response body) console-e already log
        // kora ache (`lastYoutubeTrailerError` variable-e o dhora ache) - shudhu
        // developer DevTools console kholeই seta dekhte pabe, shob visitor na.

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
        ${trailerHTML}
        ${buildTeraPlayerBoxHTML(movie)}
        ${watchHTML}
        <div class="season-accordion-group">
            ${downloadHTML}
            ${fastServersHTML}
        </div>
        ${renderCommentsSectionShell()}
        `;
        setupExpandableText('audioLangText', 'audioLangToggleBtn');
        setupExpandableText('subsLangText', 'subsLangToggleBtn');
        initCommentsSection(movie);
        verifyAndRenderWatchBox(movie, effectiveWatchLink, title, poster);
    }

    // Age ei "isRendered" flag-ta timeout-fallback render howar por SHOB
    // SHOMOY true hoye thakto, ar tarpor je asol TMDB+OMDb data ashto (Promise.all
    // resolve hoile) seta-o `if (!isRendered)` check-e আটকে গিয়ে কখনো
    // apply/re-render hoto na - ফলে trailer (specially jokhon per-season TMDB video
    // na thakay YouTube search porjonto lagto, jate 1.5s timeout-er cheye beshi
    // shomoy lagto) shudhu-i "Coming Soon" dekhiye ATKE thakto, real trailer
    // pore paoya gele-o r kokhono dekhano hoto na. Ekhon "fallbackRendered" shudhu
    // timeout-ta EKBAR-i fire hoy eta nishchit korte byabohar hocche - asol
    // TMDB/OMDb data ashar por (deri hole-o) shobshomoy notun kore render hobe,
    // jate trailer/rating/cast ইত্যাদি shob field-i shesh porjonto thik data-ta pay.
    let fallbackRendered = false;
    const forceTimeout = setTimeout(() => {
        if (!fallbackRendered) {
            fallbackRendered = true;
            // TMDB response 1.5s-er modhye na ashle amra ei fallback render-e chole jai -
            // kintu tar age-o admin-er manually deya season trailer thakle seta lagiye
            // newa hoy, na hole TMDB slow/fail hoile trailer box-i miss hoye jeto.
            const fb = resolveManualSeasonTrailerFallback(movie, isTV, null);
            if (fb) {
                if (fb.key) trailerKey = fb.key;
                if (fb.thumb) trailerThumbOverride = fb.thumb;
                trailerSelectedSeason = fb.season;
                trailerTvId = movie.tmdbId || null;
            }
            renderModalContent("N/A");
        }
    }, 1500);

    try {
        const [tmdb, omdb] = await Promise.all([
            getFullTMDBDetails(movie).catch(() => null),
            getOMDbDetails(movie).catch(() => null)
        ]);

        clearTimeout(forceTimeout);
        // Ei fetch-ta shesh howar age-i user onno kono movie-r modal khule fele
        // thakle (currentModalMovie ekhon ar ei movie na) - ei purono/stale
        // result-ta notun modal-er upore giye bhul kore boshe pore na, tai
        // eikhane thamiye deya hoy.
        if (currentModalMovie !== movie) return;

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
            if (tmdb.id) resolvedTmdbId = tmdb.id;
            if (!manualTrailerId && tmdb.trailerKey) trailerKey = tmdb.trailerKey;
            if (!manualTrailerId && tmdb.trailerThumb) trailerThumbOverride = tmdb.trailerThumb;
            if (!fetchedImdbId && tmdb.imdbId) {
                fetchedImdbId = tmdb.imdbId;
                imdbUrl = `https://www.imdb.com/title/${fetchedImdbId}/`;
            }

            // --- NEW FIXES FOR GENRES, YEAR, AND RUNTIME/SEASONS ---
            if (tmdb.genre && tmdb.genre !== "N/A") genre = tmdb.genre;
            if (tmdb.year && tmdb.year !== "N/A") year = tmdb.year;
            if (tmdb.releaseDate && tmdb.releaseDate !== "N/A") releaseDate = tmdb.releaseDate;

            if (tmdb.mediaType === 'tv' || isTV) {
                // TMDB koto season dekhacche shetar shathe admin manually koto
                // number porjonto season trailer add koreche - dutor modhye
                // je-ta boro, shei-ta-i final season count hisebe dhora hoy.
                // Na hole TMDB-e data mismatch/wrong match thakle (jemon Money
                // Heist-er khetre hoyechilo, TMDB kom season dekhachilo) admin-er
                // manually add kora shesh 1-2ta season-er trailer dropdown-e
                // ashto na.
                const finalSeasonCount = Math.max(tmdb.numberOfSeasons || 0, getMaxManualSeasonNumber(movie));
                if (finalSeasonCount > 0) {
                    durationOrSeasonPill = finalSeasonCount > 1 ? `${finalSeasonCount} Seasons` : `1 Season`;
                    trailerSeasonCount = finalSeasonCount;
                }
                if (tmdb.id) trailerTvId = tmdb.id;
                if (tmdb.latestSeasonNumber) trailerSelectedSeason = tmdb.latestSeasonNumber;

                // Series-er khetre admin panel theke ei nirdishto (latest) season-er
                // jonno manually trailer deya thakle, seta shob kichur cheye age
                // priority pabe - legacy shingle trailerLink ba TMDB/YouTube auto
                // trailer-o override kore dey.
                const manualSeasonTrailer = getManualSeasonTrailer(movie, trailerSelectedSeason);
                if (manualSeasonTrailer) {
                    if (manualSeasonTrailer.key) trailerKey = manualSeasonTrailer.key;
                    if (manualSeasonTrailer.thumb) trailerThumbOverride = manualSeasonTrailer.thumb;
                }
            } else {
                if (tmdb.runtime && tmdb.runtime !== "N/A") {
                    durationOrSeasonPill = convertRuntimeToHours(tmdb.runtime);
                }
            }
            // -------------------------------------------------------
        }

        // TMDB shofol hoile-o (upore) kono karone (latestSeasonNumber match na khawa,
        // TMDB-e videos na thaka, ইত্যাদি) trailerKey ekhono set na hole - shesh
        // upay hishebe admin-er manually deya season trailer (thakle) lagiye newa hoy,
        // jate manually add kora trailer/teaser kokhono chupchap miss na hoy.
        if (isTV && !trailerKey) {
            const fb = resolveManualSeasonTrailerFallback(movie, isTV, trailerSelectedSeason);
            if (fb) {
                if (fb.key) trailerKey = fb.key;
                if (fb.thumb) trailerThumbOverride = fb.thumb;
                trailerSelectedSeason = fb.season;
                trailerTvId = trailerTvId || (tmdb && tmdb.id) || movie.tmdbId || null;
            }
        }

        if (omdb) {
            if (omdb.awards && omdb.awards !== "N/A") awards = omdb.awards;
            // TMDB-e match na paile OMDb (IMDb ID diye) er poster use koro
            if (omdb.poster && !movie.poster && !(tmdb && tmdb.poster)) poster = omdb.poster;
        }

        smartRating = getSmartRating(tmdb, omdb);

        renderModalContent(smartRating);
    } catch (err) {
        console.error("Modal fetch error:", err);
        clearTimeout(forceTimeout);
        if (currentModalMovie !== movie) return;
        const fb = resolveManualSeasonTrailerFallback(movie, isTV, trailerSelectedSeason);
        if (fb) {
            if (fb.key) trailerKey = fb.key;
            if (fb.thumb) trailerThumbOverride = fb.thumb;
            trailerSelectedSeason = fb.season;
            trailerTvId = trailerTvId || movie.tmdbId || null;
        }
        renderModalContent("N/A");
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

// Watch box-e video (iframe) chalu thakle seta remove kore abar age-r
// thumbnail card (play button shoho) ferot boshiye dey - ei ekই logic
// duijaygay lage: (1) box-er nijer ✖ close button-e click korle, (2) "Online
// Watch" section-take accordion hide/collapse kore dile (toggleAccordion,
// nicher shathe dekho) - tai duibar code na likhe alada function-e ber kora
// hoyeche.
// "Online Watch" thumbnail-er (poster/backdrop) upore ekta choto label
// (badge) bosano hoy - eta getManualSeasonWatchBadge()-theke asha
// episode-RANGE text (jemon "EP-(01-02)", admin nijer custom label diye
// thakle seta, na hole auto min-max range) - kono season-e 1-er beshi
// episode-specific manual link na thakle (ba movie hole) ei text khali
// thake, tokhon kono badge dekhano hoy na.
function buildWatchThumbEpisodeBadgeHTML(badgeText) {
    const text = (badgeText || '').trim();
    if (!text) return '';
    return `<span class="watch-thumb-episode-badge">${escapeHtml(text)}</span>`;
}

function resetWatchBoxToThumbnail(box) {
    if (!box) return;
    const bodyEl = box.querySelector('#watchBoxBody');
    if (!bodyEl) return;
    const poster = box.getAttribute('data-poster') || '';
    const title = box.getAttribute('data-title') || '';
    const seasonNum = parseInt(box.getAttribute('data-season'), 10);
    // data-episode-o poRa hoy, jate Episode dropdown change korar por thumbnail
    // rebuild howar shomoy badge-e thik SELECTED episode-er number-i boshe.
    const epAttr = box.getAttribute('data-episode');
    const epNum = epAttr === null || epAttr === '' ? null : parseInt(epAttr, 10);
    const badgeText = Number.isFinite(seasonNum) ? getWatchThumbBadgeText(currentModalMovie, seasonNum, epNum) : '';
    const episodeBadgeHTML = buildWatchThumbEpisodeBadgeHTML(badgeText);
    bodyEl.innerHTML = `
        <div class="trailer-thumb-wrap" onclick="playModalWatch(this)">
            <img class="trailer-thumb-img" src="${poster}" alt="${title} Watch" loading="lazy" onerror="handlePosterImgError(this)">
            ${episodeBadgeHTML}
            <button type="button" class="trailer-play-btn watch-play-btn" aria-label="Play watch">▶</button>
        </div>
    `;
}

function toggleAccordion(id) {
    const el = document.getElementById(id);
    if (!el) return;
    // "Dropdown menu" feel deyar jonno ekhon r shorashori style.display
    // change kora hoy na - "open" class add/remove kore CSS transition
    // (max-height/opacity) diye smooth slide-down/slide-up animation hoy,
    // ar header-er "is-open" class diye dropdown-arrow (thakle) rotate hoy.
    //
    // Query-ta shudhu ei accordion je modal-box-er (movie details page)
    // bhitore ache, shei modal-box-er bhitore-i scope kora hoy - shompurno
    // "document" jure query korle, homepage-er "500K+ Movies & TV Shows"
    // (massive-watch player, jar nijer-o ekta "open" .season-download-body
    // thake) er moto modal-er BAIRE thaka, shompurno onno ekta section-o
    // bhul kore bondho/collapse hoye jeto - jemon: kono content search kore
    // seta play kore, tarpor ONNO ekta movie-r details page-e giye shei
    // notun modal-er kono download/watch accordion-e click korleই, age-r
    // search player-ta (background-e video chalu thaka shotteo) hঠাৎ hide
    // hoye jeto.
    const scope = el.closest('.modal-box') || document;
    const isOpen = el.classList.contains('open');
    scope.querySelectorAll('.season-download-body.open').forEach(item => {
        item.classList.remove('open');
        const hdr = item.previousElementSibling;
        if (hdr && hdr.classList.contains('season-box-header')) hdr.classList.remove('is-open');

        // "Online Watch" button/section hide (collapse) hoye gele - jodi
        // video (iframe) tokhon chalu thake - shudhu CSS-e hide korle iframe
        // DOM-e thekei jay ar background-e audio/video baja-i thake (thik
        // modal close korar shomoy-er ageer bug-tar moto-i). Tai emon
        // obosthay video-take remove kore abar thumbnail card-e ferot niye
        // asha hoy, jate "Online Watch" hide howar shathe shathe video-o
        // shathe shathe pause/stop hoye jay - shudhu nijer header-e abar
        // click korle na, onno kono download/server accordion khulleo
        // (jeta ei "Online Watch" box-take auto-collapse kore dey) ekই
        // bhabe kaj kore.
        if (item.querySelector('.trailer-video-wrap')) {
            const watchBox = item.closest('.watch-box');
            if (watchBox) resetWatchBoxToThumbnail(watchBox);
        }
        // Video Player (Terabox) box hide/collapse hoile - video/hls thamiye
        // abar thumbnail-e ferot niye asha, noile background-e chalu thakto.
        const teraPanel = item.querySelector('.tera-play-panel.open');
        if (teraPanel) closeTeraPlayerPanel(teraPanel.id);
    });
    if (!isOpen) {
        el.classList.add('open');
        const hdr = el.previousElementSibling;
        if (hdr && hdr.classList.contains('season-box-header')) hdr.classList.add('is-open');
    }
}

// Modal-এর Trailer বক্সে ক্লিক করলে thumbnail-এর জায়গায় YouTube video embed করে
// autoplay শুরু করে দেয় (আগে থেকে iframe লোড না করে শুধু thumbnail দেখিয়ে rakha হয়,
// tai modal khulei extra network/video load hoy na)
function playModalTrailer(el) {
    const box = el.closest('.trailer-box');
    if (!box) return;
    const bodyEl = box.querySelector('#trailerBoxBody');
    if (!bodyEl) return;
    const ytId = box.getAttribute('data-ytid');
    if (!ytId) return;
    const embedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0`;
    // Ei site-e COOP/COEP header active thake (ffmpeg.wasm media-scan feature-er jonno
    // proyojon), r shei COEP-r karone third-party YouTube iframe-take browser default-e
    // block kore dei ("refused to connect" dekhায়) - eta youtube-r shomossha na.
    // "credentialless" attribute dile Chrome/Edge-e eta abar kaj kore (COEP bypass hoy
    // ei ekta frame-er jonno), kintu Firefox/Safari-te ei attribute support nei - tai
    // shei browser-e trailer nao chalte pare (iframe block hoye jete pare).
    // Admin panel theke manually thumbnail set kora thakle sheita age priority pabe,
    // na thakle auto YouTube thumbnail fallback hishebe use hobe.
    const thumbUrl = box.getAttribute('data-thumb') || `https://img.youtube.com/vi/${encodeURIComponent(ytId)}/maxresdefault.jpg`;
    // background-e thumbnail rekhe dewa holo, tai iframe block/blank thakle o box-ta
    // kokhono khali/kalo dekhabe na - thumbnail-i poster hishebe thakbe.
    // NOTE: shudhu #trailerBoxBody-r content replace kora hoy (pura .trailer-box na),
    // karon .trailer-box-er bhetore trailerSeasonSelectorHTML (Season dropdown)-o thake -
    // pura box replace korle shei dropdown-o muche jeto.
    bodyEl.innerHTML = `<div class="trailer-video-wrap" style="background-image:url('${thumbUrl}')">
        <iframe src="${embedUrl}" title="Trailer" frameborder="0" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen credentialless></iframe>
    </div>`;
}

// ==================== WATCH LINK REACHABILITY CHECK ====================
// Download link auto-check (autoCheckDownloadLinks, upore dekho)-er moto-i ekই
// limitation ekhaneo prозошjjo: browser cross-origin response-er content
// (video asholei ache kina) dekhte pay na (CORS + Same-Origin Policy), tai
// eituku-i best-effort check kora shomvob - embed URL-er domain/server-i jodi
// shompurno unreachable hoy (DNS fail, connection refused, timeout), shudhu
// tokhon-i Watch button hide kora hoy. Domain live thakle (video na thakleo,
// jemon "not found" HTML page-o normal 200 response) button dekhabe - eta
// "video asholei play korbe"-r 100% guarantee na, DEAD DOMAIN-er khetre
// button na dekhano-r best-effort guarantee.
// ==================== WATCH LINK REACHABILITY CHECK ====================
// Download link auto-check (autoCheckDownloadLinks, upore dekho)-er moto-i ekই
// limitation ekhaneo prозошjjo: browser cross-origin response-er content
// (video asholei ache kina) dekhte pay na (CORS + Same-Origin Policy), tai
// eituku-i best-effort check kora shomvob - embed URL-er domain/server-i jodi
// shompurno unreachable hoy (DNS fail, connection refused, timeout), shudhu
// tokhon-i Watch button hide kora hoy. Domain live thakle (video na thakleo,
// jemon "not found" HTML page-o normal 200 response) button dekhabe - eta
// "video asholei play korbe"-r 100% guarantee na, DEAD DOMAIN-er khetre
// button na dekhano-r best-effort guarantee.
//
// Server slow hoye active hote shomoy nite pare (cold start, temporary
// overload, ইত্যাদি) - tai shudhu ekবার check kore shathe shathe hide kore
// deya hoy na. Kono active response na paoa porjonto proti kicchu shomoy
// por por retry kora hoy, mote WATCH_CHECK_MAX_WINDOW_MS (~2.5 minute)
// shomoy dhore - eituku shomoy-er modhyeo kono response na ele-i shesh
// porjonto "no active server" dhore niye Watch button hide kora hoy.
const watchLinkAvailabilityCache = new Map();
const WATCH_CHECK_ATTEMPT_TIMEOUT_MS = 6000;
const WATCH_CHECK_RETRY_DELAY_MS = 8000;
const WATCH_CHECK_MAX_WINDOW_MS = 150000; // ~2.5 minutes total retry window

async function checkWatchLinkReachable(url, shouldContinue) {
    if (!url) return false;
    if (watchLinkAvailabilityCache.has(url)) return watchLinkAvailabilityCache.get(url);
    const promise = (async () => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < WATCH_CHECK_MAX_WINDOW_MS) {
            // User modal bondho kore diyeche ba onno movie khule ফেললে ar
            // background-e retry chaliye lav nei - shathe shathe theme jai.
            if (typeof shouldContinue === 'function' && !shouldContinue()) return false;
            try {
                await fetchWithTimeout(url, { mode: 'no-cors', method: 'HEAD' }, WATCH_CHECK_ATTEMPT_TIMEOUT_MS);
                return true;
            } catch (err) {
                // eituku somoy avaliable thakle retry hobe, na hole niche loop-i shesh hobe
            }
            const remaining = WATCH_CHECK_MAX_WINDOW_MS - (Date.now() - startedAt);
            if (remaining <= 0) break;
            await new Promise(res => setTimeout(res, Math.min(WATCH_CHECK_RETRY_DELAY_MS, remaining)));
        }
        return false;
    })();
    watchLinkAvailabilityCache.set(url, promise);
    return promise;
}

// Modal render howar por background-e ei function-i asholei "Watch Now" box-take
// khali placeholder (#watchBoxContainer)-er bhitore boshay - kintu shudhu tokhon-i,
// jokhon reachability check pass kore (upore-r 2-3 minute retry window-er
// modhye kono active response paoa gele). Ei shomoy-er moddhe user modal bondho
// kore dile ba onno kono movie-r modal khule ফেললে (currentModalMovie change
// hoye gele) - ba shesh porjonto kono active server na paoa gele - kichu-i
// inject kora hoy na, mane Watch button kokhono dekha jay na.
// TV series-e admin je-je season-er jonno (season-wide ba episode-specific,
// jekono-ta) Watch link diyeche, shegular UNIQUE season number-er sorted
// list dey - Season dropdown banate lage. (Ekek season-e ekaadhik row thakte
// pare - jemon S1-er "gota season" entry + S1E5-er alada entry - tai
// duplicate bad deya hoy.)
function getManualWatchSeasonsList(movie) {
    if (!movie || movie.tmdbType !== 'tv' || !Array.isArray(movie.watchSeasonLinks) || !movie.watchSeasonLinks.length) return [];
    return movie.watchSeasonLinks
        .filter(sw => sw && sw.link && Number.isFinite(Number(sw.season)))
        .map(sw => Number(sw.season))
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .sort((a, b) => a - b);
}

// "Online Watch" box-er Season + Episode, duto dropdown-er HTML ekshathe
// banay (selectedSeason-er upor bhitti kore Episode dropdown-er option-gula
// thik hoy) - eta prothom render (verifyAndRenderWatchBox) ar Season change
// (changeModalWatchSeason) duto jaygay-i reuse hoy, jate code duibar likhte
// na hoy.
function buildWatchSelectorsHTML(movie, manualWatchSeasons, selectedSeason) {
    let html = '';
    if (manualWatchSeasons.length > 1) {
        let seasonOptionsHTML = '';
        manualWatchSeasons.forEach(s => {
            // Admin nijer TEXT label diye thakle dropdown-e shei lekha-i
            // dekhabe, na hole shadharon "Season 5".
            const sText = getManualSeasonLabel(movie, s) || `Season ${s}`;
            seasonOptionsHTML += `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${escapeHtml(sText)}</option>`;
        });
        html += `
        <div class="trailer-season-row watch-season-row">
            <label for="watchSeasonSelect">Season:</label>
            <select id="watchSeasonSelect" class="trailer-season-select watch-season-select" onchange="changeModalWatchSeason(this)">
                ${seasonOptionsHTML}
            </select>
        </div>`;
    }
    const episodes = selectedSeason != null ? getManualEpisodesForSeason(movie, selectedSeason) : [];
    const defaultEpisode = episodes.length ? episodes[0] : null;
    // Episode dropdown shudhu tokhon-i dekhano hoy jokhon shei season-er
    // jonno 1-er beshi ALADA-episode-specific link deya ache - na hole
    // (shudhu "gota season" entry thakle) ekta-i link shob episode-e chole,
    // tai Episode dropdown dorkar nei.
    if (episodes.length > 1) {
        let episodeOptionsHTML = '';
        episodes.forEach(e => {
            // Admin nijer TEXT label diye thakle dropdown-e shei lekha-i
            // dekhabe, na hole shadharon "Episode 3".
            const epText = getManualEpisodeLabel(movie, selectedSeason, e) || `Episode ${e}`;
            episodeOptionsHTML += `<option value="${e}" ${e === defaultEpisode ? 'selected' : ''}>${escapeHtml(epText)}</option>`;
        });
        html += `
        <div class="trailer-season-row watch-season-row watch-episode-row">
            <label for="watchEpisodeSelect">Episode:</label>
            <select id="watchEpisodeSelect" class="trailer-season-select watch-season-select" onchange="changeModalWatchEpisode(this)">
                ${episodeOptionsHTML}
            </select>
        </div>`;
    }
    return { html, defaultEpisode };
}

async function verifyAndRenderWatchBox(movie, link, title, poster) {
    if (!link) return;
    const stillRelevant = () => {
        if (currentModalMovie !== movie) return false;
        const overlay = document.getElementById('movieModalOverlay');
        return !!overlay && overlay.style.display === 'flex';
    };
    const ok = await checkWatchLinkReachable(link, stillRelevant);
    if (!stillRelevant()) return;
    if (!ok) {
        // 2-3 minute retry window-er modheeo kono active server paoa na gele
        // "Online Watch"-er jonno banano khali alada box-taও (border/padding
        // shoho) hide/remove kore dao, na hole content chara-i ekta khali box
        // dekha jeto.
        const emptyWrap = document.querySelector('.watch-accordion-group');
        if (emptyWrap) emptyWrap.remove();
        return;
    }
    const overlay = document.getElementById('movieModalOverlay');
    if (!overlay || overlay.style.display !== 'flex') return;
    const container = document.getElementById('watchBoxContainer');
    if (!container) return;

    // Series (TV)-er khetre admin panel-e (Watch Button tab) 1-er beshi
    // season-er jonno alada-alada manual watch link add kora thakle, ekta
    // Season dropdown dekhano hoy (Trailer tab-er moto-i) - ar shei season-er
    // modhye abar alada-alada EPISODE-er jonno-o link deya thakle, ekta
    // Episode dropdown-o dekhano hoy - jate user chaile nirdishto episode-o
    // select korte pare. Shudhu segula season-i list-e dekhano hoy jegular
    // jonno admin আসলেই link diyeche (1-theke-N continuous dhore newa hoy
    // na) - eta "sudhu manually link add korle-i" show hoy, auto TMDB embed
    // byabohar hole ei dropdown-gula ashe na.
    const manualWatchSeasons = getManualWatchSeasonsList(movie);
    const defaultWatchSeason = manualWatchSeasons.length ? manualWatchSeasons[manualWatchSeasons.length - 1] : null;
    const { html: watchSeasonSelectorHTML, defaultEpisode: defaultWatchEpisode } = buildWatchSelectorsHTML(movie, manualWatchSeasons, defaultWatchSeason);

    // Thumbnail priority: (1) shei nirdishto season+episode-er Watch Link
    // row-e manually deya thumbnail (jodi TV series-e season/episode-wise
    // link byabohar hoy) - (2) "Custom watch thumbnail" (global, shob
    // season-er jonno common) field - (3) TMDB-r "backdrop" (16:9 landscape
    // screenshot-moto image, Hero banner-e jeta byabohar hoy, poster-er theke
    // box-er shape-er shathe onek beshi manay) - (4) shesh upay hishebe
    // movie/series-er "poster" (lomba/portrait). "fallbackThumbUrl" (global
    // watchThumb/backdrop/poster) ta box-e data-attribute hishebe rekhe deya
    // hoy, jate Season/Episode dropdown-e switch korar shomoy backdrop abar
    // fetch na kore-i reuse kora jay.
    const seasonSpecificThumb = defaultWatchSeason != null ? getManualSeasonWatchThumb(movie, defaultWatchSeason, defaultWatchEpisode) : null;
    const defaultWatchBadge = defaultWatchSeason != null ? getWatchThumbBadgeText(movie, defaultWatchSeason, defaultWatchEpisode) : '';
    const customWatchThumb = (movie.watchThumb && String(movie.watchThumb).trim()) || null;
    let fallbackThumbUrl = customWatchThumb;
    if (!fallbackThumbUrl) {
        const backdropData = await fetchHeroBackdrop(movie).catch(() => null);
        if (!stillRelevant()) return; // ei await cholakalin modal bondho/movie change hoye gele ar egono na
        fallbackThumbUrl = (backdropData && backdropData.backdrop) || poster;
    }
    const watchThumbUrl = seasonSpecificThumb || fallbackThumbUrl;

    // Download list-er row-gulor moto ekই style-e (purple header + ZIP-er moto
    // right-side badge) "Online Watch" row hishebe boshano hoy, jate ei button-o
    // download button-er moto-i dekhte lage - header-e click korle
    // toggleAccordion() diye body shudhu show/hide (toggle) hoy, view count
    // barano hoy na. View count শুধু video-r ▶ play button-e click korle-i
    // (playModalWatch()) barbe, jate accordion-ta shudhu open kore dekhleই
    // "view" count na hoye jay.
    container.innerHTML = `
        <div class="season-box-item watch-box" id="watchBox" data-link="${escapeAttr(link)}" data-poster="${escapeAttr(watchThumbUrl)}" data-fallback-thumb="${escapeAttr(fallbackThumbUrl)}" data-title="${escapeAttr(title)}" data-season="${defaultWatchSeason != null ? defaultWatchSeason : ''}" data-episode="${defaultWatchEpisode != null ? defaultWatchEpisode : ''}">
            <div class="season-box-header" onclick="toggleAccordion('watchAccordionBody')">
                <span>⚡ Online Watch</span>
                <div class="season-badges-right">
                    <span class="dropdown-arrow">▼</span>
                </div>
            </div>
            <div class="season-download-body" id="watchAccordionBody">
                <div id="watchSelectorArea">${watchSeasonSelectorHTML}</div>
                <div id="watchBoxBody">
                    <div class="trailer-thumb-wrap" onclick="playModalWatch(this)">
                        <img class="trailer-thumb-img" src="${watchThumbUrl}" alt="${escapeAttr(title)} Watch" loading="lazy" onerror="handlePosterImgError(this)">
                        ${buildWatchThumbEpisodeBadgeHTML(defaultWatchBadge)}
                        <button type="button" class="trailer-play-btn watch-play-btn" aria-label="Play watch">▶</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Watch button-e (Online Watch modal box ba homepage-er "500K+" search
// player, sob jaygay-i) ▶ play-e click korle - embed.filmu.in/third-party
// video source-e majhe-modhye pop-up/redirect ads dekhate pare, tai video
// load howar shathe shathe screen-er upore ekta choto (auto-dismiss hoye
// jay) reminder toast dekhano hoy, jate user AdBlocker use korar bepare
// shotorko thake.
function showAdblockNotice() {
    showToast('⚠️ Use an AdBlocker for the best experience — this video source may show pop-up ads.', null, { duration: 6000 });
}

// "Watch Now" box-e click korle - thik trailer-er moto-i - thumbnail-er jaygay
// ekta embedded video iframe show kore dey. Admin panel-e "Watch Button" On kore
// TMDB ID diye rakhle eta embed.filmu.in-er "movie/{tmdbId}" URL diye iframe
// generate kore (jemon: <iframe src="https://embed.filmu.in/movie/1726" ...>),
// r Custom Watch Link deya thakle (YouTube link hole) shei link auto video ID
// ber kore youtube-nocookie embed banay, na hole shei link-i shorashori iframe-e
// boshay.
function playModalWatch(el) {
    const box = el.closest('.watch-box');
    if (!box) return;
    const bodyEl = box.querySelector('#watchBoxBody');
    if (!bodyEl) return;
    const rawLink = box.getAttribute('data-link');
    if (!rawLink) return;

    showAdblockNotice();

    const ytId = extractYoutubeVideoId(rawLink);
    const embedUrl = ytId
        ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0`
        : rawLink;

    // Note: referrerpolicy + credentialless attribute-dui-ta filmu.in-er official
    // embed snippet-e thake na, kintu ei site-e COOP/COEP header active thaka-r
    // karone segula chara third-party iframe (filmu.in/YouTube shobar jonno-i)
    // browser default-e block kore dite pare - tai trailer iframe-er moto ekhaneo
    // rakha hoyeche, jate embed shob browser-e reliably load hoy.
    // Close button ekhon video-r (iframe-er) BAIRE, upore alada ekta slim bar-e
    // thake - age eta iframe-er upore (top-right) bhaseto, fole player-er nijer
    // panel (jemon Audio/Subtitle menu)-er close button-er thik upore chole
    // jeto, ar user panel bondho korte giye bhul kore pura video-i close kore
    // felto.
    bodyEl.innerHTML = `<div class="watch-player-toolbar">
        <button type="button" class="watch-close-btn" aria-label="Close video" title="Close video" onclick="closeModalWatch(this)"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button>
    </div>
    <div class="trailer-video-wrap">
        <iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen credentialless></iframe>
    </div>`;

    incrementMovieViews(currentModalMovie);
}

// Watch box-e video play hocche emon obosthay upore-r ✖ button-e click korle -
// iframe remove kore abar age-r thumbnail card (transparent play button shoho)
// ferot niye ashe, jate Watch button show/hide dutoi (toggle) hishebe kaj kore -
// shudhu ekbar show hoye chirokal video-i na theke.
function closeModalWatch(el) {
    const box = el.closest('.watch-box');
    resetWatchBoxToThumbnail(box);
}

// "Online Watch" box-er Season dropdown-e (jekhon admin 1-er beshi season-er
// jonno manual watch link diyeche) onno season select korle - Trailer-er
// season dropdown-er ulto, ekhane kono API call/fetch lage na, karon Watch
// link-gula shorashori admin-er nijer deya (movie.watchSeasonLinks-e already
// client-side-e ache). Notun season-e shei season-er nijer DEFAULT episode-o
// (thakle) thik kore neya hoy, ar Episode dropdown-take-o (jodi shei season-e
// alada-alada episode-specific link thake) notun kore rebuild kora hoy -
// age-r season-er episode-list r prashongik thake na. Video already chalu
// thakle seta bondho kore abar (notun link-er jonno taja) thumbnail card
// dekhano hoy - user abar ▶ chaplei notun episode-er video load hobe.
function changeModalWatchSeason(selectEl) {
    const box = selectEl.closest('.watch-box');
    if (!box) return;
    const seasonNumber = parseInt(selectEl.value, 10);
    if (Number.isNaN(seasonNumber)) return;

    const defaultEpisode = resolveDefaultEpisodeForSeason(currentModalMovie, seasonNumber);
    const newLink = getManualSeasonWatchLink(currentModalMovie, seasonNumber, defaultEpisode);
    if (!newLink) return;

    box.setAttribute('data-link', newLink);
    box.setAttribute('data-season', seasonNumber);
    box.setAttribute('data-episode', defaultEpisode != null ? defaultEpisode : '');

    // Ei season+episode-er Watch Link row-e nijer kono manual thumbnail deya
    // thakle seta-i priority pabe, na hole shuru-te resolve kora "fallback"
    // thumbnail (global Custom watch thumbnail / TMDB backdrop / poster -
    // data-fallback-thumb-e save kora ache) byabohar hobe - notun kore
    // backdrop fetch korar dorkar nei.
    const seasonThumb = getManualSeasonWatchThumb(currentModalMovie, seasonNumber, defaultEpisode);
    const fallbackThumb = box.getAttribute('data-fallback-thumb') || box.getAttribute('data-poster') || '';
    box.setAttribute('data-poster', seasonThumb || fallbackThumb);

    // Episode dropdown-take (thakle) notun season-er upojukto option diye
    // rebuild kora hoy - Season dropdown-er nijer notun selection-o thik
    // bhabe "selected" thake, tai user-er dropdown click-e kono jump/reset
    // dekha jay na.
    const selectorArea = box.querySelector('#watchSelectorArea');
    if (selectorArea) {
        const manualWatchSeasons = getManualWatchSeasonsList(currentModalMovie);
        const { html } = buildWatchSelectorsHTML(currentModalMovie, manualWatchSeasons, seasonNumber);
        selectorArea.innerHTML = html;
    }

    resetWatchBoxToThumbnail(box);
}

// "Online Watch" box-er Episode dropdown-e (jekhon shei season-e 1-er beshi
// alada episode-specific manual watch link thake) onno episode select korle -
// Season-i ekই thake (box-er "data-season" attribute theke poRa hoy), shudhu
// oi season-er bhitorer NOTUN episode-er link/thumbnail-e switch kora hoy.
function changeModalWatchEpisode(selectEl) {
    const box = selectEl.closest('.watch-box');
    if (!box) return;
    const episodeNumber = parseInt(selectEl.value, 10);
    if (Number.isNaN(episodeNumber)) return;
    const seasonNumber = parseInt(box.getAttribute('data-season'), 10);
    if (Number.isNaN(seasonNumber)) return;

    const newLink = getManualSeasonWatchLink(currentModalMovie, seasonNumber, episodeNumber);
    if (!newLink) return;

    box.setAttribute('data-link', newLink);
    box.setAttribute('data-episode', episodeNumber);

    const episodeThumb = getManualSeasonWatchThumb(currentModalMovie, seasonNumber, episodeNumber);
    const fallbackThumb = box.getAttribute('data-fallback-thumb') || box.getAttribute('data-poster') || '';
    box.setAttribute('data-poster', episodeThumb || fallbackThumb);

    resetWatchBoxToThumbnail(box);
}

// ==================== "500K+ Movies & TV Shows" homepage search-and-watch
// section ====================
// Admin panel-e database-e add kora na thakleও - je kono movie/TV series
// nam diye search korle, TMDB theke shei content-er ID ber kore, "Online
// Watch"-e byabohar hoya shei ekই embed.filmu.in iframe pattern use kore
// shathe shathe watch kora jay. Eta ekTA shudhu-i "kono nirdishto movie-r
// object" na thaka obosthay-o kaj kore, tai movie-grid/admin database-er
// baire, homepage-e nijer alada, shwotontro (self-contained) code.

let massiveWatchDebounceTimer = null;
let massiveWatchRequestId = 0;

function initMassiveWatchSection() {
    const input = document.getElementById('massiveWatchInput');
    const clearBtn = document.getElementById('massiveWatchClearBtn');
    const resultsEl = document.getElementById('massiveWatchResults');
    const wrap = input ? input.closest('.massive-watch-search-wrap') : null;
    if (!input || !resultsEl) return;

    const hideSuggestions = () => { resultsEl.innerHTML = ''; };

    input.addEventListener('input', () => {
        clearTimeout(massiveWatchDebounceTimer);
        const q = input.value.trim();
        const playerEl = document.getElementById('massiveWatchPlayer');
        massiveWatchRequestId++; // age-r kono pending search/player update thakle seta bad
        if (playerEl) playerEl.innerHTML = '';
        // Search bar-e kichu likhle-i clear ("✕") button dekha jay, khali thakle
        // hidden thake.
        if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
        if (!q) {
            hideSuggestions();
            return;
        }
        massiveWatchDebounceTimer = setTimeout(() => runMassiveWatchSearch(q), 350);
    });

    // Clear ("✕") button-e click korle - search bar khali kore, suggestion
    // dropdown ar (jodi thake) player-o bondho kore dey, tarpor abar
    // search bar-e focus kore dey (jate user shathe shathe notun kore
    // likhte pare).
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            hideSuggestions();
            const playerEl = document.getElementById('massiveWatchPlayer');
            if (playerEl) playerEl.innerHTML = '';
            massiveWatchRequestId++;
            input.focus();
        });
    }

    // Search bar-er baire kono jaygay click korle suggestion dropdown-ta
    // bondho hoye jabe (shadharon autocomplete UX pattern-er moto-i).
    document.addEventListener('click', (e) => {
        if (wrap && !wrap.contains(e.target)) hideSuggestions();
    });
}

async function runMassiveWatchSearch(query) {
    const myRequestId = ++massiveWatchRequestId;
    const resultsEl = document.getElementById('massiveWatchResults');
    if (!resultsEl) return;
    resultsEl.innerHTML = '<div class="massive-watch-status">Searching...</div>';
    if (!TMDB_API_KEY) {
        resultsEl.innerHTML = '<div class="massive-watch-status">Search is unavailable right now.</div>';
        return;
    }
    try {
        const url = `${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&include_adult=false`;
        const res = await fetch(url);
        if (myRequestId !== massiveWatchRequestId) return; // ei shomoy-e user aro likhe felle, ei purono result-ta ar dorkar nei
        if (!res.ok) throw new Error('TMDB search failed: ' + res.status);
        const data = await res.json();
        if (myRequestId !== massiveWatchRequestId) return;

        const items = (data.results || [])
            .filter(r => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path)
            .slice(0, 8);

        if (!items.length) {
            resultsEl.innerHTML = '<div class="massive-watch-status">No results found. Try a different name.</div>';
            return;
        }

        // Autocomplete dropdown-er moto compact list - proti row-e ekta choto
        // (poster-shape) thumbnail + naam + year/type, click korleই niche
        // watch box khule jay. Dropdown-er choto thumbnail-e poster-i thik
        // ache (portrait shape-er shathe manay), kintu niche-r "watch box"-e
        // (16:9 shape) fit korার jonno alada-bhabe "backdrop_path"-o
        // (TMDB search result-e already thake, notun kore fetch korte hoy
        // na) save kore rakha hoy - "Online Watch"-e Hero banner-er backdrop
        // byabohar korar ekই cause-e, jate portrait poster দিয়ে 16:9 box-e
        // crop/letterbox na hoy.
        resultsEl.innerHTML = items.map(item => {
            const rawTitle = item.title || item.name || 'Untitled';
            const year = ((item.release_date || item.first_air_date || '').slice(0, 4)) || '';
            const poster = `https://image.tmdb.org/t/p/w92${item.poster_path}`;
            const fullPoster = `https://image.tmdb.org/t/p/w342${item.poster_path}`;
            const backdrop = item.backdrop_path ? `https://image.tmdb.org/t/p/w780${item.backdrop_path}` : '';
            const typeLabel = item.media_type === 'tv' ? 'TV Series' : 'Movie';
            return `
                <div class="massive-watch-suggestion-item" data-id="${item.id}" data-type="${item.media_type}" data-title="${escapeAttr(rawTitle)}" data-poster="${escapeAttr(fullPoster)}" data-backdrop="${escapeAttr(backdrop)}" onclick="selectMassiveWatchResult(this)">
                    <img src="${poster}" alt="${escapeAttr(rawTitle)}" loading="lazy">
                    <div class="massive-watch-suggestion-info">
                        <div class="massive-watch-suggestion-title">${escapeHtml(rawTitle)}</div>
                        <div class="massive-watch-suggestion-meta">${typeLabel}${year ? ' • ' + year : ''}</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        if (myRequestId !== massiveWatchRequestId) return;
        console.error('Massive watch search error:', err);
        resultsEl.innerHTML = '<div class="massive-watch-status">Search failed, please try again.</div>';
    }
}

function selectMassiveWatchResult(itemEl) {
    const id = itemEl.getAttribute('data-id');
    const type = itemEl.getAttribute('data-type');
    const title = itemEl.getAttribute('data-title');
    const poster = itemEl.getAttribute('data-poster');
    const backdrop = itemEl.getAttribute('data-backdrop');

    // Selection kora matro-i suggestion dropdown bondho hoye jay ar search
    // bar-e select kora naam-ta boshe jay (shadharon autocomplete UX-er moto-i),
    // tarpor "Online Watch"-er moto-i box-e content-ta watch kora jay.
    const input = document.getElementById('massiveWatchInput');
    const resultsEl = document.getElementById('massiveWatchResults');
    if (input) input.value = title;
    if (resultsEl) resultsEl.innerHTML = '';

    // Player box-ta 16:9 shape-er, tai portrait "poster"-er bodole TMDB-r
    // "backdrop" (16:9 landscape screenshot-moto image) thakle seta-i
    // priority pabe - eta box-er shape-er shathe onek beshi manay, tai kono
    // crop/letterbox chara-i clear bhabe dekhte lage. Backdrop na thakle
    // (kichu title-er backdrop nao thakte pare) - poster-i fallback hishebe
    // byabohar hoy.
    const thumb = (backdrop && backdrop.trim()) || poster;
    renderMassiveWatchPlayer(id, type, title, thumb);
    const playerEl = document.getElementById('massiveWatchPlayer');
    if (playerEl) playerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function renderMassiveWatchPlayer(tmdbId, mediaType, title, poster) {
    const playerEl = document.getElementById('massiveWatchPlayer');
    if (!playerEl) return;
    const requestId = ++massiveWatchRequestId;

    // "Online Watch"-e byabohar hoya shei ekই embed.filmu.in URL pattern -
    // movie hole "movie/{tmdbId}", series hole "tv/{tmdbId}/1/1" (Season 1,
    // Episode 1 default - shei ekই limitation "Online Watch"-erও ache).
    const link = mediaType === 'tv'
        ? `https://embed.filmu.in/tv/${encodeURIComponent(tmdbId)}/1/1`
        : `https://embed.filmu.in/movie/${encodeURIComponent(tmdbId)}`;

    playerEl.innerHTML = `
        <div class="season-box-item watch-box massive-watch-box" data-link="${escapeAttr(link)}" data-poster="${escapeAttr(poster)}" data-title="${escapeAttr(title)}">
            <div class="season-box-header" style="cursor:default;">
                <span>⚡ ${escapeHtml(title)}</span>
                <span class="watch-loading-spinner" aria-hidden="true"></span>
            </div>
        </div>
    `;

    const ok = await checkWatchLinkReachable(link, () => requestId === massiveWatchRequestId);
    if (requestId !== massiveWatchRequestId) return; // ei shomoy-e user notun kichu select/search kore fellে, ei result-ta ar dorkar nei

    if (!ok) {
        playerEl.innerHTML = `<div class="massive-watch-status">"${escapeHtml(title)}" is not available to watch right now. Please try another title.</div>`;
        return;
    }

    playerEl.innerHTML = `
        <div class="season-box-item watch-box massive-watch-box" data-link="${escapeAttr(link)}" data-poster="${escapeAttr(poster)}" data-title="${escapeAttr(title)}">
            <div class="season-box-header" style="cursor:default;">
                <span>⚡ ${escapeHtml(title)}</span>
            </div>
            <div class="season-download-body open">
                <div class="trailer-thumb-wrap" onclick="playMassiveWatch(this)">
                    <img class="trailer-thumb-img" src="${poster}" alt="${escapeAttr(title)} Watch" loading="lazy" onerror="handlePosterImgError(this)">
                    <button type="button" class="trailer-play-btn watch-play-btn" aria-label="Play watch">▶</button>
                </div>
            </div>
        </div>
    `;
}

// Trailer/Online-Watch box-er playModalWatch()-er ekdom ekই pattern - shudhu
// modal-er bhitorer .watch-box na, homepage-er standalone .massive-watch-box
// niye kaj kore. View count এখানে barano hoy na, karon eta admin database-e
// thaka kono movie/series na - shudhu TMDB theke shorashori search kore paoa
// arbitrary content.
function playMassiveWatch(el) {
    const box = el.closest('.massive-watch-box');
    if (!box) return;
    const link = box.getAttribute('data-link');
    const bodyEl = box.querySelector('.season-download-body');
    if (!bodyEl || !link) return;

    showAdblockNotice();

    let embedUrl = link;
    const ytId = extractYoutubeVideoId(link);
    if (ytId) embedUrl = `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0`;

    // Modal-er Online Watch-er moto-i: close button iframe-er baire (upore
    // alada bar-e) - jate player-er nijer Audio/Subtitle panel-er close
    // button-er upore na pore.
    bodyEl.innerHTML = `
        <div class="watch-player-toolbar">
            <button type="button" class="watch-close-btn" aria-label="Close video" title="Close video" onclick="closeMassiveWatch(this)"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button>
        </div>
        <div class="trailer-video-wrap">
            <iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen credentialless></iframe>
        </div>
    `;
}

// Massive-watch box-e video (iframe) thakle seta remove kore abar age-r
// thumbnail card (play button shoho) ferot boshiye dey - "✖" close button ar
// pauseMassiveWatchIfPlaying() (nicher-i dekho) duijaygay-i lage.
function resetMassiveWatchBoxToThumbnail(box) {
    if (!box) return;
    const bodyEl = box.querySelector('.season-download-body');
    if (!bodyEl) return;
    const title = box.getAttribute('data-title') || '';
    const poster = box.getAttribute('data-poster') || '';
    bodyEl.innerHTML = `
        <div class="trailer-thumb-wrap" onclick="playMassiveWatch(this)">
            <img class="trailer-thumb-img" src="${poster}" alt="${escapeAttr(title)} Watch" loading="lazy" onerror="handlePosterImgError(this)">
            <button type="button" class="trailer-play-btn watch-play-btn" aria-label="Play watch">▶</button>
        </div>
    `;
}

function closeMassiveWatch(el) {
    resetMassiveWatchBoxToThumbnail(el.closest('.massive-watch-box'));
}

// Homepage-er "500K+ Movies & TV Shows" search player-e video chalu thakte
// thakte user onno kono movie/series-er details page (modal) khulle - shei
// video-take pause/stop kore deya hoy (background-e chalu thaka video
// atkate), kintu shompurno massive-watch section-take hide/collapse kora hoy
// na - eta jekhaneই thakuk (page-e), shobshomoy dekha jabe, shudhu video-ta
// abar (age-r) thumbnail-e ferot jabe.
function pauseMassiveWatchIfPlaying() {
    const playerEl = document.getElementById('massiveWatchPlayer');
    if (!playerEl) return;
    const box = playerEl.querySelector('.massive-watch-box');
    if (!box) return;
    if (!box.querySelector('.trailer-video-wrap')) return; // video chalu na thakle kichu korar dorkar nei
    resetMassiveWatchBoxToThumbnail(box);
}

document.addEventListener('DOMContentLoaded', initMassiveWatchSection);

// Season dropdown-e onno season select korle shei season-er trailer fetch kore
// thumbnail/play button-take update kore dey (already play hocche emon video thakle
// seta-o notun thumbnail diye replace hoye jay - abar click korle notun season-er
// trailer-i play hobe).
async function changeModalTrailerSeason(selectEl) {
    const box = selectEl.closest('.trailer-box');
    const bodyEl = box ? box.querySelector('#trailerBoxBody') : null;
    if (!box || !bodyEl) return;

    const tvId = selectEl.getAttribute('data-tvid');
    const seasonNumber = parseInt(selectEl.value, 10);
    if (!tvId || Number.isNaN(seasonNumber)) return;

    selectEl.disabled = true;
    bodyEl.innerHTML = `<div class="trailer-empty-msg trailer-loading-msg">Loading Season ${seasonNumber} trailer...</div>`;

    // Admin panel theke ei season-er jonno manually trailer link deya thakle,
    // seta-i shobar age use kora hoy - TMDB-e API call korar dorkar-i pore na.
    const manualSeasonTrailer = getManualSeasonTrailer(currentModalMovie, seasonNumber);
    if (manualSeasonTrailer && manualSeasonTrailer.key) {
        box.setAttribute('data-ytid', manualSeasonTrailer.key);
        box.setAttribute('data-thumb', manualSeasonTrailer.thumb);
        bodyEl.innerHTML = `
            <div class="trailer-thumb-wrap" onclick="playModalTrailer(this)">
                <img class="trailer-thumb-img" src="${manualSeasonTrailer.thumb}" data-ytid="${manualSeasonTrailer.key || ''}" data-thumb-tier="maxres" alt="Season ${seasonNumber} Trailer" loading="lazy" onload="handleTrailerThumbLoad(this)" onerror="handleTrailerThumbError(this)">
                <button type="button" class="trailer-play-btn" aria-label="Play trailer">▶</button>
            </div>
            <div class="trailer-label">Watch Trailer</div>
        `;
        selectEl.disabled = false;
        return;
    }

    try {
        let newKey = await getLatestSeasonTrailerKey(tvId, seasonNumber);

        // TMDB-r per-season video endpoint-e (upore) ONNO season-er (latest
        // season chara) trailer prai kokhono thake na - age ekhane shudhu
        // eta-i try kore "Coming Soon" dekhiye dito, tai beshirbhag multi-
        // season content-e trailer load hoto na. Ekhon "Coming Soon"
        // dekhanor age aro duita fallback try kora hoy - (1) show-er
        // overall TMDB trailer, (2) YouTube search (title + season number
        // diye) - initial modal-load-e je 3-tier fallback hoy, ekhane
        // season switch korar shomoy-o thik shei-i consistency rakha hocche.
        if (!newKey) newKey = await getShowLevelTrailerKey(tvId);
        if (!newKey) {
            const title = (currentModalMovie && currentModalMovie.title) || '';
            if (title) newKey = await searchYoutubeTrailer(`${title} Season ${seasonNumber}`, null);
        }

        if (!newKey) {
            box.setAttribute('data-ytid', '');
            bodyEl.innerHTML = buildTrailerComingSoonHTML(`Season ${seasonNumber} trailer will be added soon`);
            return;
        }
        // Admin YouTube link na diyeও shudhu Thumbnail-i deya thakle (manualSeasonTrailer.thumb) -
        // video-r jonno upore-r auto (per-season) key-i use hobe, kintu
        // thumbnail-e admin-er deya custom-ta-i priority pabe.
        const thumbUrl = (manualSeasonTrailer && manualSeasonTrailer.thumb) || `https://img.youtube.com/vi/${encodeURIComponent(newKey)}/maxresdefault.jpg`;
        box.setAttribute('data-ytid', newKey);
        box.setAttribute('data-thumb', thumbUrl);
        bodyEl.innerHTML = `
            <div class="trailer-thumb-wrap" onclick="playModalTrailer(this)">
                <img class="trailer-thumb-img" src="${thumbUrl}" data-ytid="${newKey}" data-thumb-tier="maxres" alt="Season ${seasonNumber} Trailer" loading="lazy" onload="handleTrailerThumbLoad(this)" onerror="handleTrailerThumbError(this)">
                <button type="button" class="trailer-play-btn" aria-label="Play trailer">▶</button>
            </div>
            <div class="trailer-label">Watch Trailer</div>
        `;
    } catch (e) {
        console.error('changeModalTrailerSeason error:', e);
        bodyEl.innerHTML = buildTrailerComingSoonHTML('Could not load trailer, please try again later');
    } finally {
        selectEl.disabled = false;
    }
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
                fuzzyMatchScore(query, movie.languages),
                // Original title (jemon "Money Heist"-er "La casa de papel", ba
                // "Guardian"-er "Sseulsseulhago Chanranhasin: Dokkaebi") diye search
                // korleo eikhane match hoye jabe - eta admin save korar shomoy TMDB
                // (primary) ba IMDb/OMDb (fallback) theke fetch kore database-e
                // (originalTitle column) rakha thake.
                fuzzyMatchScore(query, movie.originalTitle)
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

    updateHeroVisibilityForSearch(!!query);

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

// noticeBanner-e কোন লেখা দেখাবে সেটা এক জায়গা থেকে ঠিক করা হয়, যাতে
// admin panel-e banner label save korar sathe sathe (page switch na kore-o)
// currently open category-r banner text update kora jay
const DEFAULT_NOTICE_TEXT = "We have Changed our Official Domain to BOTTMOVIES.Bookmarks Now";

// nav-link-er data-target (jemon "dc") r categories table-e save howa slug
// (jemon "DC") case-e mile na-o pare — tai exact match na paile case-insensitive
// vabe khuje dekha hoy, na hole thik thakleo sotti label-ta miss hoye jay
function getCategoryBannerLabel(category) {
    if (!categoryBannerLabels || !category) return null;
    if (categoryBannerLabels[category]) return categoryBannerLabels[category];
    const lower = String(category).toLowerCase();
    for (const key in categoryBannerLabels) {
        if (key.toLowerCase() === lower) return categoryBannerLabels[key];
    }
    return null;
}

function updateNoticeBannerText(category, targetLink) {
    const noticeText = document.getElementById('noticeBannerText');
    const noticeBanner = document.getElementById('noticeBanner');
    if (!targetLink) {
        targetLink = document.querySelector(`.nav-link[data-target="${category}"]`);
    }

    if (noticeText) {
        const customLabel = getCategoryBannerLabel(category);
        if (category === 'all') {
            noticeText.innerText = DEFAULT_NOTICE_TEXT;
        } else if (customLabel) {
            noticeText.innerText = customLabel;
        } else if (targetLink) {
            const customBanner = targetLink.getAttribute('data-banner');
            noticeText.innerText = customBanner || targetLink.innerText.trim();
        } else {
            noticeText.innerText = category;
        }
    }
    if (noticeBanner) noticeBanner.style.display = 'block';
}

function switchCategory(category, initialPage) {
    if (!category) return;

    const targetLink = document.querySelector(`.nav-link[data-target="${category}"]`);

    document.querySelectorAll('.nav-link, .dropdown-toggle').forEach(el => el.classList.remove('active'));
    if (targetLink) {
        targetLink.classList.add('active');
        const parentDropdown = targetLink.closest('.has-dropdown:not(.sub-dropdown)');
        if (parentDropdown) {
            const toggle = parentDropdown.querySelector('.dropdown-toggle');
            if (toggle) toggle.classList.add('active');
        }
    }

    document.body.setAttribute('data-category', category);

    updateNoticeBannerText(category, targetLink);

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

// ============================================================
// ডাইনামিক নেভিগেশন মেনু (Admin -> Navigation ট্যাব থেকে যোগ করা items)
// ============================================================
// index.html-এ যেসব dropdown/sub-dropdown item আগে থেকেই আছে (Movies, Web Series, OTT Shows
// এবং তাদের ভেতরের সব লিংক), সেগুলোর প্রতিটার একটা স্থায়ী "manifest id" এখানে রাখা আছে।
// Admin প্যানেল থেকে নতুন item যোগ করার সময় এই id-গুলোর যেকোনো একটাকে "parent" হিসেবে বেছে
// নেওয়া যায় - এতে নতুন item ঠিক জায়গায় (সঠিক dropdown/sub-dropdown-এর ভেতরে) বসে যায়।
const STATIC_NAV_MANIFEST = [
    { id: 'movies', label: 'Movies (top menu)', kind: 'top' },
    { id: 'movies__english', label: '— English Movies', parent: 'movies' },
    { id: 'movies__hindi', label: '— Hindi Movies', parent: 'movies' },
    { id: 'movies__bangla', label: '— Bangla Movies', parent: 'movies' },
    { id: 'movies__korean', label: '— Korean Movies', parent: 'movies' },
    { id: 'movies__german', label: '—— German Movies', parent: 'movies__english' },
    { id: 'movies__spanish', label: '—— Spanish Movies', parent: 'movies__english' },

    { id: 'webseries', label: 'Web Series (top menu)', kind: 'top' },
    { id: 'webseries__english', label: '— English Series', parent: 'webseries' },
    { id: 'webseries__hindi', label: '— Hindi Series', parent: 'webseries' },
    { id: 'webseries__bangla', label: '— Bangla Series', parent: 'webseries' },
    { id: 'webseries__korean', label: '— Korean Series', parent: 'webseries' },
    { id: 'webseries__german', label: '—— German Series', parent: 'webseries__english' },
    { id: 'webseries__spanish', label: '—— Spanish Series', parent: 'webseries__english' },

    { id: 'ott', label: 'OTT Shows (top menu)', kind: 'top' },
    { id: 'ott__netflix', label: '— Netflix', parent: 'ott' },
    { id: 'ott__prime', label: '— Prime Video', parent: 'ott' },
    { id: 'ott__hbomax', label: '— HBO MAX', parent: 'ott' },
    { id: 'ott__disney', label: '— Disney+ Hotstar', parent: 'ott' },
    { id: 'ott__marvel', label: '—— Marvel', parent: 'ott__disney' },
    { id: 'ott__dc', label: '—— DC', parent: 'ott__disney' },
    { id: 'ott__crunchyroll', label: '— Crunchyroll', parent: 'ott' },
    { id: 'ott__hoichoi', label: '— Hoichoi', parent: 'ott' },
    { id: 'ott__chorki', label: '— Chorki', parent: 'ott' }
];

// manifest id -> ওই <li> খুঁজে বের করার জন্য CSS selector (data-target ভিত্তিক)
function resolveManifestNode(manifestId) {
    const map = {
        'movies': '#navMoviesToggle',
        'webseries': '#navWebSeriesToggle',
        'ott': '#navOttToggle',
        'movies__english': '.nav-link[data-target="english"]',
        'movies__hindi': '.nav-link[data-target="hindi"]',
        'movies__bangla': '.nav-link[data-target="bangla"]',
        'movies__korean': '.nav-link[data-target="korean"]',
        'movies__german': '.nav-link[data-target="german"]',
        'movies__spanish': '.nav-link[data-target="spanish"]',
        'webseries__english': '.nav-link[data-target="english-series"]',
        'webseries__hindi': '.nav-link[data-target="hindi-series"]',
        'webseries__bangla': '.nav-link[data-target="bangla-series"]',
        'webseries__korean': '.nav-link[data-target="korean-series"]',
        'webseries__german': '.nav-link[data-target="german-series"]',
        'webseries__spanish': '.nav-link[data-target="spanish-series"]',
        'ott__netflix': '.nav-link[data-target="netflix"]',
        'ott__prime': '.nav-link[data-target="prime-video"]',
        'ott__hbomax': '.nav-link[data-target="hbo-max"]',
        'ott__disney': '.nav-link[data-target="disney"]',
        'ott__marvel': '.nav-link[data-target="marvel"]',
        'ott__dc': '.nav-link[data-target="dc"]',
        'ott__crunchyroll': '.nav-link[data-target="crunchyroll"]',
        'ott__hoichoi': '.nav-link[data-target="hoichoi"]',
        'ott__chorki': '.nav-link[data-target="chorki"]'
    };
    const selector = map[manifestId];
    if (!selector) return null;
    const el = document.querySelector(selector);
    if (!el) return null;
    // টপ-লেভেল toggle হলে সরাসরি ওর পাশের <ul class="dropdown-menu"> রিটার্ন করি
    if (el.tagName === 'A' && el.classList.contains('dropdown-toggle')) {
        return el.parentElement.querySelector(':scope > .dropdown-menu');
    }
    // নাহলে এটা একটা .nav-link — এর প্যারেন্ট <li>-টাকে যদি ইতিমধ্যে sub-dropdown বানানো
    // না থাকে, বানিয়ে দিই (যাতে নতুন child বসানোর জায়গা তৈরি হয়)
    return ensureSubDropdownContainer(el.closest('li'));
}

// একটা সাধারণ <li> (যার এখনো নিজের কোনো নেস্টেড dropdown নেই) -কে dynamic ভাবে
// sub-dropdown বানিয়ে দেয় (arrow + খালি <ul class="dropdown-menu sub-menu"> যোগ করে)
function ensureSubDropdownContainer(li) {
    if (!li) return null;
    let subMenu = li.querySelector(':scope > .dropdown-menu.sub-menu');
    if (subMenu) return subMenu;

    li.classList.add('has-dropdown', 'sub-dropdown');
    const caret = document.createElement('span');
    caret.className = 'sub-dropdown-toggle';
    caret.setAttribute('role', 'button');
    caret.setAttribute('aria-label', 'More options');
    caret.textContent = '▾';
    li.appendChild(caret);

    subMenu = document.createElement('ul');
    subMenu.className = 'dropdown-menu sub-menu';
    li.appendChild(subMenu);
    return subMenu;
}

// অ্যাডমিন প্যানেল থেকে যোগ করা সব custom nav item লোড করে ঠিক জায়গায় বসিয়ে দেয়।
// আগে ইনজেক্ট করা custom item থাকলে সেগুলো আগে সরিয়ে (duplicate এড়াতে) আবার নতুন করে বসানো হয়।
async function renderCustomNavItems() {
    document.querySelectorAll('.custom-nav-item').forEach(el => el.remove());
    document.querySelectorAll('.custom-nav-toplevel').forEach(el => el.remove());

    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;

    try {
        const { data, error } = await supabaseClient
            .from('nav_items')
            .select('*')
            .order('order_index', { ascending: true });
        if (error) throw error;

        window.__customNavItems = data || [];
        if (!data || data.length === 0) return;

        const byParent = {};
        data.forEach(item => {
            const key = item.parent_id == null ? (item.parent_manifest_id || 'ROOT') : ('db:' + item.parent_id);
            if (!byParent[key]) byParent[key] = [];
            byParent[key].push(item);
        });

        function renderInto(container, items) {
            items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'custom-nav-item';
                li.setAttribute('data-nav-id', item.id);
                const a = document.createElement('a');
                a.href = '#';
                a.className = 'nav-link';
                if (item.category_slug) a.setAttribute('data-target', item.category_slug);
                if (item.data_banner) a.setAttribute('data-banner', item.data_banner);
                a.textContent = item.label;
                li.appendChild(a);
                container.appendChild(li);

                const children = byParent['db:' + item.id];
                if (children && children.length) {
                    const subMenu = ensureSubDropdownContainer(li);
                    if (subMenu) renderInto(subMenu, children);
                }
            });
        }

        // ROOT / নতুন টপ-লেভেল মেনু আইটেম (parent_manifest_id null এবং parent_id null)
        const rootItems = (byParent['ROOT'] || []).filter(it => !it.parent_manifest_id);
        const mainUl = document.querySelector('.main-nav > ul');
        const sportsLi = document.getElementById('sportsMenuLink')?.closest('li');
        rootItems.forEach(item => {
            const li = document.createElement('li');
            li.className = 'has-dropdown custom-nav-toplevel';
            li.setAttribute('data-nav-id', item.id);
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'nav-link dropdown-toggle';
            if (item.category_slug) a.setAttribute('data-target', item.category_slug);
            a.textContent = item.label + ' ▾';
            const subUl = document.createElement('ul');
            subUl.className = 'dropdown-menu';
            li.appendChild(a);
            li.appendChild(subUl);
            if (mainUl) {
                if (sportsLi) mainUl.insertBefore(li, sportsLi);
                else mainUl.appendChild(li);
            }
            const children = byParent['db:' + item.id];
            if (children && children.length) renderInto(subUl, children);
        });

        // manifest-এর কোনো নির্দিষ্ট node-কে parent হিসেবে বেছে নেওয়া item গুলো
        Object.keys(byParent).forEach(key => {
            if (key === 'ROOT' || key.startsWith('db:')) return;
            const container = resolveManifestNode(key);
            if (container) renderInto(container, byParent[key]);
        });
    } catch (err) {
        console.error('renderCustomNavItems error:', err);
    }
}

function setupNavigation() {
    // ইভেন্ট ডেলিগেশন — document-এ একবারই লিসেনার বসানো থাকে (শুধু #mainNav-এ না, কারণ
    // logo আর "Bangla Dubbed"/"Anime-Flix" বাটনও .nav-link কিন্তু header-এ, #mainNav-এর বাইরে),
    // তাই অ্যাডমিন প্যানেল থেকে ডাইনামিকভাবে নতুন item যোগ হলেও আলাদা করে বাইন্ড করা লাগে না
    const mainNavEl = document.getElementById('mainNav');
    document.addEventListener('click', function(e) {
        const subCaret = e.target.closest('.sub-dropdown-toggle');
        if (subCaret) {
            e.preventDefault();
            e.stopPropagation();
            const parentLi = subCaret.closest('li.has-dropdown');
            if (!parentLi) return;
            const isOpen = parentLi.classList.contains('open');
            const siblingList = parentLi.parentElement;
            if (siblingList) {
                Array.from(siblingList.children).forEach(li => {
                    if (li !== parentLi) li.classList.remove('open');
                });
            }
            parentLi.classList.toggle('open', !isOpen);
            return;
        }

        const toggle = e.target.closest('.dropdown-toggle');
        if (toggle) {
            e.preventDefault();
            e.stopPropagation();
            const parentLi = toggle.parentElement;
            const isOpen = parentLi.classList.contains('open');
            document.querySelectorAll('.has-dropdown').forEach(li => li.classList.remove('open'));
            if (!isOpen) parentLi.classList.add('open');
            return;
        }

        const link = e.target.closest('.nav-link');
        if (link) {
            e.preventDefault();
            const category = link.getAttribute('data-target');
            if (!category) return;

            switchCategory(category);

            document.querySelectorAll('.has-dropdown').forEach(li => li.classList.remove('open'));
            if (document.activeElement) document.activeElement.blur();

            if (mainNavEl) mainNavEl.classList.remove('show-menu');
            document.body.classList.remove('menu-open');

            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
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
    renderCustomNavItems();
    setupHeroBannerControls();

    loadTeraApiConfig();
    fetchMoviesFromSupabase();

    const modalOverlay = document.getElementById('movieModalOverlay');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeMovieModal();
        });
    }

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
    const searchClearBtn = document.getElementById('searchClearBtn');

    if (searchBtn) searchBtn.addEventListener('click', searchMovies);
    if (searchInput) {
        searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') searchMovies(); });

        // প্রতি keystroke-এ সাথে সাথে (debounce ছাড়াই) clear (✕) বাটন আর hero banner টগল হবে,
        // যাতে টাইপ করা মাত্রই responsive লাগে - ভারী filtering কাজটা নিচের debounced ফাংশনে থাকে
        searchInput.addEventListener('input', function() {
            const hasQuery = !!searchInput.value.trim();
            if (searchClearBtn) searchClearBtn.style.display = hasQuery ? 'flex' : 'none';
            updateHeroVisibilityForSearch(hasQuery);
        });

        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', function() {
                searchInput.value = '';
                searchClearBtn.style.display = 'none';
                if (searchSuggestions) { searchSuggestions.innerHTML = ''; searchSuggestions.style.display = 'none'; }
                currentFilteredMovies = [...moviesList];
                renderMoviesByPage(currentFilteredMovies, 1);
                updateHeroVisibilityForSearch(false);
                searchInput.focus();
            });
        }

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
// পাসওয়ার্ড "strong" কিনা চেক করে — কমপক্ষে ৮ ক্যারেক্টার, অন্তত একটা বড় হাতের অক্ষর,
// একটা ছোট হাতের অক্ষর, এবং একটা সংখ্যা থাকতে হবে (Sign Up, Forgot Password, Change Password — সব জায়গায় একই নিয়ম)
function isStrongPassword(pw) {
    return typeof pw === 'string' && pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);
}
const STRONG_PASSWORD_MSG = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.';

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
        syncGoogleAvatarIfNeeded(session); // পুরনো Google ইউজার (যাদের avatar_url এখনো ফাঁকা) পেজ লোড হওয়ার সময়ও sync হয়ে যাবে

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
        if (_event === 'SIGNED_IN') syncGoogleAvatarIfNeeded(newSession); // নতুন করে Google দিয়ে সাইন-ইন করলে
    });
}

// Google দিয়ে sign in করলে Google account-এর profile picture-টা নিজে থেকেই
// Dashboard-এর avatar হিসেবে বসিয়ে দেয় — কিন্তু শুধু তখনই, যখন ইউজার আগে থেকে
// নিজের কোনো avatar আপলোড/সেট করেনি। ইউজার পরে নিজে থেকে avatar বদলে ফেললে,
// সেটাই থেকে যাবে, পরের বার লগইন করলেও আর Google ছবি দিয়ে override হবে না।
async function syncGoogleAvatarIfNeeded(session) {
    try {
        const user = session?.user;
        if (!user) return;

        const isGoogleUser = (user.app_metadata?.provider === 'google') ||
            (Array.isArray(user.identities) && user.identities.some(i => i.provider === 'google'));
        if (!isGoogleUser) return;

        // Supabase সাধারণত Google প্রোফাইল ছবিটা user_metadata.avatar_url অথবা .picture হিসেবে রাখে
        const googlePic = user.user_metadata?.avatar_url || user.user_metadata?.picture;
        if (!googlePic) return;

        const { data: profile, error } = await supabaseClient
            .from('profiles')
            .select('avatar_url')
            .eq('id', user.id)
            .maybeSingle();
        if (error) { console.error('Google avatar sync check error:', error); return; }

        if (!profile || !profile.avatar_url) {
            const { error: updateError } = await supabaseClient
                .from('profiles')
                .update({ avatar_url: googlePic })
                .eq('id', user.id);
            if (updateError) { console.error('Google avatar sync update error:', updateError); return; }

            // Dashboard খোলা থাকলে সাথে সাথেই নতুন ছবি দেখাও (রিফ্রেশ করা ছাড়াই)
            const avatarEl = document.getElementById('userDashAvatarPreview');
            if (avatarEl) avatarEl.src = googlePic;
            myCommentIdentityCache = null;
            if (commentsCurrentMovieId !== null && commentsCurrentMovieId !== undefined) renderCommentComposer();
        }
    } catch (e) {
        console.error('Unexpected error syncing Google avatar:', e);
    }
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
    cancelPendingRecoverySessionIfAny(); // ভুল করে/মাঝপথে মোডাল বন্ধ করে দিলে temporary recovery session sign-out করে দাও
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
    ['signinEmail', 'signinPassword', 'signupUsername', 'signupEmail', 'signupPassword', 'signupPasswordConfirm', 'signupCaptchaInput', 'fpIdentifier', 'fpOtpInput', 'fpNewPassword', 'fpConfirmPassword'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['authSigninMsg', 'authSignupMsg', 'signupUsernameMsg', 'fpEmailMsg', 'fpOtpMsg', 'fpNewPasswordMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    updateAuthPasswordStrength('');
    clearInterval(fpResendTimer);
    fpResolvedEmail = null;
    const forgotTab = document.getElementById('authTabForgot');
    if (forgotTab) forgotTab.style.display = 'none';
    const tabsBar = document.querySelector('.auth-tabs');
    if (tabsBar) tabsBar.style.display = 'flex';
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

// ==================== FORGOT PASSWORD (OTP based, no email link) ====================
// আগে magic-link পাঠানো হতো, কিন্তু সেই লিংকে ক্লিক করলে সরাসরি হোমপেজে চলে যেত (কোনো
// "set new password" পেজ ছিল না)। তাই পুরো ফ্লো-টা এখন OTP-ভিত্তিক করে দেওয়া হয়েছে:
//   ধাপ ১: Username/Email দিলে Supabase একটা 6-digit code মেইল করে
//   ধাপ ২: সেই code বসালে verifyOtp() দিয়ে যাচাই হয় (type: 'recovery')
//   ধাপ ৩: verify সফল হলে নতুন password + repeat password ফিল্ড আসে, updateUser() দিয়ে
//          আসল account password টাই সেট হয়ে যায় (Supabase auth এ)
//
// ⚠️ গুরুত্বপূর্ণ (কোডে করা যায় না, Supabase Dashboard থেকে করতে হবে):
// Supabase Dashboard → Authentication → Email Templates → "Reset Password" টেমপ্লেটে
// অবশ্যই {{ .Token }} ভেরিয়েবলটা বসাতে হবে (যেমন: "Your code is: {{ .Token }}"),
// তা না হলে মেইলে কোনো OTP code-ই আসবে না — শুধু আগের মতো লিংক আসবে।

let fpResolvedEmail = null;       // OTP পাঠানোর সময় resolve হওয়া আসল email
let fpRecoverySessionActive = false; // verifyOtp সফল হওয়ার পর থেকে password update না হওয়া পর্যন্ত true
let fpResendTimer = null;
let fpResendSecondsLeft = 0;

// পাসওয়ার্ড রিসেট মাঝপথে রেখে মোডাল বন্ধ করে দিলে/back করলে, verifyOtp দিয়ে খোলা
// temporary session টা sign out করে দেয় (নিরাপত্তার জন্য - পাবলিক/শেয়ার করা ডিভাইসে যেন
// অচেনা কেউ password change না করে সেই recovery session ব্যবহার করে থাকতে না পারে)
async function cancelPendingRecoverySessionIfAny() {
    if (fpRecoverySessionActive) {
        fpRecoverySessionActive = false;
        try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    }
}

function showForgotStep(step) {
    const stepIds = { email: 'fpStepEmail', otp: 'fpStepOtp', newpass: 'fpStepNewPassword', done: 'fpStepDone' };
    Object.entries(stepIds).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = (key === step) ? 'flex' : 'none';
    });
    if (step === 'otp') {
        const otpInput = document.getElementById('fpOtpInput');
        if (otpInput) { otpInput.value = ''; setTimeout(() => otpInput.focus(), 50); }
    }
}

// "Forgot password?" লিংকে ক্লিক করলে Login ফর্ম থেকে এই ৩-ধাপের ফ্লো-তে চলে আসে
function openForgotPasswordFlow() {
    const signinEmailVal = (document.getElementById('signinEmail')?.value || '').trim();
    const fpIdentifier = document.getElementById('fpIdentifier');
    if (fpIdentifier) fpIdentifier.value = signinEmailVal;

    fpResolvedEmail = null;
    fpRecoverySessionActive = false;
    clearInterval(fpResendTimer);

    ['fpEmailMsg', 'fpOtpMsg', 'fpNewPasswordMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ''; el.className = 'admin-form-msg'; }
    });
    ['fpOtpInput', 'fpNewPassword', 'fpConfirmPassword'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const resendLink = document.getElementById('fpResendLink');
    if (resendLink) { resendLink.textContent = 'Resend code'; resendLink.classList.remove('disabled'); }

    const tabsBar = document.querySelector('.auth-tabs');
    if (tabsBar) tabsBar.style.display = 'none';
    const signinTab = document.getElementById('authTabSignin');
    const signupTab = document.getElementById('authTabSignup');
    if (signinTab) signinTab.style.display = 'none';
    if (signupTab) signupTab.style.display = 'none';
    const forgotTab = document.getElementById('authTabForgot');
    if (forgotTab) forgotTab.style.display = 'flex';
    showForgotStep('email');
}

// "← Back to Login" - forgot flow থেকে বেরিয়ে আবার Login ট্যাবে ফিরে যায়
async function closeForgotPasswordFlow() {
    await cancelPendingRecoverySessionIfAny();
    clearInterval(fpResendTimer);
    const forgotTab = document.getElementById('authTabForgot');
    if (forgotTab) forgotTab.style.display = 'none';
    const tabsBar = document.querySelector('.auth-tabs');
    if (tabsBar) tabsBar.style.display = 'flex';
    switchAuthTab('signin');
}

// Resend লিংকে ৪৫ সেকেন্ডের cooldown - বারবার ক্লিক করে স্প্যাম পাঠানো ঠেকানোর জন্য
function startResendCooldown(seconds) {
    const link = document.getElementById('fpResendLink');
    if (!link) return;
    fpResendSecondsLeft = seconds || 45;
    clearInterval(fpResendTimer);
    function tick() {
        if (fpResendSecondsLeft <= 0) {
            link.textContent = 'Resend code';
            link.classList.remove('disabled');
            clearInterval(fpResendTimer);
            return;
        }
        link.textContent = `Resend code (${fpResendSecondsLeft}s)`;
        link.classList.add('disabled');
        fpResendSecondsLeft--;
    }
    tick();
    fpResendTimer = setInterval(tick, 1000);
}

// ধাপ ১ → Username/Email দিয়ে Supabase কে OTP code মেইল করতে বলে
// (isResend=true হলে ধাপ ২ থেকে "Resend code" চাপার ফলে আবার একই email এ নতুন code পাঠাবে)
async function handleSendResetOtp(isResend) {
    if (isResend && document.getElementById('fpResendLink')?.classList.contains('disabled')) return;

    const identifierInput = document.getElementById('fpIdentifier');
    const identifier = (identifierInput?.value || '').trim();
    const msgEl = document.getElementById(isResend ? 'fpOtpMsg' : 'fpEmailMsg');

    if (!identifier) {
        if (msgEl) { msgEl.textContent = 'Please enter your Username/Email first.'; msgEl.className = 'admin-form-msg error'; }
        identifierInput?.focus();
        return;
    }
    if (msgEl) { msgEl.textContent = 'Sending code...'; msgEl.className = 'admin-form-msg'; }
    try {
        const email = await resolveLoginEmail(identifier);
        if (!email) {
            if (msgEl) { msgEl.textContent = 'Incorrect Username or Password'; msgEl.className = 'admin-form-msg error'; }
            return;
        }

        // এই email দিয়ে আদৌ কোনো account আছে কিনা চেক করা হচ্ছে
        // (Supabase ডিফল্টভাবে না থাকলেও silently "success" দেখায়, নিরাপত্তার জন্য —
        // কিন্তু এই সাইটে আমরা ইউজারকে স্পষ্ট warning দেখাতে চাই)
        const { data: emailExists, error: checkError } = await supabaseClient.rpc('check_email_exists', { check_email: email });
        if (checkError) {
            console.error('Email existence check error:', checkError);
            // চেক ব্যর্থ হলে নিরাপত্তার স্বার্থে আগের মতোই এগিয়ে যাওয়া হচ্ছে (fail-open),
            // যাতে এই RPC ফাংশনটা এখনো সেটআপ করা না থাকলে পুরো ফ্লো ভেঙে না যায়
        } else if (emailExists === false) {
            if (msgEl) { msgEl.textContent = 'No account found with this email/username.'; msgEl.className = 'admin-form-msg error'; }
            return;
        }

        const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
        if (error) {
            if (msgEl) { msgEl.textContent = error.message; msgEl.className = 'admin-form-msg error'; }
            return;
        }
        fpResolvedEmail = email;
        const emailLabel = document.getElementById('fpOtpEmailLabel');
        if (emailLabel) emailLabel.textContent = email;

        if (msgEl) { msgEl.textContent = (isResend ? 'A new code has been sent ✅' : 'Code sent ✅'); msgEl.className = 'admin-form-msg success'; }
        if (!isResend) showForgotStep('otp');
        startResendCooldown(45);
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
    }
}

// ধাপ ২ → ইউজারের বসানো 6-digit code Supabase এর সাথে verify করে (type: 'recovery')
// সফল হলে সাময়িক একটা session তৈরি হয়ে যায়, যেটা দিয়ে পরের ধাপে updateUser() কল করা যাবে
async function handleVerifyResetOtp() {
    const otpInput = document.getElementById('fpOtpInput');
    const code = (otpInput?.value || '').trim();
    const msgEl = document.getElementById('fpOtpMsg');

    if (!fpResolvedEmail) { showForgotStep('email'); return; }
    if (!/^\d{6}$/.test(code)) {
        if (msgEl) { msgEl.textContent = 'Please enter the 6-digit code from your email.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (msgEl) { msgEl.textContent = 'Verifying...'; msgEl.className = 'admin-form-msg'; }
    try {
        const { error } = await supabaseClient.auth.verifyOtp({ email: fpResolvedEmail, token: code, type: 'recovery' });
        if (error) {
            if (msgEl) { msgEl.textContent = '❌ ' + (error.message || 'Invalid or expired code.'); msgEl.className = 'admin-form-msg error'; }
            return;
        }
        fpRecoverySessionActive = true;
        clearInterval(fpResendTimer);
        showForgotStep('newpass');
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
    }
}

// ধাপ ৩ → নতুন password + repeat password যাচাই করে আসল account password আপডেট করে
async function handleSubmitNewPassword() {
    const msgEl = document.getElementById('fpNewPasswordMsg');
    const newPass = document.getElementById('fpNewPassword')?.value || '';
    const confirmPass = document.getElementById('fpConfirmPassword')?.value || '';

    if (!isStrongPassword(newPass)) {
        if (msgEl) { msgEl.textContent = STRONG_PASSWORD_MSG; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (newPass !== confirmPass) {
        if (msgEl) { msgEl.textContent = 'New passwords do not match.'; msgEl.className = 'admin-form-msg error'; }
        return;
    }
    if (msgEl) { msgEl.textContent = 'Updating...'; msgEl.className = 'admin-form-msg'; }
    try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPass });
        if (error) throw error;
        fpRecoverySessionActive = false; // password change হয়ে গেছে - এখন এটা normal logged-in session
        showForgotStep('done');
    } catch (err) {
        if (msgEl) { msgEl.textContent = '❌ ' + (err?.message || 'Could not update password'); msgEl.className = 'admin-form-msg error'; }
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

// Google দিয়ে Sign In/Sign Up - দুটো ফর্মের বাটনই এই একই ফাংশন কল করে।
// Supabase নিজে থেকেই ঠিক করে: একই Google account দিয়ে আগে sign up করা থাকলে সরাসরি sign in হয়ে যাবে,
// আগে না থাকলে নতুন account তৈরি করে সাথে সাথেই sign in করে দেবে।
async function handleGoogleAuth() {
    const activeTab = document.getElementById('authTabSignup') && document.getElementById('authTabSignup').style.display !== 'none' ? 'signup' : 'signin';
    const msgEl = document.getElementById(activeTab === 'signup' ? 'authSignupMsg' : 'authSigninMsg');
    const btn = document.getElementById(activeTab === 'signup' ? 'signupGoogleBtn' : 'signinGoogleBtn');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'admin-form-msg'; }
    if (btn) btn.disabled = true;
    try {
        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) {
            if (msgEl) { msgEl.textContent = error.message || 'Google sign-in failed. Please try again.'; msgEl.className = 'admin-form-msg error'; }
            if (btn) btn.disabled = false;
        }
        // ভুল না হলে ব্রাউজার Google-এর পেজে redirect হয়ে যাবে, তাই এখানে আর কিছু করার দরকার নেই।
    } catch (e) {
        if (msgEl) { msgEl.textContent = 'Something went wrong, please try again.'; msgEl.className = 'admin-form-msg error'; }
        if (btn) btn.disabled = false;
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
    if (!isStrongPassword(password)) {
        if (msgEl) { msgEl.textContent = STRONG_PASSWORD_MSG; msgEl.className = 'admin-form-msg error'; }
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
    if (!isStrongPassword(newPass)) {
        if (msgEl) { msgEl.textContent = STRONG_PASSWORD_MSG; msgEl.className = 'admin-form-msg error'; }
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
// slug -> custom banner text (category page-e gele notice banner-e ei lekha dekhabe)
let categoryBannerLabels = {};
let adminTmdbType = 'movie';
let adminPosterMode = 'link';
let adminOriginalPosterUrl = null; // Edit-er shomoy khali field-e save korleo ei poster-i use hobe
let adminOriginalImdbId = null; // Edit load-er shomoy-kar IMDb ID - submit-e compare kore bujhte je ID change hoyeche kina
let adminOriginalTmdbId = null; // Edit load-er shomoy-kar TMDB ID - upore-r moto-i use hoy
let adminCategoriesLoaded = false;

async function loadAdminExtraCategories() {
    try {
        let { data, error } = await supabaseClient
            .from('categories')
            .select('slug, banner_label');

        if (error) {
            // purono DB-te "banner_label" column na thakle (migration run kora hoyni), shudhu slug diye fallback kori
            const fallback = await supabaseClient.from('categories').select('slug');
            data = fallback.data;
            error = fallback.error;
        }

        if (error) {
            console.error('Error loading categories from Supabase:', error.message, error);
            return;
        }

        console.log('Categories loaded from Supabase:', data);

        adminExtraCategories = new Set((data || []).map(row => row.slug).filter(Boolean));
        categoryBannerLabels = {};
        (data || []).forEach(row => {
            if (row && row.slug && row.banner_label) categoryBannerLabels[row.slug] = row.banner_label;
        });
        adminCategoriesLoaded = true;
        renderAdminCategoryBox();

        // Ei fetch shesh hote hote page-e already ekta category open thakte pare
        // (jemon direct link/bookmark diye #category niye ashle) — sekhetre
        // banner_label ashar por notice banner-er lekha refresh kore newa
        const activeCategory = document.body.getAttribute('data-category');
        if (activeCategory) {
            updateNoticeBannerText(activeCategory);
        }
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
    trailer: 'Trailer / Teaser',
    watch: 'Watch Button',
    banner: 'Hero Banner',
    navigation: 'Navigation Menu',
    comments: 'Comments',
    requests: 'Request Here',
    messages: 'Messages',
    alerts: 'Broken Link Reports',
    trash: 'Recycle Bin'
};

function switchAdminTab(tab) {
    const tabs = ['dashboard', 'add', 'manage', 'trailer', 'watch', 'banner', 'navigation', 'comments', 'requests', 'messages', 'alerts', 'trash'];
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
    } else if (validTab === 'trailer') {
        const searchInput = document.getElementById('adminTrailerSearchInput');
        renderAdminTrailerList(searchInput ? searchInput.value.trim() : '');
    } else if (validTab === 'watch') {
        const searchInput = document.getElementById('adminWatchSearchInput');
        renderAdminWatchList(searchInput ? searchInput.value.trim() : '');
        clearTeraApiForm();
        renderAdminTeraApiPool();
    } else if (validTab === 'banner') {
        const searchInput = document.getElementById('adminBannerSearchInput');
        renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
    } else if (validTab === 'navigation') {
        renderAdminNavList();
        const catBannerSearchInput = document.getElementById('adminCategoryBannerSearchInput');
        renderAdminCategoryBannerList(catBannerSearchInput ? catBannerSearchInput.value.trim() : '');
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
    loadAdminTeraApiStats();

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

    const adminTrailerSearchInput = document.getElementById('adminTrailerSearchInput');
    if (adminTrailerSearchInput) {
        adminTrailerSearchInput.addEventListener('input', function() {
            renderAdminTrailerList(this.value.trim());
        });
    }

    const adminWatchSearchInput = document.getElementById('adminWatchSearchInput');
    if (adminWatchSearchInput) {
        adminWatchSearchInput.addEventListener('input', function() {
            renderAdminWatchList(this.value.trim());
        });
    }

    const adminBannerSearchInput = document.getElementById('adminBannerSearchInput');
    if (adminBannerSearchInput) {
        adminBannerSearchInput.addEventListener('input', function() {
            renderAdminBannerList(this.value.trim());
        });
    }

    const adminCategoryBannerSearchInput = document.getElementById('adminCategoryBannerSearchInput');
    if (adminCategoryBannerSearchInput) {
        adminCategoryBannerSearchInput.addEventListener('input', function() {
            renderAdminCategoryBannerList(this.value.trim());
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
    // "tgl" hocche Tagalog bhasha-r 3-letter (ISO 639-2) code, "fil" Filipino-r -
    // eta na thakle "lat"-er moto-i shomoshsha hoto (video file-e 3-letter code
    // thake, kintu map-e shudhu "tl" (2-letter) chilo).
    tl: 'Filipino (Tagalog)', fil: 'Filipino (Tagalog)', tgl: 'Filipino (Tagalog)', filipino: 'Filipino (Tagalog)', tagalog: 'Filipino (Tagalog)',
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

    // "la" ISO 639-1 code-e asholei "Latin" bhasha bojhay (es-419/es-la-r
    // moto "Latin American" region na) - tai age bhul kore "Latin American"
    // deya chilo, seta thik kore deya holo. "lat" hocche eki bhasha-r
    // 3-letter (ISO 639-2) code - beshirbhag video/MKV file-e language
    // shadharonoto ei 3-letter code-e-i thake (onno shob bhashar jonno-o
    // upore 2-letter + 3-letter dutoi ache), tai eta na thakle "lat" detect
    // hoto na - ei-i chilo "Latin detect hocche na" problem-er asol karon.
    la: 'Latin', lat: 'Latin'
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
    // Set-er bodole array byabohar kora hocche - eki language-er duita/tinta
    // alada audio (ba subtitle) track thakle age Set duplicate-gulo shoriye
    // dito, tai ekta-i "Spanish" dekhato - ekhon file-e joto-bar shei bhasha-r
    // track ache thik totobar-i dekhabe (jemon 2 ta Spanish track thakle
    // "Spanish, Spanish").
    const audio = [];
    const subtitle = [];
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
                // "und" (undefined) age null kore bad deya hoto, fole ei track-er
                // baseName ber kora jeto na ar resolveTrack() null return korto -
                // track-ta "Unknown" dekhanor bodole ekdom baad porto. Ekhon "und"
                // rekhe deya hocche, jate MEDIA_SCAN_LANGUAGE_MAP-er und -> "Unknown"
                // entry-i thik moto match hoy.
                code: codeRaw || null,
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
            if (val) {
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
        // t.ietf/t.code dutoi null hote pare jodi track-e kono "language:"
        // metadata line-i na thake (FFmpeg log-e "und" likhe-o na, kichu-i na) -
        // agey ei obosthay resolveTrack() null return korto, fole track-ta
        // "Unknown" hishebe dekhanor bodole puropuri skip hoye jeto. Tai
        // language ekdom na paile default "Unknown"-e fallback kora hocche.
        const baseName = mediaScanGuessLanguageFromToken(t.ietf || t.code) || 'Unknown';
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

    audioTracks.forEach(t => { const n = resolveTrack(t); if (n) audio.push(n); });
    subtitleTracks.forEach(t => { const n = resolveTrack(t); if (n) subtitle.push(n); });

    return { audio, subtitle };
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

// একাধিক স্ক্যানের ফলাফল মিলিয়ে একটাই লিস্ট বানায়। এখন প্রতিটা স্ক্যানে একই ভাষার
// কয়টা করে track পাওয়া গেছে সেটাও (multiset হিসেবে) গোনা হয় - যেমন এক ফাইলে ২টা
// Spanish track থাকলে ফলাফলে "Spanish, Spanish" দুটোই থাকবে, একটায় মিশে যাবে না।
// প্রতিটা occurrence (১ম Spanish, ২য় Spanish...) আলাদাভাবে চেক হয় - সব স্ক্যানে ওই
// occurrence-count থাকলে ট্যাগ ছাড়া বসে, নাহলে যে স্ক্যানগুলোতে আছে তাদের "Only"
// ট্যাগ নিয়ে বসে। প্রথমবার যে ক্রমে ভাষাগুলো পাওয়া গেছে সেই ক্রমই বজায় থাকে।
function mediaScanMergeHistory(historyKey) {
    const totalScans = mediaScanHistory.length;
    if (totalScans === 0) return { labels: [], count: 0, commonCount: 0 };

    const order = []; // item naam-gulo prothom dekha jawar order-e
    const countsByItem = new Map(); // item -> [scan1-count, scan2-count, ...]
    mediaScanHistory.forEach((scan, idx) => {
        (scan[historyKey] || []).forEach(item => {
            if (!countsByItem.has(item)) { countsByItem.set(item, new Array(totalScans).fill(0)); order.push(item); }
            countsByItem.get(item)[idx]++;
        });
    });

    let commonCount = 0;
    const labels = [];
    order.forEach(item => {
        const counts = countsByItem.get(item);
        const maxCount = Math.max(...counts);
        for (let k = 1; k <= maxCount; k++) {
            const scansWithK = [];
            for (let s = 0; s < totalScans; s++) { if (counts[s] >= k) scansWithK.push(s + 1); }
            if (scansWithK.length === totalScans) {
                commonCount++;
                labels.push(item);
            } else {
                labels.push(`${item} ${mediaScanFormatScanTag(new Set(scansWithK))}`);
            }
        }
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

        const label = document.createElement('span');
        label.className = 'admin-category-pill-label';
        label.textContent = cat;
        label.onclick = function() {
            if (adminSelectedCategories.has(cat)) adminSelectedCategories.delete(cat);
            else adminSelectedCategories.add(cat);
            renderAdminCategoryBox();
        };
        pill.appendChild(label);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'admin-category-pill-icon';
        editBtn.title = 'Rename category';
        editBtn.textContent = '✏️';
        editBtn.onclick = function(e) { e.stopPropagation(); renameAdminCategory(cat); };
        pill.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'admin-category-pill-icon';
        deleteBtn.title = 'Delete category';
        deleteBtn.textContent = '✕';
        deleteBtn.onclick = function(e) { e.stopPropagation(); deleteAdminCategory(cat); };
        pill.appendChild(deleteBtn);

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

// একটা category-র নাম বদলালে সেটা যত movie-তে ব্যবহার হচ্ছে সব কটাতেই নতুন নাম বসে যাবে
async function renameAdminCategory(oldSlug) {
    const typed = await showPromptModal('Rename category "' + escapeHtml(oldSlug) + '" to:', oldSlug);
    if (typed === null) return;
    const newSlug = normalizeCategorySlug(slugifyCategory(typed));
    if (!newSlug) { showToast('❌ Category name lekha lagbe', 'error'); return; }
    if (newSlug === oldSlug) return;

    const mergingIntoExisting = getAllKnownCategories().includes(newSlug);
    if (mergingIntoExisting) {
        const merge = await showConfirmModal(
            `"${escapeHtml(newSlug)}" already ache. "${escapeHtml(oldSlug)}"-ke er sathe merge korte chao? Shob movie-r tag update hoye jabe.`,
            { confirmText: 'Merge', danger: false }
        );
        if (!merge) return;
    }

    const affectedMovies = (Array.isArray(allMovies) ? allMovies : []).filter(m => Array.isArray(m.category) && m.category.includes(oldSlug));
    const bannerLabel = categoryBannerLabels[oldSlug] || null;

    try {
        const { data: updRows, error: updErr } = await supabaseClient
            .from('categories').update({ slug: newSlug }).eq('slug', oldSlug).select();
        if (updErr && updErr.code !== '23505') throw updErr;
        if (!updRows || !updRows.length) {
            const { error: insErr } = await supabaseClient.from('categories').insert([{ slug: newSlug, banner_label: bannerLabel }]);
            if (insErr && insErr.code !== '23505') throw insErr;
        }

        await Promise.all(affectedMovies.map(async (m) => {
            const newCats = Array.from(new Set(m.category.map(c => c === oldSlug ? newSlug : c)));
            const { error } = await supabaseClient.from('movies').update({ category: newCats.join('|') }).eq('id', m.id);
            if (error) throw error;
            m.category = newCats;
        }));

        adminExtraCategories.delete(oldSlug);
        adminExtraCategories.add(newSlug);
        if (bannerLabel) {
            delete categoryBannerLabels[oldSlug];
            categoryBannerLabels[newSlug] = bannerLabel;
        }
        if (adminSelectedCategories.has(oldSlug)) {
            adminSelectedCategories.delete(oldSlug);
            adminSelectedCategories.add(newSlug);
        }

        renderAdminCategoryBox();
        refreshAdminCategoryBannerListIfVisible();
        showToast(`✅ "${oldSlug}" ke "${newSlug}" e rename kora hoyeche (${affectedMovies.length}টা title update hoyeche)`);
    } catch (err) {
        console.error('renameAdminCategory error:', err);
        showToast('❌ Rename failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }
}

// একটা category delete korle sheita je shob movie-te tag kora ache shekhan theke shudhu tag ta uthe jabe (movie delete hobe na)
async function deleteAdminCategory(slug) {
    const affectedMovies = (Array.isArray(allMovies) ? allMovies : []).filter(m => Array.isArray(m.category) && m.category.includes(slug));
    const warnMsg = affectedMovies.length
        ? `"${escapeHtml(slug)}" category ${affectedMovies.length}টা title theke remove hobe (title gulo delete hobe na, shudhu category tag ta uthe jabe). Continue?`
        : `"${escapeHtml(slug)}" category delete korte chao?`;
    const confirmed = await showConfirmModal(warnMsg, { confirmText: 'Delete', danger: true });
    if (!confirmed) return;

    // ভুলে delete হয়ে গেলে "Undo" দিয়ে ফিরিয়ে আনার জন্য, মুছে ফেলার আগে movie-গুলোর
    // আসল category লিস্ট আর banner text-এর একটা snapshot রেখে দাও
    const snapshot = affectedMovies.map(m => ({ id: m.id, category: m.category.slice() }));
    const bannerLabelSnapshot = categoryBannerLabels[slug] || null;

    try {
        const { error: delErr } = await supabaseClient.from('categories').delete().eq('slug', slug);
        if (delErr) throw delErr;

        await Promise.all(affectedMovies.map(async (m) => {
            const newCats = m.category.filter(c => c !== slug);
            const { error } = await supabaseClient.from('movies').update({ category: newCats.join('|') }).eq('id', m.id);
            if (error) throw error;
            m.category = newCats;
        }));

        adminExtraCategories.delete(slug);
        adminSelectedCategories.delete(slug);
        delete categoryBannerLabels[slug];

        renderAdminCategoryBox();
        refreshAdminCategoryBannerListIfVisible();
        showToast(`✅ "${slug}" category delete kora hoyeche`, null, {
            actionLabel: '↩ Undo',
            duration: 8000,
            onAction: () => undoDeleteAdminCategory(slug, snapshot, bannerLabelSnapshot)
        });
    } catch (err) {
        console.error('deleteAdminCategory error:', err);
        showToast('❌ Delete failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }
}

// "Undo" চাপলে category-টা আবার ফিরিয়ে আনো, আর যে movie-গুলো থেকে tag উঠে গিয়েছিল
// সেগুলোতেও আগের মতো tag আর banner text আবার বসিয়ে দাও
async function undoDeleteAdminCategory(slug, snapshot, bannerLabel) {
    try {
        const { error: insErr } = await supabaseClient.from('categories').insert([{ slug, banner_label: bannerLabel || null }]);
        if (insErr && insErr.code !== '23505') throw insErr;

        await Promise.all((snapshot || []).map(async (snap) => {
            const movie = (Array.isArray(allMovies) ? allMovies : []).find(m => m.id === snap.id);
            if (!movie) return;
            const { error } = await supabaseClient.from('movies').update({ category: snap.category.join('|') }).eq('id', snap.id);
            if (error) throw error;
            movie.category = snap.category.slice();
        }));

        adminExtraCategories.add(slug);
        if (bannerLabel) categoryBannerLabels[slug] = bannerLabel;
        renderAdminCategoryBox();
        refreshAdminCategoryBannerListIfVisible();
        showToast(`✅ "${slug}" category firiye ana hoyeche`);
    } catch (err) {
        console.error('undoDeleteAdminCategory error:', err);
        showToast('❌ Undo failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }
}

// Navigation ট্যাব খোলা থাকলে category banner list-টাও সাথে সাথে refresh kore dao
function refreshAdminCategoryBannerListIfVisible() {
    const list = document.getElementById('adminCategoryBannerList');
    if (!list) return;
    const searchInput = document.getElementById('adminCategoryBannerSearchInput');
    renderAdminCategoryBannerList(searchInput ? searchInput.value.trim() : '');
}

// ---------- Category banner text (Navigation ট্যাব থেকে সব category-র জন্য আলাদা notice-banner লেখা) ----------

function renderAdminCategoryBannerList(filter) {
    const container = document.getElementById('adminCategoryBannerList');
    if (!container) return;
    container.innerHTML = '';

    const q = (filter || '').toLowerCase().trim();
    const cats = getAllKnownCategories().filter(c => !q || c.toLowerCase().includes(q));

    if (!cats.length) {
        container.innerHTML = '<div class="admin-db-empty">No categories found.</div>';
        return;
    }

    cats.forEach(cat => {
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-banner-card';
        card.innerHTML = `
            <div class="admin-db-info">
                <div class="admin-db-title">${escapeHtml(cat)}</div>
                <div class="admin-banner-fields">
                    <input type="text" class="admin-banner-label-input admin-category-banner-input" placeholder="Custom banner text for this category (optional)" value="${escapeAttr(categoryBannerLabels[cat] || '')}">
                </div>
            </div>
            <div class="admin-db-actions">
                <span class="admin-mini-btn admin-banner-save-btn admin-banner-autosave-status" aria-live="polite">Saved</span>
            </div>
        `;
        const input = card.querySelector('.admin-category-banner-input');
        const statusEl = card.querySelector('.admin-banner-autosave-status');

        const doSave = () => {
            statusEl.disabled = true;
            statusEl.textContent = 'Saving...';
            saveCategoryBannerLabel(cat, input.value, statusEl);
        };
        input.addEventListener('input', debounce(doSave, 800));
        statusEl.style.cursor = 'pointer';
        statusEl.addEventListener('click', () => { if (statusEl.textContent.includes('Retry')) doSave(); });

        container.appendChild(card);
    });
}

async function saveCategoryBannerLabel(slug, label, btn) {
    const trimmed = (label || '').trim();
    try {
        // age .update().select() diye check kora hoto row update hoyeche kina,
        // kintu Supabase RLS-e SELECT policy na thakle update shofol holeo
        // .select() khali data ferot dey — takei "row nai" bhebe upore insert
        // try kora hoto, ar shei insert duplicate-key (23505) e giye chup-chap
        // "Saved" dekhiye ditho, othocho আসল data DB-te save-i hoyni.
        // Tai এখন { count: 'exact' } diye সরাসরি koyta row update holo seta
        // dhore, SELECT policy-r upor nirbhor kori na.
        const { error: updErr, count } = await supabaseClient
            .from('categories')
            .update({ banner_label: trimmed || null }, { count: 'exact' })
            .eq('slug', slug);
        if (updErr) throw updErr;

        if (!count) {
            const { error: insErr } = await supabaseClient
                .from('categories')
                .insert([{ slug: slug, banner_label: trimmed || null }]);
            if (insErr) {
                if (insErr.code === '23505') {
                    // Row already ache, tao update-e 0 count — mane row update
                    // korar RLS policy nai (SELECT policy thakleo UPDATE policy alada)
                    throw new Error('Row ache kintu update hocche na — Supabase-e "categories" table-er UPDATE policy check korun (RLS)');
                }
                throw insErr;
            }
        }

        if (trimmed) categoryBannerLabels[slug] = trimmed;
        else delete categoryBannerLabels[slug];
        adminExtraCategories.add(slug);

        // Ei muhurte user jodi ei category-r page-e already thake, tahole
        // admin panel bondho na kore-o notice banner-er lekha shathe shathe update hobe
        const activeCategory = document.body.getAttribute('data-category');
        if (activeCategory && activeCategory.toLowerCase() === String(slug).toLowerCase()) {
            updateNoticeBannerText(activeCategory);
        }

        if (btn) { btn.disabled = false; btn.textContent = 'Saved'; }
    } catch (err) {
        console.error('saveCategoryBannerLabel error:', err);
        if (btn) { btn.disabled = false; btn.textContent = '⚠️ Retry'; }
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error') + ' — Supabase-e "categories" table-er RLS (Row Level Security) UPDATE policy check korun', 'error');
    }
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

    const seasonTrailersField = document.getElementById('adminSeasonTrailersField');
    if (seasonTrailersField) seasonTrailersField.style.display = value === 'tv' ? 'flex' : 'none';
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

// "trailerEnabled" column Supabase-e na thakle save fail kore - shei khetre
// admin-ke bujhiye dawar moto ekta clear message ber kore.
function friendlyTrailerToggleError(err) {
    const msg = (err && err.message) ? err.message : '';
    if (/trailerEnabled/i.test(msg)) {
        return 'Supabase-e "trailerEnabled" column nei. Supabase → SQL Editor-e ei ta ekbar run koro: ALTER TABLE movies ADD COLUMN IF NOT EXISTS "trailerEnabled" boolean DEFAULT true;';
    }
    return msg || 'Unknown error';
}

function updateAdminPosterPreview() {
    const linkInput = document.getElementById('adminPosterLink');
    const prev = document.getElementById('adminPosterPreview');
    const wrap = document.getElementById('adminPosterPreviewWrap');
    if (!linkInput || !prev || !wrap) return;
    // Field khali thakleo, jodi eta auto TMDB poster hidden thaka ekta edit hoy,
    // taholeo original poster-tar preview thumbnail dekhano hoy (link text chara).
    const link = linkInput.value.trim() || adminOriginalPosterUrl || '';
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

    const seasonTrailersField = document.getElementById('adminSeasonTrailersField');
    if (seasonTrailersField) seasonTrailersField.style.display = value === 'tv' ? 'flex' : 'none';

    if (value === 'movie') {
        const list = document.getElementById('adminMovieLinksList');
        if (list && list.children.length === 0) {
            addMovieLinkRow();
        }
    } else if (value === 'tv') {
        const trailerList = document.getElementById('adminSeasonTrailersList');
        if (trailerList && trailerList.children.length === 0) {
            addSeasonTrailerRow();
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

// ---------- Season trailer rows (TV) ----------
// Series-er khetre proti season-er jonno alada manually trailer link/thumbnail
// deoar jonno ei row-gula. Kono season-er row na thakle (ba khali thakle) shei
// season select korle auto TMDB/YouTube trailer khoja hobe - eta purano
// single Trailer Link field-er moto na, eta season-wise.
function addSeasonTrailerRow(data) {
    data = data || {};
    const list = document.getElementById('adminSeasonTrailersList');
    if (!list) return;
    const nextSeasonGuess = data.season || (list.children.length + 1);
    const row = document.createElement('div');
    row.className = 'admin-link-row admin-season-trailer-row';
    row.innerHTML = `
        <input type="number" min="1" class="admin-season-trailer-num" placeholder="Season" value="${escapeAttr(nextSeasonGuess)}">
        <input type="text" class="admin-season-trailer-link" placeholder="YouTube link or video ID" value="${escapeAttr(data.link)}">
        <input type="text" class="admin-season-trailer-thumb" placeholder="Thumbnail link (optional)" value="${escapeAttr(data.thumb)}">
        <button type="button" class="admin-row-remove-btn" onclick="this.closest('.admin-season-trailer-row').remove()">✕</button>
    `;
    list.appendChild(row);
}

// Season Trailer row-e kono bhul thakle (season number bhul, link khali, ba
// link theke video ID ber kora na gele) age eta chupchap shei row-take skip
// kore dito - fole admin bhabto save hoye gache, kintu ashole seta save-i
// hoyni. Ekhon eta-i clear error dekhiye deya hoy (throw kore), jate submit
// howar age-i bhul-ta dhora pore.
function collectSeasonTrailers() {
    const rows = document.querySelectorAll('#adminSeasonTrailersList .admin-season-trailer-row');
    const result = [];
    rows.forEach(row => {
        const seasonRaw = row.querySelector('.admin-season-trailer-num').value.trim();
        const link = row.querySelector('.admin-season-trailer-link').value.trim();
        const thumb = row.querySelector('.admin-season-trailer-thumb').value.trim();

        // Link ar Thumbnail duitai khali - ei row-ta khali/unused (notun add
        // kora row-e "Season" number auto-fill kora thake, tao real kono
        // content na thakle chupchap skip - error dekhano hoy na).
        if (!link && !thumb) return;

        const seasonNum = parseInt(seasonRaw, 10);
        if (!seasonRaw || Number.isNaN(seasonNum) || seasonNum < 1) {
            throw new Error(`Season Trailer row-e "Season" number sothik bhabe dao (1 ba tar beshi) - link/thumbnail "${link || thumb || '(khali)'}" er jonno eta lagbe.`);
        }
        // YouTube link OPTIONAL - na dile video-r jonno auto (TMDB/YouTube)
        // trailer-i use hobe (thumbnail thakle seta-o kaje lagbe). Shudhu
        // link dile-i seta valid YouTube link/ID kina check kora hoy.
        if (link && !extractYoutubeVideoId(link)) {
            throw new Error(`Season ${seasonNum}-er Trailer Link ("${link}") theke valid YouTube video ID ber kora gelo na - link-ta abar check koro (poro YouTube link ba khali 11-character video ID dite paro), ba link-ta khali rekhe dao.`);
        }

        result.push({ season: seasonNum, link: link || null, thumb: thumb || null });
    });
    return result;
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

// Admin je kono format-e trailer link disol paste korte pare (full youtube.com/watch?v=,
// youtu.be/, /embed/, /shorts/ link, ba shudhu 11-character video ID) - shob format theke
// asol YouTube video ID-ta ber kore ane. Kichu match na hole null return kore.
function extractYoutubeVideoId(input) {
    if (!input) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;

    const patterns = [
        /(?:youtube\.com\/watch\?[^#]*\bv=|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/
    ];
    for (const re of patterns) {
        const m = trimmed.match(re);
        if (m) return m[1];
    }
    // Shudhu bare video ID dile (link na diye) - 11-character YouTube ID format
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    return null;
}

// ---------- Poster / Trailer Thumbnail upload (Supabase Storage) ----------
// Same "posters" bucket reused for trailer thumbnails too, just with a different
// filename prefix - so no extra Supabase bucket setup is needed for this feature.

async function uploadPosterFile(file, prefix = 'poster') {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;

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
    document.getElementById('adminPosterLink').placeholder = 'https://... poster image link';
    adminOriginalPosterUrl = null;
    adminOriginalImdbId = null;
    adminOriginalTmdbId = null;
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
    document.getElementById('adminSeasonTrailersList').innerHTML = '';
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
    // TMDB theke auto-asha poster (image.tmdb.org) link-ta field-e text hisheve
    // dekhano hoy na - field khali thake, shudhu ekta note thake je poster
    // already ache. Field khali rekhe Save korleo ei poster-i thake, karon
    // adminOriginalPosterUrl-e eta save kora ache (nichey submit handler dekho).
    // Nijer deya (manual/custom) poster link hole age-r moto field-e dekha jay,
    // jate shohoje dekhe-check-edit kora jay.
    const posterLinkInput = document.getElementById('adminPosterLink');
    const isAutoTmdbPoster = !!(movie.poster && /image\.tmdb\.org/i.test(movie.poster));
    adminOriginalPosterUrl = movie.poster || null;
    adminOriginalImdbId = movie.imdbId || null;
    adminOriginalTmdbId = movie.tmdbId || null;
    if (isAutoTmdbPoster) {
        posterLinkInput.value = '';
        posterLinkInput.placeholder = '✓ Auto TMDB poster already set - khali rakhle eta-i thakbe, notun link dile replace hobe';
    } else {
        posterLinkInput.value = movie.poster || '';
        posterLinkInput.placeholder = 'https://... poster image link';
    }
    updateAdminPosterPreview();

    document.getElementById('adminMovieLinksList').innerHTML = '';
    document.getElementById('adminSeasonsList').innerHTML = '';
    document.getElementById('adminSeasonTrailersList').innerHTML = '';

    if (movie.tmdbType === 'tv') {
        const seasonTrailers = Array.isArray(movie.seasonTrailers) ? movie.seasonTrailers : [];
        if (seasonTrailers.length > 0) {
            seasonTrailers.forEach(st => addSeasonTrailerRow(st));
        } else {
            addSeasonTrailerRow();
        }
    }

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
        const posterFieldValue = document.getElementById('adminPosterLink').value.trim();
        let posterUrl = posterFieldValue || adminOriginalPosterUrl || null;
        let posterRefreshFailed = false;

        // Edit-er shomoy IMDb/TMDB ID change/remove/correct kora hoyeche kina check kora
        // hocche. Age eta check hoto na - fole IMDb ID vul chilo bole delete/correct korleo,
        // Poster Link field khali rakhle purono (bhul content-er) auto-TMDB poster-i silently
        // reuse hoye jeto (adminOriginalPosterUrl theke), karon IMDb ID change-er sathe
        // poster-er kono connection chilo na. Ekhon: ID actually change hole ar admin nijei
        // notun poster link na dile, notun ID diye fresh poster re-fetch kora hoy - na paoa
        // gele purono bhul poster rakha na hoye khali thake (jate ar bhul poster na dekhay).
        const imdbIdChanged = (imdbId || '') !== (adminOriginalImdbId || '');
        const tmdbIdChanged = String(tmdbId || '') !== String(adminOriginalTmdbId || '');
        const wasAutoTmdbPoster = !!(adminOriginalPosterUrl && /image\.tmdb\.org/i.test(adminOriginalPosterUrl));

        if (editingId && !posterFieldValue && wasAutoTmdbPoster && (imdbIdChanged || tmdbIdChanged) && adminPosterMode !== 'file') {
            submitBtn.textContent = 'Refreshing poster...';
            const freshPoster = await fetchFreshTmdbPoster({ imdbId, tmdbId, tmdbType: adminTmdbType, title, searchName }).catch(() => null);
            posterUrl = freshPoster;
            posterRefreshFailed = !freshPoster;
            submitBtn.textContent = 'Saving...';
        }

        if (adminPosterMode === 'file') {
            const fileInput = document.getElementById('adminPosterFile');
            if (fileInput && fileInput.files && fileInput.files[0]) {
                submitBtn.textContent = 'Uploading poster...';
                posterUrl = await uploadPosterFile(fileInput.files[0], 'poster');

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

        // Original title (TMDB primary, IMDb/OMDb fallback - dekho
        // fetchOriginalTitle()-er comment) fetch kore rakha hocche, jate
        // পরে user shei original title diye search korleo ei content-take
        // khuje paye - protibar search-e live API call korle slow hoye
        // jeto, tai eta ekbar save-er shomoy-i kore database-e rekhe deya
        // hocche.
        submitBtn.textContent = 'Fetching original title...';
        const originalTitle = await fetchOriginalTitle({
            title,
            searchName,
            imdbId,
            tmdbId,
            tmdbType: adminTmdbType
        }).catch(() => null);
        submitBtn.textContent = 'Saving...';

        // Movie-r jonno ekta shingle global trailer thake (trailerLink/trailerThumb).
        // Series (tv)-er jonno eta khali rekhe deya hoy - shei khetre proti season-er
        // jonno alada trailer "Season Trailers" (seasonTrailers) list theke aashe.
        const isTvType = adminTmdbType === 'tv';
        const seasonTrailers = isTvType ? collectSeasonTrailers() : [];

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
            seasonTrailers: isTvType ? JSON.stringify(seasonTrailers) : null,
            downloadBlocks: JSON.stringify(downloadBlocks),
            originalTitle: originalTitle
        };

        // Trailer Link/Thumbnail, Trailer On/Off ar Watch Button (On/Off + Custom
        // Watch Link) ekhon ei form-e nei - segulo alada "Trailer / Teaser" ar
        // "Watch Button" tab-e manage kora hoy. Tai edit-er shomoy payload-e
        // ei column-gulo pathano hoy na, jate oi tab-e deya value overwrite hoye
        // na jay. Notun content add korar shomoy Watch Button auto "On" thake
        // (chaile pore Watch Button tab theke Off kora jabe).
        if (!editingId) { payload.watchEnabled = true; payload.teraPlayEnabled = true; } // Notun content-e Tera Play auto ON



        // নতুন content add করলে (edit নয়) সেটা সবসময় Serial #1-এ বসবে, আর যে item গুলোতে
        // আগে থেকে ম্যানুয়ালি Serial (display_order) দেওয়া আছে, তারা সবাই ১ ঘর করে পিছিয়ে
        // যাবে (2 → 3, 3 → 4 ...)। যাদের Serial এখনো Auto (display_order null), তাদের
        // ছোঁয়া হচ্ছে না - তারা নিজেদের existing (recency) ক্রমেই এই পিন করা item গুলোর নিচে থাকবে।
        if (!editingId) {
            submitBtn.textContent = 'Reordering serials...';
            const { data: pinnedMovies, error: pinnedFetchError } = await supabaseClient
                .from('movies')
                .select('id, display_order')
                .not('display_order', 'is', null);

            if (pinnedFetchError) throw pinnedFetchError;

            if (pinnedMovies && pinnedMovies.length > 0) {
                const bumpResults = await Promise.all(
                    pinnedMovies.map(m =>
                        supabaseClient.from('movies').update({ display_order: m.display_order + 1 }).eq('id', m.id)
                    )
                );
                const bumpError = bumpResults.find(r => r.error);
                if (bumpError) throw bumpError.error;
            }

            payload.display_order = 1;
            submitBtn.textContent = 'Saving...';
        }

        let error;
        if (editingId) {
            ({ error } = await supabaseClient.from('movies').update(payload).eq('id', editingId));
        } else {
            ({ error } = await supabaseClient.from('movies').insert([payload]));
        }

        if (error) throw error;

        msgEl.textContent = editingId ? '✅ Content updated successfully!' : '✅ Content added successfully!';
        if (posterRefreshFailed) {
            msgEl.textContent += ' ⚠️ IMDb/TMDB ID change hoyeche - notun ID diye auto poster khuje paoa jayni, tai poster khali/purono thakte pare. Poster Link field-e manually shothik poster link/file din.';
        }
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

// Edit-er shomoy IMDb/TMDB ID change/correct korle purono (bhul) auto-TMDB poster
// silently reuse na kore, notun ID diye fresh full-size poster fetch kora hoy.
// fetchTmdbPosterQuick theke alada rakha hoyeche karon oi function movie.id diye
// cache kore - shei cache use korle notun ID-r jonno abaro purono (id-based) cached
// poster-i ferot ashto. Eta kono cache use kore na, always fresh fetch kore.
async function fetchFreshTmdbPoster({ imdbId, tmdbId, tmdbType, title, searchName }) {
    if (!TMDB_API_KEY) return null;
    let posterUrl = null;
    try {
        const mediaType = tmdbType === 'tv' ? 'tv' : 'movie';
        let matchId = tmdbId || null;
        const cleanImdbId = extractImdbId(imdbId);

        if (!matchId && cleanImdbId) {
            const findRes = await fetchWithTimeout(`${TMDB_BASE_URL}/find/${cleanImdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`, {}, 4000);
            if (findRes.ok) {
                const findData = await findRes.json();
                const hit = (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
                if (hit) {
                    matchId = hit.id;
                    if (hit.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
                }
            }
        }

        if (!posterUrl && matchId) {
            const detailRes = await fetchWithTimeout(`${TMDB_BASE_URL}/${mediaType}/${matchId}?api_key=${TMDB_API_KEY}`, {}, 4000);
            if (detailRes.ok) {
                const detailData = await detailRes.json();
                if (detailData.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${detailData.poster_path}`;
            }
        }

        if (!posterUrl && !matchId && (title || searchName)) {
            const cleanQuery = (searchName || title).replace(/\s*\([\d\-]+\)/g, '').trim();
            const searchRes = await fetchWithTimeout(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanQuery)}`, {}, 4000);
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                if (searchData && searchData.results && searchData.results.length > 0) {
                    const match = searchData.results.find(item => item.media_type === 'movie' || item.media_type === 'tv') || searchData.results[0];
                    if (match.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${match.poster_path}`;
                }
            }
        }

        if (!posterUrl && (cleanImdbId || title || searchName)) {
            const omdbQuery = cleanImdbId
                ? `i=${encodeURIComponent(cleanImdbId)}`
                : `t=${encodeURIComponent((searchName || title).replace(/\s*\([\d\-]+\)/g, '').trim())}`;
            const omdbRes = await fetchWithTimeout(`https://www.omdbapi.com/?${omdbQuery}&apikey=${OMDB_API_KEY}`, {}, 4000);
            if (omdbRes.ok) {
                const omdbData = await omdbRes.json();
                if (omdbData && omdbData.Response === "True" && omdbData.Poster && omdbData.Poster !== "N/A") {
                    posterUrl = omdbData.Poster;
                }
            }
        }
    } catch (err) {
        console.warn('fetchFreshTmdbPoster failed for', title, err);
    }
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

    // homepage-এ যে order দেখানো হয় (Serial দেওয়া item গুলো ঠিক সেই position-এ), এই লিস্টেও
    // ঠিক সেই একই order মেনে চলে - তাই পুরো source-এর উপর order বসিয়ে তারপর filter করা হচ্ছে
    const orderedSource = applyManualSerialPositions(source);
    const filteredIds = new Set(filtered.map(m => m.id));
    const sorted = orderedSource.filter(m => filteredIds.has(m.id));

    // যাদের Serial ম্যানুয়ালি সেট করা নেই, তাদের ঘরে খালি "Auto" না দেখিয়ে
    // এখন তারা homepage-এ ঠিক কত নম্বরে আছে (effective position) সেটাই দেখানো হবে,
    // যাতে অ্যাডমিন আগের/বর্তমান সিরিয়াল দেখে সহজে এডিট করে বদলাতে পারে
    const positionMap = new Map();
    orderedSource.forEach((m, idx) => positionMap.set(m.id, idx + 1));

    sorted.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'admin-db-card';
        const cats = Array.isArray(movie.category) ? movie.category.join(', ') : (movie.category || '');
        const typeLabel = movie.tmdbType === 'tv' ? 'TV Series' : 'Movie';
        const displaySerial = movie.display_order != null ? movie.display_order : (positionMap.get(movie.id) ?? '');
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-db-title">${movie.title || 'Untitled'}</div>
                <div class="admin-db-meta">${typeLabel} · ${cats || 'No category'}</div>
                <div class="admin-db-order-row">
                    <label for="order-${movie.id}">Serial:</label>
                    <input type="number" id="order-${movie.id}" class="admin-db-order-input" placeholder="Auto" value="${displaySerial}">
                    <button type="button" class="admin-db-order-save-btn">Save</button>
                </div>
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-db-edit-btn">Edit</button>
                <button type="button" class="admin-db-delete-btn">Delete</button>
            </div>
        `;
        card.querySelector('.admin-db-edit-btn').addEventListener('click', () => loadMovieIntoAdminForm(movie));
        card.querySelector('.admin-db-delete-btn').addEventListener('click', () => deleteMovieToTrash(movie));
        const orderInput = card.querySelector('.admin-db-order-input');
        const orderSaveBtn = card.querySelector('.admin-db-order-save-btn');
        orderSaveBtn.addEventListener('click', () => updateMovieDisplayOrder(movie, orderInput.value, orderSaveBtn));
        orderInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') updateMovieDisplayOrder(movie, orderInput.value, orderSaveBtn); });
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

// serial/display order manually সেট করা - ছোট নাম্বার আগে দেখাবে। খালি রাখলে/মুছে দিলে
// আবার site-এর default order (recently added আগে) ফিরে আসবে
// display_order অনুযায়ী allMovies-কে in-place সাজায় (ছোট নাম্বার আগে, তারপর যাদের
// serial সেট করা নেই তারা id descending অনুযায়ী - অর্থাৎ Supabase fetch-এর order-টাই মিরর করে)
function sortAllMoviesByDisplayOrder() {
    if (!Array.isArray(allMovies)) return;
    allMovies = applyManualSerialPositions(allMovies);
}

// currentFilteredMovies (যেটা এখন homepage-এ দেখানো হচ্ছে) কে allMovies-এর নতুন order
// অনুযায়ী পুনরায় সাজায় - filter/search এর ফলাফল একই থাকে, শুধু ক্রম আপডেট হয়
function reorderFilteredMoviesToMatchAllMovies() {
    if (!Array.isArray(currentFilteredMovies) || !Array.isArray(allMovies)) return;
    const orderIndex = new Map();
    allMovies.forEach((m, idx) => orderIndex.set(m.id, idx));
    currentFilteredMovies.sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));
}

async function updateMovieDisplayOrder(movie, rawValue, btn) {
    const trimmed = String(rawValue ?? '').trim();
    const value = trimmed === '' ? null : parseInt(trimmed, 10);
    if (trimmed !== '' && Number.isNaN(value)) {
        showToast('❌ Serial-e sudhu number likho', 'error');
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
        // নতুন Serial number বসানো হলে (খালি করে Auto করা নয়), সেই নাম্বার এবং তার পরের
        // নাম্বারগুলোতে যাদের আগে থেকে Serial ম্যানুয়ালি বসানো আছে, তাদের সবাইকে ১ ঘর করে
        // পিছিয়ে দেওয়া হচ্ছে - যাতে দুটো item একই Serial নাম্বার নিয়ে duplicate না হয়ে যায়।
        if (value !== null) {
            const { data: toShift, error: shiftFetchError } = await supabaseClient
                .from('movies')
                .select('id, display_order')
                .neq('id', movie.id)
                .gte('display_order', value);

            if (shiftFetchError) throw shiftFetchError;

            if (toShift && toShift.length > 0) {
                const shiftResults = await Promise.all(
                    toShift.map(m =>
                        supabaseClient.from('movies').update({ display_order: m.display_order + 1 }).eq('id', m.id)
                    )
                );
                const shiftError = shiftResults.find(r => r.error);
                if (shiftError) throw shiftError.error;

                // মেমরিতে থাকা লিস্টেও (রি-ফেচ ছাড়াই) shift হওয়া নাম্বারগুলো আপডেট করে দাও
                toShift.forEach(shifted => {
                    const cached = allMovies.find(x => x.id === shifted.id);
                    if (cached) cached.display_order = shifted.display_order + 1;
                });
            }
        }

        const { error } = await supabaseClient
            .from('movies')
            .update({ display_order: value })
            .eq('id', movie.id);
        if (error) throw error;

        movie.display_order = value;
        showToast('✅ Serial updated for "' + (movie.title || 'this item') + '"');

        // page reload chara-i live site-e (homepage grid) notun order shathe shathe dekhano
        sortAllMoviesByDisplayOrder();
        moviesList = [...allMovies];
        reorderFilteredMoviesToMatchAllMovies();
        renderMoviesByPage(currentFilteredMovies, currentPage || 1);

        const searchInput = document.getElementById('adminSearchInput');
        renderAdminDatabaseList(searchInput ? searchInput.value.trim() : '');
    } catch (err) {
        console.error('updateMovieDisplayOrder error:', err);
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}



async function fetchAdminNavItems() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return [];
    try {
        const { data, error } = await supabaseClient.from('nav_items').select('*').order('order_index', { ascending: true });
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('fetchAdminNavItems error:', err);
        return [];
    }
}

function buildNavParentSelectOptions(customItems) {
    let html = '<option value="">➕ Top Level (new main menu tab, next to SPORTS)</option>';
    html += '<optgroup label="Existing Menu Items">';
    STATIC_NAV_MANIFEST.forEach(m => {
        html += `<option value="${escapeAttr(m.id)}">${escapeHtml(m.label)}</option>`;
    });
    html += '</optgroup>';
    if (customItems.length) {
        html += '<optgroup label="Your Custom Items">';
        customItems.forEach(it => {
            html += `<option value="db:${it.id}">${escapeHtml(it.label)}</option>`;
        });
        html += '</optgroup>';
    }
    return html;
}

function getNavSiblings(items, item) {
    const pid = item.parent_id ?? null;
    const pmid = item.parent_manifest_id || null;
    return items
        .filter(x => (x.parent_id ?? null) === pid && (x.parent_manifest_id || null) === pmid)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
}

async function renderAdminNavList() {
    const listEl = document.getElementById('adminNavList');
    const selectEl = document.getElementById('adminNavParentSelect');
    if (!listEl || !selectEl) return;
    listEl.innerHTML = '<div class="admin-db-empty">Loading...</div>';

    const items = await fetchAdminNavItems();
    window.__customNavItems = items;
    selectEl.innerHTML = buildNavParentSelectOptions(items);

    if (!items.length) {
        listEl.innerHTML = '<div class="admin-db-empty">Ekhono kono custom navigation item add kora hoyni. Upore form theke notun item add koro.</div>';
        return;
    }

    const manifestLabel = {};
    STATIC_NAV_MANIFEST.forEach(m => { manifestLabel[m.id] = m.label.replace(/^—+\s*/, ''); });

    listEl.innerHTML = items.map(item => {
        let parentLabel = 'Top Level (main menu)';
        if (item.parent_manifest_id) parentLabel = manifestLabel[item.parent_manifest_id] || item.parent_manifest_id;
        else if (item.parent_id) {
            const p = items.find(x => x.id === item.parent_id);
            parentLabel = p ? p.label : ('#' + item.parent_id);
        }
        const siblings = getNavSiblings(items, item);
        const posIndex = siblings.findIndex(x => x.id === item.id);
        return `
            <div class="admin-db-card">
                <div class="admin-db-info">
                    <div class="admin-db-title">${escapeHtml(item.label)}</div>
                    <div class="admin-db-meta">Parent: ${escapeHtml(parentLabel)}${item.category_slug ? ' · slug: ' + escapeHtml(item.category_slug) : ' · (container/toggle only, click hobe na)'}</div>
                </div>
                <div class="admin-db-actions">
                    <button type="button" class="admin-banner-move-btn" data-nav-move-id="${item.id}" data-dir="up" ${posIndex <= 0 ? 'disabled' : ''} title="Move earlier">▲</button>
                    <button type="button" class="admin-banner-move-btn" data-nav-move-id="${item.id}" data-dir="down" ${posIndex >= siblings.length - 1 ? 'disabled' : ''} title="Move later">▼</button>
                    <button type="button" class="admin-mini-btn" data-nav-edit-id="${item.id}" title="Edit this item">✏️ Edit</button>
                    <button type="button" class="admin-db-delete-btn" data-nav-delete-id="${item.id}">Delete</button>
                </div>
            </div>`;
    }).join('');

    listEl.querySelectorAll('[data-nav-move-id]').forEach(btn => {
        btn.addEventListener('click', () => moveAdminNavItem(parseInt(btn.getAttribute('data-nav-move-id'), 10), btn.getAttribute('data-dir')));
    });
    listEl.querySelectorAll('[data-nav-edit-id]').forEach(btn => {
        btn.addEventListener('click', () => editAdminNavItem(parseInt(btn.getAttribute('data-nav-edit-id'), 10)));
    });
    listEl.querySelectorAll('[data-nav-delete-id]').forEach(btn => {
        btn.addEventListener('click', () => deleteAdminNavItem(parseInt(btn.getAttribute('data-nav-delete-id'), 10)));
    });
}

// null hole notun item add hocche, kono id thakle sheita edit/update hocche
let adminNavEditingId = null;

function editAdminNavItem(id) {
    const items = window.__customNavItems || [];
    const item = items.find(x => x.id === id);
    if (!item) return;

    const parentSelect = document.getElementById('adminNavParentSelect');
    const labelInput = document.getElementById('adminNavLabelInput');
    const slugInput = document.getElementById('adminNavSlugInput');
    const bannerInput = document.getElementById('adminNavBannerInput');
    const addBtn = document.getElementById('adminNavAddBtn');
    const cancelBtn = document.getElementById('adminNavCancelEditBtn');
    if (!parentSelect || !labelInput) return;

    adminNavEditingId = id;
    parentSelect.value = item.parent_manifest_id ? item.parent_manifest_id : (item.parent_id ? 'db:' + item.parent_id : '');
    labelInput.value = item.label || '';
    if (slugInput) slugInput.value = item.category_slug || '';
    if (bannerInput) bannerInput.value = item.data_banner || '';
    if (addBtn) addBtn.textContent = '💾 Update Item';
    if (cancelBtn) cancelBtn.style.display = '';

    labelInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    labelInput.focus();
}

function cancelEditAdminNavItem() {
    adminNavEditingId = null;
    const labelInput = document.getElementById('adminNavLabelInput');
    const slugInput = document.getElementById('adminNavSlugInput');
    const bannerInput = document.getElementById('adminNavBannerInput');
    const parentSelect = document.getElementById('adminNavParentSelect');
    const addBtn = document.getElementById('adminNavAddBtn');
    const cancelBtn = document.getElementById('adminNavCancelEditBtn');
    if (labelInput) labelInput.value = '';
    if (slugInput) slugInput.value = '';
    if (bannerInput) bannerInput.value = '';
    if (parentSelect) parentSelect.value = '';
    if (addBtn) addBtn.textContent = '➕ Add Item';
    if (cancelBtn) cancelBtn.style.display = 'none';
}

async function saveAdminNavItem() {
    const parentSelect = document.getElementById('adminNavParentSelect');
    const labelInput = document.getElementById('adminNavLabelInput');
    const slugInput = document.getElementById('adminNavSlugInput');
    const bannerInput = document.getElementById('adminNavBannerInput');
    if (!parentSelect || !labelInput) return;

    const label = labelInput.value.trim();
    if (!label) { showToast('❌ Label lekha lagbe', 'error'); return; }

    const parentVal = parentSelect.value;
    let parent_id = null, parent_manifest_id = null;
    if (parentVal.startsWith('db:')) parent_id = parseInt(parentVal.slice(3), 10);
    else if (parentVal) parent_manifest_id = parentVal;

    const editingId = adminNavEditingId;
    const addBtn = document.getElementById('adminNavAddBtn');

    try {
        if (editingId) {
            // নিজেকেই নিজের parent বানানো আটকানো
            if (parent_id === editingId) { showToast('❌ Ekta item nijer parent hote pare na', 'error'); return; }
            if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Updating...'; }

            const { error } = await supabaseClient.from('nav_items').update({
                parent_id,
                parent_manifest_id,
                label,
                category_slug: slugInput ? (slugInput.value.trim() || null) : null,
                data_banner: bannerInput ? (bannerInput.value.trim() || null) : null
            }).eq('id', editingId);
            if (error) throw error;

            showToast('✅ Navigation item update hoyeche');
            cancelEditAdminNavItem();
        } else {
            const items = window.__customNavItems || [];
            const siblings = items.filter(x => (x.parent_id ?? null) === parent_id && (x.parent_manifest_id || null) === parent_manifest_id);
            const maxOrder = siblings.reduce((max, x) => Math.max(max, x.order_index ?? -1), -1);

            if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding...'; }

            const { error } = await supabaseClient.from('nav_items').insert({
                parent_id,
                parent_manifest_id,
                label,
                category_slug: slugInput ? (slugInput.value.trim() || null) : null,
                data_banner: bannerInput ? (bannerInput.value.trim() || null) : null,
                order_index: maxOrder + 1
            });
            if (error) throw error;

            labelInput.value = '';
            if (slugInput) slugInput.value = '';
            if (bannerInput) bannerInput.value = '';
            showToast('✅ Navigation item add hoyeche');
        }
        await renderAdminNavList();
        renderCustomNavItems();
    } catch (err) {
        console.error('saveAdminNavItem error:', err);
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    } finally {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = adminNavEditingId ? '💾 Update Item' : '➕ Add Item'; }
    }
}

async function deleteAdminNavItem(id) {
    const confirmed = await showConfirmModal('Ei navigation item ta delete korte chao? Nicher shob sub-item o delete hoye jabe.', { confirmText: 'Delete', danger: true });
    if (!confirmed) return;
    try {
        const { error } = await supabaseClient.from('nav_items').delete().eq('id', id);
        if (error) throw error;
        if (adminNavEditingId === id) cancelEditAdminNavItem();
        showToast('✅ Deleted');
        await renderAdminNavList();
        renderCustomNavItems();
    } catch (err) {
        console.error('deleteAdminNavItem error:', err);
        showToast('❌ Delete failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }
}

async function moveAdminNavItem(id, direction) {
    const items = window.__customNavItems || [];
    const item = items.find(x => x.id === id);
    if (!item) return;
    const siblings = getNavSiblings(items, item);
    const idx = siblings.findIndex(x => x.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    try {
        const a = item.order_index ?? 0, b = other.order_index ?? 0;
        const [{ error: e1 }, { error: e2 }] = await Promise.all([
            supabaseClient.from('nav_items').update({ order_index: b }).eq('id', item.id),
            supabaseClient.from('nav_items').update({ order_index: a }).eq('id', other.id)
        ]);
        if (e1 || e2) throw (e1 || e2);
        await renderAdminNavList();
        renderCustomNavItems();
    } catch (err) {
        console.error('moveAdminNavItem error:', err);
        showToast('❌ Move failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }
}



function getFeaturedSortedMovies() {
    const source = Array.isArray(allMovies) ? allMovies : [];
    return source
        .filter(m => m.featured === true)
        .sort((a, b) => (a.featured_order ?? 999) - (b.featured_order ?? 999));
}

// ---------- Trailer / Teaser tab (Database-er pashe alada tab - je kono movie/series-er
// jonno trailer/teaser YouTube link manually add/edit kora jay, puro Add/Edit Content
// form na khule-i. Series-er khetre proti-season alada trailer, movie-r khetre ekta
// shingle trailer link+thumbnail.) ----------

function renderAdminTrailerList(filter) {
    const container = document.getElementById('adminTrailerList');
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

    filtered.forEach(movie => {
        const isTv = movie.tmdbType === 'tv';
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-trailer-card';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-db-title">${escapeHtml(movie.title || 'Untitled')}</div>
                <div class="admin-db-meta">${isTv ? 'TV Series' : 'Movie'}</div>
                ${isTv ? `
                <div class="admin-trailer-season-rows"></div>
                <button type="button" class="admin-add-row-btn admin-trailer-add-season-btn">+ Add Season Trailer</button>
                ` : `
                <div class="admin-trailer-movie-row">
                    <input type="text" class="admin-trailer-movie-link" placeholder="YouTube Trailer/Teaser link or video ID" value="${escapeAttr(movie.trailerLink || '')}">
                    <input type="text" class="admin-trailer-movie-thumb" placeholder="Thumbnail link (optional)" value="${escapeAttr(movie.trailerThumb || '')}">
                </div>
                `}
            </div>
            <div class="admin-db-actions">
                <button type="button" class="admin-watch-state-pill admin-trailer-state-pill ${movie.trailerEnabled === false ? 'off' : 'on'}" title="Trailer On/Off toggle">${movie.trailerEnabled === false ? '🚫 Off' : '🎬 On'}</button>
                <span class="admin-mini-btn admin-trailer-save-btn admin-autosave-status" aria-live="polite">Saved</span>
            </div>
        `;
        card.classList.toggle('is-trailer-off', movie.trailerEnabled === false);

        // Trailer On/Off pill - click korle shathe shathe save hoy (alada Save lage na).
        const trailerPill = card.querySelector('.admin-trailer-state-pill');
        trailerPill.addEventListener('click', () => toggleAdminTrailerEnabled(movie, card, trailerPill));

        if (isTv) {
            const rowsContainer = card.querySelector('.admin-trailer-season-rows');
            const saveBtnEl = card.querySelector('.admin-trailer-save-btn');
            const existing = Array.isArray(movie.seasonTrailers) ? movie.seasonTrailers : [];
            if (existing.length > 0) {
                existing.forEach(st => addAdminTrailerSeasonRow(rowsContainer, st));
            } else {
                addAdminTrailerSeasonRow(rowsContainer);
            }
            const addBtn = card.querySelector('.admin-trailer-add-season-btn');
            addBtn.addEventListener('click', () => addAdminTrailerSeasonRow(rowsContainer));

            // Season trailer row-gula dynamic-bhabe add/remove hoy, tai "blur"
            // (bubble kore na) er bodole "focusout" (bubble kore) event
            // delegation-e ekbar-i rowsContainer-e listener boshano hoy - notun
            // row add korleও alada kore attach korte hoy na. Shudhu Link/Thumb
            // field-e (Season number-e na, karon notun row-e seta age-thekei
            // auto-fill kora thake, chuye gele-i premature "link dao" error
            // dekhabe) blur/Enter korleই auto-save hoy. Row remove ("✕") korleও
            // shathe shathe save hoye jay, jate manually Save-e chapা na lagে.
            rowsContainer.addEventListener('focusout', (e) => {
                if (!e.target.matches('.admin-season-trailer-link, .admin-season-trailer-thumb')) return;
                saveAdminTrailerSettings(movie, card, saveBtnEl);
            });
            rowsContainer.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                if (!e.target.matches('.admin-season-trailer-link, .admin-season-trailer-thumb')) return;
                e.preventDefault();
                e.target.blur();
            });
            rowsContainer.addEventListener('click', (e) => {
                if (!e.target.matches('.admin-row-remove-btn')) return;
                saveAdminTrailerSettings(movie, card, saveBtnEl);
            });
        } else {
            // Movie (TV series na) hole - Trailer link ar Thumbnail link field-e
            // likhe blur (field-er baire click) korle othoba Enter chaplei —
            // Save button-e chapa na diyeo — auto-save hoye jabe. Value age
            // theke jeta save kora chilo tar shathe mile gele abar save hobe na.
            const saveBtnEl = card.querySelector('.admin-trailer-save-btn');
            const linkInput = card.querySelector('.admin-trailer-movie-link');
            const thumbInput = card.querySelector('.admin-trailer-movie-thumb');
            const makeFieldAutoSave = (inputEl, savedValueGetter) => {
                const trigger = () => {
                    const newVal = inputEl.value.trim() || null;
                    if (newVal === savedValueGetter()) return;
                    saveAdminTrailerSettings(movie, card, saveBtnEl);
                };
                inputEl.addEventListener('blur', trigger);
                inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        inputEl.blur();
                    }
                });
            };
            makeFieldAutoSave(linkInput, () => movie.trailerLink || null);
            makeFieldAutoSave(thumbInput, () => movie.trailerThumb || null);
        }

        container.appendChild(card);

        if (!movie.poster) {
            const imgEl = card.querySelector('.admin-db-thumb');
            fetchTmdbPosterQuick(movie).then(url => {
                if (url && imgEl && imgEl.isConnected) imgEl.src = url;
            });
        }
    });
}

// Ekta card-er bhitore notun ekta Season Trailer row jog kore (Add/Edit form-er
// addSeasonTrailerRow()-er moto UI, kintu ei tab-e ekshathe onek card thakte pare
// bole global #adminSeasonTrailersList-er bodole nijer container-e kaj kore).
function addAdminTrailerSeasonRow(container, data) {
    if (!container) return;
    data = data || {};
    const nextSeasonGuess = data.season || (container.children.length + 1);
    const row = document.createElement('div');
    row.className = 'admin-link-row admin-season-trailer-row';
    row.innerHTML = `
        <input type="number" min="1" class="admin-season-trailer-num" placeholder="Season" value="${escapeAttr(nextSeasonGuess)}">
        <input type="text" class="admin-season-trailer-link" placeholder="YouTube link or video ID" value="${escapeAttr(data.link)}">
        <input type="text" class="admin-season-trailer-thumb" placeholder="Thumbnail link (optional)" value="${escapeAttr(data.thumb)}">
        <button type="button" class="admin-row-remove-btn">✕</button>
    `;
    row.querySelector('.admin-row-remove-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
}

// Card-er bhitorer season-trailer row gula theke data collect kore - Add/Edit
// form-er collectSeasonTrailers()-er moto-i validation (bhul/khali link thakle
// clear error dekhabe, chupchap kono row skip korbe na).
function collectAdminTrailerSeasonRows(card) {
    const rows = card.querySelectorAll('.admin-trailer-season-rows .admin-season-trailer-row');
    const result = [];
    rows.forEach(row => {
        const seasonRaw = row.querySelector('.admin-season-trailer-num').value.trim();
        const link = row.querySelector('.admin-season-trailer-link').value.trim();
        const thumb = row.querySelector('.admin-season-trailer-thumb').value.trim();

        // Link ar Thumbnail duitai khali - ei row-ta khali/unused (notun
        // add kora row hole "Season" number-o auto-fill kora thake, tao
        // real kono content na thakle chupchap skip - error dekhano hoy na).
        if (!link && !thumb) return;

        const seasonNum = parseInt(seasonRaw, 10);
        if (!seasonRaw || Number.isNaN(seasonNum) || seasonNum < 1) {
            throw new Error(`Season Trailer row-e "Season" number sothik bhabe dao (1 ba tar beshi) - link/thumbnail "${link || thumb || '(khali)'}" er jonno eta lagbe.`);
        }
        // Link na diyeও shudhu Thumbnail-i deya jete pare - tokhon video-r
        // jonno auto (TMDB/YouTube) trailer-i use hobe, kintu thumbnail-ta
        // admin-er deya custom-ta-i dekhabe (ei row-take r khali "link nei"
        // bole error dekhiye reject kora hoy na).
        if (link && !extractYoutubeVideoId(link)) {
            throw new Error(`Season ${seasonNum}-er Trailer Link ("${link}") theke valid YouTube video ID ber kora gelo na - link-ta abar check koro.`);
        }

        result.push({ season: seasonNum, link: link || null, thumb: thumb || null });
    });
    return result;
}

// Trailer/Teaser tab-er card-e "On/Off" pill-e click korle - trailerEnabled
// value ulte diye (Off = trailer box-i user-er modal-e dekha jabe na) shathe shathe
// Supabase-e save kore.
async function toggleAdminTrailerEnabled(movie, card, pill) {
    if (!movie || !movie.id || pill.disabled) return;
    const newValue = movie.trailerEnabled === false; // ekhon Off chilo -> On hobe, othoba ulta
    pill.disabled = true;
    try {
        const { error } = await supabaseClient.from('movies').update({ trailerEnabled: newValue }).eq('id', movie.id);
        if (error) throw error;
        movie.trailerEnabled = newValue;
        pill.classList.toggle('on', newValue);
        pill.classList.toggle('off', !newValue);
        pill.textContent = newValue ? '🎬 On' : '🚫 Off';
        card.classList.toggle('is-trailer-off', !newValue);
        showToast((newValue ? '🎬 Trailer On' : '🚫 Trailer Off') + ' for "' + (movie.title || 'this item') + '"');
    } catch (err) {
        console.error('Toggle trailer error:', err);
        showToast('❌ Save failed: ' + friendlyTrailerToggleError(err), 'error');
    } finally {
        pill.disabled = false;
    }
}

// Save button-e click korle - series hole shob season-trailer row collect kore
// "seasonTrailers" column-e, movie hole shingle "trailerLink"/"trailerThumb"
// column-e shorashori update kore dey (puro Add/Edit form na khule-i).
async function saveAdminTrailerSettings(movie, card, btn) {
    if (!movie || !movie.id) return;
    const isTv = movie.tmdbType === 'tv';
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        let payload;
        let parsedSeasonTrailers = null;
        if (isTv) {
            parsedSeasonTrailers = collectAdminTrailerSeasonRows(card);
            payload = { seasonTrailers: JSON.stringify(parsedSeasonTrailers) };
        } else {
            const linkRaw = card.querySelector('.admin-trailer-movie-link').value.trim() || null;
            const thumbRaw = card.querySelector('.admin-trailer-movie-thumb').value.trim() || null;
            if (linkRaw && !extractYoutubeVideoId(linkRaw)) {
                throw new Error('Trailer Link-e valid YouTube link ba video ID dao - eta theke video ID ber kora gelo na.');
            }
            payload = { trailerLink: linkRaw, trailerThumb: thumbRaw };
        }

        const { error } = await supabaseClient.from('movies').update(payload).eq('id', movie.id);
        if (error) throw error;

        // Local cache (allMovies)-o update kore dao, jate tab abar render korle
        // ba movie-r modal khullei notun data shathe shathe dekha jay.
        if (isTv) {
            movie.seasonTrailers = parsedSeasonTrailers;
        } else {
            movie.trailerLink = payload.trailerLink;
            movie.trailerThumb = payload.trailerThumb;
        }

        showToast('✅ Trailer saved for "' + (movie.title || 'this item') + '"');
        btn.textContent = 'Saved';
    } catch (err) {
        console.error('Save trailer error:', err);
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        // Explicit "Save" button-er bodole ekhon ekta chhoto status indicator
        // (jeta klik-e save hoy na, karon shob field-i blur/change-e nijeই
        // auto-save hoy) - tai save fail korleo eikhane "Retry" showing kore
        // kono lav nei (click-e kichu hobe na), tai just error-state dekhano
        // hoy, textContent "Save" na reverting kore.
        btn.textContent = '⚠️ Save failed';
    } finally {
        btn.disabled = false;
    }
}

// ---------- "Watch Button" tab: per-item Watch On/Off + custom link, without
// opening the full Add/Edit Content form (thik Trailer/Teaser tab-er moto-i
// pattern) ----------

// TV series-er khetre - ekta shingle "Custom watch link" field-er bodole,
// Trailer tab-er "Season Trailer" row-er moto-i - proti season-er jonno alada
// Watch link (chaile Thumbnail-o) deyar sujog thake (jehetu series-er khetre
// alada-alada season-e alada video/link/thumbnail lagte pare, ekta flat link
// diye shob season cover kora jaay na). Kono season-e alada Thumbnail na
// dile, upore-r global "Custom watch thumbnail" field (thakle) fallback
// hishebe byabohar hoy.
// TV series-er khetre - proti "row" ekta season-er GOTA-season-wide link
// (Episode field khali rakhle) OTHOBA ekta nirdishto EPISODE-er jonno alada
// link (Episode number dile) hote pare - jate admin chaile shudhu "Season 1"
// bole ekta shingle link diye pura season cover korte pare, abar chaile
// proti episode-er jonno alada-alada link-o (S1E1, S1E2, S1E3...) ekta-ekta
// kore add korte pare.
//
// Compact "Season" dropdown design: sob season/episode row ekshathe boro
// list-e na dekhiye, upore ekta Season dropdown ("Season 1 (3 EP)" moto)
// diye SHUDHU currently-selected season-er episode row-gula-i dekhano hoy -
// baki season-er row-gula DOM-e thekei jay (data hariye jay na, save-o hoy),
// shudhu hide thake - jaiga onek kom lage, Netflix/streaming site-er
// season-picker-er moto-i. Prottek row-e "Season" number input-ta thake
// (collectAdminWatchSeasonRows()-e portho, tai remove kora hoyni) kintu
// CSS diye visually hide kora - season nirbachon dropdown diye-i hoy, row-er
// nijer moddhe na.
function addAdminWatchSeasonRow(container, data, forcedSeason, fallbackPoster) {
    if (!container) return;
    data = data || {};
    let seasonVal = (data.season != null && data.season !== '') ? data.season : forcedSeason;
    if (seasonVal == null || seasonVal === '') seasonVal = 1;

    // Save kora row-e admin-er nijer lekha TEXT label (epLabel) thakle
    // seta-i input-e ferot dekhano hoy, na hole shudhu episode number.
    let episodeGuess = (data.epLabel != null && String(data.epLabel).trim()) ? String(data.epLabel).trim() : data.episode;
    if (episodeGuess == null || episodeGuess === '') {
        // Ei season-e already koyta episode row ache, tar modhye shobcheye
        // boro episode number-er porerta-i guess kora hoy (notun "+ Add
        // Episode" click-e sadharonoto eta-i cai).
        const existingRows = Array.from(container.querySelectorAll('.admin-season-watch-row'))
            .filter(r => r.getAttribute('data-season') === String(seasonVal));
        let maxEp = 0;
        existingRows.forEach(r => {
            const epVal = parseInt(r.querySelector('.admin-episode-watch-num').value, 10);
            if (Number.isFinite(epVal) && epVal > maxEp) maxEp = epVal;
        });
        episodeGuess = maxEp > 0 ? maxEp + 1 : '';
    }

    // Row-er bam-dik-e ekta choto "live preview" thumbnail thake - Thumbnail
    // link field-e ki deya ache (na dile, movie-r nijer poster fallback
    // hishebe) shei image-i eikhane dekhano hoy, r tar right-top corner-e
    // "EP {number}" badge-ta bosano thake - Episode number field change
    // korle shathe shathe (typing-er shomoyi) ei badge-o auto update hoy,
    // tai admin shathe shathe bujhte pare frontend-e eta exactly kemon
    // dekhabe.
    const previewFallback = (fallbackPoster && String(fallbackPoster).trim()) || ADMIN_POSTER_PLACEHOLDER;
    const initialPreviewSrc = (data.thumb && String(data.thumb).trim()) || previewFallback;

    const row = document.createElement('div');
    row.className = 'admin-link-row admin-season-watch-row';
    row.setAttribute('data-season', seasonVal);
    row.setAttribute('data-fallback-poster', previewFallback);
    row.innerHTML = `
        <div class="admin-episode-thumb-preview">
            <img class="admin-episode-thumb-preview-img" src="${escapeAttr(initialPreviewSrc)}" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <span class="admin-episode-thumb-badge" style="${episodeGuess ? '' : 'display:none;'}">EP ${escapeHtml(String(episodeGuess || ''))}</span>
        </div>
        <input type="number" min="1" class="admin-season-watch-num admin-watch-hidden-field" value="${escapeAttr(seasonVal)}" tabindex="-1" aria-hidden="true">
        <input type="text" class="admin-episode-watch-num" placeholder="Ep (number ba text)" value="${escapeAttr(episodeGuess)}">
        <input type="text" class="admin-season-watch-link" placeholder="Custom watch/embed link" value="${escapeAttr(data.link)}">
        <input type="text" class="admin-season-watch-thumb" placeholder="Thumbnail link (optional)" value="${escapeAttr(data.thumb)}">
        <button type="button" class="admin-row-remove-btn">✕</button>
    `;
    row.querySelector('.admin-row-remove-btn').addEventListener('click', () => {
        const card = row.closest('.admin-db-card');
        const removedSeason = row.getAttribute('data-season');
        row.remove();
        if (card) {
            refreshAdminWatchSeasonSelect(card);
            const seasonSelectEl = card.querySelector('.admin-watch-season-select');
            const activeSeason = seasonSelectEl ? parseInt(seasonSelectEl.value, 10) : parseInt(removedSeason, 10);
            updateAdminWatchSeasonBadgeUI(card, activeSeason);
            updateAdminWatchSeasonLabelUI(card, activeSeason);
        }
    });

    // Thumbnail link field-e typing korar shathe shathe (khali korle
    // fallback poster-e ferot giye) preview image-o live update hoy.
    const previewImg = row.querySelector('.admin-episode-thumb-preview-img');
    row.querySelector('.admin-season-watch-thumb').addEventListener('input', (e) => {
        const val = e.target.value.trim();
        previewImg.src = val || row.getAttribute('data-fallback-poster') || ADMIN_POSTER_PLACEHOLDER;
    });

    // Episode number field-e typing korar shathe shathe badge-o live update
    // hoy - khali rakhle (gota-season-wide link) badge lukiye jay.
    const previewBadge = row.querySelector('.admin-episode-thumb-badge');
    row.querySelector('.admin-episode-watch-num').addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val) {
            // Shudhu number dile age-r moto-i "EP 3" dekhay, kintu admin jodi
            // nijer kono TEXT (jemon "Finale", "EP 3 (Hindi)") likhe - tahole
            // shei lekha-take-i hubohu badge hishebe dekhano hoy.
            previewBadge.textContent = /^\d+$/.test(val) ? `EP ${val}` : val;
            previewBadge.style.display = '';
        } else {
            previewBadge.style.display = 'none';
        }
    });

    container.appendChild(row);
    return row;
}

// Season-er episode row-gular "Ep" number field theke (2-er beshi row thakle)
// min-max range ber kore "EP-(01-02)" moto ekta auto-suggested label banay -
// admin nijer kono custom label na dile, eta-i frontend-e byabohar hobe
// (getManualSeasonWatchBadge()-e ekই logic mirror kora ache).
function computeAutoWatchSeasonBadge(rowsContainer, seasonNum) {
    if (!rowsContainer || seasonNum == null || Number.isNaN(Number(seasonNum))) return '';
    const rows = Array.from(rowsContainer.querySelectorAll('.admin-season-watch-row'))
        .filter(r => r.getAttribute('data-season') === String(seasonNum));
    const epNums = rows
        .map(r => parseInt(r.querySelector('.admin-episode-watch-num').value, 10))
        .filter(n => Number.isFinite(n));
    if (epNums.length < 2) return '';
    const min = Math.min(...epNums);
    const max = Math.max(...epNums);
    const pad = n => String(n).padStart(2, '0');
    return min === max ? `EP-${pad(min)}` : `EP-(${pad(min)}-${pad(max)})`;
}

// "Poster label" input-take current-active season-er shathe sync rakhe -
// shudhu tokhon-i show kora hoy jokhon shei season-e 1-er beshi episode row
// thake (na hole - shingle episode/gota-season link-e alada label-er dorkar
// nei), ar value-o (admin-er save kora custom label thakle seta, na hole
// khali - auto-suggestion shudhu placeholder hishebe dekhano hoy) thik kore
// dey.
function updateAdminWatchSeasonBadgeUI(card, seasonNum) {
    if (!card) return;
    const badgeInput = card.querySelector('.admin-watch-season-badge-input');
    const rowsContainer = card.querySelector('.admin-watch-season-rows');
    if (!badgeInput) return;
    if (!rowsContainer || seasonNum == null || Number.isNaN(Number(seasonNum))) {
        badgeInput.style.display = 'none';
        return;
    }
    const rowCount = rowsContainer.querySelectorAll(`.admin-season-watch-row[data-season="${seasonNum}"]`).length;
    if (rowCount <= 1) {
        badgeInput.style.display = 'none';
        return;
    }
    const badges = card._watchSeasonBadges || (card._watchSeasonBadges = {});
    badgeInput.style.display = '';
    badgeInput.setAttribute('data-active-season', seasonNum);
    badgeInput.value = badges[seasonNum] || '';
    const autoSuggestion = computeAutoWatchSeasonBadge(rowsContainer, seasonNum);
    badgeInput.placeholder = autoSuggestion
        ? `Poster label (optional) — leave blank for auto "${autoSuggestion}"`
        : 'Poster label for this season (optional) — e.g. EP-(01-02)';
}

// "Season name" input-take current-active season-er shathe sync rakhe -
// (Episode field-e admin je-bhabe number-er bodole nijer kono TEXT likhte
// pare, ek-i rokom bhabe ei field-e Season-er jonno-o nijer kono custom
// nam/text likhte pare - jemon "Season 5" na likhe "সিজন ৫" ba "Bachelor
// Point S5" - Season dropdown-e Season number-er bodole eta-i dekhabe).
// Badge input-er ulTo - eta shobshomoy dekhano hoy (episode shonkha
// nirbishesheh), karon 1-ta episode thakleo season-er nijer ekTa nam thakte
// pare.
function updateAdminWatchSeasonLabelUI(card, seasonNum) {
    if (!card) return;
    const labelInput = card.querySelector('.admin-watch-season-label-input');
    if (!labelInput) return;
    if (seasonNum == null || Number.isNaN(Number(seasonNum))) {
        labelInput.style.display = 'none';
        return;
    }
    const labels = card._watchSeasonLabels || (card._watchSeasonLabels = {});
    labelInput.style.display = '';
    labelInput.setAttribute('data-active-season', seasonNum);
    labelInput.value = labels[seasonNum] || '';
    labelInput.placeholder = `Season name (optional) — leave blank for auto "Season ${seasonNum}"`;
}


// list ar proti-season-e koyta episode row ache seta ber kore, Season
// dropdown-take notun kore populate kore ("Season X (Y EP)" format-e) - ar
// tarpor shudhu currently-active season-er row-gula-i dekhay (baki-gula hide
// kore dey). Row add/remove hole, ba card prothom render howar shomoy - ei
// function-i call kora hoy, jate dropdown-ta shobshomoy actual row-data-r
// shathe sync-e thake.
function refreshAdminWatchSeasonSelect(card, preferredSeason) {
    const rowsContainer = card.querySelector('.admin-watch-season-rows');
    const selectEl = card.querySelector('.admin-watch-season-select');
    if (!rowsContainer || !selectEl) return;

    const rows = Array.from(rowsContainer.querySelectorAll('.admin-season-watch-row'));
    const seasonCounts = {};
    rows.forEach(r => {
        const s = r.getAttribute('data-season');
        if (!s) return;
        seasonCounts[s] = (seasonCounts[s] || 0) + 1;
    });
    const seasons = Object.keys(seasonCounts).map(Number).sort((a, b) => a - b);

    if (seasons.length === 0) {
        selectEl.innerHTML = '';
        return;
    }

    const wantedSeason = preferredSeason != null ? preferredSeason : parseInt(selectEl.value, 10);
    const activeSeason = seasons.includes(wantedSeason) ? wantedSeason : seasons[seasons.length - 1];

    selectEl.innerHTML = seasons.map(s =>
        `<option value="${s}" ${s === activeSeason ? 'selected' : ''}>Season ${s} (${seasonCounts[s]} EP)</option>`
    ).join('');

    filterAdminWatchRowsBySeason(rowsContainer, activeSeason);
}

// Shudhu "seasonNum"-er row-gula-i dekhay, baki shob season-er row-gula
// (DOM-e thekei jay, delete hoy na - collectAdminWatchSeasonRows()-e save
// korar shomoy shobkota-i porha hoy) hide kore dey.
function filterAdminWatchRowsBySeason(rowsContainer, seasonNum) {
    rowsContainer.querySelectorAll('.admin-season-watch-row').forEach(r => {
        r.style.display = (r.getAttribute('data-season') === String(seasonNum)) ? '' : 'none';
    });
}

// Card-er bhitorer season-watch row gula theke data collect kore -
// collectAdminTrailerSeasonRows()-er moto-i pattern, shudhu YouTube-video-ID
// validation nei (Watch link jekono embed URL hote pare, shudhu YouTube na).
// Link na diyeও shudhu Thumbnail-i deya jete pare (Trailer tab-er thumb-only
// support-er moto-i) - tokhon video-r jonno auto/global watch link-i use
// hobe, kintu thumbnail-ta shei season-er jonno custom-ta-i dekhabe. Episode
// field khali rakhle - eta shei GOTA season-er jonno (shob episode-e) kaj
// korbe; nirdishto episode number dile - shudhu shei episode-er jonno-i
// (onno episode-e noy) kaj korbe.
function collectAdminWatchSeasonRows(card) {
    const rows = card.querySelectorAll('.admin-watch-season-rows .admin-season-watch-row');
    const seasonBadges = card._watchSeasonBadges || {};
    const seasonLabels = card._watchSeasonLabels || {};
    const result = [];
    // Proti season-e kon kon episode number already byabohar hoye geche -
    // shudhu-text ("Finale" moto) row-e automatic number assign korar shomoy
    // eta lage, jate duiTa row-e ekই number na pore.
    const usedEpisodeNumbersBySeason = {};
    rows.forEach(row => {
        const seasonRaw = row.querySelector('.admin-season-watch-num').value.trim();
        const episodeRaw = row.querySelector('.admin-episode-watch-num').value.trim();
        const link = row.querySelector('.admin-season-watch-link').value.trim();
        const thumb = row.querySelector('.admin-season-watch-thumb').value.trim();

        // Link ar Thumbnail duitai khali - ei row-ta khali/unused (notun add
        // kora row hole "Season" number-o auto-fill kora thake, tao real
        // kono content na thakle chupchap skip - error dekhano hoy na).
        if (!link && !thumb) return;

        const seasonNum = parseInt(seasonRaw, 10);
        if (!seasonRaw || Number.isNaN(seasonNum) || seasonNum < 1) {
            throw new Error(`Watch Link row-e "Season" number sothik bhabe dao (1 ba tar beshi) - link/thumbnail "${link || thumb || '(khali)'}" er jonno eta lagbe.`);
        }

        // "Episode" field-e ekhon shudhu number na - je kono TEXT-o lekha jay
        // (jemon "Finale", "EP 3 (Hindi)", "Special"). Bhitore-bhitore protiTa
        // episode-er ekTa unique NUMBER lage (oi number diye-i link/thumbnail
        // khuje ber kora hoy, ar dropdown-er order thik thake) - tai:
        //   - Text-er modhye kono number thakle (jemon "EP 3 (Hindi)" -> 3)
        //     shei number-take-i episode number dhora hoy.
        //   - Puro-i text hole (kono number nei) - oi season-e ekhono byabohar
        //     hoyni emon shobcheye choto number automatic assign kora hoy.
        //   - Admin jodi shudhu-i number likhe, age-r moto-i shob kaj kore.
        // Ar admin-er lekha mul text-ta "epLabel" hishebe save hoy - frontend-e
        // Episode dropdown ar poster-er badge-e hubohu ei lekha-i dekhabe.
        let episodeNum = null;
        let episodeLabel = null;
        if (episodeRaw) {
            const usedEpNums = usedEpisodeNumbersBySeason[seasonNum] || (usedEpisodeNumbersBySeason[seasonNum] = new Set());
            const numMatch = episodeRaw.match(/\d+/);
            if (numMatch) {
                const parsed = parseInt(numMatch[0], 10);
                if (Number.isFinite(parsed) && parsed >= 1) episodeNum = parsed;
            }
            if (episodeNum == null) {
                let next = 1;
                while (usedEpNums.has(next)) next++;
                episodeNum = next;
            }
            usedEpNums.add(episodeNum);
            if (!/^\d+$/.test(episodeRaw)) episodeLabel = episodeRaw;
        }

        // Admin ei season-er jonno kono custom "poster label" (jemon
        // "EP-(01-02)") diye thakle - shei season-er PROTI row-e-i eta
        // attach kore rakha hoy (redundant kintu simple), jate kono ekta
        // nirdishto episode-er link-o (jekhan theke-i frontend-e default
        // thumbnail resolve hoy) shei label-take khuje pete pare.
        const badge = seasonBadges[seasonNum] || null;

        // Thik ekই bhabe - kono custom "Season name" (jemon "সিজন ৫") deya
        // thakle, seta-o proti row-e attach kore rakha hoy.
        const seasonLabel = seasonLabels[seasonNum] || null;

        result.push({ season: seasonNum, episode: episodeNum, epLabel: episodeLabel, link: link || null, thumb: thumb || null, badge, seasonLabel });
    });
    return result;
}

function renderAdminWatchList(filter) {
    const container = document.getElementById('adminWatchList');
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

    filtered.forEach(movie => {
        const isTv = movie.tmdbType === 'tv';
        const isOn = !!movie.watchEnabled;
        const hasSeasonLinks = isTv && Array.isArray(movie.watchSeasonLinks) && movie.watchSeasonLinks.length > 0;
        const card = document.createElement('div');
        card.className = 'admin-db-card admin-trailer-card admin-watch-card';
        card.innerHTML = `
            <img class="admin-db-thumb" src="${movie.poster || ADMIN_POSTER_PLACEHOLDER}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${ADMIN_POSTER_PLACEHOLDER}';">
            <div class="admin-db-info">
                <div class="admin-watch-card-head" role="button" tabindex="0" aria-expanded="false">
                    <div class="admin-watch-card-head-text">
                        <div class="admin-db-title">${escapeHtml(movie.title || 'Untitled')}</div>
                        <div class="admin-db-meta">${isTv ? 'TV Series' : 'Movie'}${movie.tmdbId ? ' • TMDB ' + escapeHtml(String(movie.tmdbId)) : ' • no TMDB match'}</div>
                    </div>
                    <button type="button" class="admin-watch-state-pill ${isOn ? 'on' : 'off'}" title="Watch Button On/Off toggle">${isOn ? '▶️ On' : '🚫 Off'}</button>
                    <button type="button" class="admin-watch-state-pill admin-tera-state-pill ${movie.teraPlayEnabled === true ? 'on' : 'off'}" title="Terabox Play On/Off toggle">${movie.teraPlayEnabled === true ? '📦 Tera Play: On' : '📦 Tera Play: Off'}</button>
                    <span class="admin-watch-collapse-caret" aria-hidden="true">▾</span>
                </div>
                <button type="button" class="admin-watch-showhide-btn" aria-expanded="false">▾ Show</button>
                <div class="admin-watch-card-body">
                ${isTv ? `
                <label class="admin-watch-auto-toggle">
                    <input type="checkbox" class="admin-watch-auto-checkbox" ${hasSeasonLinks ? '' : 'checked'}>
                    <span>Auto (one link for all seasons)</span>
                </label>
                <div class="admin-watch-season-picker">
                    <select class="admin-watch-season-select"></select>
                    <button type="button" class="admin-mini-btn admin-watch-add-season-inline-btn" title="Add a new season">+ Season</button>
                </div>
                <input type="text" class="admin-watch-season-label-input" placeholder="Season name (optional) — e.g. Season 5 / সিজন ৫">
                <input type="text" class="admin-watch-season-badge-input" placeholder="Poster label for this season (optional) — e.g. EP-(01-02)" style="display:none;">
                <div class="admin-watch-season-rows"></div>
                <button type="button" class="admin-add-row-btn admin-watch-add-season-btn">+ Add Episode</button>
                ` : ''}
                <input type="text" class="admin-watch-link-input" placeholder="Custom watch/embed link (optional — overrides the automatic TMDB embed)" value="${escapeAttr(movie.watchLink || '')}">
                <input type="text" class="admin-watch-thumb-input" placeholder="Custom watch thumbnail (optional — otherwise the poster is shown automatically)" value="${escapeAttr(movie.watchThumb || '')}">
                </div>
            </div>
            <div class="admin-db-actions">
                <span class="admin-mini-btn admin-watch-save-btn admin-autosave-status" aria-live="polite">Saved</span>
            </div>
        `;

        let watchOnState = isOn;
        const thumbInput = card.querySelector('.admin-watch-thumb-input');
        const linkInput = card.querySelector('.admin-watch-link-input');
        const saveBtn = card.querySelector('.admin-watch-save-btn');
        const statePill = card.querySelector('.admin-watch-state-pill');

        // ---------- Collapse / expand (dropdown-er moto) ----------
        // Prottek content-er card SHURU-te bondho (collapsed) thake - shudhu
        // title + type/TMDB line + ekta choto On/Off pill + caret (▾) dekha
        // jay. Header-e click (ba keyboard-e Enter/Space) korle shei ekta
        // content-er-i shob control (On/Off, Auto checkbox, Season dropdown,
        // episode row, link/thumbnail field) khule jay. ACCORDION behaviour:
        // ekta khullei baki khola card-gula apna-apni bondho hoye jay, tai
        // ek shomoy ekta-i content open thake ar list-ta choto/poriskar
        // thake. (Ek-shathe onekta khola rakhte chaile - nicher
        // "closeOtherWatchCards()" call-ta shudhu muche dile-i hobe.)
        const headEl = card.querySelector('.admin-watch-card-head');
        const showHideBtn = card.querySelector('.admin-watch-showhide-btn');
        card.classList.add('is-collapsed');

        const closeOtherWatchCards = () => {
            container.querySelectorAll('.admin-watch-card:not(.is-collapsed)').forEach(other => {
                if (other === card) return;
                other.classList.add('is-collapsed');
                const otherHead = other.querySelector('.admin-watch-card-head');
                if (otherHead) otherHead.setAttribute('aria-expanded', 'false');
            });
        };

        const toggleWatchCard = (forceOpen) => {
            const willOpen = (forceOpen != null) ? forceOpen : card.classList.contains('is-collapsed');
            if (willOpen) closeOtherWatchCards();
            card.classList.toggle('is-collapsed', !willOpen);
            headEl.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            showHideBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            showHideBtn.textContent = willOpen ? '▴ Hide' : '▾ Show';
        };

        // Show/Hide button-ta AGE-r boro "🚫 Off / ▶️ On" toggle-group-er
        // jaigay-i (title-er thik niche) boshe ache ar shob-shomoy-i dekha
        // jay - collapsed thakle "▾ Show", khola thakle "▴ Hide".
        showHideBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWatchCard();
        });
        headEl.addEventListener('click', () => toggleWatchCard());
        headEl.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleWatchCard();
        });

        // ---------- Header-er pill-i ekhon On/Off toggle ----------
        // Age-r boro dui-button-er group-ta shorie deya hoyeche (oi jaigay
        // ekhon Show/Hide button) - tar bodole header-er choto pill-ta-i
        // ekhon CLICK-able toggle: click korlei On <-> Off hoy ar shathe
        // shathe (Save button-e chapa chara-i) auto-save hoye jay. Card
        // bondho thakleo pill dekhe-i bojha jay kono content-er Watch
        // Button ekhon On na Off.
        const syncStatePill = (on) => {
            if (!statePill) return;
            statePill.textContent = on ? '▶️ On' : '🚫 Off';
            statePill.classList.toggle('on', !!on);
            statePill.classList.toggle('off', !on);
            statePill.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        syncStatePill(watchOnState);

        // ---------- Tera Play On/Off pill (Terabox link theke video play) ----------
        const teraPill = card.querySelector('.admin-tera-state-pill');
        const syncTeraPill = (on) => {
            teraPill.textContent = on ? '📦 Tera Play: On' : '📦 Tera Play: Off';
            teraPill.classList.toggle('on', !!on);
            teraPill.classList.toggle('off', !on);
            teraPill.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        teraPill.addEventListener('click', async (e) => {
            e.stopPropagation();
            const next = movie.teraPlayEnabled !== true;
            syncTeraPill(next);
            teraPill.disabled = true;
            try {
                await saveTeraPlayToggle(movie, next);
                showToast('✅ Tera Play ' + (next ? 'ON' : 'OFF') + ' for "' + (movie.title || 'this item') + '"');
            } catch (err) {
                console.error('Tera Play toggle error:', err);
                syncTeraPill(!next);
                showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error') + ' (SUPABASE_TERA_PLAY.sql run korechen?)', 'error');
            } finally { teraPill.disabled = false; }
        });

        statePill.addEventListener('click', (e) => {
            // Pill-ta header-er BHITORE, tai stopPropagation na korle click-ta
            // header-e-o pouchhe giye card-ta khule/bondho kore felto.
            e.stopPropagation();
            watchOnState = !watchOnState;
            syncStatePill(watchOnState);
            saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
        });

        // Custom watch thumbnail/link field-e likhe blur (field-er baire click)
        // korle othoba Enter chaplei — Save button-e chapa na diyeo —
        // auto-save hoye jabe. Value age theke jeta save kora chilo tar
        // shathe mile gele abar save hobe na. Thumbnail field khali rakhle
        // frontend-e automatic-bhabe movie-r nijer poster-i dekhano hoy (kono
        // kichu manually add korte hoy na).
        const makeFieldAutoSave = (inputEl, savedValueGetter) => {
            const trigger = () => {
                const newVal = inputEl.value.trim() || null;
                if (newVal === savedValueGetter()) return;
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            };
            inputEl.addEventListener('blur', trigger);
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    inputEl.blur();
                }
            });
        };
        makeFieldAutoSave(thumbInput, () => movie.watchThumb || null);
        makeFieldAutoSave(linkInput, () => movie.watchLink || null);

        if (isTv) {
            // TV series - "Auto" checkbox diye dui-rokom mode-er modhye
            // switch kora jay: (1) checked = Movie-r moto-i ekটাই shingle
            // Custom watch link field, shob season/episode-er jonno ekই link
            // - season picker/Add button hide thake. (2) unchecked =
            // Trailer tab-er Season Trailer-er moto-i proti season-er jonno
            // alada Watch link, kintu compact Season dropdown diye shudhu
            // ekta season-er episode-gula-i ekbar-e dekhano hoy - shingle
            // link field hide thake. Checkbox change korleo shathe shathe
            // auto-save hoy, jate database-o shothik mode onujayi update
            // hoy.
            const autoCheckbox = card.querySelector('.admin-watch-auto-checkbox');
            const rowsContainer = card.querySelector('.admin-watch-season-rows');
            const addSeasonBtn = card.querySelector('.admin-watch-add-season-btn');
            const seasonSelect = card.querySelector('.admin-watch-season-select');
            const addSeasonInlineBtn = card.querySelector('.admin-watch-add-season-inline-btn');

            // Episode row-er "live preview" thumbnail-er fallback (jokhon
            // shei row-e nijer kono Thumbnail link deya thake na) - frontend-e
            // "Online Watch"-e je-priority-e thumbnail resolve hoy (Custom
            // watch thumbnail field FIRST, tarpor movie/series-er nijer
            // poster) - eikhaneo ekই priority mena hoy, jate admin panel-er
            // preview-ta আসল frontend-er shathe mile jay. (TMDB backdrop eikhane
            // shamil kora hoyni - shudhu ekta choto preview, extra API call
            // lagbe na.)
            const resolveRowFallbackPoster = () => (thumbInput.value.trim() || movie.poster || '');

            const existingSw = Array.isArray(movie.watchSeasonLinks) ? movie.watchSeasonLinks : [];

            // Kono season-e admin age-i (kono ekta row-e) ekta custom "poster
            // label" (jemon "EP-(01-02)") save kore rekhe thakle - shei
            // value-gula season-number diye group kore ekta shadharon JS
            // object-e (card-er nijer upor-i, DOM-e na, karon eta persist
            // korte hobe season dropdown switch korar shomoy-o) rakha hoy -
            // collectAdminWatchSeasonRows() save korar shomoy eikhan theke-i
            // proti row-e abar attach kore dey.
            const seasonBadges = {};
            existingSw.forEach(sw => {
                if (sw && sw.badge && String(sw.badge).trim() && sw.season != null) {
                    const sNum = Number(sw.season);
                    if (Number.isFinite(sNum) && !seasonBadges[sNum]) seasonBadges[sNum] = String(sw.badge).trim();
                }
            });
            card._watchSeasonBadges = seasonBadges;

            // Thik shei-i bhabe - kono season-e admin age-i custom "Season
            // name" (jemon "সিজন ৫") save kore thakle, shei-o ekটা alada
            // map-e (season number -> label) group kore rakha hoy.
            const seasonLabels = {};
            existingSw.forEach(sw => {
                if (sw && sw.seasonLabel && String(sw.seasonLabel).trim() && sw.season != null) {
                    const sNum = Number(sw.season);
                    if (Number.isFinite(sNum) && !seasonLabels[sNum]) seasonLabels[sNum] = String(sw.seasonLabel).trim();
                }
            });
            card._watchSeasonLabels = seasonLabels;

            if (existingSw.length > 0) {
                existingSw.forEach(sw => addAdminWatchSeasonRow(rowsContainer, sw, sw.season, resolveRowFallbackPoster()));
            } else {
                addAdminWatchSeasonRow(rowsContainer, { episode: 1 }, 1, resolveRowFallbackPoster());
            }
            refreshAdminWatchSeasonSelect(card);
            updateAdminWatchSeasonBadgeUI(card, parseInt(seasonSelect.value, 10));
            updateAdminWatchSeasonLabelUI(card, parseInt(seasonSelect.value, 10));

            // Season dropdown-e onno season select korle - shudhu shei
            // season-er episode row-gula-i dekhano hoy, baki-gula hide
            // (DOM-e thekei jay, data hariye jay na).
            seasonSelect.addEventListener('change', () => {
                const activeSeason = parseInt(seasonSelect.value, 10);
                filterAdminWatchRowsBySeason(rowsContainer, activeSeason);
                updateAdminWatchSeasonBadgeUI(card, activeSeason);
                updateAdminWatchSeasonLabelUI(card, activeSeason);
            });

            // "+ Season" - shobcheye boro existing season number-er porerta
            // niye ekta notun season shuru kore, tar 1-nombor episode-er
            // jonno ekta khali row add kore, ar dropdown-take shei notun
            // season-e switch kore dey.
            addSeasonInlineBtn.addEventListener('click', () => {
                const rows = Array.from(rowsContainer.querySelectorAll('.admin-season-watch-row'));
                let maxSeason = 0;
                rows.forEach(r => {
                    const s = parseInt(r.getAttribute('data-season'), 10);
                    if (Number.isFinite(s) && s > maxSeason) maxSeason = s;
                });
                const newSeason = maxSeason + 1;
                addAdminWatchSeasonRow(rowsContainer, { episode: 1 }, newSeason, resolveRowFallbackPoster());
                refreshAdminWatchSeasonSelect(card, newSeason);
                updateAdminWatchSeasonBadgeUI(card, newSeason);
                updateAdminWatchSeasonLabelUI(card, newSeason);
            });

            // "+ Add Episode" - dropdown-e ekhon je season select kora ache,
            // shei season-e-i notun episode row add hoy (episode number
            // auto-increment hoy).
            addSeasonBtn.addEventListener('click', () => {
                const activeSeason = parseInt(seasonSelect.value, 10) || 1;
                addAdminWatchSeasonRow(rowsContainer, {}, activeSeason, resolveRowFallbackPoster());
                refreshAdminWatchSeasonSelect(card, activeSeason);
                updateAdminWatchSeasonBadgeUI(card, activeSeason);
                updateAdminWatchSeasonLabelUI(card, activeSeason);
            });

            const applyWatchModeVisibility = () => {
                const isAuto = autoCheckbox.checked;
                card.querySelector('.admin-watch-season-picker').style.display = isAuto ? 'none' : '';
                card.querySelector('.admin-watch-season-label-input').style.display = isAuto ? 'none' : '';
                card.querySelector('.admin-watch-season-badge-input').style.display = isAuto ? 'none' : '';
                rowsContainer.style.display = isAuto ? 'none' : '';
                addSeasonBtn.style.display = isAuto ? 'none' : '';
                linkInput.style.display = isAuto ? '' : 'none';
                if (!isAuto) {
                    updateAdminWatchSeasonBadgeUI(card, parseInt(seasonSelect.value, 10));
                    updateAdminWatchSeasonLabelUI(card, parseInt(seasonSelect.value, 10));
                }
            };
            applyWatchModeVisibility();
            autoCheckbox.addEventListener('change', () => {
                applyWatchModeVisibility();
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            });

            // Season watch row-gula dynamic-bhabe add/remove hoy, tai "blur"
            // (bubble kore na) er bodole "focusout" (bubble kore) event
            // delegation-e ekbar-i rowsContainer-e listener boshano hoy - notun
            // row add korleও alada kore attach korte hoy na. "Ep" (episode
            // number/label), Link ar Thumbnail - tinTA field-e-i (Season
            // number-e na, karon notun row-e seta age-thekei auto-fill kora
            // thake, chuye gele-i premature "link/thumbnail dao" error
            // dekhabe) blur/Enter korleই auto-save hoy - Save button-e alada
            // kore chapa lage na.
            rowsContainer.addEventListener('focusout', (e) => {
                if (!e.target.matches('.admin-episode-watch-num, .admin-season-watch-link, .admin-season-watch-thumb')) return;
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            });
            rowsContainer.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                if (!e.target.matches('.admin-episode-watch-num, .admin-season-watch-link, .admin-season-watch-thumb')) return;
                e.preventDefault();
                e.target.blur();
            });
            rowsContainer.addEventListener('click', (e) => {
                if (!e.target.matches('.admin-row-remove-btn')) return;
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            });

            // Uporer "Custom watch thumbnail" (global) field-e admin typing
            // korar shathe shathe - jei row-gular NIJER kono Thumbnail link
            // deya nei, shei row-gular preview-o shathe shathe (live) ei
            // notun global thumbnail-e update hoy, jate admin field-ta blur
            // na kore-i (ba save na kore-i) shathe shathe bujhte pare eta
            // eikhon-i poster-er bodole ei link-take fallback hishebe
            // byabohar korbe.
            thumbInput.addEventListener('input', () => {
                const fallback = resolveRowFallbackPoster();
                rowsContainer.querySelectorAll('.admin-season-watch-row').forEach(row => {
                    row.setAttribute('data-fallback-poster', fallback);
                    const rowThumbInput = row.querySelector('.admin-season-watch-thumb');
                    const previewImg = row.querySelector('.admin-episode-thumb-preview-img');
                    if (rowThumbInput && !rowThumbInput.value.trim() && previewImg) {
                        previewImg.src = fallback || ADMIN_POSTER_PLACEHOLDER;
                    }
                });
            });

            // "Poster label" input (jemon "EP-(01-02)") - shudhu tokhon-i
            // dekhano hoy jokhon currently-selected season-e 1-er beshi
            // episode-specific row thake. Admin nijer moto likhle seta
            // seasonBadges map-e save hoy, r blur/Enter korleই auto-save
            // hoy - kono value na dile (khali), auto-computed range-i
            // (placeholder-e dekhano) frontend-e byabohar hobe.
            const seasonBadgeInput = card.querySelector('.admin-watch-season-badge-input');
            seasonBadgeInput.addEventListener('blur', () => {
                const activeSeason = parseInt(seasonBadgeInput.getAttribute('data-active-season'), 10);
                if (Number.isNaN(activeSeason)) return;
                const badges = card._watchSeasonBadges || (card._watchSeasonBadges = {});
                const newVal = seasonBadgeInput.value.trim() || null;
                if ((badges[activeSeason] || null) === newVal) return;
                if (newVal) badges[activeSeason] = newVal; else delete badges[activeSeason];
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            });
            seasonBadgeInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                seasonBadgeInput.blur();
            });

            // "Season name" input - Episode-er moto-i, admin nijer kono
            // custom nam/text (jemon "সিজন ৫") diye Season dropdown/label-er
            // default "Season 5" ke override korte pare - blur/Enter korleই
            // seasonLabels map-e save hoy ar auto-save hoy.
            const seasonLabelInput = card.querySelector('.admin-watch-season-label-input');
            seasonLabelInput.addEventListener('blur', () => {
                const activeSeason = parseInt(seasonLabelInput.getAttribute('data-active-season'), 10);
                if (Number.isNaN(activeSeason)) return;
                const labels = card._watchSeasonLabels || (card._watchSeasonLabels = {});
                const newVal = seasonLabelInput.value.trim() || null;
                if ((labels[activeSeason] || null) === newVal) return;
                if (newVal) labels[activeSeason] = newVal; else delete labels[activeSeason];
                saveAdminWatchSettings(movie, card, saveBtn, () => watchOnState);
            });
            seasonLabelInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                seasonLabelInput.blur();
            });
        }

        container.appendChild(card);

        if (!movie.poster) {
            const imgEl = card.querySelector('.admin-db-thumb');
            fetchTmdbPosterQuick(movie).then(url => {
                if (!url || !imgEl || !imgEl.isConnected) return;
                imgEl.src = url;
                movie.poster = url;
                // Poster ta age theke na thaka-y shuru-te episode row-gular
                // "EP" preview-o placeholder-i dekhiyechilo (kono custom
                // Thumbnail link deya na thakle) - poster-ta ekhon aslo bole,
                // shei row-gular preview-o (r data-fallback-poster) refresh
                // kore neya hoy - global "Custom watch thumbnail" field-e
                // ageই kichu deya thakle shei-tai priority pabe, notun
                // poster-ta na.
                if (!isTv) return;
                const thumbInputEl = card.querySelector('.admin-watch-thumb-input');
                const fallback = (thumbInputEl && thumbInputEl.value.trim()) || url;
                card.querySelectorAll('.admin-season-watch-row').forEach(row => {
                    row.setAttribute('data-fallback-poster', fallback);
                    const rowThumbInput = row.querySelector('.admin-season-watch-thumb');
                    const previewImg = row.querySelector('.admin-episode-thumb-preview-img');
                    if (rowThumbInput && !rowThumbInput.value.trim() && previewImg) previewImg.src = fallback;
                });
            });
        }
    });
}

// Card-er bhitorer On/Off + custom link (movie-r khetre, ba TV series-er
// "Auto" mode-e, shingle link; TV series-er "Season" mode-e per-season link
// list) theke data niye Supabase-e save kore, thik saveAdminTrailerSettings()-er
// moto-i pattern - local allMovies cache-o shathe shathe update kore dey jate
// list/modal notun data-i dekhay.
async function saveAdminWatchSettings(movie, card, btn, getOnState) {
    if (!movie || !movie.id) return;
    const isTv = movie.tmdbType === 'tv';
    // TV series-e "Auto" checkbox uncheck kora thakleই shudhu Season mode
    // (per-season row) active dhora hoy - checked thakle (ba movie hole,
    // checkbox-i thake na) shingle link field-i active.
    const autoCheckbox = isTv ? card.querySelector('.admin-watch-auto-checkbox') : null;
    const useSeasonMode = isTv && autoCheckbox && !autoCheckbox.checked;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const watchEnabled = !!(getOnState && getOnState());
        const thumbRaw = card.querySelector('.admin-watch-thumb-input').value.trim() || null;

        let payload;
        let parsedWatchSeasonLinks = null;
        let linkRaw = null;
        if (useSeasonMode) {
            parsedWatchSeasonLinks = collectAdminWatchSeasonRows(card);
            payload = { watchEnabled, watchSeasonLinks: JSON.stringify(parsedWatchSeasonLinks), watchThumb: thumbRaw };
        } else {
            linkRaw = card.querySelector('.admin-watch-link-input').value.trim() || null;
            payload = { watchEnabled, watchLink: linkRaw, watchThumb: thumbRaw };
        }

        const { error } = await supabaseClient.from('movies').update(payload).eq('id', movie.id);
        if (error) throw error;

        movie.watchEnabled = watchEnabled;
        movie.watchThumb = thumbRaw;
        if (useSeasonMode) {
            movie.watchSeasonLinks = parsedWatchSeasonLinks;
        } else {
            movie.watchLink = linkRaw;
        }

        showToast('✅ Watch Button saved for "' + (movie.title || 'this item') + '"');
        btn.textContent = 'Saved';
    } catch (err) {
        console.error('Save watch settings error:', err);
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        // Explicit "Save" button-er bodole ekhon ekta chhoto status indicator
        // (jeta klik-e save hoy na, karon shob field-i blur/change-e nijeই
        // auto-save hoy) - tai save fail korleo eikhane "Retry" showing kore
        // kono lav nei (click-e kichu hobe na), tai just error-state dekhano
        // hoy, textContent "Save" na reverting kore.
        btn.textContent = '⚠️ Save failed';
    } finally {
        btn.disabled = false;
    }
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
    const bannerCatOptions = getAllKnownCategories();

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
                    <select class="admin-banner-category-select" title="Category badge shown on this banner slide">
                        <option value="">Auto (from movie's category)</option>
                        ${bannerCatOptions.map(cat => `<option value="${escapeAttr(cat)}" ${movie.featured_category === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
                    </select>
                    <input type="text" class="admin-banner-label-input" placeholder="Custom badge text (optional, e.g. Marvel)" value="${escapeAttr(movie.featured_category_label || '')}">
                    <input type="text" class="admin-banner-image-input" placeholder="Custom banner image URL (optional — overrides TMDB backdrop)" value="${movie.featured_image || ''}">
                </div>
            </div>
            <div class="admin-db-actions">
                <span class="admin-mini-btn admin-banner-save-btn admin-banner-autosave-status" aria-live="polite">Saved</span>
            </div>
        `;
        const cb = card.querySelector('.admin-banner-featured-cb');
        const imageInput = card.querySelector('.admin-banner-image-input');
        const catSelect = card.querySelector('.admin-banner-category-select');
        const labelInput = card.querySelector('.admin-banner-label-input');
        const statusBtn = card.querySelector('.admin-banner-autosave-status');

        const doAutoSave = () => {
            statusBtn.disabled = true;
            statusBtn.textContent = 'Saving...';
            saveBannerSettings(movie, {
                featured: cb.checked,
                featured_image: imageInput.value.trim() || null,
                featured_category: catSelect.value.trim() || null,
                featured_category_label: labelInput.value.trim() || null
            }, statusBtn);
        };
        // চেকবক্স/ক্যাটাগরি বদলালেই সাথে সাথে auto-save হবে
        cb.addEventListener('change', doAutoSave);
        catSelect.addEventListener('change', doAutoSave);
        // টাইপ করার সময় প্রতি keystroke-এ save না করে, থামার একটু পর (debounce) auto-save হবে
        const debouncedSave = debounce(doAutoSave, 800);
        imageInput.addEventListener('input', debouncedSave);
        labelInput.addEventListener('input', debouncedSave);
        // Save ব্যর্থ হলে স্ট্যাটাসে ক্লিক করে আবার try করা যাবে
        statusBtn.style.cursor = 'pointer';
        statusBtn.addEventListener('click', () => {
            if (statusBtn.textContent.includes('Retry')) doAutoSave();
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
async function saveBannerSettings(movie, changes, btn) {
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
                featured_image: changes.featured_image,
                featured_category: changes.featured_category,
                featured_category_label: changes.featured_category_label
            })
            .eq('id', movie.id);
        if (error) throw error;

        movie.featured = changes.featured;
        movie.featured_order = featuredOrder;
        movie.featured_image = changes.featured_image;
        movie.featured_category = changes.featured_category;
        movie.featured_category_label = changes.featured_category_label;

        // remove করার পর বাকিগুলোর নাম্বার gap ছাড়া 0,1,2... করে re-sequence করে দাও
        if (!changes.featured) {
            await resequenceBannerOrder();
        }

        const searchInput = document.getElementById('adminBannerSearchInput');
        renderAdminBannerList(searchInput ? searchInput.value.trim() : '');
        if (typeof renderHeroSlides === 'function') renderHeroSlides();
        if (btn) { btn.disabled = false; btn.textContent = 'Saved'; }
        showToast('✅ Banner settings saved for "' + (movie.title || 'this item') + '"');
    } catch (err) {
        console.error('Save banner settings error:', err);
        showToast('❌ Save failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
        if (btn) { btn.disabled = false; btn.textContent = '⚠️ Retry'; }
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
                <button type="button" class="custom-confirm-x-btn" aria-label="Close">×</button>
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
        overlay.querySelector('.custom-confirm-x-btn').addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        });

        requestAnimationFrame(() => overlay.classList.add('open'));
    });
}

// টেক্সট ইনপুট সহ প্রম্পট মডাল (যেমন category rename করার সময় ব্যবহার হয়)
function showPromptModal(message, defaultValue) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-confirm-overlay';
        overlay.innerHTML = `
            <div class="custom-confirm-box">
                <button type="button" class="custom-confirm-x-btn" aria-label="Close">×</button>
                <div class="custom-confirm-message">${message}</div>
                <input type="text" class="custom-confirm-prompt-input" value="${escapeAttr(defaultValue || '')}">
                <div class="custom-confirm-actions">
                    <button type="button" class="custom-confirm-cancel-btn">Cancel</button>
                    <button type="button" class="custom-confirm-ok-btn">Rename</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('.custom-confirm-prompt-input');

        const cleanup = (result) => {
            overlay.remove();
            resolve(result);
        };

        overlay.querySelector('.custom-confirm-ok-btn').addEventListener('click', () => cleanup(input.value));
        overlay.querySelector('.custom-confirm-cancel-btn').addEventListener('click', () => cleanup(null));
        overlay.querySelector('.custom-confirm-x-btn').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(null);
        });
        input.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') cleanup(input.value);
            if (e.key === 'Escape') cleanup(null);
        });

        requestAnimationFrame(() => {
            overlay.classList.add('open');
            input.focus();
            input.select();
        });
    });
}

// ছোট, নিজে থেকে মিলিয়ে যাওয়া টোস্ট নোটিফিকেশন — বড় centered modal-এর বদলে
// দ্রুত inline feedback দেয়ার জন্য (যেমন Banner Save করার পর)
// options: { actionLabel, onAction, duration } — actionLabel/onAction thakle toast-e ekta
// extra button (jemon "Undo") dekhabe, click korle onAction call hoye toast bondho hoye jabe.
function showToast(message, type, options) {
    options = options || {};
    let wrap = document.getElementById('toastWrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'toastWrap';
        wrap.className = 'toast-wrap';
        document.body.appendChild(wrap);
    }
    const toast = document.createElement('div');
    toast.className = 'toast-item' + (type === 'error' ? ' toast-error' : '');

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    let autoHideTimer;
    const dismiss = () => {
        clearTimeout(autoHideTimer);
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 500);
    };

    if (options.actionLabel && typeof options.onAction === 'function') {
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'toast-action-btn';
        actionBtn.textContent = options.actionLabel;
        actionBtn.addEventListener('click', () => {
            dismiss();
            options.onAction();
        });
        toast.appendChild(actionBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    toast.appendChild(closeBtn);

    wrap.appendChild(toast);

    closeBtn.addEventListener('click', dismiss);

    requestAnimationFrame(() => toast.classList.add('show'));

    autoHideTimer = setTimeout(dismiss, options.duration || 2500);
}

function showNoticeModal(message, options) {
    options = options || {};
    const confirmText = options.confirmText || 'OK';

    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'custom-confirm-overlay';
        overlay.innerHTML = `
            <div class="custom-confirm-box">
                <button type="button" class="custom-confirm-x-btn" aria-label="Close">×</button>
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
        overlay.querySelector('.custom-confirm-x-btn').addEventListener('click', cleanup);
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
