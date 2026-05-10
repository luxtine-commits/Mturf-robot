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
    .split(/[-–—]/)
    .map(function (x) { return parseInt(String(x).trim()); })
    .filter(function (n) { return n > 0; });
  result._arrNums = arrNums;

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
// V8.0 NEW : EXTRACTION DES COTES PRÉ-COURSE (G / SP / ZS / ZC)
// =====================================================================
// ZEturf affiche pour chaque cheval, AVANT la course, 4 cotes :
//   - Simple Gagnant (live)
//   - Simple Placé (range, ex : "4.0 - 6.3")
//   - ZEshow
//   - ZECouillon
// Ce parser tente plusieurs stratégies pour extraire ces cotes,
// puis renvoie un debug info riche en cas d'échec.
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
      divsWithCote: $('[class*="cote" i]').length,
      divsWithPartant: $('[class*="partant" i]').length + $('[class*="runner" i]').length,
      divsWithHorse: $('[class*="horse" i]').length,
      attemptedStrategies: [],
      // v8.1 : extraits structurels pour diagnostic
      tableStructures: [],
      classNamesSample: [],
      bodyExcerpts: {},
      jsonStateInfo: null
    }
  };

  // === Échantillonnage structurel : récupère les classes CSS "intéressantes" ===
  const interestingClasses = {};
  $('*[class]').each(function () {
    const cls = $(this).attr('class') || '';
    cls.split(/\s+/).forEach(function (c) {
      if (/cote|partant|runner|horse|race|odd|cheval/i.test(c)) {
        interestingClasses[c] = (interestingClasses[c] || 0) + 1;
      }
    });
  });
  result.debug.classNamesSample = Object.keys(interestingClasses)
    .map(function (c) { return c + ' x' + interestingClasses[c]; })
    .slice(0, 40);

  // === v8.8 : diagnostic ULTIME pour trouver où sont VRAIMENT les cotes ===
  result.debug.ultimateDiag = {};
  // Compte les turbo-frames
  result.debug.ultimateDiag.turboFrameCount = $('turbo-frame').length;
  result.debug.ultimateDiag.turboFrameIds = [];
  $('turbo-frame').each(function () {
    const id = $(this).attr('id') || '';
    if (id) result.debug.ultimateDiag.turboFrameIds.push(id);
  });
  // Compte les scripts inline avec JSON
  result.debug.ultimateDiag.jsonScriptCount = $('script[type="application/json"]').length;
  // 1ère cellule cote-zeshow : son HTML complet et ses attributs
  const $firstZS = $('.cote-zeshow').filter(function () {
    return $(this).prop('tagName') !== 'TH';
  }).first();
  if ($firstZS.length) {
    const attrs = {};
    Object.keys($firstZS[0].attribs || {}).forEach(function (k) {
      attrs[k] = String($firstZS[0].attribs[k]).slice(0, 100);
    });
    result.debug.ultimateDiag.firstZSCellAttrs = attrs;
    result.debug.ultimateDiag.firstZSCellHtml = clean($.html($firstZS)).slice(0, 400);
    result.debug.ultimateDiag.firstZSCellInnerHtml = $firstZS.html() ? clean($firstZS.html()).slice(0, 200) : '(vide)';
    // Parent et grand-parent
    const $parent = $firstZS.parent();
    result.debug.ultimateDiag.firstZSParentTag = $parent.length ? ($parent.prop('tagName') + ' class="' + ($parent.attr('class')||'').slice(0,50) + '"') : 'NONE';
  }
  // Recherche de décimales près de "ZEshow" dans le HTML brut
  const zsIdx = html.toLowerCase().indexOf('zeshow');
  if (zsIdx > 0) {
    const around = html.slice(Math.max(0, zsIdx - 100), zsIdx + 3000);
    const decimals = around.match(/\d+[.,]\d+/g) || [];
    result.debug.ultimateDiag.decimalsNearZEshow = decimals.slice(0, 30);
  }
  // Cherche tous les data-* attributs sur les cote-* cells
  const dataAttrSamples = [];
  $('[class*="cote-"]').slice(0, 5).each(function () {
    const el = this;
    const sample = { class: ($(this).attr('class') || '').slice(0, 60), attrs: {} };
    Object.keys(el.attribs || {}).forEach(function (k) {
      if (k.indexOf('data-') === 0) sample.attrs[k] = String(el.attribs[k]).slice(0, 80);
    });
    if (Object.keys(sample.attrs).length) dataAttrSamples.push(sample);
  });
  result.debug.ultimateDiag.dataAttrSamples = dataAttrSamples;

  // === Structure des tables ===
  $("table").each(function (i) {
    const $t = $(this);
    const cls = $t.attr('class') || '';
    const parentCls = $t.parent().attr('class') || '';
    const rowCount = $t.find('tr').length;
    const firstRow = $t.find('tr').first();
    const firstRowText = clean(firstRow.text()).slice(0, 150);
    const cellCount = firstRow.find('td,th').length;
    result.debug.tableStructures.push({
      idx: i,
      class: cls.slice(0, 80),
      parentClass: parentCls.slice(0, 80),
      rows: rowCount,
      firstRowCells: cellCount,
      firstRowText: firstRowText
    });
  });

  // === Extraits autour des mots-clés ===
  const lowerHtml = html.toLowerCase();
  function excerptAround(needle, before, after) {
    const idx = lowerHtml.indexOf(needle.toLowerCase());
    if (idx < 0) return null;
    return html.slice(Math.max(0, idx - before), idx + needle.length + after)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
  }
  result.debug.bodyExcerpts.simpleGagnant = excerptAround("Simple gagnant", 80, 600);
  result.debug.bodyExcerpts.zeshow = excerptAround("ZEshow", 80, 600);
  result.debug.bodyExcerpts.cotes = excerptAround("Cotes", 50, 400);

  // --- STRATÉGIE 0 : JSON embarqué (Nuxt/Vue/React state) ---
  result.debug.attemptedStrategies.push("json-embedded");
  const jsonPatterns = [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*[;<]/,
    /window\.__NUXT__\s*=\s*({[\s\S]*?})\s*[;<]/,
    /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})\s*[;<]/,
    /__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    /window\.__DATA__\s*=\s*({[\s\S]*?})\s*[;<]/
  ];
  for (var pi = 0; pi < jsonPatterns.length; pi++) {
    const m = html.match(jsonPatterns[pi]);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        result.debug.jsonStateInfo = {
          patternIndex: pi,
          topKeys: Object.keys(data || {}).slice(0, 30)
        };
        // Recherche en profondeur d'une liste de partants avec cotes
        const found = findParticipantsInJson(data, 0);
        if (found && found.length >= 3) {
          result.participants = found;
          result.parseStrategy = "json-state";
          return result;
        }
        break;
      } catch (e) {
        result.debug.jsonStateInfo = { patternIndex: pi, parseError: String(e.message).slice(0, 100) };
      }
    }
  }

  // --- STRATÉGIE 1 (PRIORITAIRE) : classes CSS dédiées ZEturf ---
  // ZEturf utilise des classes spécifiques par type de cote :
  //   .cote-simplegagnant, .cote-simpleplace, .cote-zeshow, .cote-zecouillon
  // Et chaque ligne de partant est dans .cheval avec un .numero-cheval-card
  result.debug.attemptedStrategies.push("zeturf-classes");
  result.debug.zeturfClasses = {};
  const zeturfResult = tryParseZeturfClasses($, result.debug.zeturfClasses);
  if (zeturfResult && zeturfResult.length >= 3) {
    result.participants = zeturfResult;
    result.parseStrategy = "zeturf-classes";
    return result;
  }

  // --- STRATÉGIE 2 : <table> classique ---
  result.debug.attemptedStrategies.push("html-table");
  const tableResult = tryParseTables($);
  if (tableResult && tableResult.length >= 3) {
    result.participants = tableResult;
    result.parseStrategy = "html-table";
    return result;
  }

  // --- STRATÉGIE 2 : éléments avec class="runner" / "partant" / "horse" ---
  result.debug.attemptedStrategies.push("class-selector");
  const classResult = tryParseClassElements($);
  if (classResult && classResult.length >= 3) {
    result.participants = classResult;
    result.parseStrategy = "class-selector";
    return result;
  }

  // --- STRATÉGIE 3 : <tbody> orphelins ou divs structurés ---
  result.debug.attemptedStrategies.push("repeated-structure");
  const repResult = tryParseRepeatedStructure($);
  if (repResult && repResult.length >= 3) {
    result.participants = repResult;
    result.parseStrategy = "repeated-structure";
    return result;
  }

  // --- STRATÉGIE 4 : scan brut du body texte ---
  result.debug.attemptedStrategies.push("body-text");
  const bodyResult = tryParseBodyText($);
  if (bodyResult && bodyResult.length >= 3) {
    result.participants = bodyResult;
    result.parseStrategy = "body-text";
    return result;
  }

  return result;
}

// Helper : parcours JSON pour trouver une liste de partants
function findParticipantsInJson(obj, depth) {
  if (!obj || depth > 8) return null;
  if (Array.isArray(obj)) {
    // Test si c'est une liste de partants : objets avec des cotes
    if (obj.length >= 3 && typeof obj[0] === 'object' && obj[0]) {
      const sample = obj[0];
      const hasNumeric = Object.values(sample).some(function (v) { return typeof v === 'number' && v > 1 && v < 200; });
      const hasNum = ('number' in sample) || ('num' in sample) || ('numero' in sample) || ('runnerNumber' in sample);
      if (hasNumeric && hasNum) {
        const out = [];
        obj.forEach(function (it) {
          const num = it.number || it.num || it.numero || it.runnerNumber || 0;
          if (!num || num > 30) return;
          // Cherche les champs cotes (différents noms possibles)
          const cG = parseCote(it.coteGagnant || it.odds_gagnant || it.gagnant || it.odd_g || it.simpleGagnant || 0);
          const cZS = parseCote(it.coteZeshow || it.odds_zeshow || it.zeshow || it.odd_zs || 0);
          const cZC = parseCote(it.coteZecouillon || it.odds_zecouillon || it.zecouillon || it.odd_zc || 0);
          out.push({
            num: num, name: String(it.name || it.horse || it.cheval || '').slice(0, 60),
            coteG: cG, coteSP_min: 0, coteSP_max: 0,
            coteZS: cZS, coteZC: cZC
          });
        });
        if (out.length >= 3) return out;
      }
    }
    // Sinon descend dans chaque élément
    for (var i = 0; i < obj.length; i++) {
      const r = findParticipantsInJson(obj[i], depth + 1);
      if (r) return r;
    }
  } else if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      const r = findParticipantsInJson(obj[keys[k]], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// Helper : parser ZEturf via classes CSS dédiées (le plus fiable)
// Stratégie : on part des cellules .cote-zeshow (1 par partant exactement)
// et on remonte au <tr> parent pour lire les autres cotes + numéro + nom.
// (.cheval matche trop d'éléments — boutons, liens — donc inutilisable comme ancre)
function tryParseZeturfClasses($, dbg) {
  if (!dbg) dbg = {};
  const participants = [];
  const seen = {};

  function firstCote(txt) {
    if (!txt) return 0;
    const m = txt.match(/(\d+[.,]\d+)/);
    return m ? parseCote(m[1]) : 0;
  }
  function rangeCote(txt) {
    if (!txt) return { min: 0, max: 0 };
    const r = txt.match(/(\d+[.,]\d+)\s*[-–]\s*(\d+[.,]\d+)/);
    if (r) return { min: parseCote(r[1]), max: parseCote(r[2]) };
    const single = firstCote(txt);
    return { min: single, max: single };
  }

  // Ancre : .cote-zeshow (ou .cote-zecouillon) — exactement 1 par partant
  // IMPORTANT v8.5 : on filtre les <th> (en-têtes) — on ne garde que les TD/cellules de tbody
  // Les classes .cote-zeshow sont aussi sur les <th> d'en-tête, on doit les exclure
  let $cells = $('tbody .cote-zeshow, td.cote-zeshow').filter(function () {
    return $(this).prop('tagName') !== 'TH';
  });
  let anchorClass = 'tbody .cote-zeshow';
  if ($cells.length < 3) {
    $cells = $('tbody .cote-zecouillon, td.cote-zecouillon').filter(function () {
      return $(this).prop('tagName') !== 'TH';
    });
    anchorClass = 'tbody .cote-zecouillon';
  }
  if ($cells.length < 3) {
    $cells = $('tbody .cote-simpleplace, td.cote-simpleplace').filter(function () {
      return $(this).prop('tagName') !== 'TH';
    });
    anchorClass = 'tbody .cote-simpleplace';
  }
  // Fallback : si tbody n'existe pas, on prend tous les .cote-zeshow mais on filtre les TH
  if ($cells.length < 3) {
    $cells = $('.cote-zeshow').filter(function () {
      return $(this).prop('tagName') !== 'TH';
    });
    anchorClass = '.cote-zeshow (sans TH)';
  }

  dbg.anchorClass = anchorClass;
  dbg.anchorCellCount = $cells.length;
  dbg.cellSamples = [];

  $cells.each(function (idx) {
    const $cell = $(this);
    let $row = $cell.closest('tr');
    let rowSource = 'closest-tr';
    if (!$row.length) {
      $row = $cell.parent().parent().parent();
      rowSource = 'parent-3';
    }

    // Pour le 1er cell, on stocke un échantillon détaillé pour debug
    if (idx === 0) {
      const cellTag = $cell.prop('tagName') || '?';
      const cellClass = ($cell.attr('class') || '').slice(0, 80);
      const cellText = clean($cell.text()).slice(0, 60);
      const rowTag = $row.length ? ($row.prop('tagName') || '?') : 'NONE';
      const rowText = $row.length ? clean($row.text()).slice(0, 200) : '';
      const rowHtmlSample = $row.length ? clean($.html($row)).slice(0, 500) : '';
      dbg.cellSamples.push({
        idx: idx, cellTag: cellTag, cellClass: cellClass, cellText: cellText,
        rowSource: rowSource, rowTag: rowTag, rowText: rowText,
        rowHtmlSample: rowHtmlSample
      });
    }

    if (!$row.length) return;

    // Numéro du cheval — plusieurs sources possibles, dans l'ordre de fiabilité
    let numText = '';
    let numSource = '';

    // 1) Attribut data-runner sur le <tr> (le plus fiable)
    const dataRunner = $row.attr('data-runner');
    if (dataRunner) {
      numText = String(dataRunner);
      numSource = 'data-runner';
    }
    // 2) <td class="numero"> avec attribut data-order, ou son texte
    if (!numText) {
      const $tdNumero = $row.find('td.numero, th.numero').first();
      if ($tdNumero.length) {
        numText = $tdNumero.attr('data-order') || clean($tdNumero.text());
        numSource = 'td.numero';
      }
    }
    // 3) <span class="partant"> (souvent enfant direct du td.numero)
    if (!numText) {
      const $partant = $row.find('.partant').first();
      if ($partant.length) {
        numText = clean($partant.text());
        numSource = 'span.partant';
      }
    }
    // 4) Ancien sélecteur (au cas où)
    if (!numText) {
      numText = clean($row.find('.numero-cheval-card').first().text());
      if (numText) numSource = 'numero-cheval-card';
    }
    // 5) Fallback ultime : 1ère cellule non-vide
    if (!numText) {
      $row.find('td').each(function () {
        if (numText) return;
        const t = clean($(this).text());
        if (t && /\d/.test(t)) {
          numText = t;
          numSource = 'first-non-empty-td';
        }
      });
    }

    const numMatch = numText.match(/(\d{1,2})/);

    if (idx === 0 && dbg.cellSamples[0]) {
      dbg.cellSamples[0].numText = numText.slice(0, 60);
      dbg.cellSamples[0].numSource = numSource;
      dbg.cellSamples[0].numMatchOk = !!numMatch;
    }

    if (!numMatch) return;
    const num = parseInt(numMatch[1]);
    if (!num || num > 30 || seen[num]) return;

    // Nom du cheval — multiple stratégies
    let name = clean($row.find('.horse-name').first().text());
    if (!name) name = clean($row.find('td.cheval .first-line a').first().text());
    if (!name) name = clean($row.find('td.cheval').first().text());
    if (!name) name = clean($row.find('.cheval-reunion').first().text());
    if (!name) name = clean($row.find('.card-cheval-casaque').first().text());
    name = name.slice(0, 60);

    // Cotes par classe — on cherche n'importe quel élément avec cette classe
    // dans la ligne, en excluant les TH (en-têtes)
    function findCote(cls) {
      let result = '';
      $row.find('.' + cls).each(function () {
        if (result) return;
        if ($(this).prop('tagName') === 'TH') return;
        const t = clean($(this).text());
        if (t) result = t;
      });
      return result;
    }
    const sgText = findCote('cote-simplegagnant');
    const spText = findCote('cote-simpleplace');
    const zsText = findCote('cote-zeshow');
    const zcText = findCote('cote-zecouillon');

    if (idx === 0 && dbg.cellSamples[0]) {
      dbg.cellSamples[0].sgText = sgText.slice(0, 50);
      dbg.cellSamples[0].spText = spText.slice(0, 50);
      dbg.cellSamples[0].zsText = zsText.slice(0, 50);
      dbg.cellSamples[0].zcText = zcText.slice(0, 50);
    }

    const coteG = firstCote(sgText);
    const sp = rangeCote(spText);
    const coteZS = firstCote(zsText);
    const coteZC = firstCote(zcText);

    if (!coteG && !sp.min && !coteZS && !coteZC) return;

    seen[num] = true;
    participants.push({
      num: num,
      name: name,
      coteG: coteG,
      coteSP_min: sp.min,
      coteSP_max: sp.max,
      coteZS: coteZS,
      coteZC: coteZC,
      rawCotes: [sgText, spText, zsText, zcText]
    });
  });

  dbg.participantsExtracted = participants.length;
  return participants;
}

// Helper : parser tables HTML
function tryParseTables($) {
  let bestParticipants = [];
  $("table").each(function () {
    const $t = $(this);
    const rows = $t.find("tr");
    if (rows.length < 4) return;
    const ps = [];
    rows.each(function () {
      const tds = $(this).find("td");
      if (tds.length < 3) return;
      const numTxt = clean($(tds[0]).text()).match(/^(\d+)/);
      if (!numTxt) return;
      const num = parseInt(numTxt[1]);
      if (!num || num > 30) return;
      const cotes = [];
      tds.each(function () {
        const t = clean($(this).text());
        const single = t.match(/^(\d+[.,]\d+)$/);
        const range = t.match(/^(\d+[.,]\d+)\s*[-–]\s*(\d+[.,]\d+)$/);
        if (range) cotes.push({ raw: t, type: "range", min: parseCote(range[1]), max: parseCote(range[2]) });
        else if (single) cotes.push({ raw: t, type: "single", val: parseCote(single[1]) });
      });
      if (cotes.length < 2) return;
      const nameCell = tds.length > 1 ? clean($(tds[1]).text()).slice(0, 60) : "";
      ps.push(buildParticipant(num, nameCell, cotes));
    });
    if (ps.length > bestParticipants.length) bestParticipants = ps;
  });
  return bestParticipants;
}

// Helper : parser via class CSS
function tryParseClassElements($) {
  // Cherche éléments répétés avec class contenant runner/partant/horse
  const selectors = [
    '[class*="runner" i]',
    '[class*="partant" i]',
    '[class*="participant" i]',
    '[class*="horse" i]',
    '[class*="cheval" i]'
  ];
  let bestParticipants = [];
  for (var s = 0; s < selectors.length; s++) {
    const ps = [];
    $(selectors[s]).each(function () {
      const txt = clean($(this).text());
      // Recherche un n° suivi de cotes décimales dans le texte interne
      const numMatch = txt.match(/^\s*(\d{1,2})\b/);
      if (!numMatch) return;
      const num = parseInt(numMatch[1]);
      if (!num || num > 30) return;
      const cotesMatch = txt.match(/(\d+[.,]\d+)/g);
      if (!cotesMatch || cotesMatch.length < 2) return;
      const cotes = cotesMatch.map(function (c) { return { raw: c, type: "single", val: parseCote(c) }; });
      ps.push(buildParticipant(num, txt.slice(0, 60), cotes));
    });
    // Dédupliquer par numéro
    const seen = {};
    const dedup = [];
    ps.forEach(function (p) { if (!seen[p.num]) { seen[p.num] = true; dedup.push(p); } });
    if (dedup.length > bestParticipants.length) bestParticipants = dedup;
  }
  return bestParticipants;
}

// Helper : structures répétées (divs, li, etc.)
function tryParseRepeatedStructure($) {
  // Cherche tout élément contenant N enfants directs ayant la même tag+class
  let bestParticipants = [];
  $('*').each(function () {
    const $parent = $(this);
    const children = $parent.children();
    if (children.length < 4 || children.length > 30) return;
    // Tous les enfants doivent avoir le même tag
    const firstTag = children[0].tagName;
    let same = true;
    children.each(function () { if (this.tagName !== firstTag) same = false; });
    if (!same) return;
    // Tester chaque enfant comme une "ligne" de participant
    const ps = [];
    children.each(function () {
      const txt = clean($(this).text());
      if (txt.length < 5 || txt.length > 300) return;
      const numMatch = txt.match(/^\s*(\d{1,2})\b/);
      if (!numMatch) return;
      const num = parseInt(numMatch[1]);
      if (!num || num > 30) return;
      const cotesMatch = txt.match(/(\d+[.,]\d+)/g);
      if (!cotesMatch || cotesMatch.length < 2) return;
      const cotes = cotesMatch.map(function (c) { return { raw: c, type: "single", val: parseCote(c) }; });
      ps.push(buildParticipant(num, txt.slice(0, 60), cotes));
    });
    const seen = {};
    const dedup = [];
    ps.forEach(function (p) { if (!seen[p.num]) { seen[p.num] = true; dedup.push(p); } });
    if (dedup.length >= 4 && dedup.length > bestParticipants.length) bestParticipants = dedup;
  });
  return bestParticipants;
}

// Helper : scan body text brut
function tryParseBodyText($) {
  const body = clean($("body").text());
  let zoneStart = -1;
  const cotesAnchor = body.match(/(?:Choisissez\s+vos\s+chevaux|COTES|Simple\s+gagnant)/i);
  if (cotesAnchor) zoneStart = cotesAnchor.index;
  if (zoneStart < 0) return [];
  const zone = body.slice(zoneStart, zoneStart + 12000);
  const lineRe = /\b(\d{1,2})\b[^\d]{0,200}?(\d+[.,]\d+)\s+(\d+[.,]\d+)(?:\s*[-–]\s*(\d+[.,]\d+))?\s+(\d+[.,]\d+)\s+(\d+[.,]\d+)/g;
  const ps = [];
  const seen = {};
  let m;
  while ((m = lineRe.exec(zone)) !== null && ps.length < 30) {
    const num = parseInt(m[1]);
    if (!num || num > 30 || seen[num]) continue;
    seen[num] = true;
    const cotes = [];
    if (m[4] !== undefined) {
      cotes.push({ raw: m[2], type: "single", val: parseCote(m[2]) });
      cotes.push({ raw: m[3] + "-" + m[4], type: "range", min: parseCote(m[3]), max: parseCote(m[4]) });
      cotes.push({ raw: m[5], type: "single", val: parseCote(m[5]) });
      cotes.push({ raw: m[6], type: "single", val: parseCote(m[6]) });
    } else {
      cotes.push({ raw: m[2], type: "single", val: parseCote(m[2]) });
      cotes.push({ raw: m[3], type: "single", val: parseCote(m[3]) });
      cotes.push({ raw: m[5], type: "single", val: parseCote(m[5]) });
      cotes.push({ raw: m[6], type: "single", val: parseCote(m[6]) });
    }
    ps.push(buildParticipant(num, "", cotes));
  }
  return ps;
}

// Helper : construit un participant à partir de numéro, nom, et tableau de cotes
function buildParticipant(num, name, cotes) {
  let coteG = 0, coteSP_min = 0, coteSP_max = 0, coteZS = 0, coteZC = 0;
  if (cotes.length >= 5) {
    coteG = cotes[1].val || cotes[1].min || cotes[0].val || cotes[0].min || 0;
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
  } else if (cotes.length === 3) {
    coteG = cotes[0].val || cotes[0].min || 0;
    coteZS = cotes[1].val || cotes[1].min || 0;
    coteZC = cotes[2].val || cotes[2].min || 0;
  } else if (cotes.length === 2) {
    coteG = cotes[0].val || cotes[0].min || 0;
    coteZS = cotes[1].val || cotes[1].min || 0;
  }
  return {
    num: num, name: name,
    coteG: coteG, coteSP_min: coteSP_min, coteSP_max: coteSP_max,
    coteZS: coteZS, coteZC: coteZC,
    rawCotes: cotes.map(function (c) { return c.raw; })
  };
}

// ===================== ROUTES =====================

app.get("/", function (req, res) {
  res.json({ status: "ok", message: "MTURF Robot OK", time: new Date().toISOString(), version: "v8.8-ultimate-diag" });
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
// V8.0 NEW : ROUTES COTES PRÉ-COURSE
// ============================================================

// Route principale — slug direct
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

// Route auto — trouve le slug à partir de date/reunion/course en passant par la page de réunion
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

  // Si hippo fourni → on tente le slug direct (rapide, 1 seul fetch)
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
      // Si la page existe mais pas de cotes parseées : on tente quand même la méthode auto
    } catch (e) {
      // 404 ou autre : fallback sur la méthode auto
    }
  }

  // Méthode auto : on cherche le slug via la page réunion
  // ZEturf utilise /fr/reunion-du-jour/<date>/<reunion-slug>
  // Mais on ne connaît pas l'hippo… on peut tenter via la home du jour
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

// Route debug — retourne en plus des extraits HTML pour diagnostic
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
      // Zone de texte autour de "Simple gagnant" si présent
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
