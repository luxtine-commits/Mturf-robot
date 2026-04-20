const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("MTURF Robot OK");
});

app.get("/zeturf/course", async (req, res) => {
  try {
    const courseUrl = req.query.url;
    if (!courseUrl) {
      return res.status(400).json({
        status: "error",
        message: "Paramètre url manquant"
      });
    }

    const response = await fetch(courseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const pageText = $("body").text().replace(/\s+/g, " ").trim();

    const rcMatch = pageText.match(/\bR(\d+)\s+C(\d+)\b/);
    const lieuDateMatch = pageText.match(/([A-ZÀ-ÖØ-Ý' -]+)\s+(\d{2}\/\d{2}\/\d{4})/);
    const courseMatch = pageText.match(/(\d{1,2}h\d{2})\s+([^]+?)\s+Plat\s*-\s*(\d+)m\s*-\s*([\d\s]+€)\s*-\s*(\d+)\s+Partants/);
    const arriveeMatch = pageText.match(/Arrivée officielle\s*:\s*([0-9 -]+)/);

    const rows = [];
    $("body *").each((_, el) => {
      const t = $(el).text().replace(/\s+/g, " ").trim();
      const m = t.match(/^(\d+er|\d+e)\s+(\d+)\s+([A-Z'À-ÖØ-Ý -]+)$/i);
      if (m) {
        rows.push({
          place: m[1],
          numero: m[2],
          cheval: m[3].trim()
        });
      }
    });

    res.json({
      status: "ok",
      url: courseUrl,
      reunion: rcMatch ? `R${rcMatch[1]}` : "",
      course: rcMatch ? `C${rcMatch[2]}` : "",
      hippodrome: lieuDateMatch ? lieuDateMatch[1].trim() : "",
      date: lieuDateMatch ? lieuDateMatch[2] : "",
      heure: courseMatch ? courseMatch[1] : "",
      nom_course: courseMatch ? courseMatch[2].trim() : "",
      distance: courseMatch ? `${courseMatch[3]}m` : "",
      allocation: courseMatch ? courseMatch[4].trim() : "",
      partants: courseMatch ? courseMatch[5] : "",
      arrivee_officielle: arriveeMatch ? arriveeMatch[1].trim() : "",
      top4: rows.slice(0, 4)
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.toString()
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
