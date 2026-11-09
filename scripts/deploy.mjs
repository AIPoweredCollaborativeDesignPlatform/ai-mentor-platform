#!/usr/bin/env node
// One-command release: bump version → build (stamps version + Taipei time) → firebase deploy → git commit + tag.
//
//   npm run deploy               patch bump (6.0.0 → 6.0.1)
//   npm run deploy -- --minor    minor bump (6.0.1 → 6.1.0)
//   npm run deploy -- --major    major bump (6.1.0 → 7.0.0)
//   npm run deploy -- --dry      bump + build only; nothing is deployed or committed, version is restored
//   npm run deploy -- --functions  force-deploy Cloud Functions even if unchanged
//   npm run deploy -- --web-only   deploy hosting and Firestore rules only
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
const FUNCTIONS = path.join(ROOT, 'functions');
const STATE_FILE = path.join(ROOT, '.deploy-state.json');
const PROJECT = 'ai-mentor-web';

const args = new Set(process.argv.slice(2));
const bump = args.has('--major') ? 'major' : args.has('--minor') ? 'minor' : 'patch';
const dry = args.has('--dry');
const webOnly = args.has('--web-only');
const codingOnly = args.has('--coding-only');
const codingBankOnly = args.has('--coding-bank-only');

// Loading functions/ (Anthropic SDK + Admin SDK) can exceed the CLI's 10s discovery timeout on this machine
const run = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: '120' } });
const read = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
const step = (msg) => console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);

// Hash of functions/ source (excluding node_modules) to skip redundant function deploys
function hashFunctions() {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(name).update(readFileSync(p));
    }
  };
  walk(FUNCTIONS);
  return h.digest('hex');
}

const pkgPath = path.join(FRONTEND, 'package.json');
const lockPath = path.join(FRONTEND, 'package-lock.json');
const originalPkg = readFileSync(pkgPath, 'utf-8');
const originalLock = readFileSync(lockPath, 'utf-8');
const restoreVersion = () => {
  writeFileSync(pkgPath, originalPkg);
  writeFileSync(lockPath, originalLock);
};

let deployed = false;
try {
  step(`Bumping ${bump} version`);
  const version = read(`npm version ${bump} --no-git-tag-version`, FRONTEND).replace(/^v/, '');
  console.log(`  → v${version}`);

  step('Building frontend (type check + bundle)');
  run('npm run build -- --configLoader runner', FRONTEND);

  if (dry) {
    restoreVersion();
    console.log('\n--dry: build OK. Version restored; nothing deployed or committed.');
    process.exit(0);
  }

  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : {};
  const fnHash = hashFunctions();
  const targets = (webOnly || codingOnly || codingBankOnly) ? ['hosting', 'firestore:rules'] : ['hosting', 'firestore:rules', 'storage'];
  if (codingOnly) targets.push('functions:prepareCodingSemantic');
  if (codingBankOnly) targets.push('functions:getCodingBank');
  if (!webOnly && !codingOnly && !codingBankOnly && (args.has('--functions') || state.functionsHash !== fnHash)) targets.push('functions');

  step(`Deploying to Firebase (${targets.join(', ')})`);
  run(`firebase deploy --only ${targets.join(',')} --project ${PROJECT}`);
  deployed = true;

  writeFileSync(STATE_FILE, JSON.stringify({
    functionsHash: (webOnly || codingOnly || codingBankOnly) ? state.functionsHash : fnHash,
    lastVersion: version,
    lastDeployedAt: new Date().toISOString()
  }, null, 2) + '\n');

  step('Recording release in git');
  run('git add -A');
  run(`git commit -q -m "release: v${version}" --allow-empty`);
  run(`git tag -a v${version} -m "Deployed v${version}"`);

  console.log(`\n\x1b[32m✔ v${version} is live at https://ai-mentor-design.web.app\x1b[0m`);
} catch (err) {
  if (deployed) {
    // Site is already live with the new version; keep the bump so source matches production
    console.error('\n\x1b[33m⚠ Deployed, but the git commit/tag failed. Commit manually.\x1b[0m');
  } else {
    restoreVersion();
    console.error('\n\x1b[31m✖ Release aborted; version number restored. Nothing was deployed or committed.\x1b[0m');
  }
  process.exit(1);
}
