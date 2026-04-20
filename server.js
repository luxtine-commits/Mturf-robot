const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.get('/', (req, res) => {
  res.send('MTURF Robot OK');
});

app.get('/zeturf', async (req, res) => {
  try {
    const url = 'https://www.zeturf.fr/fr/course-du-jour';

    const response = await fetch(url);
    const text = await response.text();

    res.send({
      status: "ok",
      message: "Connexion ZEturf OK",
      length: text.length
    });

  } catch (err) {
    res.send({
      status: "error",
      message: err.toString()
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
