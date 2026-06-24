/**
 * Vercel serverless function: ARCA (ex-AFIP) CAE request
 * POST /api/arca-cae
 *
 * Required env vars:
 *   ARCA_CUIT      - CUIT del emisor (ej: 20123456789)
 *   ARCA_CERT      - Certificado X.509 en PEM (contenido completo, con saltos de línea como \n)
 *   ARCA_KEY       - Clave privada RSA en PEM (contenido completo, con saltos de línea como \n)
 *   ARCA_PDV       - Punto de venta (número, ej: 1)
 *   ARCA_PROD      - "true" para producción, omitir o "false" para homologación
 *
 * Body: { pdv, cbteNro, fecha (YYYYMMDD), cuitComprador, docTipo (80=CUIT, 96=DNI), importe }
 * Response: { cae, caeFecha } o { error }
 */

const https = require('https');
const crypto = require('crypto');

// ARCA/AFIP servers use 512-bit DH keys rejected by modern OpenSSL (SECLEVEL>=1).
// Fix: set SECLEVEL=0 in cipher string + allow legacy server connect.
const SSL_OP_LEGACY = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0;
const SSL_OP_RENEG  = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION || 0;
const arcaAgent = new https.Agent({
  secureOptions: SSL_OP_LEGACY | SSL_OP_RENEG,
  ciphers: 'DEFAULT:@SECLEVEL=0',
  rejectUnauthorized: false
});

const WSAA_URL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_URL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSFEV1_URL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSFEV1_URL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';

function isProd() {
  return process.env.ARCA_PROD === 'true';
}

// Build TRA (Ticket de Requerimiento de Acceso) XML
function toARCADate(d) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}-${mo}-${day}T${h}:${mi}:${s}Z`;
}

function buildTRA(service = 'wsfe') {
  const now = new Date();
  const from = toARCADate(new Date(now.getTime() - 600000));
  const to = toARCADate(new Date(now.getTime() + 36000000));
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(Date.now() / 1000)}</uniqueId>
    <generationTime>${from}</generationTime>
    <expirationTime>${to}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

// Sign TRA with PKCS#7 CMS using node's crypto
function signTRA(traXml, certPem, keyPem) {
  // We need to create a CMS/PKCS7 signed message
  // Since we can't use node-forge without installing it in the function,
  // we'll use a minimal approach with the forge library included via dynamic require
  try {
    const forge = require('node-forge');
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
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return Buffer.from(der, 'binary').toString('base64');
  } catch (e) {
    throw new Error('Error firmando TRA: ' + e.message);
  }
}

// SOAP call via raw HTTP (no dependency needed for simple SOAP)
function soapCall(url, action, body) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      agent: arcaAgent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': action,
        'Content-Length': Buffer.byteLength(envelope)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(envelope);
    req.end();
  });
}

// Extract text between XML tags
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

// WSAA: get Token and Sign
async function getTokenSign(certPem, keyPem) {
  const tra = buildTRA('wsfe');
  const cms = signTRA(tra, certPem, keyPem);
  const wsaaUrl = isProd() ? WSAA_URL_PROD.replace('?wsdl', '') : WSAA_URL_HOMO.replace('?wsdl', '');
  const body = `<loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov.ar"><in0>${cms}</in0></loginCms>`;
  const resp = await soapCall(wsaaUrl, 'loginCms', body);
  const result = extractTag(resp, 'loginCmsReturn');
  if (!result) throw new Error('WSAA no retornó loginCmsReturn. Respuesta: ' + resp.slice(0, 500));
  const token = extractTag(result.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'), 'token');
  const sign  = extractTag(result.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'), 'sign');
  if (!token || !sign) throw new Error('No se pudo extraer Token/Sign del TA');
  return { token, sign };
}

// WSFEV1: request CAE for Factura C (CbteTipo 11)
async function solicitarCAE({ token, sign, cuit, pdv, cbteNro, fecha, docTipo, cuitComprador, importe }) {
  const wsfev1Url = isProd() ? WSFEV1_URL_PROD.replace('?WSDL','') : WSFEV1_URL_HOMO.replace('?WSDL','');
  const body = `<FECAESolicitar xmlns="http://ar.gov.afip.devel.FEV1/">
    <Auth>
      <Token>${token}</Token>
      <Sign>${sign}</Sign>
      <Cuit>${cuit}</Cuit>
    </Auth>
    <FeCAEReq>
      <FeCabReq>
        <CantReg>1</CantReg>
        <PtoVta>${pdv}</PtoVta>
        <CbteTipo>11</CbteTipo>
      </FeCabReq>
      <FeDetReq>
        <FECAEDetRequest>
          <Concepto>1</Concepto>
          <DocTipo>${docTipo}</DocTipo>
          <DocNro>${cuitComprador}</DocNro>
          <CbteDesde>${cbteNro}</CbteDesde>
          <CbteHasta>${cbteNro}</CbteHasta>
          <CbteFch>${fecha}</CbteFch>
          <ImpTotal>${importe.toFixed(2)}</ImpTotal>
          <ImpTotConc>0.00</ImpTotConc>
          <ImpNeto>${importe.toFixed(2)}</ImpNeto>
          <ImpOpEx>0.00</ImpOpEx>
          <ImpIVA>0.00</ImpIVA>
          <ImpTrib>0.00</ImpTrib>
          <MonId>PES</MonId>
          <MonCotiz>1</MonCotiz>
        </FECAEDetRequest>
      </FeDetReq>
    </FeCAEReq>
  </FECAESolicitar>`;
  const resp = await soapCall(wsfev1Url, 'FECAESolicitar', body);
  const cae = extractTag(resp, 'CAE');
  const caeFchVto = extractTag(resp, 'CAEFchVto');
  const errMsg = extractTag(resp, 'Msg');
  if (!cae) {
    const obsMsg = extractTag(resp, 'Obs') || errMsg || resp.slice(0, 500);
    throw new Error('ARCA no otorgó CAE: ' + obsMsg);
  }
  // caeFchVto comes as YYYYMMDD, convert to YYYY-MM-DD
  const caeFecha = caeFchVto ? caeFchVto.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '';
  return { cae, caeFecha };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const certPem = (process.env.ARCA_CERT || '').replace(/\\n/g, '\n');
  const keyPem  = (process.env.ARCA_KEY  || '').replace(/\\n/g, '\n');
  const cuit    = process.env.ARCA_CUIT  || '';

  if (!certPem || !keyPem || !cuit) {
    return res.status(500).json({ error: 'Variables de entorno ARCA_CERT, ARCA_KEY y ARCA_CUIT son requeridas.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
  }

  const { pdv = parseInt(process.env.ARCA_PDV) || 1, cbteNro, fecha, cuitComprador = '0', docTipo = 96, importe } = body || {};

  if (!cbteNro || !fecha || importe == null) {
    return res.status(400).json({ error: 'Faltan parámetros: cbteNro, fecha, importe' });
  }

  try {
    const { token, sign } = await getTokenSign(certPem, keyPem);
    const result = await solicitarCAE({ token, sign, cuit, pdv, cbteNro, fecha, docTipo, cuitComprador, importe });
    return res.status(200).json(result);
  } catch (e) {
    console.error('ARCA error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
