// Cut a release from main:  npm run release -- patch | minor | major | X.Y.Z
// Bumps manifest.json, commits "Release Waveform X.Y.Z", tags vX.Y.Z, and pushes
// both. GitHub Actions then tests, submits to AMO, and drafts the GitHub release.
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { execFileSync } = require('node:child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => { console.error(`\n✖ ${message}`); process.exit(1); };

function nextVersion(current, bump) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(bump ?? '')) return bump;
  fail('Usage: npm run release -- patch | minor | major | X.Y.Z');
}

async function main() {
  if (git('branch', '--show-current') !== 'main') fail('Releases are cut from main. Merge dev into main first.');
  if (git('status', '--porcelain')) fail('Working tree has uncommitted changes.');
  git('fetch', '--quiet', '--tags', 'origin');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not in sync with origin/main (pull or push first).');

  const manifestText = fs.readFileSync('manifest.json', 'utf8');
  const current = JSON.parse(manifestText).version;
  const version = nextVersion(current, process.argv[2]);
  const tag = `v${version}`;
  if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists.`);

  console.log(`Running checks for ${current} → ${version}…`);
  execFileSync('npm', ['run', '--silent', 'check'], { stdio: 'inherit' });
  execFileSync('npm', ['run', '--silent', 'test:background'], { stdio: 'inherit' });

  const changes = git('log', '--oneline', `v${current}..HEAD`) || '(no commits since last tag)';
  console.log(`\nCommits going into ${tag}:\n${changes}\n`);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Commit, tag, and push ${tag}? [y/N] `);
  prompt.close();
  if (answer.trim().toLowerCase() !== 'y') fail('Cancelled; nothing changed.');

  // Replace only the version string so the manifest's formatting is untouched.
  fs.writeFileSync('manifest.json', manifestText.replace(`"version": "${current}"`, `"version": "${version}"`));
  git('commit', '--quiet', '-m', `Release Waveform ${version}`, '--', 'manifest.json');
  git('tag', '-a', tag, '-m', `Waveform ${version}`);
  execFileSync('git', ['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' });

  console.log(`\n✔ Pushed ${tag}. Follow it at https://github.com/braydenalex/waveform/actions`);
  console.log('  Remember to bring dev up to date: git checkout dev && git merge main');
}

main().catch((error) => fail(error.message));
