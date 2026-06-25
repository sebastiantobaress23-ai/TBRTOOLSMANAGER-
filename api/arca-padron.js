'use strict';
const https = require('https');

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      rejectUnauthorized: false,
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-AR,es;q=0.9',
        'Origin': 'https://www.afip.gob.ar',
        'Referer': 'https://www.afip.gob.ar/',
        ...extraHeaders,
      },
    };
    const req = https.get(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data.slice(0, 200) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Dígito verificador CUIT
function calcVerif(prefix, dni) {
  const base = String(prefix) + String(dni).padStart(8, '0');
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = base.split('').reduce((acc, d, i) => acc + parseInt(d) * pesos[i], 0);
  const resto = suma % 11;
  if (resto === 0) return 0;
  if (resto === 1) return null;
  return 11 - resto;
}

function cuitsDesdeDNI(dni) {
  const cuits = [];
  for (const p of [20, 23, 24, 27]) {
    const v = calcVerif(p, dni);
    if (v !== null) cuits.push(`${p}${String(dni).padStart(8, '0')}${v}`);
  }
  return cuits;
}

function normalizeRest(p) {
  if (!p) return null;
  const nombre = p.razonSocial
    || (p.apellido && p.nombre ? `${p.apellido}, ${p.nombre}` : null)
    || p.nombre || '';
  if (!nombre.trim()) return null;

  let categoriaIVA = '';
  if (p.categoriasMonotributo?.categoriaMonotributo) {
    const cat = p.categoriasMonotributo.categoriaMonotributo;
    const c = Array.isArray(cat) ? cat[0] : cat;
    categoriaIVA = 'Monotributo ' + (c?.idCategoria || '');
  } else if (p.categoriaIVA) {
    categoriaIVA = p.categoriaIVA;
  } else if (p.impuesto) {
    const imp = Array.isArray(p.impuesto) ? p.impuesto : [p.impuesto];
    const iva = imp.find(i => [30, 32].includes(i.idImpuesto));
    if (iva) categoriaIVA = iva.descripcionImpuesto || '';
  }

  const dom = p.domicilioFiscal || p.domicilio || {};
  let direccion = dom.direccion || '';
  if (!direccion && dom.calle) {
    direccion = [dom.calle, dom.numero, dom.piso && `piso ${dom.piso}`, dom.depto && `dto ${dom.depto}`]
      .filter(Boolean).join(' ');
  }

  return {
    cuit:        String(p.idPersona || ''),
    nombre:      nombre.trim(),
    categoriaIVA,
    estadoClave: p.estadoClave || '',
    direccion:   direccion.trim(),
    localidad:   dom.descripcionLocalidad || dom.localidad || '',
    provincia:   dom.descripcionProvincia || dom.provincia || '',
    codPostal:   String(dom.codPostal || dom.codigoPostal || ''),
  };
}

async function consultarCUIT(cuit) {
  const intentos = [
    // tramitesadistancia — más accesible públicamente
    { url: `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${cuit}`, key: 'persona' },
    // REST v2 oficial
    { url: `https://soa.afip.gov.ar/sr-padron/v2/persona/${cuit}`, key: 'data' },
    // REST v1 oficial
    { url: `https://soa.afip.gov.ar/sr-padron/v1/persona/${cuit}`, key: 'data' },
  ];

  for (const { url, key } of intentos) {
    try {
      console.log(`[padron] GET ${url}`);
      const { status, body, raw } = await httpsGet(url);
      console.log(`[padron] ${status} body=${body ? JSON.stringify(body).slice(0,120) : raw}`);
      if (status !== 200 || !body) continue;
      const raw2 = body[key] || body;
      if (!raw2 || Array.isArray(raw2)) continue;
      const persona = normalizeRest(raw2);
      if (persona) return persona;
    } catch (e) {
      console.error(`[padron] error ${url}: ${e.message}`);
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const doc = String(req.query?.doc || '').replace(/\D/g, '');
  if (!doc || doc.length < 7 || doc.length > 11)
    return res.status(400).json({ error: 'Ingresá un CUIT (11 dígitos) o DNI (7-8 dígitos)' });

  const esCUIT = doc.length === 11;

  if (esCUIT) {
    const persona = await consultarCUIT(doc);
    if (persona) return res.status(200).json(persona);
    return res.status(404).json({ error: `CUIT ${doc} no encontrado en ARCA. Verificá que esté inscripto.` });
  }

  // DNI → derivar CUITs posibles y consultarlos en paralelo
  const posibles = cuitsDesdeDNI(doc);
  console.log(`[padron] DNI ${doc} → CUITs posibles: ${posibles.join(', ')}`);

  const resultados = await Promise.all(posibles.map(c => consultarCUIT(c)));
  const encontrados = resultados.filter(Boolean);

  if (encontrados.length === 0) {
    return res.status(404).json({
      error: `DNI ${doc} no encontrado en ARCA. Si la persona no está inscripta en AFIP, ingresá los datos manualmente.`
    });
  }
  if (encontrados.length === 1) return res.status(200).json(encontrados[0]);
  return res.status(200).json({ multiple: true, personas: encontrados });
};
