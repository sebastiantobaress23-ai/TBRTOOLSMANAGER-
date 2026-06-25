'use strict';
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Origin': 'https://www.afip.gob.ar',
        'Referer': 'https://www.afip.gob.ar/',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout 5s')); });
    req.on('error', reject);
  });
}

// CUIT de prueba conocido: AFIP misma (33693450239) o un CUIT público cualquiera
const CUIT_PRUEBA = '20000000000'; // no existe, debería dar 404 limpio

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const cuit = req.query?.cuit || CUIT_PRUEBA;
  const resultados = [];

  const urls = [
    `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${cuit}`,
    `https://soa.afip.gov.ar/sr-padron/v2/persona/${cuit}`,
    `https://arca.gob.ar/sr-padron/v2/persona/${cuit}`,
  ];

  for (const url of urls) {
    const t0 = Date.now();
    try {
      const r = await httpsGet(url);
      resultados.push({ url, status: r.status, ms: Date.now()-t0, body: r.body });
    } catch(e) {
      resultados.push({ url, error: e.message, ms: Date.now()-t0 });
    }
  }

  return res.status(200).json({ cuit, resultados });
};
