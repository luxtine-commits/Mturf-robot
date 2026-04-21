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

// PARSER v6.1 : beaucoup plus tolérant. On localise la zone "RAPPORTS"
// et on extrait les paires (numéro de cheval, montants en €) sans imposer
// un format strict d'en-tête.
function extractRapportsFromCoursePage(html, arriveeStr) {
  const $ = cheerio.load(html);
  const body = clean($("body").text());
  const result = { rapG: 0, rapZS: 0, rapZC: 0, _arrivee: arriveeStr || "", _matched: false };

  // 1) Localiser le début de la zone RAPPORTS / SIMPLE
  // On essaie plusieurs ancres dans l'ordre
  const anchors = [
    /\bRAPPORTS\b/i,
    /SIMPLE\s+GAGNANT/i,
    /ZEshow/i
  ];
  let startIdx = -1;
  for (const re of anchors) {
    const m = body.match(re);
    if (m) {
      startIdx = body.indexOf(m[0]);
      break;
    }
  }
  if (startIdx < 0) {
    result._zone = "(aucune ancre RAPPORTS/SIMPLE GAGNANT/ZEshow trouvée)";
    return result;
  }

  // 2) Trouver la fin (avant Jumelé / Numéro Plus)
  const endCandidates = [
    body.indexOf("Jumelé", startIdx),
    body.indexOf("JUMEL", startIdx),
    body.indexOf("Numéro Plus", startIdx),
    body.indexOf("Multi", startIdx)
  ].filter(function (x) { return x > 0; });
  const endIdx = endCandidates.length ? Math.min.apply(null, endCandidates) : Math.min(body.length, startIdx + 800);
  const zone = body.slice(startIdx, endIdx);

  // 3) Skipper la partie "header" (mots SIMPLE GAGNANT, ZEshow, etc.)
  // On commence à parser après le dernier mot d'en-tête ZE COUILLON / ZECOUILLON / SIMPLE PLACÉ
  const headerEndIdx = (function () {
    const candidates = [
      zone.search(/ZE\s*COUILLON/i),
      zone.search(/SIMPLE\s+PLAC[ÉE]/i),
      zone.search(/ZEshow/i)
    ].filter(function (x) { return x >= 0; });
    if (!candidates.length) return 0;
    const last = Math.max.apply(null, candidates);
    // Avancer jusqu'au prochain caractère non-lettre après cette position
    const tail = zone.slice(last);
    const m = tail.match(/[A-ZÉÈ]+/);
    return m ? last + m[0].length : last;
  })();
  const dataZone = zone.slice(headerEndIdx);

  // 4) Extraire les "lignes" : numéro suivi d'un ou plusieurs montants en €
  // Ex : "10 27,10 € 7,40 € 16 9,90 € 2,30 € 14 3,20 € 11 13,60 €"
  // On accepte aussi : "10 27.10€ 7,40€ ..." avec ou sans espace avant €
  const lineRe = /(\d{1,2})\s+((?:\d+[.,]\d+\s*€\s*){1,4})/g;
  const lines = [];
  let lm;
  while ((lm = lineRe.exec(dataZone)) !== null && lines.length < 8) {
    const num = parseInt(lm[1]);
    if (!num) continue;
    // Extraire les montants un par un
    const valsRe = /(\d+[.,]\d+)\s*€/g;
    const vals = [];
    let vm;
    while ((vm = valsRe.exec(lm[2])) !== null) {
      vals.push(parseEuro(vm[1]));
    }
    if (vals.length > 0) lines.push({ num: num, values: vals });
  }

  result._linesFound = lines;
  result._zoneStart = zone.slice(0, 200);
  result._dataZoneStart = dataZone.slice(0, 200);

  // 5) Associer aux numéros d'arrivée
  const arrNums = String(arriveeStr || "").split(/[-–—]/).map(function (x) { return parseInt(String(x).trim()); }).filter(function (n) { return n > 0; });
  result._arrNums = arrNums;

  // SG = 1ère valeur de la ligne dont le numéro = arrNums[0]
  // ZS = 1ère valeur de la ligne dont le numéro = arrNums[1] (cette ligne ne contient PAS de SG, donc 1ère valeur = ZS)
  // ZC = 1ère valeur de la ligne dont le numéro = arrNums[3] (cette ligne ne contient QUE le ZC en général)
  if (arrNums[0]) {
    const l = lines.find(function (x) { return x.num === arrNums[0]; });
    if (l && l.values[0]) { result.rapG = l.values[0]; result._matched = true; }
  }
  if (arrNums[1]) {
    const l = lines.find(function (x) { return x.num === arrNums[1]; });
    if (l && l.values[0]) result.rapZS = l.values[0];
  }
  if (arrNums[3]) {
    const l = lines.find(function (x) { return x.num === arrNums[3]; });
    if (l && l.values[0]) result.rapZC = l.values[0];
  }

  return result;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString(), version: "v6.1-parser-tolerant" });
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
