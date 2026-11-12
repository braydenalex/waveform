// Minimal addons.mozilla.org API client used by the release workflows.
//   node scripts/amo.cjs status <version>         prints: missing | unreviewed | public | disabled
//   node scripts/amo.cjs download <version> <out> saves the signed .xpi (must be public)
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (https://addons.mozilla.org/developers/addon/api/key/).
const crypto = require('node:crypto');
const fs = require('node:fs');

const API = 'https://addons.mozilla.org/api/v5';
const addonId = JSON.parse(fs.readFileSync('manifest.json', 'utf8'))
  .browser_specific_settings.gecko.id;

function token() {
  const { AMO_JWT_ISSUER: iss, AMO_JWT_SECRET: secret } = process.env;
  if (!iss || !secret) throw new Error('AMO_JWT_ISSUER and AMO_JWT_SECRET must be set');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss, jti: crypto.randomUUID(), iat, exp: iat + 60 })}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

async function getVersion(version) {
  // The "v" prefix forces lookup by version number rather than numeric id.
  const url = `${API}/addons/addon/${encodeURIComponent(addonId)}/versions/v${encodeURIComponent(version)}/`;
  const response = await fetch(url, { headers: { Authorization: `JWT ${token()}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AMO ${response.status}: ${await response.text()}`);
  return response.json();
}

async function status(version) {
  const data = await getVersion(version);
  return data?.file?.status ?? 'missing';
}

async function download(version, output) {
  const data = await getVersion(version);
  if (data?.file?.status !== 'public') throw new Error(`Version ${version} is not approved yet`);
  const response = await fetch(data.file.url, { headers: { Authorization: `JWT ${token()}` } });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = data.file.hash.split(':');
  const actual = crypto.createHash(algorithm).update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Hash mismatch: expected ${expected}, got ${actual}`);
  fs.writeFileSync(output, bytes);
  console.log(output);
}

const [command, version, output] = process.argv.slice(2);
const run = { status: () => status(version).then(console.log), download: () => download(version, output) }[command];
if (!run || !version || (command === 'download' && !output)) {
  console.error('Usage: amo.cjs status <version> | download <version> <out.xpi>');
  process.exit(2);
}
run().catch((error) => { console.error(error.message); process.exit(1); });
