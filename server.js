const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

// === CORS — autorise les appels depuis n'importe quel domaine (Netlify, iPad, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 10000;

function clean(txt = "") {
  return String(txt).replace(/\s+/g, " ").trim();
}

function parseArrivalFromBody(bodyText) {
  const text = clean(bodyText);
  const patterns = [
    /Arrivée officielle\s*:?[\s-]*([0-9\s\-–—]+)/i,
    /Arrivee officielle\s*:?[\s-]*([0-9\s\-–—]+)/i,
    /Arrivée\s*:?[\s-]*([0-9\s\-–—]+)/i,
    /Arrivee\s*:?[\s-]*([0-9\s\-–—]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return clean(m[1].replace(/[–—]/g, "-"));
  }
  return "";
}

function parseCourseMetaFromUrl(url) {
  const m = url.match(/\/(\d{4}-\d{2}-\d{2})\/(R\d+)C(\d+)-([^/]+)$/i);
  if (!m) return {};
  return {
    dateUrl: m[1],
    reunion: m[2].toUpperCase(),
    course: "C" + m[3],
    slug: m[4]
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "fr-FR,fr;q=0.9"
    },
    timeout: 15000
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " sur " + url);
  return await res.text();
}

async function parseOneCourse(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const bodyText = clean($("body").text());
  const meta = parseCourseMetaFromUrl(url);

  let hippodrome = "", nom_course = "", heure = "", distance = "", allocation = "", partants = "", arrivee_officielle = "";

  const h1 = clean($("h1").first().text());
  if (h1) nom_course = h1;

  const hourMatch = bodyText.match(/\b(\d{1,2}h\d{2})\b/);
  if (hourMatch) heure = hourMatch[1];

  const distMatch = bodyText.match(/\b(\d{3,4}m)\b/i);
  if (distMatch) distance = distMatch[1];

  const allocMatch = bodyText.match(/(\d[\d\s]*€)/);
  if (allocMatch) allocation = clean(allocMatch[1]);

  const partMatch = bodyText.match(/(\d+)\s+Partants/i) || bodyText.match(/Partants\s*:?\s*(\d+)/i);
  if (partMatch) partants = partMatch[1];

  arrivee_officielle = parseArrivalFromBody(bodyText);

  if (meta.slug) {
    const slugParts = meta.slug.split("-");
    if (slugParts.length > 1) hippodrome = slugParts[0].toUpperCase();
  }

  return {
    status: "ok", url,
    reunion: meta.reunion || "", course: meta.course || "",
    hippodrome, date: meta.dateUrl || "",
    heure, nom_course, distance, allocation, partants, arrivee_officielle
  };
}

function absoluteUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return "https://www.zeturf.fr" + href;
  return "https://www.zeturf.fr/" + href;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const k = keyFn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function findCoursesOfDay(dateStr) {
  const dayUrl = `https://www.zeturf.fr/fr/course-du-jour/${dateStr}`;
  const html = await fetchHtml(dayUrl);
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = absoluteUrl(href);
    if (abs.includes(`/fr/course-du-jour/${dateStr}/`) && /\/R\d+C\d+-/i.test(abs)) {
      links.push(abs);
    }
  });
  return uniqBy(links, x => x).sort();
}

// === Endpoint racine pour réveiller Render (ping)
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString() });
});

// === Endpoint ping léger pour pré-réveiller le serveur sans appel lourd
app.get("/ping", (req, res) => {
  res.json({ status: "ok", awake: true });
});

app.get("/zeturf", async (req, res) => {
  try {
    const url = "https://www.zeturf.fr/fr/course-du-jour";
    const html = await fetchHtml(url);
    res.json({ status: "ok", message: "Connexion ZEturf OK", length: html.length });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.toString() });
  }
});

app.get("/zeturf/course", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ status: "error", message: "Paramètre url manquant" });
    const parsed = await parseOneCourse(url);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.toString() });
  }
});

app.get("/zeturf/jour", async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "error", message: "Paramètre date invalide, format attendu YYYY-MM-DD" });
    }
    const urls = await findCoursesOfDay(date);
    const results = [];
    for (const url of urls) {
      try {
        const parsed = await parseOneCourse(url);
        results.push(parsed);
      } catch (e) {
        results.push({ status: "error", url, message: e.toString() });
      }
    }
    res.json({ status: "ok", date, total: results.length, courses: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.toString() });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
