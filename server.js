const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();

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
  return String(txt || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

function parseEuro(str) {
  if (!str) return 0;
  const s = String(str).replace(/[€\s\u00A0]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function extractArriveesFromReunionPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("tr").each(function () {
    const txt = clean($(this).text());
    const cMatch = txt.match(/\bC(\d+)\b/);
    const aMatch = txt.match(/Arriv[ée]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/i);
    if (cMatch && aMatch) {
      const arrStr = clean(aMatch[1]);
      if (arrStr.indexOf("-") >= 0) out.push({ course: "C" + cMatch[1], arrivee_officielle: arrStr });
    }
  });
  if (out.length === 0) {
    const body = clean($("body").text());
    const re = /\bC(\d+)\b[^A-Za-z]{0,200}Arriv[ée]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const arrStr = clean(m[2]);
      if (arrStr.indexOf("-") >= 0) out.push({ course: "C" + m[1], arrivee_officielle: arrStr });
    }
  }
  return out;
}

function extractCourseLinksFromReunionPage(html, dateStr, reunionNum) {
  const $ = cheerio.load(html);
  const map = {};
  const reunionPattern = new RegExp("/" + reunionNum + "C(\\d+)-", "i");
  $("a[href]").each(function () {
    let href = $(this).attr("href") || "";
    if (!href) return;
    let abs = href.startsWith("/") ? BASE + href : href;
    if (abs.indexOf(dateStr) < 0) return;
    const m = abs.match(reunionPattern);
    if (!m) return;
    abs = abs.split("#")[0].split("?")[0];
    const ckey = "C" + m[1];
    if (!map[ckey]) map[ckey] = abs;
  });
  return map;
}

// v7.3 : attribution finale
// rapG = Simple Gagnant (1er montant du 1er cheval)
// rapZS = ZEshow (1er montant du 2e cheval)
// rapZC = Simple Place du 4e cheval (dernier montant, souvent 0)
function extractRapportsFromCoursePage(html, arriveeStr) {
  const $ = cheerio.load(html);
  const body = clean($("body").text());
  const result = {
    rapG: 0, rapZS: 0, rapZC: 0,
    _arrivee: arriveeStr || "",
    _matched: false,
    _debug: {}
  };

  const arrNums = String(arriveeStr || "")
    .split(/[-–—]/)
    .map(function (x) { return parseInt(String(x).trim()); })
    .filter(function (n) { return n > 0; });
  result._arrNums = arrNums;

  // Trouver la zone RAPPORTS
  let zoneStart = -1;
  const rapportsRe = /RAPPORTS/gi;
  let rapMatch;
  while ((rapMatch = rapportsRe.exec(body)) !== null) {
    const snippet = body.slice(rapMatch.index, rapMatch.index + 2000);
    const euros = (snippet.match(/\d+[.,]\d+\s*€/g) || []).length;
    if (euros >= 2) zoneStart = rapMatch.index;
  }
  result._debug.rapportsZoneStart = zoneStart;
  if (zoneStart < 0) return result;

  const zone = body.slice(zoneStart, zoneStart + 5000);

  // Isoler la section SIMPLE (entre "Simple placé" et le prochain label)
  const spStartMatch = zone.match(/Simple\s+plac[ée]/i);
  if (!spStartMatch) {
    result._debug.error = "Simple place label not found";
    return result;
  }
  const simpleStart = spStartMatch.index + spStartMatch[0].length;
  const endLabels = /Jumel|Triordre|ZE4|Coupl|Quart|Quint/i;
  const afterSimple = zone.slice(simpleStart);
  const endMatch = afterSimple.match(endLabels);
  const simpleEnd = endMatch ? simpleStart + endMatch.index : simpleStart + 500;

  const simpleZone = zone.slice(simpleStart, simpleEnd);
  result._debug.simpleZone = simpleZone;

  // Extraire les lignes du tableau : num + liste de montants
  const lineRe = /(\d{1,2})\s+((?:\d+[.,]\d+\s*€\s*)+)/g;
  const chevalData = {};
  let lm;
  while ((lm = lineRe.exec(simpleZone)) !== null) {
    const num = parseInt(lm[1]);
    if (!num || num > 25) continue;
    const montants = [];
    const vr = /(\d+[.,]\d+)\s*€/g;
    let vm;
    while ((vm = vr.exec(lm[2])) !== null) montants.push(parseEuro(vm[1]));
    if (montants.length > 0) chevalData[num] = montants;
  }
  result._debug.chevalData = chevalData;

  // ATTRIBUTION (selon preferences user)
  // rapG : Simple Gagnant = 1er montant du 1er cheval
  if (arrNums[0] && chevalData[arrNums[0]]) {
    result.rapG = chevalData[arrNums[0]][0];
    result._matched = true;
  }
  // rapZS : ZEshow = 1er montant du 2e cheval
  if (arrNums[1] && chevalData[arrNums[1]]) {
    result.rapZS = chevalData[arrNums[1]][0];
  }
  // rapZC : Simple Place du 4e cheval = dernier montant (souvent absent)
  if (arrNums[3] && chevalData[arrNums[3]]) {
    const m = chevalData[arrNums[3]];
    result.rapZC = m[m.length - 1];
  }

  return result;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString(), version: "v7.3-final" });
});

app.get("/ping", function (req, res) {
  res.json({ status: "ok", awake: true });
});

app.get("/zeturf/jour", async function (req, res) {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "error", message: "Date invalide" });
    }
    const reunionsParam = req.query.reunions || "";
    const wantRapports = req.query.rapports === "1" || req.query.rapports === "true";
    if (!reunionsParam) return res.json({ status: "ok", date: date, total: 0, courses: [] });
    const reunionSlugs = reunionsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    const allCourses = [];
    for (const slug of reunionSlugs) {
      const reunionUrl = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
      try {
        const html = await fetchHtml(reunionUrl);
        const arrivees = extractArriveesFromReunionPage(html);
        const rMatch = slug.match(/^(R\d+)/i);
        const reunion = rMatch ? rMatch[1].toUpperCase() : "";
        const courseLinks = extractCourseLinksFromReunionPage(html, date, reunion);
        const hippo = slug.replace(/^R\d+-?/i, "").toUpperCase();
        for (const a of arrivees) {
          const c = { status: "ok", date: date, reunion: reunion, course: a.course, hippodrome: hippo, arrivee_officielle: a.arrivee_officielle, rapG: 0, rapZS: 0, rapZC: 0 };
          if (wantRapports && courseLinks[a.course]) {
            try {
              await sleep(300);
              const cHtml = await fetchHtml(courseLinks[a.course]);
              const rap = extractRapportsFromCoursePage(cHtml, a.arrivee_officielle);
              c.rapG = rap.rapG; c.rapZS = rap.rapZS; c.rapZC = rap.rapZC;
            } catch (e) { c.rapportsError = String(e.message || e); }
          }
          allCourses.push(c);
        }
      } catch (e) {}
    }
    res.json({ status: "ok", date: date, total: allCourses.length, withRapports: wantRapports, courses: allCourses });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.get("/debug/reunion", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  if (!date || !slug) return res.status(400).json({ status: "error" });
  const url = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const rMatch = slug.match(/^(R\d+)/i);
    const reunion = rMatch ? rMatch[1].toUpperCase() : "";
    res.json({
      status: "ok",
      url: url,
      reunion: reunion,
      arrivees: extractArriveesFromReunionPage(html),
      courseLinks: extractCourseLinksFromReunionPage(html, date, reunion)
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.get("/debug/course", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  const arr = req.query.arrivee || "";
  if (!date || !slug) return res.status(400).json({ status: "error" });
  const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const rap = extractRapportsFromCoursePage(html, arr);
    res.json({ status: "ok", url: url, htmlLength: html.length, rapports: rap });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT);
});
