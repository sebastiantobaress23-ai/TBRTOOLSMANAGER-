'use strict';
const https = require('https');

// Consulta la API REST pública de ARCA (sin autenticación)
// GET /api/arca-padron?doc=20430697529
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('Respuesta no es JSON: ' + data.slice(0,100))); }
      });
    }).on('error', reject);
  });
}

function normalizeRest(p) {
  if (!p) return null;
  const nombre = p.nombre || p.razonSocial
    || [p.apellido, p.nombre].filter(Boolean).join(', ')
    || '';
  let categoriaIVA = '';
  if (p.categoriasMonotributo?.categoriaMonotributo) {
    const cat = p.categoriasMonotributo.categoriaMonotributo;
    const c = Array.isArray(cat) ? cat[0] : cat;
    categoriaIVA = 'Monotributo ' + (c?.idCategoria || '');
  } else if (p.categoriaIVA) {
    categoriaIVA = p.categoriaIVA;
  } else if (p.impuesto) {
    const imp = Array.isArray(p.impuesto) ? p.impuesto : [p.impuesto];
    const iva = imp.find(i => i.idImpuesto === 32 || i.idImpuesto === 30);
    if (iva) categoriaIVA = iva.descripcionImpuesto || '';
  }
  const dom = p.domicilioFiscal || p.domicilio || {};
  return {
    cuit:         String(p.idPersona || ''),
    nombre,
    categoriaIVA,
    estadoClave:  p.estadoClave || '',
    direccion:    dom.direccion || dom.calle || '',
    localidad:    dom.localidad || dom.descripcionLocalidad || '',
    provincia:    dom.descripcionProvincia || dom.provincia || '',
    codPostal:    String(dom.codPostal || dom.codigoPostal || ''),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const doc = String(req.query?.doc || '').replace(/\D/g, '');
  if (!doc || doc.length < 7)
    return res.status(400).json({ error: 'Ingresá un CUIT (11 dígitos) o DNI (7-8 dígitos)' });

  const esCUIT = doc.length === 11;
  const esDNI  = doc.length >= 7 && doc.length <= 8;
  if (!esCUIT && !esDNI)
    return res.status(400).json({ error: 'Documento inválido. CUIT: 11 dígitos, DNI: 7-8 dígitos' });

  // Intentar API REST pública de ARCA (no requiere autenticación)
  if (esCUIT) {
    try {
      const url = `https://soa.afip.gov.ar/sr-padron/v2/persona/${doc}`;
      console.log('Consultando REST ARCA:', url);
      const { status, body } = await httpsGet(url);
      console.log('REST ARCA status:', status, 'body keys:', Object.keys(body||{}));
      if (status === 200 && body?.data) {
        const persona = normalizeRest(body.data);
        if (persona?.nombre) {
          return res.status(200).json(persona);
        }
      }
      if (status === 404) {
        return res.status(404).json({ error: 'CUIT no encontrado en ARCA' });
      }
      console.warn('REST ARCA respuesta inesperada:', status, JSON.stringify(body).slice(0,200));
    } catch (e) {
      console.error('REST ARCA error:', e.message);
    }
  }

  // Fallback: intentar con la segunda URL pública
  if (esCUIT) {
    try {
      const url = `https://soa.afip.gov.ar/sr-padron/v1/persona/${doc}`;
      const { status, body } = await httpsGet(url);
      if (status === 200 && body?.data) {
        const persona = normalizeRest(body.data);
        if (persona?.nombre) return res.status(200).json(persona);
      }
    } catch (e) {
      console.error('REST ARCA v1 error:', e.message);
    }
  }

  return res.status(404).json({ error: `No se pudo obtener datos para ${esCUIT ? 'CUIT' : 'DNI'} ${doc}. Verificá que esté registrado en ARCA.` });
};
