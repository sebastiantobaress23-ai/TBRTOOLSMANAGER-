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
const wsdlOpts = { agent: sslAgent };

const WSAA_WSDL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_WSDL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSFEV1_WSDL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSFEV1_WSDL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL';

function isProd() { return process.env.ARCA_PROD === 'true'; }

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
  if (client.httpClient) client.httpClient.options = Object.assign(client.httpClient.options||{}, { agent: sslAgent, rejectUnauthorized: false });
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
async function solicitarCAE({ token, sign, cuit, pdv, cbteNro, fecha, docTipo, cuitComprador, importe }) {
  const wsdl = isProd() ? WSFEV1_WSDL_PROD : WSFEV1_WSDL_HOMO;
  const client = await soap.createClientAsync(wsdl, { wsdl_options: wsdlOpts });
  if (client.httpClient) client.httpClient.options = Object.assign(client.httpClient.options||{}, { agent: sslAgent, rejectUnauthorized: false });

  const args = {
    Auth: { Token: token, Sign: sign, Cuit: cuit },
    FeCAEReq: {
      FeCabReq: { CantReg: 1, PtoVta: pdv, CbteTipo: 11 },
      FeDetReq: {
        FECAEDetRequest: {
          Concepto:  1,
          DocTipo:   docTipo,
          DocNro:    cuitComprador,
          CbteDesde: cbteNro,
          CbteHasta: cbteNro,
          CbteFch:   fecha,
          ImpTotal:  importe.toFixed(2),
          ImpTotConc:'0.00',
          ImpNeto:   importe.toFixed(2),
          ImpOpEx:   '0.00',
          ImpIVA:    '0.00',
          ImpTrib:   '0.00',
          MonId:     'PES',
          MonCotiz:  1
        }
      }
    }
  };

  const [result] = await client.FECAESolicitarAsync(args);
  const det = result?.FECAESolicitarResult?.FeDetResp?.FECAEDetResponse;
  const cae = det?.CAE;
  const caeFchVto = det?.CAEFchVto;
  if (!cae) {
    const err = result?.FECAESolicitarResult?.Errors?.Err?.Msg
      || result?.FECAESolicitarResult?.FeDetResp?.FECAEDetResponse?.Observaciones?.Obs?.Msg
      || JSON.stringify(result).slice(0,400);
    throw new Error('ARCA no otorgó CAE: ' + err);
  }
  const caeFecha = caeFchVto ? String(caeFchVto).replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3') : '';
  return { cae, caeFecha };
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

  const { pdv=parseInt(process.env.ARCA_PDV)||1, cbteNro, fecha, cuitComprador='0', docTipo=96, importe } = body||{};
  if (!cbteNro||!fecha||importe==null)
    return res.status(400).json({ error:'Faltan parámetros: cbteNro, fecha, importe' });

  try {
    const { token, sign } = await getTokenSign(certPem, keyPem);
    const result = await solicitarCAE({ token, sign, cuit, pdv, cbteNro, fecha, docTipo, cuitComprador, importe });
    return res.status(200).json(result);
  } catch(e) {
    console.error('ARCA error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
