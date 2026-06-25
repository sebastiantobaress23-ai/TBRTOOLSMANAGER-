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
  // Armar dirección con calle + número si están separados
  let direccion = dom.direccion || '';
  if (!direccion && dom.calle) {
    direccion = dom.calle + (dom.numero ? ' ' + dom.numero : '');
    if (dom.piso) direccion += ' piso ' + dom.piso;
    if (dom.depto) direccion += ' dto ' + dom.depto;
  }
  const localidad = dom.descripcionLocalidad || dom.localidad || '';
  const provincia = dom.descripcionProvincia || dom.provincia || '';
  return {
    cuit:         String(p.idPersona || ''),
    nombre:       nombre.trim(),
    categoriaIVA,
    estadoClave:  p.estadoClave || '',
    direccion:    direccion.trim(),
    localidad,
    provincia,
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

  const endpoints = esCUIT ? [
    // Endpoint público de ARCA via tramitesadistancia (más confiable)
    `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${doc}`,
    // Fallbacks REST oficiales
    `https://soa.afip.gov.ar/sr-padron/v2/persona/${doc}`,
    `https://soa.afip.gov.ar/sr-padron/v1/persona/${doc}`,
  ] : [
    // Para DNI: endpoint de búsqueda por documento
    `https://soa.afip.gov.ar/sr-padron/v2/personas?documento=${doc}&tipodocumento=96`,
  ];

  for (const url of endpoints) {
    try {
      console.log('Consultando ARCA:', url);
      const { status, body } = await httpsGet(url);
      console.log('ARCA status:', status, 'keys:', Object.keys(body || {}));

      if (status !== 200) continue;

      // tramitesadistancia devuelve { persona: {...} }
      // soa.afip.gov.ar devuelve { data: {...} } o { data: [{...}] }
      const raw = body?.persona || body?.data;
      if (!raw) continue;

      // Múltiples resultados (búsqueda por DNI)
      if (Array.isArray(raw)) {
        if (raw.length === 0) continue;
        if (raw.length === 1) {
          const persona = normalizeRest(raw[0]);
          if (persona?.nombre) return res.status(200).json(persona);
        } else {
          const personas = raw.map(normalizeRest).filter(p => p?.nombre);
          if (personas.length === 0) continue;
          return res.status(200).json({ multiple: true, personas });
        }
        continue;
      }

      // Resultado único
      const persona = normalizeRest(raw);
      if (persona?.nombre) return res.status(200).json(persona);

    } catch (e) {
      console.error('Error consultando', url, ':', e.message);
    }
  }

  return res.status(404).json({
    error: `No se encontraron datos para ${esCUIT ? 'CUIT' : 'DNI'} ${doc} en ARCA. Verificá que esté inscripto.`
  });
};
