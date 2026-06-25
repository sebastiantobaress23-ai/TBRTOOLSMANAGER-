export const config = { runtime: 'edge' };

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

function normalizePersona(p) {
  if (!p || typeof p !== 'object') return null;
  const nombre = p.razonSocial
    || (p.apellido && p.nombre ? `${p.apellido}, ${p.nombre}` : null)
    || p.nombre || '';
  if (!nombre.trim()) return null;

  const domArr = Array.isArray(p.domicilio) ? p.domicilio : null;
  const dom = p.domicilioFiscal
    || (domArr ? (domArr.find(d => d.tipoDomicilio === 'FISCAL') || domArr[0]) : null)
    || (typeof p.domicilio === 'object' && !Array.isArray(p.domicilio) ? p.domicilio : null)
    || {};

  let direccion = dom.direccion || '';
  if (!direccion && dom.calle) {
    direccion = [dom.calle, dom.numero, dom.piso && `piso ${dom.piso}`, dom.depto && `dto ${dom.depto}`]
      .filter(Boolean).join(' ');
  }

  return {
    cuit:      String(p.idPersona || ''),
    nombre:    nombre.trim(),
    direccion: direccion.trim(),
    localidad: dom.descripcionLocalidad || dom.localidad || '',
    provincia: dom.descripcionProvincia || dom.provincia || '',
  };
}

async function fetchCUIT(cuit) {
  const endpoints = [
    {
      url: `https://constancias.afip.gob.ar/nrConstancia/rest/consulta/${cuit}`,
      extract: b => b?.persona || b,
    },
    {
      url: `https://afip.tramitesadistancia.gob.ar/generic-person/person-endpoint-general/persona/${cuit}`,
      extract: b => b?.persona || b?.data || b,
    },
    {
      url: `https://soa.afip.gov.ar/sr-padron/v2/persona/${cuit}`,
      extract: b => b?.data || b?.persona || b,
    },
  ];

  for (const { url, extract } of endpoints) {
    try {
      console.log(`[edge] GET ${url}`);
      const r = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.afip.gob.ar',
          'Referer': 'https://www.afip.gob.ar/',
        },
      });
      const text = await r.text();
      console.log(`[edge] ${r.status} ${url.split('/')[2]} | ${text.slice(0,200)}`);
      if (!r.ok) continue;
      let body; try { body = JSON.parse(text); } catch { continue; }
      const raw = extract(body);
      if (!raw || Array.isArray(raw)) continue;
      const persona = normalizePersona(raw);
      if (persona) return persona;
    } catch (e) { console.log(`[edge] error: ${e.message}`); }
  }
  return null;
}

export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers });

  const { searchParams } = new URL(req.url);
  const doc = (searchParams.get('doc') || '').replace(/\D/g, '');
  if (!doc || doc.length < 7 || doc.length > 11)
    return new Response(JSON.stringify({ error: 'CUIT (11 dígitos) o DNI (7-8 dígitos)' }), { status: 400, headers });

  if (doc.length === 11) {
    const persona = await fetchCUIT(doc);
    if (persona) return new Response(JSON.stringify(persona), { status: 200, headers });
    return new Response(JSON.stringify({ error: 'notFound' }), { status: 404, headers });
  }

  const posibles = cuitsDesdeDNI(doc);
  const resultados = await Promise.all(posibles.map(c => fetchCUIT(c)));
  const encontrados = resultados.filter(Boolean);

  if (encontrados.length === 1) return new Response(JSON.stringify(encontrados[0]), { status: 200, headers });
  if (encontrados.length > 1)  return new Response(JSON.stringify({ multiple: true, personas: encontrados }), { status: 200, headers });
  return new Response(JSON.stringify({ error: 'notFound', cuitsTesteados: posibles }), { status: 404, headers });
}
