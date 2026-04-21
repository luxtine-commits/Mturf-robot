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

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
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

function parseRapport(str) {
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
      if (arrStr.indexOf("-") >= 0) {
        out.push({ course: "C" + cMatch[1], arrivee_officielle: arrStr });
      }
    }
  });
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

function extractRapportsFromCoursePage(html) {
  const $ = cheerio.load(html);
  const result = { rapG: 0, rapZS: 0, rapZC: 0 };
  let targetTable = null;
  $("table").each(function () {
    const t = clean($(this).text());
    if (/SIMPLE\s+GAGNANT/i.test(t) && /ZESHOW/i.test(t)) {
      targetTable = $(this);
      return false;
    }
  });
  if (!targetTable) return result;
  let idxSG = -1, idxZS = -1, idxZC = -1;
  let headerRow = null;
  targetTable.find("tr").each(function () {
    const t = clean($(this).text());
    if (/SIMPLE\s+GAGNANT/i.test(t)) {
      headerRow = $(this);
      return false;
    }
  });
  if (!headerRow) return result;
  const headerCells = headerRow.find("th, td");
  headerCells.each(function (i) {
    const t = clean($(this).text()).toUpperCase();
    if (/SIMPLE\s+GAGNANT/.test(t)) idxSG = i;
    else if (/ZESHOW/.test(t)) idxZS = i;
    else if (/ZE\s+COUILLON/.test(t)) idxZC = i;
  });
  const dataRows = [];
  let foundHeader = false;
  targetTable.find("tr").each(function () {
    if (this === headerRow[0]) { foundHeader = true; return; }
    if (!foundHeader) return;
    const cells = $(this).find("td");
    if (cells.length === 0) return;
    const rowText = clean($(this).text()).toUpperCase();
    if (/JUMEL|TRIO|ZE\s*\d|MULTI/.test(rowText) && !/€/.test(rowText)) return;
    dataRows.push(cells);
  });
  if (dataRows.length >= 1 && idxSG >= 0) {
    const cell = dataRows[0].eq(idxSG);
    if (cell && cell.length) result.rapG = parseRapport(clean(cell.text()));
  }
  if (dataRows.length >= 2 && idxZS >= 0) {
    const cell = dataRows[1].eq(idxZS);
    if (cell && cell.length) result.rapZS = parseRapport(clean(cell.text()));
  }
  if (dataRows.length >= 4 && idxZC >= 0) {
    const cell = dataRows[3].eq(idxZC);
    if (cell && cell.length) result.rapZC = parseRapport(clean(cell.text()));
  }
  return result;
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({
    status: "ok",
    message: "MTURF Robot OK",
    time: new Date().toISOString(),
    version: "v5b-debug"
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
    const reunionsParam = req.query.reunions || "";
    const wantRapports = req.query.rapports === "1" || req.query.rapports === "true";
    if (!reunionsParam) {
      return res.json({ status: "ok", date: date, total: 0, courses: [], debug: { message: "Aucune reunion fournie" } });
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
        debugAttempts.push({
          url: reunionUrl,
          status: "ok",
          arriveesFound: arrivees.length,
          linksFound: Object.keys(courseLinks).length
        });
        const rMatch = slug.match(/^(R\d+)/i);
        const reunion = rMatch ? rMatch[1].toUpperCase() : "";
        const hippo = slug.replace(/^R\d+-?/i, "").toUpperCase();
        for (const a of arrivees) {
          const courseObj = {
            status: "ok",
            date: date,
            reunion: reunion,
            course: a.course,
            hippodrome: hippo,
            arrivee_officielle: a.arrivee_officielle,
            rapG: 0,
            rapZS: 0,
            rapZC: 0
          };
          if (wantRapports && courseLinks[a.course]) {
            try {
              await sleep(300);
              const cHtml = await fetchHtml(courseLinks[a.course]);
              const rap = extractRapportsFromCoursePage(cHtml);
              courseObj.rapG = rap.rapG;
              courseObj.rapZS = rap.rapZS;
              courseObj.rapZC = rap.rapZC;
              courseObj.courseUrl = courseLinks[a.course];
            } catch (e) {
              courseObj.rapportsError = String(e.message || e);
            }
          }
          allCourses.push(courseObj);
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
      withRapports: wantRapports,
      courses: allCourses,
      debug: { attempts: debugAttempts }
    });
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

// Debug page de course : renvoie le contexte HTML autour de "RAPPORTS"
app.get("/debug/course", async function (req, res) {
  const date = req.query.date;
  const slug = req.query.slug;
  if (!date || !slug) return res.status(400).json({ status: "error", message: "date et slug requis" });
  const url = BASE + "/fr/course-du-jour/" + date + "/" + slug;
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const body = clean($("body").text());
    const idx = body.toUpperCase().indexOf("RAPPORTS");
    const around = idx >= 0 ? body.slice(idx, idx + 1500) : "(pas trouvé RAPPORTS)";
    const tableCount = $("table").length;
    // Tester si nos détections de tableau marchent
    let foundSimpleGagnantTable = false;
    $("table").each(function () {
      const t = clean($(this).text());
      if (/SIMPLE\s+GAGNANT/i.test(t)) foundSimpleGagnantTable = true;
    });
    const rap = extractRapportsFromCoursePage(html);
    res.json({
      status: "ok",
      url: url,
      htmlLength: html.length,
      tableCount: tableCount,
      foundSimpleGagnantTable: foundSimpleGagnantTable,
      rapports: rap,
      rapportsZone: around
    });
  } catch (err) {
    res.status(500).json({ status: "error", url: url, message: String(err.message || err) });
  }
});

app.listen(PORT, function () {
  console.log("Server running on " + PORT);
});
