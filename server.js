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
  return String(txt || "").replace(/\s+/g, " ").trim();
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
  const s = String(str).replace(/[€\s]/g, "").replace(",", ".");
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

function extractCourseLinksFromReunionPage(html, dateStr) {
  const $ = cheerio.load(html);
  const map = {};
  $("a[href]").each(function () {
    let href = $(this).attr("href") || "";
    if (!href) return;
    let abs = href.startsWith("/") ? BASE + href : href;
    if (abs.indexOf(dateStr) < 0) return;
    const m = abs.match(/\/R\d+C(\d+)-/i);
    if (!m) return;
    abs = abs.split("#")[0].split("?")[0];
    const ckey = "C" + m[1];
    if (!map[ckey]) map[ckey] = abs;
  });
  return map;
}

// NOUVEAU PARSER : basé sur le texte brut, beaucoup plus robuste
// Le bloc dans le HTML ressemble à :
// "Simple gagnant Simple ZEshow Simple placé ZE couillon
//  10 27,10 € 7,40 €
//  16 9,90 € 2,30 €
//  14 3,20 €
//  11 13,60 €"
// On parse les 4 lignes après l'en-tête.
function extractRapportsFromCoursePage(html, arriveeStr) {
  const $ = cheerio.load(html);
  const body = clean($("body").text());
  const result = { rapG: 0, rapZS: 0, rapZC: 0, _arrivee: arriveeStr || "", _matched: false };

  // Trouver la zone qui contient "ZEshow" et "Simple placé" et "ZE couillon"
  // (c'est l'en-tête du tableau des rapports SIMPLE)
  const headerRe = /Simple\s+gagnant.{0,40}ZEshow.{0,40}Simple\s+plac[ée].{0,40}ZE\s+couillon/i;
  const hMatch = body.match(headerRe);
  if (!hMatch) return result;

  // Le bloc utile est juste après cet en-tête, jusqu'à "Jumelé" ou "Numéro"
  const startIdx = body.indexOf(hMatch[0]) + hMatch[0].length;
  const endIdx = (function () {
    const candidates = [body.indexOf("Jumelé", startIdx), body.indexOf("JUMEL", startIdx), body.indexOf("Numéro Plus", startIdx)];
    const valid = candidates.filter(function (x) { return x > 0; });
    return valid.length ? Math.min.apply(null, valid) : startIdx + 500;
  })();
  const zone = body.slice(startIdx, endIdx);

  // Extraire des paires "numero  X,XX €  Y,YY €"
  // ex : "10 27,10 € 7,40 € 16 9,90 € 2,30 € 14 3,20 € 11 13,60 €"
  // Pattern : un numéro de cheval suivi d'un ou plusieurs montants en €
  const lineRe = /(\d{1,2})\b(?:\s+(\d+[.,]\d+)\s*€)?(?:\s+(\d+[.,]\d+)\s*€)?(?:\s+(\d+[.,]\d+)\s*€)?(?:\s+(\d+[.,]\d+)\s*€)?/g;
  // On cherche jusqu'à 4 lignes (4 chevaux : 1er, 2e, 3e, 4e)
  const lines = [];
  let lm;
  while ((lm = lineRe.exec(zone)) !== null && lines.length < 6) {
    const num = parseInt(lm[1]);
    if (!num) continue;
    const vals = [lm[2], lm[3], lm[4], lm[5]].filter(Boolean).map(parseEuro);
    lines.push({ num: num, values: vals });
  }

  // Maintenant on associe : la ligne dont le numéro correspond au 1er de l'arrivée → SG (1ère valeur)
  // 2e de l'arrivée → ZS (2e valeur dans la ligne du 2e cheval)
  // 4e de l'arrivée → ZC (...)
  const arrNums = String(arriveeStr || "").split(/[-–—]/).map(function (x) { return parseInt(String(x).trim()); }).filter(function (n) { return n > 0; });

  if (arrNums.length >= 1 && lines[0] && lines[0].num === arrNums[0]) {
    // Ligne du 1er = [SG, SP_1er] ou juste [SG]
    if (lines[0].values.length >= 1) result.rapG = lines[0].values[0];
    result._matched = true;
  }
  if (arrNums.length >= 2 && lines[1] && lines[1].num === arrNums[1]) {
    // Ligne du 2e = [ZS, SP_2e]
    if (lines[1].values.length >= 1) result.rapZS = lines[1].values[0];
  }
  if (arrNums.length >= 4 && lines[3] && lines[3].num === arrNums[3]) {
    // Ligne du 4e = [ZC] (seule valeur car SG/ZS/SP n'existent pas pour le 4e)
    if (lines[3].values.length >= 1) result.rapZC = lines[3].values[0];
  }

  // Si l'ordre n'a pas matché (ex : SP a été détecté en plus), on tente une approche différente :
  // Chercher la ligne dont le numéro correspond à arrNums[0], idem [1], idem [3]
  if (!result.rapG && arrNums[0]) {
    const l = lines.find(function (x) { return x.num === arrNums[0]; });
    if (l && l.values[0]) result.rapG = l.values[0];
  }
  if (!result.rapZS && arrNums[1]) {
    const l = lines.find(function (x) { return x.num === arrNums[1]; });
    if (l && l.values[0]) result.rapZS = l.values[0];
  }
  if (!result.rapZC && arrNums[3]) {
    const l = lines.find(function (x) { return x.num === arrNums[3]; });
    if (l && l.values[0]) result.rapZC = l.values[0];
  }

  result._linesFound = lines;
  result._zone = zone.slice(0, 300);
  return result;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString(), version: "v6-rapports-text" });
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
    const reunionsParam = req.query.reunions || "";
    const wantRapports = req.query.rapports === "1" || req.query.rapports === "true";
    if (!reunionsParam) {
      return res.json({ status: "ok", date: date, total: 0, courses: [] });
    }
    const reunionSlugs = reunionsParam.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    const allCourses = [];
    const debugAttempts = [];
    for (const slug of reunionSlugs) {
      const reunionUrl = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
      try {
        const html = await fetchHtml(reunionUrl);
        const arrivees = extractArriveesFromReunionPage(html);
        const courseLinks = extractCourseLinksFromReunionPage(html, date);
        debugAttempts.push({ url: reunionUrl, status: "ok", arriveesFound: arrivees.length, linksFound: Object.keys(courseLinks).length });
        const rMatch = slug.match(/^(R\d+)/i);
        const reunion = rMatch ? rMatch[1].toUpperCase() : "";
        const hippo = slug.replace(/^R\d+-?/i, "").toUpperCase();
        for (const a of arrivees) {
          const courseObj = {
            status: "ok", date: date, reunion: reunion, course: a.course,
            hippodrome: hippo, arrivee_officielle: a.arrivee_officielle,
            rapG: 0, rapZS: 0, rapZC: 0
          };
          if (wantRapports && courseLinks[a.course]) {
            try {
              await sleep(300);
              const cHtml = await fetchHtml(courseLinks[a.course]);
              const rap = extractRapportsFromCoursePage(cHtml, a.arrivee_officielle);
              courseObj.rapG = rap.rapG;
              courseObj.rapZS = rap.rapZS;
              courseObj.rapZC = rap.rapZC;
            } catch (e) {
              courseObj.rapportsError = String(e.message || e);
            }
          }
          allCourses.push(courseObj);
        }
      } catch (e) {
        debugAttempts.push({ url: reunionUrl, status: "error", message: String(e.message || e) });
      }
    }
    res.json({ status: "ok", date: date, total: allCourses.length, withRapports: wantRapports, courses: allCourses, debug: { attempts: debugAttempts } });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.get("/debug/reunion", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  if (!date || !slug) return res.status(400).json({ status: "error", message: "date et slug requis" });
  const url = BASE + "/fr/reunion-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const arrivees = extractArriveesFromReunionPage(html);
    const links = extractCourseLinksFromReunionPage(html, date);
    res.json({ status: "ok", url: url, arrivees: arrivees, courseLinks: links });
  } catch (err) {
    res.status(500).json({ status: "error", url: url, message: String(err.message || err) });
  }
});

app.get("/debug/course", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  const arr = req.query.arrivee || "";
  if (!date || !slug) return res.status(400).json({ status: "error", message: "date et slug requis" });
  const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const rap = extractRapportsFromCoursePage(html, arr);
    res.json({ status: "ok", url: url, htmlLength: html.length, rapports: rap });
  } catch (err) {
    res.status(500).json({ status: "error", url: url, message: String(err.message || err) });
  }
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT);
});
