const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

if (!TMDB_API_KEY) console.log("⚠️ WARNING: TMDB_API_KEY is missing in Environment Variables!");

// --- MANIFEST (Tells Nuvio what this addon does) ---
const manifest = {
    id: "community.nuvio.discover.plus",
    version: "1.0.0",
    name: "Nuvio Discover+ (Real Data)",
    description: "Real TMDb data, seasons, episodes, universes, and similar options.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "trending_movies", name: "Trending Movies" },
        { type: "series", id: "trending_series", name: "Trending Series" }
    ],
    idPrefixes: ["tmdb:", "tt"],
    logo: "https://image.tmdb.org/t/p/w500/wwemwZzAB3Rd7JjC9uK2j71k7u9.jpg"
};

// --- HELPERS ---
const img = (path, size = "w500") => path ? `${IMG}/${size}${path}` : null;

const tmdbGet = async (url, params = {}) => {
    const res = await axios.get(`${TMDB}${url}`, { 
        params: { api_key: TMDB_API_KEY, ...params },
        timeout: 10000 // 10 second timeout to prevent Render/Vercel from crashing
    });
    return res.data;
};

// --- HOME ROUTE (Health check) ---
app.get('/', (req, res) => {
    res.send('🚀 Nuvio Discover+ Backend is alive! Use /manifest.json');
});

// --- MANIFEST ROUTE ---
app.get('/manifest.json', (req, res) => res.json(manifest));

// --- CATALOG ROUTE (Trending Rows) ---
app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!id.includes('trending')) return res.json({ metas: [] });

        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const data = await tmdbGet(`/trending/${tmdbType}/week`);
        
        const metas = data.results.map(item => ({
            id: `tmdb:${item.id}`,
            type: type,
            name: item.title || item.name,
            poster: img(item.poster_path),
            background: img(item.backdrop_path, "original"),
            description: item.overview,
            releaseInfo: (item.release_date || item.first_air_date || "").slice(0, 4),
            imdbRating: item.vote_average ? item.vote_average.toFixed(1) : null
        }));

        res.json({ metas });
    } catch (e) {
        console.error("Catalog Error:", e.message);
        res.json({ metas: [] });
    }
});

// --- META ROUTE (The Magic: Episodes, Cast, Universe, Similar) ---
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        let tmdbId = id;
        const tmdbType = type === 'series' ? 'tv' : 'movie';

        // 1. Resolve ID (Handle both tmdb:123 and tt12345)
        if (id.startsWith('tt')) {
            const findRes = await tmdbGet(`/find/${id}`, { external_source: 'imdb_id' });
            const result = tmdbType === 'tv' ? findRes.tv_results[0] : findRes.movie_results[0];
            if (!result) return res.json({ meta: {} });
            tmdbId = result.id;
        } else if (id.startsWith('tmdb:')) {
            tmdbId = id.replace('tmdb:', '');
        }

        // 2. Get Core Details + Cast + Trailers
        const details = await tmdbGet(`/${tmdbType}/${tmdbId}`, { append_to_response: "credits,videos" });
        
        let meta = {
            id: `tmdb:${tmdbId}`,
            type: type,
            name: details.title || details.name,
            poster: img(details.poster_path),
            background: img(details.backdrop_path, "original"),
            description: details.overview,
            releaseInfo: (details.release_date || details.first_air_date || "").slice(0, 4),
            imdbRating: details.vote_average ? details.vote_average.toFixed(1) : null,
            genres: (details.genres || []).map(g => g.name),
            cast: (details.credits.cast || []).slice(0, 8).map(c => c.name),
            trailers: (details.videos.results || []).filter(v => v.site === "YouTube").slice(0, 3).map(v => ({
                source: v.key,
                name: v.name,
                ytId: v.key
            }))
        };

        // 3. Get Episodes (If Series) - Fetches Season 1 by default
        if (type === 'series' && details.seasons) {
            const seasonData = await tmdbGet(`/tv/${tmdbId}/season/1`);
            meta.videos = (seasonData.episodes || []).map(ep => ({
                id: `tmdb:${tmdbId}:1:${ep.episode_number}`,
                title: `${ep.episode_number}. ${ep.name}`,
                season: 1,
                episode: ep.episode_number,
                thumbnail: img(ep.still_path, "w300"),
                overview: ep.overview
            }));
        }

        // 4. Get "Universe" / Spin-offs (Search TMDb by the show's name)
        const searchQuery = (details.name || details.title).split(':')[0]; 
        const searchRes = await tmdbGet(`/search/${tmdbType}`, { query: searchQuery });
        
        meta.universe = (searchRes.results || [])
            .filter(r => r.id !== parseInt(tmdbId)) // Remove the current show from its own universe
            .slice(0, 10)
            .map(r => ({
                id: `tmdb:${r.id}`,
                type: type,
                name: r.title || r.name,
                poster: img(r.poster_path),
                description: "Spin-off / Related"
            }));

        // 5. Get Similar / Discover+ Recommendations
        const recs = await tmdbGet(`/${tmdbType}/${tmdbId}/recommendations`);
        meta.similar = (recs.results || []).slice(0, 10).map(r => ({
            id: `tmdb:${r.id}`,
            type: type,
            name: r.title || r.name,
            poster: img(r.poster_path)
        }));

        res.json({ meta });
    } catch (e) {
        console.error("Meta Error:", e.message);
        res.json({ meta: {} });
    }
});

app.listen(PORT, () => console.log(`🚀 Nuvio Discover+ running on port ${PORT}`));
