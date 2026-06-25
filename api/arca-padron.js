'use strict';
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error('Respuesta no es JSON: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

// Calcula el dígito verificador de un CUIT dado el prefijo y el DNI
function calcVerif(prefix, dni) {
  const base = String(prefix) + String(dni).padStart(8, '0');
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = base.split('').reduce((acc, d, i) => acc + parseInt(d) * pesos[i], 0);
  const resto = suma % 11;
  if (resto === 0) return 0;
  if (resto === 1) return null; // CUIT inválido para este prefijo
  return 11 - resto;
}

// Genera todos los CUITs posibles a partir de un DNI
function cuitsDesdeDNI(dni) {
  const prefijos = [20, 23, 24, 27]; // masculino, especial, especial, femenino
  const cuits = [];
  for (const p of prefijos) {
    const v = calcVerif(p, dni);
    if (v !== null) {
      cuits.push(`${p}${String(dni).padStart(8, '0')}${v}`);
    }
  }
  return cuits;
}

function normalizeRest(p) {
  if (!p) return null;
  const nombre = p.razonSocial
    || (p.apellido && p.nombre ? `${p.apellido}, ${p.nombre}` : null)
    || p.nombre
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
  let direccion = dom.direccion || '';
  if (!direccion && dom.calle) {
    direccion = dom.calle + (dom.numero ? ' ' + dom.numero : '');
    if (dom.piso) direccion += ' piso ' + dom.piso;
    if (dom.depto) direccion += ' dto ' + dom.depto;
  }
  const localidad = dom.descripcionLocalidad || dom.localidad || '';
  const provincia = dom.descripcionProvincia || dom.provincia || '';
  return {
    cuit:        String(p.idPersona || ''),
    nombre:      nombre.trim(),
    categoriaIVA,
    estadoClave: p.estadoClave || '',
    direccion:   direccion.trim(),
    localidad,
    provincia,
    codPostal:   String(dom.codPostal || dom.codigoPostal || ''),
  };
}

async function consultarCUIT(cuit) {
  const urls = [
    `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${cuit}`,
    `https://soa.afip.gov.ar/sr-padron/v2/persona/${cuit}`,
    `https://soa.afip.gov.ar/sr-padron/v1/persona/${cuit}`,
  ];
  for (const url of urls) {
    try {
      const { status, body } = await httpsGet(url);
      if (status !== 200) continue;
      const raw = body?.persona || body?.data;
      if (!raw || Array.isArray(raw)) continue;
      const persona = normalizeRest(raw);
      if (persona?.nombre) return persona;
    } catch (e) {
      console.error('Error consultando', url, ':', e.message);
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
  if (!doc || doc.length < 7)
    return res.status(400).json({ error: 'Ingresá un CUIT (11 dígitos) o DNI (7-8 dígitos)' });

  const esCUIT = doc.length === 11;
  const esDNI  = doc.length >= 7 && doc.length <= 8;
  if (!esCUIT && !esDNI)
    return res.status(400).json({ error: 'Documento inválido. CUIT: 11 dígitos, DNI: 7-8 dígitos' });

  if (esCUIT) {
    const persona = await consultarCUIT(doc);
    if (persona) return res.status(200).json(persona);
    return res.status(404).json({ error: `CUIT ${doc} no encontrado en ARCA.` });
  }

  // Para DNI: derivar todos los CUITs posibles y probarlos en paralelo
  const cuits = cuitsDesdeDNI(doc);
  console.log(`DNI ${doc} → CUITs a probar:`, cuits);

  const resultados = await Promise.all(cuits.map(c => consultarCUIT(c)));
  const encontrados = resultados.filter(Boolean);

  if (encontrados.length === 0) {
    return res.status(404).json({
      error: `DNI ${doc} no encontrado en ARCA. Si la persona no está inscripta en AFIP, ingresá los datos manualmente.`
    });
  }
  if (encontrados.length === 1) {
    return res.status(200).json(encontrados[0]);
  }
  // Múltiples CUITs activos para el mismo DNI (raro pero posible)
  return res.status(200).json({ multiple: true, personas: encontrados });
};
