/**
 * Vercel serverless function: consulta Padrón público ARCA/AFIP
 * GET /api/arca-padron?cuit=20430697529
 *
 * Usa la API pública de AFIP — no requiere autenticación.
 * Solo funciona con CUIT (11 dígitos). Para DNI no hay lookup público.
 */

'use strict';
const https  = require('https');
const crypto = require('crypto');

const SSL_OP_LEGACY = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0;
const SSL_OP_RENEG  = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION || 0;
const sslAgent = new https.Agent({
  secureOptions: SSL_OP_LEGACY | SSL_OP_RENEG,
  ciphers: 'DEFAULT:@SECLEVEL=0',
  rejectUnauthorized: false,
});

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: sslAgent, headers: { 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('Respuesta inválida del padrón ARCA')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout consultando padrón')); });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const cuit = String(req.query?.cuit || '').replace(/\D/g, '');
  if (!cuit || cuit.length !== 11)
    return res.status(400).json({ error: 'CUIT inválido — debe tener 11 dígitos' });

  try {
    const { status, body } = await fetchJSON(
      `https://soa.afip.gob.ar/sr-padron/v2/persona/${cuit}`
    );

    if (status === 404 || !body?.data)
      return res.status(404).json({ error: 'CUIT no encontrado en el padrón de ARCA' });

    if (status !== 200)
      return res.status(502).json({ error: 'Error del padrón ARCA: ' + JSON.stringify(body).slice(0, 200) });

    const d = body.data;
    const dom = d.domicilioFiscal || {};

    // Normalize: personas físicas tienen nombre+apellido, jurídicas tienen razonSocial
    const nombre = d.razonSocial
      || [d.apellido, d.nombre].filter(Boolean).join(', ')
      || '';

    return res.status(200).json({
      cuit:       String(d.idPersona || cuit),
      nombre,
      categoriaIVA: d.categoriasMonotributo
        ? 'Monotributo ' + (d.categoriasMonotributo.categoria || '')
        : (d.categoriaIVA || ''),
      estadoClave:  d.estadoClave || '',
      direccion:    dom.direccion || '',
      localidad:    dom.localidad || '',
      provincia:    dom.descripcionProvincia || '',
      codPostal:    dom.codPostal || '',
    });
  } catch (e) {
    console.error('Padrón error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
