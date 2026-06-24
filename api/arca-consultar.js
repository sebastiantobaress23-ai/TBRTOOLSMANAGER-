/**
 * Vercel serverless function: consulta comprobantes emitidos en ARCA
 * GET /api/arca-consultar?desde=1&hasta=25
 *
 * Devuelve todos los comprobantes tipo 11 (Factura C) del punto de venta
 * configurado, en el rango de números indicado.
 */

'use strict';
const soap   = require('soap');
const forge  = require('node-forge');
const https  = require('https');
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

const WSAA_WSDL_PROD   = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_WSDL_HOMO   = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSFEV1_WSDL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSFEV1_WSDL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL';

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
  if (!token||!sign) throw new Error('No se pudo extraer Token/Sign');
  return { token, sign };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const certPem = (process.env.ARCA_CERT||'').replace(/\\n/g,'\n');
  const keyPem  = (process.env.ARCA_KEY ||'').replace(/\\n/g,'\n');
  const cuit    =  process.env.ARCA_CUIT||'';
  if (!certPem||!keyPem||!cuit)
    return res.status(500).json({ error: 'Faltan variables de entorno ARCA' });

  const pdv   = parseInt(process.env.ARCA_PDV) || 1;
  const desde = parseInt(req.query?.desde) || 1;

  try {
    const { token, sign } = await getTokenSign(certPem, keyPem);
    const wsdl = isProd() ? WSFEV1_WSDL_PROD : WSFEV1_WSDL_HOMO;
    const client = await soap.createClientAsync(wsdl, { wsdl_options: wsdlOpts });

    // Consultar el último autorizado en ARCA para determinar el rango
    let hasta = parseInt(req.query?.hasta) || 0;
    try {
      const [ru] = await client.FECompUltimoAutorizadoAsync({
        Auth: { Token: token, Sign: sign, Cuit: cuit },
        PtoVta: pdv,
        CbteTipo: 11
      });
      const ultimo = ru?.FECompUltimoAutorizadoResult?.CbteNro;
      console.log('FECompUltimoAutorizado raw:', JSON.stringify(ru?.FECompUltimoAutorizadoResult));
      hasta = Math.max(hasta, parseInt(ultimo) || 0);
    } catch(e) {
      console.error('FECompUltimoAutorizado error:', e.message);
    }
    // Mínimo 30 por si FECompUltimoAutorizado devuelve 0
    hasta = Math.max(hasta, desde + 29);
    const max = Math.min(hasta - desde + 1, 50);
    const auth = { Token: token, Sign: sign, Cuit: cuit };

    const facturas = [];
    for (let nro = desde; nro < desde + max; nro++) {
      try {
        const [r] = await client.FECompConsultarAsync({
          Auth: auth,
          FeCompConsReq: {
            CbteTipo: 11,
            CbteNro:  nro,
            PtoVta:   pdv
          }
        });
        const d = r?.FECompConsultarResult?.ResultGet;
        if (!d || !d.CAE) continue; // no existe o sin CAE

        const fechaStr = String(d.CbteFch||'');
        const fecha = fechaStr.length === 8
          ? `${fechaStr.slice(0,4)}-${fechaStr.slice(4,6)}-${fechaStr.slice(6,8)}`
          : fechaStr;
        const caeFchVto = String(d.CAEFchVto||'');
        const caeFecha = caeFchVto.length === 8
          ? `${caeFchVto.slice(0,4)}-${caeFchVto.slice(4,6)}-${caeFchVto.slice(6,8)}`
          : caeFchVto;

        facturas.push({
          cbteNro:    nro,
          nro:        `${pdv}-${String(nro).padStart(8,'0')}`,
          fecha,
          cae:        String(d.CAE),
          caeFecha,
          importe:    parseFloat(d.ImpTotal) || 0,
          docTipo:    d.DocTipo,
          docNro:     String(d.DocNro||'0'),
          resultado:  d.Resultado,
        });
      } catch { /* comprobante no existe, continuar */ }
    }

    return res.status(200).json({ facturas, ultimo: desde + max - 1 });
  } catch (e) {
    console.error('Consultar error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
