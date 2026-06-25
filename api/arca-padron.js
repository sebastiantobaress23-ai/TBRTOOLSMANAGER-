'use strict';
const https = require('https');

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      rejectUnauthorized: false,
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-AR,es;q=0.9',
        ...extraHeaders,
      },
    };
    const req = https.get(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: null }); }
        catch { resolve({ status: res.statusCode, body: null, raw: data.slice(0, 300) }); }
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
  if (!p || typeof p !== 'object') return null;
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
    const iva = imp.find(i => [30, 32].includes(i?.idImpuesto));
    if (iva) categoriaIVA = iva.descripcionImpuesto || '';
  }

  // El domicilio puede venir como objeto o como array
  const domArr = Array.isArray(p.domicilio) ? p.domicilio : null;
  const dom = p.domicilioFiscal
    || (domArr ? domArr.find(d => d.tipoDomicilio === 'FISCAL') || domArr[0] : null)
    || (typeof p.domicilio === 'object' && !Array.isArray(p.domicilio) ? p.domicilio : null)
    || {};

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
    // Constancias fiscales — endpoint de verificación pública (QR constancias)
    {
      url: `https://constancias.afip.gob.ar/nrConstancia/rest/consulta/${cuit}`,
      extra: { 'Origin': 'https://constancias.afip.gob.ar', 'Referer': 'https://constancias.afip.gob.ar/' },
      extract: body => body?.persona || body,
    },
    // TaD — portal Trámites a Distancia
    {
      url: `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${cuit}`,
      extra: { 'Origin': 'https://www.afip.gob.ar', 'Referer': 'https://www.afip.gob.ar/' },
      extract: body => body?.persona || body?.data || body,
    },
    // ARCA — nuevo dominio
    {
      url: `https://arca.gob.ar/sr-padron/v2/persona/${cuit}`,
      extra: { 'Origin': 'https://arca.gob.ar', 'Referer': 'https://arca.gob.ar/' },
      extract: body => body?.data || body?.persona || body,
    },
  ];

  for (const { url, extra, extract } of intentos) {
    try {
      console.log(`[padron] GET ${url}`);
      const { status, body, raw } = await httpsGet(url, extra);
      console.log(`[padron] ${cuit} ${url.split('/')[2]} → ${status} | ${body ? JSON.stringify(body).slice(0, 120) : raw}`);

      if (status === 404) { console.log(`[padron] 404 en ${url.split('/')[2]}, siguiente`); continue; }
      if (status !== 200 || !body) continue;

      const raw2 = extract(body);
      if (!raw2 || Array.isArray(raw2) || typeof raw2 !== 'object') continue;

      const persona = normalizeRest(raw2);
      if (persona) return { persona, encontrado: true };
    } catch (e) {
      console.log(`[padron] error ${url.split('/')[2]}: ${e.message}`);
    }
  }
  return { persona: null, encontrado: false };
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
    const { persona } = await consultarCUIT(doc);
    if (persona) return res.status(200).json(persona);
    return res.status(404).json({ error: 'notFound', msg: `CUIT ${doc} no encontrado en ARCA.` });
  }

  // DNI → derivar CUITs posibles y consultarlos en paralelo
  const posibles = cuitsDesdeDNI(doc);
  console.log(`[padron] DNI ${doc} → CUITs posibles: ${posibles.join(', ')}`);

  const resultados = await Promise.all(posibles.map(c => consultarCUIT(c)));
  const personas   = resultados.map(r => r?.persona).filter(Boolean);

  if (personas.length === 1) return res.status(200).json(personas[0]);
  if (personas.length > 1)  return res.status(200).json({ multiple: true, personas });

  return res.status(404).json({
    error: 'notFound',
    msg: `DNI ${doc} no tiene CUIT registrado en ARCA.`,
    cuitsTesteados: posibles,
  });
};
