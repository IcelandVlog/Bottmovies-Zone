#!/usr/bin/env node
/*
 * IMDb public dataset theke "Most Popular" ar "Top Rated" list banay ar TMDB id-r sathe match kore
 * imdb-lists.json lekhe (project root-e). Site ei file-ti pore Browse "Sort by" option-e use kore.
 *
 * Use:
 *   node scripts/build-imdb-lists.js            (default: ./IMDB folder)
 *   node scripts/build-imdb-lists.js "D:\path\to\IMDB"
 *
 * Folder-e thakte hobe (IMDb dataset file-gulo, gz obosthay):
 *   title.basics.tsv.gz   (naam, type, year)
 *   title.ratings.tsv.gz  (rating, vote)
 *   episode.tsv.gz        (optional - ongoing series-er season/episode count)
 *
 * Node 18+ lagbe. Kono npm package lagbe na.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'IMDB');
const OUT = path.join(ROOT, 'imdb-lists.json');

const LIST_SIZE = 500;        // proti list-e koto item
const MIN_VOTES_POP = 10000;  // ei-er kom vote-er content bad
const MIN_VOTES_TOP = 25000;  // Top Rated-er jonno minimum vote (ektu bhalo rating-er onno filter)

// TMDB key ar base URL script.js theke neya hoy (already frontend-e public)
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const TMDB_KEY = (scriptSrc.match(/TMDB_API_KEY\s*=\s*["']([^"']+)["']/) || [])[1];
const TMDB_BASE = (scriptSrc.match(/TMDB_BASE_URL\s*=\s*["']([^"']+)["']/) || [])[1] || 'https://api.themoviedb.org/3';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NULL = '\\N';

function findFile(prefix) {
    if (!fs.existsSync(DIR)) throw new Error('Folder paoa jay ni: ' + DIR);
    const name = fs.readdirSync(DIR).find(n => n.toLowerCase().startsWith(prefix));
    if (!name) throw new Error(prefix + '*.tsv.gz file paoa jay ni folder-e: ' + DIR);
    return path.join(DIR, name);
}

// gz TSV file stream kore line-by-line porhe, prothom line header
async function readTsv(file, onRow) {
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let header = null;
    let count = 0;
    for await (const line of rl) {
        if (!line) continue;
        if (!header) { header = line.split('\t'); continue; }
        const cols = line.split('\t');
        const row = {};
        for (let i = 0; i < header.length; i++) row[header[i]] = cols[i];
        onRow(row);
        count++;
    }
    return count;
}

async function tmdbFind(imdbId) {
    try {
        const res = await fetch(`${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`);
        if (!res.ok) return null;
        const d = await res.json();
        const movieHit = (d.movie_results || [])[0];
        const tvHit = (d.tv_results || [])[0];
        if (movieHit) return { tmdbId: movieHit.id, type: 'movie', poster_path: movieHit.poster_path || null, backdrop_path: movieHit.backdrop_path || null };
        if (tvHit) return { tmdbId: tvHit.id, type: 'tv', poster_path: tvHit.poster_path || null, backdrop_path: tvHit.backdrop_path || null };
        return null;
    } catch (e) {
        return null;
    }
}

(async () => {
    if (!TMDB_KEY) throw new Error('script.js theke TMDB_API_KEY paoa jay ni');
    console.log('Folder:', DIR);

    // 1) Ratings - vote beshi ekhon-i rakhi
    const ratingsFile = findFile('title.ratings');
    const ratings = new Map();
    console.log('Reading ratings...');
    await readTsv(ratingsFile, r => {
        const votes = Number(r.numVotes);
        if (votes >= MIN_VOTES_POP) ratings.set(r.tconst, { rating: Number(r.averageRating), votes });
    });
    console.log('Titles with enough votes:', ratings.size);

    // 2) Basics - movie / series, adult bad
    const basicsFile = findFile('title.basics');
    const items = [];
    console.log('Reading basics...');
    await readTsv(basicsFile, b => {
        const rt = ratings.get(b.tconst);
        if (!rt) return;
        if (b.isAdult === '1') return;
        if (!['movie', 'tvSeries', 'tvMiniSeries'].includes(b.titleType)) return;
        items.push({
            imdbId: b.tconst,
            type: b.titleType === 'movie' ? 'movie' : 'tv',
            title: b.primaryTitle,
            year: b.startYear && b.startYear !== NULL ? b.startYear : '',
            rating: rt.rating,
            votes: rt.votes
        });
    });

    const topRated = items
        .filter(x => x.votes >= MIN_VOTES_TOP)
        .sort((a, b) => (b.rating - a.rating) || (b.votes - a.votes))
        .slice(0, LIST_SIZE * 2);
    const mostPopular = [...items]
        .sort((a, b) => b.votes - a.votes)
        .slice(0, LIST_SIZE * 2);

    // 3) TMDB id match (shob list-er jonno, ek-bar)
    const unique = new Map();
    [...topRated, ...mostPopular].forEach(x => unique.set(x.imdbId, x));
    console.log('Matching', unique.size, 'titles to TMDB...');
    let n = 0;
    for (const x of unique.values()) {
        const m = await tmdbFind(x.imdbId);
        if (m) Object.assign(x, m);
        n++;
        if (n % 50 === 0) console.log('  ', n, '/', unique.size);
        await sleep(120); // TMDB rate limit-er jonno choto gap
    }

    // 4) Episode file (optional) - series-er latest season ar tar episode count (ongoing hint)
    const episodeFile = (() => { try { return findFile('episode'); } catch (e) { return null; } })();
    if (episodeFile) {
        const tvIds = new Map();
        unique.forEach(x => { if (x.type === 'tv') tvIds.set(x.imdbId, new Map()); });
        console.log('Reading episodes for', tvIds.size, 'series...');
        await readTsv(episodeFile, e => {
            const seasons = tvIds.get(e.parentTconst);
            if (!seasons) return;
            const s = Number(e.seasonNumber);
            if (!Number.isFinite(s)) return;
            seasons.set(s, (seasons.get(s) || 0) + 1);
        });
        unique.forEach(x => {
            const seasons = tvIds.get(x.imdbId);
            if (!seasons || !seasons.size) return;
            const latest = Math.max(...seasons.keys());
            x.latestSeason = latest;
            x.latestSeasonEpisodes = seasons.get(latest);
        });
    } else {
        console.log('episode.tsv.gz paoa jay ni - ongoing hint skip kora holo.');
    }

    const keep = arr => arr.filter(x => x.tmdbId && x.poster_path).slice(0, LIST_SIZE);
    const out = {
        generatedAt: new Date().toISOString(),
        source: 'IMDb public datasets (title.basics, title.ratings' + (episodeFile ? ', episode' : '') + ') matched to TMDB ids',
        topRated: keep(topRated),
        mostPopular: keep(mostPopular)
    };
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log('Done. topRated:', out.topRated.length, 'mostPopular:', out.mostPopular.length);
    console.log('Written:', OUT);
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
