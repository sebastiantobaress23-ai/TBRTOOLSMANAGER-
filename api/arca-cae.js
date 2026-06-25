/**
 * Vercel serverless function: ARCA (ex-AFIP) CAE request
 * POST /api/arca-cae
 *
 * Required env vars:
 *   ARCA_CUIT   - CUIT del emisor (ej: 20430697529)
 *   ARCA_CERT   - Certificado X.509 en PEM completo
 *   ARCA_KEY    - Clave privada RSA en PEM completo
 *   ARCA_PDV    - Punto de venta (número, ej: 1)
 *   ARCA_PROD   - "true" para producción
 */

'use strict';
const soap   = require('soap');
const forge  = require('node-forge');
const https  = require('https');
const crypto = require('crypto');

// AFIP/ARCA servers use 512-bit DH keys — need SECLEVEL=0
const SSL_OP_LEGACY = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0;
const SSL_OP_RENEG  = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION || 0;
const sslAgent = new https.Agent({
  secureOptions: SSL_OP_LEGACY | SSL_OP_RENEG,
  ciphers: 'DEFAULT:@SECLEVEL=0',
  rejectUnauthorized: false,
});
// Override global agent so the soap package uses it for every HTTPS request
https.globalAgent = sslAgent;
const wsdlOpts = { agent: sslAgent };

const WSAA_WSDL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_WSDL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSFEV1_WSDL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSFEV1_WSDL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL';

function isProd() { return process.env.ARCA_PROD === 'true'; }

let _tsCache = null;
async function getTokenSignCached(certPem, keyPem) {
  const now = Date.now();
  if (_tsCache && _tsCache.expiresAt > now + 60000) return _tsCache;
  const ts = await getTokenSign(certPem, keyPem);
  _tsCache = { ...ts, expiresAt: now + 34200000 };
  return _tsCache;
}

// Build TRA XML
function buildTRA(service = 'wsfe') {
  const pad = n => String(n).padStart(2,'0');
  const fmt = d => {
    const y=d.getUTCFullYear(),mo=pad(d.getUTCMonth()+1),dy=pad(d.getUTCDate()),
          h=pad(d.getUTCHours()),mi=pad(d.getUTCMinutes()),s=pad(d.getUTCSeconds());
    return `${y}-${mo}-${dy}T${h}:${mi}:${s}Z`;
  };
  const now = Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now/1000)}</uniqueId><generationTime>${fmt(new Date(now-600000))}</generationTime><expirationTime>${fmt(new Date(now+36000000))}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
}

// Sign TRA with PKCS7 CMS
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

// Get WSAA token+sign via node-soap
async function getTokenSign(certPem, keyPem) {
  const tra = buildTRA('wsfe');
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
  if (!token||!sign) throw new Error('No se pudo extraer Token/Sign: ' + xml.slice(0,300));
  return { token, sign };
}

// Request CAE via node-soap WSFEV1
async function getUltimoComprobante(client, token, sign, cuit, pdv, cbteTipo = 11) {
  const [result] = await client.FECompUltimoAutorizadoAsync({
    Auth: { Token: token, Sign: sign, Cuit: cuit },
    PtoVta: parseInt(pdv),
    CbteTipo: cbteTipo
  });
  return result?.FECompUltimoAutorizadoResult?.CbteNro || 0;
}

// cbteAsoc: { tipo, pdv, nro, cuit } — para Notas de Crédito
async function solicitarCAE({ token, sign, cuit, pdv, fecha, docTipo, cuitComprador, concepto, importe, cbteTipo = 11, cbteAsoc = null }) {
  const wsdl = isProd() ? WSFEV1_WSDL_PROD : WSFEV1_WSDL_HOMO;
  const client = await soap.createClientAsync(wsdl, { wsdl_options: wsdlOpts });

  // Always get next number from ARCA to avoid duplicates
  const ultimo = await getUltimoComprobante(client, token, sign, cuit, pdv, cbteTipo);
  const cbteNro = Number(ultimo) + 1;

  const docNroInt = parseInt(cuitComprador) || 0;

  const detReq = {
    Concepto:   parseInt(concepto) || 1,
    DocTipo:    parseInt(docTipo),
    DocNro:     docNroInt,
    CbteDesde:  cbteNro,
    CbteHasta:  cbteNro,
    CbteFch:    String(fecha),
    ImpTotal:   parseFloat(importe.toFixed(2)),
    ImpTotConc: 0,
    ImpNeto:    parseFloat(importe.toFixed(2)),
    ImpOpEx:    0,
    ImpIVA:     0,
    ImpTrib:    0,
    MonId:      'PES',
    MonCotiz:   1
  };

  // NC (CbteTipo=13) requiere referencia al comprobante original
  if (cbteAsoc) {
    // Cuit es opcional en CbtesAsoc — solo si el emisor del cbte original es distinto
    detReq.CbtesAsoc = {
      CbteAsoc: [{
        Tipo:   parseInt(cbteAsoc.tipo) || 11,
        PtoVta: parseInt(cbteAsoc.pdv)  || parseInt(pdv),
        Nro:    parseInt(cbteAsoc.nro)
      }]
    };
  }

  const args = {
    Auth: { Token: token, Sign: sign, Cuit: String(cuit) },
    FeCAEReq: {
      FeCabReq: {
        CantReg:  1,
        PtoVta:   parseInt(pdv),
        CbteTipo: cbteTipo
      },
      FeDetReq: {
        FECAEDetRequest: [detReq]
      }
    }
  };

  // Log SOAP XML for debugging
  client.on('request', xml => console.log('SOAP FECAESolicitar request:\n', xml));

  const [result] = await client.FECAESolicitarAsync(args);
  const detRaw = result?.FECAESolicitarResult?.FeDetResp?.FECAEDetResponse;
  const det = Array.isArray(detRaw) ? detRaw[0] : detRaw;
  const cae = det?.CAE;
  const caeFchVto = det?.CAEFchVto;
  if (!cae) {
    // Obs can be a single object or an array
    const obs = det?.Observaciones?.Obs;
    const obsMsg = Array.isArray(obs)
      ? obs.map(o=>`[${o.Code}] ${o.Msg}`).join(' | ')
      : obs ? `[${obs.Code}] ${obs.Msg}` : '';
    const errMsg = result?.FECAESolicitarResult?.Errors?.Err?.Msg
      || obsMsg
      || JSON.stringify(result).slice(0,500);
    throw new Error('ARCA no otorgó CAE: ' + errMsg);
  }
  const caeFecha = caeFchVto ? String(caeFchVto).replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3') : '';
  return { cae, caeFecha, cbteNro };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST')    return res.status(405).json({ error:'Method not allowed' });

  const certPem = (process.env.ARCA_CERT||'').replace(/\\n/g,'\n');
  const keyPem  = (process.env.ARCA_KEY ||'').replace(/\\n/g,'\n');
  const cuit    =  process.env.ARCA_CUIT||'';
  if (!certPem||!keyPem||!cuit)
    return res.status(500).json({ error:'Faltan variables de entorno ARCA_CERT, ARCA_KEY, ARCA_CUIT' });

  let body = req.body;
  if (typeof body==='string') {
    try { body=JSON.parse(body); } catch { return res.status(400).json({ error:'JSON inválido' }); }
  }

  const { pdv=parseInt(process.env.ARCA_PDV)||1, fecha, cuitComprador='0', concepto=1, importe, cbteTipo=11, cbteAsoc=null } = body||{};
  if (!fecha||importe==null)
    return res.status(400).json({ error:'Faltan parámetros: fecha, importe' });

  // Auto-detect DocTipo from document number
  const docNro  = String(cuitComprador||'0').replace(/\D/g,'') || '0';
  const docTipo = docNro==='0'||docNro==='' ? 99
    : docNro.length===11 ? 80   // CUIT
    : docNro.length<=8   ? 96   // DNI
    : 99;

  try {
    const { token, sign } = await getTokenSignCached(certPem, keyPem);
    const result = await solicitarCAE({ token, sign, cuit, pdv, fecha, docTipo, cuitComprador: docNro, concepto: parseInt(concepto)||1, importe, cbteTipo: parseInt(cbteTipo)||11, cbteAsoc });
    return res.status(200).json(result);
  } catch(e) {
    console.error('ARCA error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
