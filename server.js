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
  const s = String(str).replace(/[â¬\s\u00A0]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseCote(str) {
  if (!str) return 0;
  const s = String(str).replace(/[\s\u00A0]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function extractArriveesFromReunionPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("tr").each(function () {
    const txt = clean($(this).text());
    const cMatch = txt.match(/\bC(\d+)\b/);
    const aMatch = txt.match(/Arriv[Ã©e]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/i);
    if (cMatch && aMatch) {
      const arrStr = clean(aMatch[1]);
      if (arrStr.indexOf("-") >= 0) out.push({ course: "C" + cMatch[1], arrivee_officielle: arrStr });
    }
  });
  if (out.length === 0) {
    const body = clean($("body").text());
    const re = /\bC(\d+)\b[^A-Za-z]{0,200}Arriv[Ã©e]e\s*officielle\s*[:\-]?\s*([0-9][0-9\s\-]+)/gi;
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

// v7.3 : attribution finale (post-course)
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
    .split(/[-ââ]/)
    .map(function (x) { return parseInt(String(x).trim()); })
    .filter(function (n) { return n > 0; });
  result._arrNums = arrNums;

  let zoneStart = -1;
  const rapportsRe = /RAPPORTS/gi;
  let rapMatch;
  while ((rapMatch = rapportsRe.exec(body)) !== null) {
    const snippet = body.slice(rapMatch.index, rapMatch.index + 2000);
    const euros = (snippet.match(/\d+[.,]\d+\s*â¬/g) || []).length;
    if (euros >= 2) zoneStart = rapMatch.index;
  }
  result._debug.rapportsZoneStart = zoneStart;
  if (zoneStart < 0) return result;

  const zone = body.slice(zoneStart, zoneStart + 5000);

  const spStartMatch = zone.match(/Simple\s+plac[Ã©e]/i);
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

  const lineRe = /(\d{1,2})\s+((?:\d+[.,]\d+\s*â¬\s*)+)/g;
  const chevalData = {};
  let lm;
  while ((lm = lineRe.exec(simpleZone)) !== null) {
    const num = parseInt(lm[1]);
    if (!num || num > 25) continue;
    const montants = [];
    const vr = /(\d+[.,]\d+)\s*â¬/g;
    let vm;
    while ((vm = vr.exec(lm[2])) !== null) montants.push(parseEuro(vm[1]));
    if (montants.length > 0) chevalData[num] = montants;
  }
  result._debug.chevalData = chevalData;

  if (arrNums[0] && chevalData[arrNums[0]]) {
    result.rapG = chevalData[arrNums[0]][0];
    result._matched = true;
  }
  if (arrNums[1] && chevalData[arrNums[1]]) {
    result.rapZS = chevalData[arrNums[1]][0];
  }
  if (arrNums[3] && chevalData[arrNums[3]]) {
    const m = chevalData[arrNums[3]];
    result.rapZC = m[m.length - 1];
  }

  return result;
}

// =====================================================================
// V8.0 NEW : EXTRACTION DES COTES PRÃ-COURSE (G / SP / ZS / ZC)
// =====================================================================
// ZEturf affiche pour chaque cheval, AVANT la course, 4 cotes :
//   - Simple Gagnant (live)
//   - Simple PlacÃ© (range, ex : "4.0 - 6.3")
//   - ZEshow
//   - ZECouillon
// Ce parser tente plusieurs stratÃ©gies pour extraire ces cotes,
// puis renvoie un debug info riche en cas d'Ã©chec.
// =====================================================================

function extractCotesFromCoursePage(html) {
  const $ = cheerio.load(html);
  const result = {
    participants: [],
    parseStrategy: null,
    debug: {
      htmlLength: html.length,
      hasSimpleGagnantText: html.toLowerCase().indexOf("simple gagnant") >= 0,
      hasZeshowText: html.toLowerCase().indexOf("zeshow") >= 0,
      hasZecouillonText: html.toLowerCase().indexOf("zecouillon") >= 0 ||
                        html.toLowerCase().indexOf("ze couillon") >= 0,
      hasRapportsText: html.toLowerCase().indexOf("rapports") >= 0,
      tableCount: $("table").length,
      divsWithCote: $('[class*="cote"]').length,
      divsWithParticipant: $('[class*="participant"]').length,
      divsWithRunner: $('[class*="runner"]').length,
      attemptedStrategies: []
    }
  };

  // --- STRATÃGIE 0 : JSON embarquÃ© ---
  // Beaucoup de sites Vue/Nuxt embarquent l'Ã©tat initial en JSON dans un script
  result.debug.attemptedStrategies.push("json-embedded");
  const jsonRe = /(?:__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__|window\.__DATA__)\s*=\s*({[\s\S]*?})\s*[;<]/;
  const jsonMatch = html.match(jsonRe);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      result.debug.jsonStateFound = true;
      result.debug.jsonStateKeys = Object.keys(data || {}).slice(0, 30);
      // On ne sait pas la structure exacte â renvoyÃ©e en debug pour analyse manuelle
    } catch (e) {
      result.debug.jsonStateFound = "parse-error";
      result.debug.jsonStateError = String(e.message || e);
    }
  }

  // --- STRATÃGIE 1 : Tables HTML avec lignes de chevaux ---
  // Une ligne de cheval contient un nÂ° + 3 Ã  5 cotes numÃ©riques
  result.debug.attemptedStrategies.push("html-table");
  let bestTable = null;
  let bestRows = 0;
  $("table").each(function () {
    const $t = $(this);
    const rows = $t.find("tr");
    if (rows.length < 4) return;
    let validRows = 0;
    rows.each(function () {
      const tds = $(this).find("td");
      if (tds.length < 4) return;
      const numTxt = clean($(tds[0]).text());
      const num = parseInt(numTxt);
      if (!num || num > 30) return;
      // Compter les cellules contenant une cote (decimal ou range)
      let cotes = 0;
      tds.each(function () {
        const t = clean($(this).text());
        if (/^\d+[.,]\d+(?:\s*[-â]\s*\d+[.,]\d+)?$/.test(t)) cotes++;
      });
      if (cotes >= 3) validRows++;
    });
    if (validRows >= 3 && validRows > bestRows) {
      bestTable = $t;
      bestRows = validRows;
    }
  });

  if (bestTable) {
    const participants = [];
    bestTable.find("tr").each(function () {
      const tds = $(this).find("td");
      if (tds.length < 4) return;
      const numTxt = clean($(tds[0]).text());
      const num = parseInt(numTxt);
      if (!num || num > 30) return;

      // RÃ©cupÃ©rer toutes les cotes de la ligne dans l'ordre
      const cotes = [];
      tds.each(function () {
        const t = clean($(this).text());
        const single = t.match(/^(\d+[.,]\d+)$/);
        const range = t.match(/^(\d+[.,]\d+)\s*[-â]\s*(\d+[.,]\d+)$/);
        if (range) {
          cotes.push({ raw: t, type: "range",
            min: parseCote(range[1]), max: parseCote(range[2]) });
        } else if (single) {
          cotes.push({ raw: t, type: "single", val: parseCote(single[1]) });
        }
      });

      if (cotes.length < 3) return;

      // Mapping selon le nombre de cotes trouvÃ©es
      // ZEturf affiche typiquement 5 colonnes : G(Ã  HH:MM), G(En direct), SP, ZS, ZC
      // ou 4 si pas d'historique : G, SP, ZS, ZC
      // ou 3 (rare)
      let coteG = 0, coteSP_min = 0, coteSP_max = 0, coteZS = 0, coteZC = 0;
      if (cotes.length >= 5) {
        // 5 cotes : on prend la 2e (G en direct)
        coteG = cotes[1].val || cotes[1].min || 0;
        const sp = cotes[2];
        coteSP_min = sp.min || sp.val || 0;
        coteSP_max = sp.max || sp.val || 0;
        coteZS = cotes[3].val || cotes[3].min || 0;
        coteZC = cotes[4].val || cotes[4].min || 0;
      } else if (cotes.length === 4) {
        coteG = cotes[0].val || cotes[0].min || 0;
        const sp = cotes[1];
        coteSP_min = sp.min || sp.val || 0;
        coteSP_max = sp.max || sp.val || 0;
        coteZS = cotes[2].val || cotes[2].min || 0;
        coteZC = cotes[3].val || cotes[3].min || 0;
      } else {
        // 3 cotes : G, ZS, ZC (pas de SP)
        coteG = cotes[0].val || cotes[0].min || 0;
        coteZS = cotes[1].val || cotes[1].min || 0;
        coteZC = cotes[2].val || cotes[2].min || 0;
      }

      // Nom du cheval (souvent dans la 2e colonne)
      const nameCell = tds.length > 1 ? clean($(tds[1]).text()).slice(0, 60) : "";

      participants.push({
        num,
        name: nameCell,
        coteG, coteSP_min, coteSP_max, coteZS, coteZC,
        rawCotes: cotes.map(function (c) { return c.raw; })
      });
    });

    if (participants.length >= 3) {
      result.participants = participants;
      result.parseStrategy = "html-table";
      return result;
    }
  }

  // --- STRATÃGIE 2 : Body text scanning ---
  // Cherche dans le texte brut un pattern : numÃ©ro + suite de cotes
  result.debug.attemptedStrategies.push("body-text");
  const body = clean($("body").text());
  // Localiser la zone des cotes (entre "Choisissez vos chevaux" / "COTES" et la fin)
  let zoneStart = -1;
  const cotesAnchor = body.match(/(?:Choisissez\s+vos\s+chevaux|COTES|Simple\s+gagnant)/i);
  if (cotesAnchor) zoneStart = cotesAnchor.index;
  result.debug.bodyZoneStart = zoneStart;

  if (zoneStart >= 0) {
    const zone = body.slice(zoneStart, zoneStart + 12000);
    // Pattern : NÂ° (1-30) suivi (Ã  plus ou moins de distance) de 4 nombres dÃ©cimaux
    // ex: "1 A STOLEN KISS Johne ... 6.2 3.5 4.0 - 6.3 10.2 9.0"
    const lineRe = /\b(\d{1,2})\b[^\d]{0,200}?(\d+[.,]\d+)\s+(\d+[.,]\d+)(?:\s*[-â]\s*(\d+[.,]\d+))?\s+(\d+[.,]\d+)\s+(\d+[.,]\d+)/g;
    const participants = [];
    const seen = {};
    let m;
    while ((m = lineRe.exec(zone)) !== null && participants.length < 30) {
      const num = parseInt(m[1]);
      if (!num || num > 30 || seen[num]) continue;
      seen[num] = true;
      // Mapping : c1 c2 [- c3] c4 c5 â SP_min SP_max [pas le cas] ZS ZC, ou G,SP_min,SP_max,ZS,ZC
      // Si m[4] prÃ©sent : 5 nombres incluant un range â c1=G, c2-c3=SP, c4=ZS, c5=ZC
      // Sinon 4 nombres â c1=G, c2=SP_single, c3=ZS, c4(=m[5])=ZC ; m[4] est undefined
      let coteG, spMin, spMax, coteZS, coteZC;
      if (m[4] !== undefined) {
        coteG = parseCote(m[2]);
        spMin = parseCote(m[3]);
        spMax = parseCote(m[4]);
        coteZS = parseCote(m[5]);
        coteZC = parseCote(m[6]);
      } else {
        coteG = parseCote(m[2]);
        spMin = parseCote(m[3]);
        spMax = parseCote(m[3]);
        coteZS = parseCote(m[5]);
        coteZC = parseCote(m[6]);
      }
      participants.push({ num, name: "",
        coteG, coteSP_min: spMin, coteSP_max: spMax, coteZS, coteZC,
        rawMatch: m[0].slice(0, 200) });
    }
    if (participants.length >= 3) {
      result.participants = participants;
      result.parseStrategy = "body-text";
      return result;
    }
  }

  // --- ÃCHEC : aucune stratÃ©gie n'a fonctionnÃ© ---
  return result;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString(), version: "v8.0-cotes" });
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

// ============================================================
// V8.0 NEW : ROUTES COTES PRÃ-COURSE
// ============================================================

// Route principale â slug direct
// Exemple : /cotes-zeturf?date=2026-05-10&slug=R2C7-hoppegarten
app.get("/cotes-zeturf", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  if (!date || !slug) {
    return res.status(400).json({ status: "error", message: "date et slug requis" });
  }
  const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const cotes = extractCotesFromCoursePage(html);
    res.json({
      status: "ok",
      url: url,
      participants: cotes.participants,
      parseStrategy: cotes.parseStrategy,
      participantsCount: cotes.participants.length,
      debug: cotes.debug
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

// Route auto â trouve le slug Ã  partir de date/reunion/course en passant par la page de rÃ©union
// Exemple : /cotes-zeturf-rc?date=2026-05-10&reunion=2&course=7&hippo=hoppegarten
app.get("/cotes-zeturf-rc", async function (req, res) {
  const date = req.query.date;
  const reunion = req.query.reunion;
  const course = req.query.course;
  const hippoHint = req.query.hippo || "";
  if (!date || !reunion || !course) {
    return res.status(400).json({ status: "error", message: "date, reunion, course requis" });
  }
  const reunionTag = "R" + String(reunion).replace(/\D/g, "");
  const courseTag = "C" + String(course).replace(/\D/g, "");

  // Si hippo fourni â on tente le slug direct (rapide, 1 seul fetch)
  if (hippoHint) {
    const slug = reunionTag + courseTag + "-" + hippoHint.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
    try {
      const html = await fetchHtml(url);
      const cotes = extractCotesFromCoursePage(html);
      if (cotes.participants.length > 0) {
        return res.json({
          status: "ok", url: url, slug: slug, method: "direct-with-hippo",
          participants: cotes.participants,
          parseStrategy: cotes.parseStrategy,
          participantsCount: cotes.participants.length,
          debug: cotes.debug
        });
      }
      // Si la page existe mais pas de cotes parseÃ©es : on tente quand mÃªme la mÃ©thode auto
    } catch (e) {
      // 404 ou autre : fallback sur la mÃ©thode auto
    }
  }

  // MÃ©thode auto : on cherche le slug via la page rÃ©union
  // ZEturf utilise /fr/reunion-du-jour/<date>/<reunion-slug>
  // Mais on ne connaÃ®t pas l'hippoâ¦ on peut tenter via la home du jour
  const homeUrl = BASE + "/fr/courses-du-jour/" + date;
  try {
    const homeHtml = await fetchHtml(homeUrl);
    const $ = cheerio.load(homeHtml);
    const targetPattern = new RegExp("/" + reunionTag + courseTag + "-", "i");
    let foundUrl = null;
    $("a[href]").each(function () {
      if (foundUrl) return;
      let href = $(this).attr("href") || "";
      if (!href) return;
      const abs = href.startsWith("/") ? BASE + href : href;
      if (abs.indexOf(date) < 0) return;
      if (targetPattern.test(abs)) {
        foundUrl = abs.split("#")[0].split("?")[0];
      }
    });

    if (!foundUrl) {
      return res.status(404).json({
        status: "error",
        message: "Course introuvable depuis " + homeUrl,
        method: "auto-via-home",
        homeUrl: homeUrl
      });
    }

    const html = await fetchHtml(foundUrl);
    const cotes = extractCotesFromCoursePage(html);
    res.json({
      status: "ok", url: foundUrl, method: "auto-via-home",
      participants: cotes.participants,
      parseStrategy: cotes.parseStrategy,
      participantsCount: cotes.participants.length,
      debug: cotes.debug
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

// Route debug â retourne en plus des extraits HTML pour diagnostic
// Exemple : /debug/cotes-zeturf?date=2026-05-10&slug=R2C7-hoppegarten&raw=1
app.get("/debug/cotes-zeturf", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  const wantRaw = req.query.raw === "1";
  if (!date || !slug) {
    return res.status(400).json({ status: "error", message: "date et slug requis" });
  }
  const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const cotes = extractCotesFromCoursePage(html);
    const response = {
      status: "ok",
      url: url,
      participants: cotes.participants,
      parseStrategy: cotes.parseStrategy,
      debug: cotes.debug
    };

    if (wantRaw) {
      const $ = cheerio.load(html);
      // Premier table HTML (potentielle table cotes)
      const firstTable = $("table").first();
      const firstTableHtml = firstTable.length ? firstTable.html() : null;
      // Zone de texte autour de "Simple gagnant" si prÃ©sent
      const body = clean($("body").text());
      const sgIdx = body.toLowerCase().indexOf("simple gagnant");
      const cotesZone = sgIdx >= 0 ? body.slice(sgIdx, sgIdx + 3000) : null;

      response.htmlExcerpts = {
        first2k: html.slice(0, 2000),
        last1k: html.slice(-1000),
        firstTableHtml: firstTableHtml ? firstTableHtml.slice(0, 4000) : null,
        cotesZoneText: cotesZone ? cotesZone.slice(0, 3000) : null
      };
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ status: "error", message: String(err.message || err) });
  }
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT + " (v8.0-cotes)");
});
