/**
 * Vercel serverless function: consulta Padrón ARCA ws_sr_padron_a5
 * GET /api/arca-padron?doc=20430697529   (CUIT 11 dígitos)
 * GET /api/arca-padron?doc=12345678      (DNI 7-8 dígitos)
 *
 * Usa autenticación WSAA con las mismas credenciales del facturador.
 */

'use strict';
const soap  = require('soap');
const forge = require('node-forge');
const https = require('https');
const crypto = require('crypto');

const SSL_OP_LEGACY = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0;
const SSL_OP_RENEG  = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION || 0;
const sslAgent = new https.Agent({
  secureOptions: SSL_OP_LEGACY | SSL_OP_RENEG,
  ciphers: 'DEFAULT:@SECLEVEL=0',
  rejectUnauthorized: false,
});
https.globalAgent = sslAgent;
const wsdlOpts = { agent: sslAgent };

const WSAA_WSDL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_WSDL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const PADRON_WSDL_PROD = 'https://servicios1.afip.gov.ar/ws_sr_padron_a5/service.asmx?WSDL';
const PADRON_WSDL_HOMO = 'https://wswhomo.afip.gov.ar/ws_sr_padron_a5/service.asmx?WSDL';

function isProd() { return process.env.ARCA_PROD === 'true'; }

function buildTRA(service) {
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => {
    const y=d.getUTCFullYear(),mo=pad(d.getUTCMonth()+1),dy=pad(d.getUTCDate()),
          h=pad(d.getUTCHours()),mi=pad(d.getUTCMinutes()),s=pad(d.getUTCSeconds());
    return `${y}-${mo}-${dy}T${h}:${mi}:${s}Z`;
  };
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now/1000)}</uniqueId><generationTime>${fmt(new Date(now-600000))}</generationTime><expirationTime>${fmt(new Date(now+36000000))}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
}

function signTRA(traXml, certPem, keyPem) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(certPem);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign({ detached: false });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64');
}

async function getTokenSign(certPem, keyPem) {
  const tra = buildTRA('ws_sr_padron_a5');
  const cms = signTRA(tra, certPem, keyPem);
  const wsdl = isProd() ? WSAA_WSDL_PROD : WSAA_WSDL_HOMO;
  const client = await soap.createClientAsync(wsdl, { wsdl_options: wsdlOpts });
  const [result] = await client.loginCmsAsync({ in0: cms });
  const xml = result.loginCmsReturn;
  if (!xml) throw new Error('WSAA no retornó loginCmsReturn');
  const decode = s => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const tag = (x,t) => { const m=x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`,'i')); return m?m[1].trim():''; };
  const decoded = decode(xml);
  const token = tag(decoded,'token');
  const sign  = tag(decoded,'sign');
  if (!token||!sign) throw new Error('No se pudo extraer Token/Sign');
  return { token, sign };
}

function normalizePersona(p) {
  if (!p) return null;
  const nombre = p.razonSocial
    || [p.apellido, p.nombre].filter(Boolean).join(', ')
    || '';
  const dom = p.domicilioFiscal || {};
  let categoriaIVA = '';
  if (p.categoriasMonotributo?.categoriaMonotributo) {
    const cat = p.categoriasMonotributo.categoriaMonotributo;
    const c = Array.isArray(cat) ? cat[0] : cat;
    categoriaIVA = 'Monotributo ' + (c?.idCategoria || '');
  } else if (p.categoriaIVA) {
    categoriaIVA = p.categoriaIVA;
  }
  return {
    cuit:         String(p.idPersona || ''),
    nombre,
    categoriaIVA,
    estadoClave:  p.estadoClave || '',
    direccion:    dom.direccion || '',
    localidad:    dom.localidad || '',
    provincia:    dom.descripcionProvincia || '',
    codPostal:    String(dom.codPostal || ''),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const certPem = (process.env.ARCA_CERT||'').replace(/\\n/g,'\n');
  const keyPem  = (process.env.ARCA_KEY ||'').replace(/\\n/g,'\n');
  const cuitEmisor = process.env.ARCA_CUIT||'';
  if (!certPem||!keyPem||!cuitEmisor)
    return res.status(500).json({ error: 'Faltan variables de entorno ARCA' });

  const doc = String(req.query?.doc || '').replace(/\D/g,'');
  if (!doc || doc.length < 7)
    return res.status(400).json({ error: 'Ingresá un CUIT (11 dígitos) o DNI (7-8 dígitos)' });

  const esCUIT = doc.length === 11;
  const esDNI  = doc.length >= 7 && doc.length <= 8;
  if (!esCUIT && !esDNI)
    return res.status(400).json({ error: 'Documento inválido. CUIT: 11 dígitos, DNI: 7-8 dígitos' });

  try {
    const { token, sign } = await getTokenSign(certPem, keyPem);
    const wsdl = isProd() ? PADRON_WSDL_PROD : PADRON_WSDL_HOMO;
    const client = await soap.createClientAsync(wsdl, { wsdl_options: wsdlOpts });
    const auth = { token, sign, cuitRepresentada: cuitEmisor };

    if (esCUIT) {
      const [r] = await client.getPersonaAsync({ ...auth, idPersona: doc });
      const persona = r?.personaReturn?.persona;
      if (!persona) return res.status(404).json({ error: 'CUIT no encontrado en ARCA' });
      return res.status(200).json(normalizePersona(persona));
    }

    // DNI: buscar por documento
    const [r] = await client.getPersonaListByDocumentoAsync({
      ...auth,
      tipoDocumento: 96,
      numeroDocumento: parseInt(doc)
    });
    const lista = r?.personaListReturn?.persona;
    if (!lista) return res.status(404).json({ error: 'DNI no encontrado en ARCA' });
    const personas = Array.isArray(lista) ? lista : [lista];
    if (personas.length === 1) {
      return res.status(200).json(normalizePersona(personas[0]));
    }
    // Múltiples resultados: devolver lista para que el usuario elija
    return res.status(200).json({
      multiple: true,
      personas: personas.map(normalizePersona)
    });

  } catch (e) {
    console.error('Padrón error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
