const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 10000;
const BASE = "https://www.zeturf.fr";

function clean(txt) {
  return String(txt || "").replace(/\s+/g, " ").trim();
}

function slugifyHippo(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['']/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
    },
    redirect: "follow"
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " sur " + url);
  return await res.text();
}

// Extrait toutes les arrivées d'une page de réunion
// Format de la page : tableau avec colonnes C1, C2, C3...
// Chaque ligne contient "Arrivée officielle: 10 - 16 - 14 - 11 - 3 - 2 - 15"
function extractArriveesFromReunionPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  // On cherche tous les TR du tableau qui contiennent "Arrivée officielle"
  $("tr").each(function () {
    const txt = clean($(this).text());
    // Détecter le numéro de course (C1, C2, ...)
    const cMatch = txt.match(/\bC(\d+)\b/);
    // Détecter l'arrivée
    const aMatch = txt.match(/Arriv[ée]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/i);
    if (cMatch && aMatch) {
      const arrStr = clean(aMatch[1]);
      if (arrStr.indexOf("-") >= 0) {
        out.push({
          course: "C" + cMatch[1],
          arrivee_officielle: arrStr
        });
      }
    }
  });
  // Fallback : chercher dans tout le body si rien trouvé via tr
  if (out.length === 0) {
    const body = clean($("body").text());
    const re = /\bC(\d+)\b[^A-Za-z]{0,200}Arriv[ée]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const arrStr = clean(m[2]);
      if (arrStr.indexOf("-") >= 0) {
        out.push({ course: "C" + m[1], arrivee_officielle: arrStr });
      }
    }
  }
  return out;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({
    status: "ok",
    message: "MTURF Robot OK",
    time: new Date().toISOString(),
    version: "v4-reunions"
  });
});

app.get("/ping", function (req, res) {
  res.json({ status: "ok", awake: true });
});

// Route principale : reçoit la liste des réunions et renvoie les arrivées
// /zeturf/jour?date=2026-04-18&reunions=R1-enghien-soisy,R2-avenches,R3-lyon-parilly
app.get("/zeturf/jour", async function (req, res) {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "error", message: "Date invalide, format YYYY-MM-DD" });
    }
    const reunionsParam = req.query.reunions || "";
    if (!reunionsParam) {
      return res.json({
        status: "ok",
        date: date,
        total: 0,
        courses: [],
        debug: { message: "Aucune reunion fournie, ajoute ?reunions=R1-enghien-soisy,R2-..." }
      });
    }
    const reunionSlugs = reunionsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    const allCourses = [];
    const debugAttempts = [];
    for (const slug of reunionSlugs) {
      const reunionUrl = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
      try {
        const html = await fetchHtml(reunionUrl);
        const arrivees = extractArriveesFromReunionPage(html);
        debugAttempts.push({
          url: reunionUrl,
          status: "ok",
          htmlLength: html.length,
          arriveesFound: arrivees.length
        });
        // Numéro de réunion (R1, R2, ...) extrait du slug
        const rMatch = slug.match(/^(R\d+)/i);
        const reunion = rMatch ? rMatch[1].toUpperCase() : "";
        const hippo = slug.replace(/^R\d+-?/i, "").toUpperCase();
        for (const a of arrivees) {
          allCourses.push({
            status: "ok",
            date: date,
            reunion: reunion,
            course: a.course,
            hippodrome: hippo,
            arrivee_officielle: a.arrivee_officielle
          });
        }
      } catch (e) {
        debugAttempts.push({
          url: reunionUrl,
          status: "error",
          message: String(e.message || e)
        });
      }
    }
    res.json({
      status: "ok",
      date: date,
      total: allCourses.length,
      courses: allCourses,
      debug: { attempts: debugAttempts }
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: String(err.message || err)
    });
  }
});

// Routes debug
app.get("/debug/reunion", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  if (!date || !slug) return res.status(400).json({ status: "error", message: "date et slug requis" });
  const url = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const arrivees = extractArriveesFromReunionPage(html);
    res.json({ status: "ok", url: url, htmlLength: html.length, arrivees: arrivees });
  } catch (err) {
    res.status(500).json({ status: "error", url: url, message: String(err.message || err) });
  }
});

app.get("/debug/slug", function (req, res) {
  res.json({ status: "ok", input: req.query.name || "", slug: slugifyHippo(req.query.name || "") });
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT);
});
