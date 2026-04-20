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
  return { html: await res.text(), finalUrl: res.url };
}

function parseArrivee(text) {
  const patterns = [
    /Arriv[ée]e\s+officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/i,
    /Arriv[ée]e\s+d[eé]finitive\s*[:\-]?\s*([0-9][0-9\s\-]+)/i,
    /Arriv[ée]e\s*[:\-]?\s*([0-9][0-9\s\-]+)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const s = clean(m[1].replace(/\s+/g, " "));
      if (s.indexOf("-") >= 0) return s;
    }
  }
  return "";
}

function parseMetaFromUrl(url) {
  const m = url.match(/\/(\d{4}-\d{2}-\d{2})\/(R\d+)C(\d+)-([^/?#]+)/i);
  if (!m) return null;
  return {
    date: m[1],
    reunion: m[2].toUpperCase(),
    course: "C" + m[3],
    slug: m[4]
  };
}

function extractCourseLinks($, dateStr) {
  const links = new Set();
  $("a[href]").each(function () {
    let href = $(this).attr("href") || "";
    if (!href) return;
    let abs = href.startsWith("/") ? BASE + href : href;
    if (abs.indexOf(dateStr) >= 0 && /\/course-du-jour\/.*\/R\d+C\d+-/i.test(abs)) {
      abs = abs.split("#")[0].split("?")[0];
      links.add(abs);
    }
  });
  return Array.from(links).sort();
}

// Brute force : essaye R1 à R15 et suit les redirections
async function findCoursesByBruteForce(dateStr) {
  const allLinks = new Set();
  const attempts = [];
  for (let i = 1; i <= 15; i++) {
    const url = BASE + "/fr/reunion-du-jour/" + dateStr + "/R" + i;
    try {
      const { html, finalUrl } = await fetchHtml(url);
      const $ = cheerio.load(html);
      const found = extractCourseLinks($, dateStr);
      attempts.push({
        url: url,
        finalUrl: finalUrl,
        status: "ok",
        htmlLength: html.length,
        linksFound: found.length
      });
      found.forEach(function (l) { allLinks.add(l); });
    } catch (e) {
      attempts.push({
        url: url,
        status: "error",
        message: String(e.message || e)
      });
    }
  }
  return { links: Array.from(allLinks).sort(), attempts: attempts };
}

async function parseOneCourse(url) {
  try {
    const { html } = await fetchHtml(url);
    const $ = cheerio.load(html);
    const bodyText = clean($("body").text());
    const meta = parseMetaFromUrl(url) || {};
    let hippodrome = "";
    if (meta.slug) {
      const parts = meta.slug.split("-");
      if (parts.length > 0) hippodrome = parts[0].toUpperCase();
    }
    return {
      status: "ok",
      url: url,
      date: meta.date || "",
      reunion: meta.reunion || "",
      course: meta.course || "",
      hippodrome: hippodrome,
      arrivee_officielle: parseArrivee(bodyText)
    };
  } catch (e) {
    return { status: "error", url: url, message: String(e.message || e) };
  }
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({
    status: "ok",
    message: "MTURF Robot OK",
    time: new Date().toISOString(),
    version: "v3-bruteforce"
  });
});

app.get("/ping", function (req, res) {
  res.json({ status: "ok", awake: true });
});

app.get("/zeturf/jour", async function (req, res) {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "error", message: "Date invalide, format YYYY-MM-DD" });
    }
    const listing = await findCoursesByBruteForce(date);
    const results = [];
    for (const url of listing.links) {
      const parsed = await parseOneCourse(url);
      results.push(parsed);
    }
    res.json({
      status: "ok",
      date: date,
      total: results.length,
      courses: results,
      debug: { attempts: listing.attempts }
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: String(err.message || err)
    });
  }
});

app.get("/debug/listing", async function (req, res) {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ status: "error", message: "date YYYY-MM-DD requise" });
  }
  try {
    const listing = await findCoursesByBruteForce(date);
    res.json({
      status: "ok",
      date: date,
      totalLinks: listing.links.length,
      firstLinks: listing.links.slice(0, 20),
      attempts: listing.attempts
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.get("/debug/fetch", async function (req, res) {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: "error", message: "url requise" });
  try {
    const { html, finalUrl } = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title = clean($("title").text());
    const bodyText = clean($("body").text());
    const arrivee = parseArrivee(bodyText);
    res.json({
      status: "ok",
      url: url,
      finalUrl: finalUrl,
      htmlLength: html.length,
      title: title,
      arrivee_detectee: arrivee,
      bodyStart: bodyText.slice(0, 500)
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT);
});
