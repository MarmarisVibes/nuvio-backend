const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const DB_KEY = "nuvio_discover_db_v1";

/* ================= PERSISTENT DB (Upstash Redis) ================= */

function emptyDB() {
  return { users: {}, codes: {}, events: [], favorites: [] };
}

let memFallback = null;

async function loadDB() {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const r = await axios.post(REDIS_URL, ["GET", DB_KEY], {
        headers: { Authorization: "Bearer " + REDIS_TOKEN },
        timeout: 10000
      });
      if (r.data && r.data.result) return JSON.parse(r.data.result);
    } catch (e) {
      console.error("DB load error:", e.message);
    }
    return emptyDB();
  }
  return memFallback || emptyDB();
}

async function saveDB(db) {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await axios.post(REDIS_URL, ["SET", DB_KEY, JSON.stringify(db)], {
        headers: { Authorization: "Bearer " + REDIS_TOKEN },
        timeout: 10000
      });
      return;
    } catch (e) {
      console.error("DB save error:", e.message);
    }
  }
  memFallback = db;
}

/* ================= TMDB HELPERS ================= */

const cache = new Map();

async function tmdbGet(path, params = {}) {
  const key = path + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;

  const res = await axios.get(TMDB + path, {
    params: Object.assign({ api_key: TMDB_API_KEY }, params),
    timeout: 10000
  });

  cache.set(key, { data: res.data, expires: Date.now() + 30 * 60 * 1000 });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return res.data;
}

const img = (path, size = "w500") => path ? IMG + "/" + size + path : null;

function mapMovie(m, extra) {
  return Object.assign({
    id: "tmdb:" + m.id,
    type: "movie",
    name: m.title || m.name || "Unknown",
    poster: img(m.poster_path),
    background: img(m.backdrop_path, "original"),
    description: m.overview || "",
    releaseInfo: (m.release_date || "").slice(0, 4),
    imdbRating: m.vote_average ? Number(m.vote_average).toFixed(1) : undefined
  }, extra || {});
}

function mapTv(m, extra) {
  return Object.assign({
    id: "tmdb:" + m.id,
    type: "series",
    name: m.name || m.title || "Unknown",
    poster: img(m.poster_path),
    background: img(m.backdrop_path, "original"),
    description: m.overview || "",
    releaseInfo: (m.first_air_date || "").slice(0, 4),
    imdbRating: m.vote_average ? Number(m.vote_average).toFixed(1) : undefined
  }, extra || {});
}

function mapItem(type, item, extra) {
  return type === "movie" ? mapMovie(item, extra) : mapTv(item, extra);
}

async function resolveId(type, id) {
  if (!id) return null;
  if (id.startsWith("tmdb:")) return { type: type, tmdbId: Number(id.split(":")[1]) };
  if (id.startsWith("tt")) {
    try {
      const d = await tmdbGet("/find/" + id, { external_source: "imdb_id" });
      const movie = d.movie_results && d.movie_results[0];
      const tv = d.tv_results && d.tv_results[0];
      if (movie) return { type: "movie", tmdbId: movie.id };
      if (tv) return { type: "series", tmdbId: tv.id };
    } catch (e) { return null; }
  }
  if (!isNaN(Number(id))) return { type: type, tmdbId: Number(id) };
  return null;
}

async function getTmdbItem(type, tmdbId) {
  const t = type === "series" ? "tv" : "movie";
  return tmdbGet("/" + t + "/" + tmdbId, {});
}

function refsFromItems(items, limit) {
  const map = new Map();
  for (const it of items) {
    if (!it || !it.type || !it.tmdbId) continue;
    const key = it.type + ":" + it.tmdbId;
    if (!map.has(key)) {
      map.set(key, {
        type: it.type,
        tmdbId: Number(it.tmdbId),
        progress: it.progress === undefined ? 100 : it.progress,
        at: it.at || Date.now(),
        friends: it.friends || null
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.at - a.at)
    .slice(0, limit || 25);
}

async function metasFromRefs(refs, limit, decorator) {
  const out = [];
  for (const ref of refs.slice(0, limit || 20)) {
    try {
      const item = await getTmdbItem(ref.type, ref.tmdbId);
      const meta = mapItem(ref.type, item);
      if (decorator) decorator(meta, ref);
      out.push(meta);
    } catch (e) { /* skip broken item */ }
  }
  return out;
}

function progressDecorator(meta, ref) {
  if (typeof ref.progress === "number" && ref.progress < 100) {
    meta.description = ref.progress + "% watched • " + meta.description;
  }
}

async function getTrendingMetas(type, limit) {
  const t = type === "series" ? "tv" : "movie";
  const d = await tmdbGet("/trending/" + t + "/week", {});
  return (d.results || []).slice(0, limit || 20).map(i => mapItem(type, i));
}

async function getRecommendationMetas(refs, limit, fallbackType) {
  if (!refs.length) return getTrendingMetas(fallbackType, limit);
  const scores = new Map();
  for (const ref of refs.slice(0, 6)) {
    const t = ref.type === "series" ? "tv" : "movie";
    try {
      const d = await tmdbGet("/" + t + "/" + ref.tmdbId + "/recommendations", { page: 1 });
      for (const item of (d.results || []).slice(0, 12)) {
        const key = ref.type + ":" + item.id;
        if (!scores.has(key)) scores.set(key, { type: ref.type, item: item, score: 0 });
        scores.get(key).score += 1 + (item.vote_average || 0) / 2;
      }
    } catch (e) { /* skip */ }
  }
  const recs = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 18)
    .map(x => mapItem(x.type, x.item));
  if (!recs.length) return getTrendingMetas(fallbackType, limit);
  return recs;
}

function getUserActivityRefs(db, token, type) {
  const events = db.events.filter(e => e.token === token && (!type || e.type === type));
  const favs = db.favorites.filter(f => f.token === token && (!type || f.type === type));
  return refsFromItems(favs.concat(events));
}

function getFriendTokens(db, token) {
  const u = db.users[token];
  return u ? (u.friends || []) : [];
}

function getFriendActivityRefs(db, token, type) {
  const ft = getFriendTokens(db, token);
  const events = db.events.filter(e => ft.includes(e.token) && (!type || e.type === type));
  const favs = db.favorites.filter(f => ft.includes(f.token) && (!type || f.type === type));
  return refsFromItems(favs.concat(events));
}

async function getFriendsWatchingMetas(db, token, type) {
  const ft = getFriendTokens(db, token);
  const grouped = new Map();
  for (const e of db.events) {
    if (!ft.includes(e.token) || e.type !== type) continue;
    const key = e.type + ":" + e.tmdbId;
    if (!grouped.has(key)) {
      grouped.set(key, { type: e.type, tmdbId: e.tmdbId, progress: e.progress || 100, at: e.at || Date.now(), friends: new Set() });
    }
    const g = grouped.get(key);
    g.friends.add((db.users[e.token] && db.users[e.token].name) || "Friend");
    if (e.at > g.at) g.at = e.at;
  }
  const refs = Array.from(grouped.values()).sort((a, b) => b.at - a.at).slice(0, 20);
  return metasFromRefs(refs, 20, (meta, ref) => {
    const names = Array.from(ref.friends).slice(0, 3).join(", ");
    meta.description = "Friends watching: " + names + " • " + meta.description;
  });
}

/* ================= MANIFEST ================= */

function makeManifest(db, token, root) {
  const u = token ? db.users[token] : null;
  const catalogs = [];

  if (u) {
    catalogs.push(
      { type: "movie", id: "movie_continue", name: "▶️ Continue Watching" },
      { type: "series", id: "series_continue", name: "▶️ Continue Watching" },
      { type: "movie", id: "movie_recent", name: "🕘 Recently Watched" },
      { type: "series", id: "series_recent", name: "🕘 Recently Watched" },
      { type: "movie", id: "movie_favorites", name: "❤️ Your Favorites" },
      { type: "series", id: "series_favorites", name: "❤️ Your Favorites" },
      { type: "movie", id: "movie_for_you", name: "✨ Because You Watched" },
      { type: "series", id: "series_for_you", name: "✨ Because You Watched" },
      { type: "movie", id: "movie_friends_watching", name: "👥 Friends Watching" },
      { type: "series", id: "series_friends_watching", name: "👥 Friends Watching" },
      { type: "movie", id: "movie_friends_recs", name: "🎁 Friends Recommendations" },
      { type: "series", id: "series_friends_recs", name: "🎁 Friends Recommendations" }
    );
  }

  catalogs.push(
    { type: "movie", id: "trending_movies", name: "🔥 Trending Now" },
    { type: "series", id: "trending_series", name: "🔥 Trending Now" }
  );

  return {
    id: u ? "nuvio_discover_" + u.token.slice(0, 10) : "nuvio_discover_public",
    version: "1.1.0",
    name: u ? "Nuvio Discover+ • " + u.name : "Nuvio Discover+",
    description: "Personal library, friends sync, universes, episodes and similar options.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:", "tt"],
    catalogs: catalogs,
    logo: "https://image.tmdb.org/t/p/w500/wwemwZzAB3Rd7JjC9uK2j71k7u9.jpg",
    behaviorHints: { configurable: true },
    links: [
      { label: "Open Dashboard", url: u ? root + "/dashboard/" + u.token : root + "/setup" }
    ]
  };
}

/* ================= PAGES ================= */

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return proto + "://" + host;
}

app.get("/", (req, res) => {
  res.send('<h2>Nuvio Discover+ Backend v1.1</h2><p><a href="/setup">Create Profile</a></p>');
});

app.get("/configure", (req, res) => res.redirect("/setup"));
app.get("/u/:token/configure", (req, res) => res.redirect("/dashboard/" + req.params.token));

app.get("/setup", (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nuvio Discover+ Setup</title>
<style>body{background:#0b0b0f;color:#fff;font-family:sans-serif;padding:24px}
.card{background:#181820;border-radius:16px;padding:20px;max-width:480px;margin:0 auto}
input,button{width:100%;padding:14px;margin:8px 0;border-radius:10px;border:1px solid #333;background:#0f0f15;color:#fff;font-size:16px}
button{background:#8a5cf6;border:0;font-weight:700}
.code{background:#000;border:1px dashed #8a5cf6;border-radius:12px;padding:14px;text-align:center;font-size:24px;letter-spacing:3px;color:#8a5cf6;margin:12px 0}
a{color:#8a5cf6}</style></head><body>
<div class="card"><h2>Nuvio Discover+</h2>
<p style="color:#a0a0b0;font-size:13px">Create your profile to unlock favorites, watched history and friend sync.</p>
<input id="name" placeholder="Your name">
<button onclick="register()">Create Profile</button>
<div id="result"></div></div>
<script>
async function register(){
  var name=document.getElementById('name').value||'Profile';
  var r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});
  var d=await r.json();
  if(!d.ok){document.getElementById('result').innerText=d.error||'Error';return;}
  document.getElementById('result').innerHTML=
   '<p><strong>Your Friend Code:</strong></p><div class="code">'+d.code+'</div>'+
   '<p><strong>Add this URL in Nuvio:</strong></p><input readonly value="'+d.addonUrl+'">'+
   '<p><a href="'+d.dashboardUrl+'">Open Dashboard</a></p>';
}
</script></body></html>`);
});

app.get("/dashboard/:token", (req, res) => {
  const token = req.params.token;
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nuvio Dashboard</title>
<style>body{background:#0b0b0f;color:#fff;font-family:sans-serif;padding:16px}
.card{background:#181820;border-radius:14px;padding:16px;margin-bottom:14px}
input,select,button{width:100%;padding:12px;margin:6px 0;border-radius:10px;border:1px solid #333;background:#0f0f15;color:#fff;font-size:15px}
button{background:#8a5cf6;border:0;font-weight:700}
.row2{display:flex;gap:8px}.row2>*{flex:1}
li{margin:6px 0;font-size:13px;color:#d5d5e0}
.muted{color:#a0a0b0;font-size:12px}
.code{background:#000;border:1px dashed #8a5cf6;border-radius:10px;padding:10px;text-align:center;font-size:20px;letter-spacing:3px;color:#8a5cf6}</style></head><body>
<div class="card"><h2>Dashboard</h2>
<div class="muted" id="pname"></div>
<div class="code" id="pcode"></div>
<input readonly id="addonUrl">
<div class="muted">Long-press the URL above to copy it into Nuvio (replaces your old addon URL).</div></div>
<div class="card"><h3>Connect Friend</h3>
<div class="row2"><input id="fcode" placeholder="Friend code"><button onclick="addFriend()">Add</button></div>
<ul id="friends"></ul></div>
<div class="card"><h3>Add To Library</h3>
<select id="ctype"><option value="movie">Movie</option><option value="series">Series</option></select>
<input id="cid" placeholder="TMDb ID (e.g. 1396 / 27205)">
<input id="cprog" placeholder="Progress % (default 100)" value="100">
<div class="row2"><button onclick="addFav()">❤️ Favorite</button><button onclick="addWatched()">▶️ Watched</button></div>
<ul id="favlist"></ul><ul id="evlist"></ul></div>
<script>
var token=${JSON.stringify(token)};
function esc(s){return String(s===null||s===undefined?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
async function api(url,body){var r=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();}
async function load(){
  var d=await api('/api/state/'+token);
  if(!d.ok){document.body.innerHTML='<p>Profile not found. Open /setup to create one.</p>';return;}
  document.getElementById('pname').innerText='Profile: '+d.user.name;
  document.getElementById('pcode').innerText=d.user.code;
  document.getElementById('addonUrl').value=d.addonUrl;
  var f='';for(var i=0;i<d.friends.length;i++){f+='<li>👥 '+esc(d.friends[i].name)+' ('+esc(d.friends[i].code)+')</li>';}
  document.getElementById('friends').innerHTML=f||'<li class="muted">No friends yet</li>';
  var fv='';for(var j=0;j<d.favorites.length;j++){fv+='<li>❤️ '+esc(d.favorites[j].type)+' #'+esc(d.favorites[j].tmdbId)+'</li>';}
  document.getElementById('favlist').innerHTML=fv||'<li class="muted">No favorites</li>';
  var ev='';for(var k=0;k<d.events.length;k++){ev+='<li>▶️ '+esc(d.events[k].type)+' #'+esc(d.events[k].tmdbId)+' - '+esc(d.events[k].progress)+'%</li>';}
  document.getElementById('evlist').innerHTML=ev||'<li class="muted">Nothing watched</li>';
}
async function addFriend(){
  var code=document.getElementById('fcode').value.trim().toUpperCase();
  var r=await api('/api/friend/add',{token:token,friendCode:code});
  alert(r.ok?'Connected!':r.error);load();
}
async function addFav(){
  var r=await api('/api/favorite',{token:token,type:document.getElementById('ctype').value,tmdbId:Number(document.getElementById('cid').value)});
  alert(r.ok?(r.favorited?'Added to favorites':'Removed from favorites'):r.error);load();
}
async function addWatched(){
  var r=await api('/api/watched',{token:token,type:document.getElementById('ctype').value,tmdbId:Number(document.getElementById('cid').value),progress:Number(document.getElementById('cprog').value||100)});
  alert(r.ok?'Watched saved':r.error);load();
}
load();
</script></body></html>`);
});

/* ================= API ================= */

app.post("/api/register", async (req, res) => {
  const db = await loadDB();
  const name = String(req.body.name || "Profile").trim();
  const token = crypto.randomBytes(16).toString("hex");
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (db.codes[code]);
  db.users[token] = { token: token, name: name, code: code, friends: [], createdAt: Date.now() };
  db.codes[code] = token;
  await saveDB(db);
  res.json({
    ok: true, token: token, code: code,
    addonUrl: baseUrl(req) + "/u/" + token + "/manifest.json",
    dashboardUrl: baseUrl(req) + "/dashboard/" + token
  });
});

app.get("/api/state/:token", async (req, res) => {
  const db = await loadDB();
  const u = db.users[req.params.token];
  if (!u) return res.status(404).json({ error: "Profile not found" });
  res.json({
    ok: true,
    user: { name: u.name, code: u.code },
    friends: (u.friends || []).map(t => db.users[t]).filter(Boolean).map(f => ({ name: f.name, code: f.code })),
    events: db.events.filter(e => e.token === u.token).sort((a, b) => b.at - a.at).slice(0, 30),
    favorites: db.favorites.filter(f => f.token === u.token).slice(0, 30),
    addonUrl: baseUrl(req) + "/u/" + u.token + "/manifest.json",
    dashboardUrl: baseUrl(req) + "/dashboard/" + u.token
  });
});

app.post("/api/friend/add", async (req, res) => {
  const db = await loadDB();
  const u = db.users[req.body.token];
  if (!u) return res.status(404).json({ error: "Profile not found" });
  const code = String(req.body.friendCode || "").trim().toUpperCase();
  const ft = db.codes[code];
  if (!ft) return res.status(404).json({ error: "Friend code not found" });
  if (ft === u.token) return res.status(400).json({ error: "Cannot add yourself" });
  const friend = db.users[ft];
  if (!u.friends.includes(ft)) u.friends.push(ft);
  if (!friend.friends.includes(u.token)) friend.friends.push(u.token);
  await saveDB(db);
  res.json({ ok: true, message: "Connected with " + friend.name });
});

app.post("/api/watched", async (req, res) => {
  const db = await loadDB();
  const { token, type, tmdbId, progress, season, episode } = req.body;
  if (!db.users[token]) return res.status(404).json({ error: "Profile not found" });
  if (!["movie", "series"].includes(type)) return res.status(400).json({ error: "type must be movie or series" });
  if (!tmdbId || isNaN(Number(tmdbId))) return res.status(400).json({ error: "tmdbId must be a number" });
  db.events.push({
    id: crypto.randomUUID(), token: token, type: type, tmdbId: Number(tmdbId),
    progress: Math.max(0, Math.min(100, Number(progress === undefined ? 100 : progress))),
    season: season || null, episode: episode || null, at: Date.now()
  });
  await saveDB(db);
  res.json({ ok: true });
});

app.post("/api/favorite", async (req, res) => {
  const db = await loadDB();
  const { token, type, tmdbId } = req.body;
  if (!db.users[token]) return res.status(404).json({ error: "Profile not found" });
  if (!["movie", "series"].includes(type)) return res.status(400).json({ error: "type must be movie or series" });
  if (!tmdbId || isNaN(Number(tmdbId))) return res.status(400).json({ error: "tmdbId must be a number" });
  const idx = db.favorites.findIndex(f => f.token === token && f.type === type && Number(f.tmdbId) === Number(tmdbId));
  let favorited;
  if (idx >= 0) { db.favorites.splice(idx, 1); favorited = false; }
  else { db.favorites.push({ token: token, type: type, tmdbId: Number(tmdbId), at: Date.now() }); favorited = true; }
  await saveDB(db);
  res.json({ ok: true, favorited: favorited });
});

/* ================= STREMIO / NUVIO ROUTES ================= */

app.get(["/manifest.json", "/u/:token/manifest.json"], async (req, res) => {
  const db = await loadDB();
  res.json(makeManifest(db, req.params.token || null, baseUrl(req)));
});

app.get(["/catalog/:type/:id.json", "/u/:token/catalog/:type/:id.json"], async (req, res) => {
  try {
    const db = await loadDB();
    const token = req.params.token || null;
    const { type, id } = req.params;
    const u = token ? db.users[token] : null;
    let metas = [];

    if (id === "trending_movies" && type === "movie") metas = await getTrendingMetas("movie", 20);
    if (id === "trending_series" && type === "series") metas = await getTrendingMetas("series", 20);

    if (u) {
      if (id === "movie_continue" && type === "movie") {
        let refs = refsFromItems(db.events.filter(e => e.token === token && e.type === "movie" && e.progress < 100));
        if (!refs.length) refs = refsFromItems(db.events.filter(e => e.token === token && e.type === "movie"));
        metas = await metasFromRefs(refs, 20, progressDecorator);
      }
      if (id === "series_continue" && type === "series") {
        let refs = refsFromItems(db.events.filter(e => e.token === token && e.type === "series" && e.progress < 100));
        if (!refs.length) refs = refsFromItems(db.events.filter(e => e.token === token && e.type === "series"));
        metas = await metasFromRefs(refs, 20, progressDecorator);
      }
      if (id === "movie_recent" && type === "movie")
        metas = await metasFromRefs(refsFromItems(db.events.filter(e => e.token === token && e.type === "movie")), 20, progressDecorator);
      if (id === "series_recent" && type === "series")
        metas = await metasFromRefs(refsFromItems(db.events.filter(e => e.token === token && e.type === "series")), 20, progressDecorator);
      if (id === "movie_favorites" && type === "movie")
        metas = await metasFromRefs(refsFromItems(db.favorites.filter(f => f.token === token && f.type === "movie")), 20);
      if (id === "series_favorites" && type === "series")
        metas = await metasFromRefs(refsFromItems(db.favorites.filter(f => f.token === token && f.type === "series")), 20);
      if (id === "movie_for_you" && type === "movie")
        metas = await getRecommendationMetas(getUserActivityRefs(db, token, "movie"), 18, "movie");
      if (id === "series_for_you" && type === "series")
        metas = await getRecommendationMetas(getUserActivityRefs(db, token, "series"), 18, "series");
      if (id === "movie_friends_watching" && type === "movie") metas = await getFriendsWatchingMetas(db, token, "movie");
      if (id === "series_friends_watching" && type === "series") metas = await getFriendsWatchingMetas(db, token, "series");
      if (id === "movie_friends_recs" && type === "movie")
        metas = await getRecommendationMetas(getFriendActivityRefs(db, token, "movie"), 18, "movie");
      if (id === "movie_friends_recs" && type === "series")
        metas = await getRecommendationMetas(getFriendActivityRefs(db, token, "series"), 18, "series");
    }

    if (!metas.length) metas = await getTrendingMetas(type, 10);
    res.json({ metas: metas });
  } catch (e) {
    console.error("Catalog error:", e.message);
    res.json({ metas: [] });
  }
});

app.get(["/meta/:type/:id.json", "/u/:token/meta/:type/:id.json"], async (req, res) => {
  try {
    const { type, id } = req.params;
    const resolved = await resolveId(type, id);
    if (!resolved) return res.json({ meta: {} });
    const tmdbType = resolved.type === "series" ? "tv" : "movie";

    const details = await tmdbGet("/" + tmdbType + "/" + resolved.tmdbId, { append_to_response: "credits,videos" });
    let meta = mapItem(resolved.type, details);
    meta.genres = (details.genres || []).map(g => g.name);
    meta.cast = (details.credits && details.credits.cast || []).slice(0, 8).map(c => c.name);
    meta.trailers = (details.videos && details.videos.results || [])
      .filter(v => v.site === "YouTube").slice(0, 3)
      .map(v => ({ source: v.key, name: v.name, ytId: v.key }));

    if (resolved.type === "series" && details.seasons) {
      try {
        const seasonData = await tmdbGet("/tv/" + resolved.tmdbId + "/season/1", {});
        meta.videos = (seasonData.episodes || []).map(ep => ({
          id: "tmdb:" + resolved.tmdbId + ":1:" + ep.episode_number,
          title: ep.episode_number + ". " + ep.name,
          season: 1, episode: ep.episode_number,
          thumbnail: img(ep.still_path, "w300"),
          overview: ep.overview || ""
        }));
      } catch (e) { meta.videos = []; }

      const searchQuery = (details.name || "").split(":")[0];
      try {
        const sr = await tmdbGet("/search/tv", { query: searchQuery });
        meta.universe = (sr.results || []).filter(r => r.id !== resolved.tmdbId).slice(0, 10)
          .map(r => mapTv(r, { description: "Spin-off / Related" }));
      } catch (e) { meta.universe = []; }
    }

    try {
      const recs = await tmdbGet("/" + tmdbType + "/" + resolved.tmdbId + "/recommendations", { page: 1 });
      meta.similar = (recs.results || []).slice(0, 10).map(r => mapItem(resolved.type, r));
    } catch (e) { meta.similar = []; }

    res.json({ meta: meta });
  } catch (e) {
    console.error("Meta error:", e.message);
    res.json({ meta: {} });
  }
});

app.listen(PORT, () => console.log("🚀 Nuvio Discover+ v1.1 running on port " + PORT));
