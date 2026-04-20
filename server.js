const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();

function uniqBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanHippodromeFromSlug(slug) {
  return decodeURIComponent(slug || '')
    .replace(/^prix-de-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

app.get('/', (req, res) => {
  res.send('MTURF Robot OK');
});

app.get('/zeturf', async (req, res) => {
  try {
    const url = 'https://www.zeturf.fr/fr/course-du-jour';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 MTURF Robot'
      }
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const courses = [];

    $('a[href*="/fr/course-du-jour/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.zeturf.fr${href}`;

      const match = fullUrl.match(
        /\/fr\/course-du-jour\/(\d{4}-\d{2}-\d{2})\/R(\d+)C(\d+)-([^/?#]+)/
      );

      if (!match) return;

      const [, date, reunion, course, slug] = match;

      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const parentText = $(el).parent().text().replace(/\s+/g, ' ').trim();
      const blocText = ($(el).closest('li, article, div').text() || '')
        .replace(/\s+/g, ' ')
        .trim();

      const heureMatch = `${text} ${parentText} ${blocText}`.match(/\b(\d{1,2})[:h](\d{2})\b/);
      const heure = heureMatch ? `${heureMatch[1].padStart(2, '0')}:${heureMatch[2]}` : null;

      courses.push({
        date,
        reunion: Number(reunion),
        course: Number(course),
        heure,
        hippodrome: cleanHippodromeFromSlug(slug),
        label: text || null,
        url: fullUrl
      });
    });

    const propres = uniqBy(courses, (c) => `${c.date}-R${c.reunion}C${c.course}`)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.reunion !== b.reunion) return a.reunion - b.reunion;
        return a.course - b.course;
      });

    res.json({
      status: 'ok',
      total: propres.length,
      courses: propres
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.toString()
    });
  }
});

app.get('/zeturf/mturf', async (req, res) => {
  try {
    const url = 'https://www.zeturf.fr/fr/course-du-jour';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 MTURF Robot'
      }
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const lignes = [];

    $('a[href*="/fr/course-du-jour/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.zeturf.fr${href}`;

      const match = fullUrl.match(
        /\/fr\/course-du-jour\/(\d{4}-\d{2}-\d{2})\/R(\d+)C(\d+)-([^/?#]+)/
      );

      if (!match) return;

      const [, date, reunion, course, slug] = match;
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const blocText = ($(el).closest('li, article, div').text() || '')
        .replace(/\s+/g, ' ')
        .trim();
      const heureMatch = `${text} ${blocText}`.match(/\b(\d{1,2})[:h](\d{2})\b/);
      const heure = heureMatch ? `${heureMatch[1].padStart(2, '0')}:${heureMatch[2]}` : '';

      lignes.push({
        Date: date,
        Reunion: `R${reunion}`,
        Course: `C${course}`,
        Heure: heure,
        Hippodrome: cleanHippodromeFromSlug(slug),
        Numero1: '',
        Numero2: '',
        Statut: 'A_ANALYSER',
        URL: fullUrl
      });
    });

    const propres = uniqBy(lignes, (c) => `${c.Date}-${c.Reunion}-${c.Course}`)
      .sort((a, b) => {
        if (a.Date !== b.Date) return a.Date.localeCompare(b.Date);
        const ra = Number(a.Reunion.replace('R', ''));
        const rb = Number(b.Reunion.replace('R', ''));
        if (ra !== rb) return ra - rb;
        return Number(a.Course.replace('C', '')) - Number(b.Course.replace('C', ''));
      });

    res.json({
      status: 'ok',
      total: propres.length,
      tableau_mturf: propres
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.toString()
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
