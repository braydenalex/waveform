const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// An allowlist prevents fixtures, tests, build files, and dependencies shipping.
const releaseFiles = [
  'manifest.json', 'background.js', 'content.js', 'audio-injector.js', 'LICENSE',
  'popup/popup.html', 'popup/popup.js', 'popup/popup.css',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'
];
function build(outputDirectory = 'dist') {
  const version = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version;
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error('Release tag must match the manifest version');
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const archive = path.resolve(outputDirectory, `waveform-${version}.zip`);
  // Zip updates existing archives; delete only this generated output to ensure
  // removed files cannot survive in a package from an earlier build.
  fs.rmSync(archive, { force: true });
  execFileSync('zip', ['-q', archive, ...releaseFiles]);
  console.log(archive);
  return archive;
}
if (require.main === module) build();
module.exports = { releaseFiles, build };
