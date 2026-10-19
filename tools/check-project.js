// tools/check-project.js
// Dev-only helper. Usage (from the project root):  node tools/check-project.js
// Checks: referenced files exist (case-sensitive), import trees resolve, named imports are
// exported, and every JS file passes a syntax check as an ES module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let problems = 0;

const ok = (message) => console.log(`  ok    ${message}`);
const fail = (message) => {
  problems += 1;
  console.log(`  FAIL  ${message}`);
};

/** Case-sensitive existence check (Windows/macOS would otherwise hide a wrong-case name). */
function existsExact(relPath) {
  let dir = root;
  for (const segment of relPath.split('/')) {
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}

function syntaxCheck(relPath) {
  const temp = path.join(os.tmpdir(), `ff-check-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.copyFileSync(path.join(root, relPath), temp);
  const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
  fs.unlinkSync(temp);
  if (result.status === 0) {
    ok(`syntax  ${relPath}`);
  } else {
    fail(`syntax error in ${relPath}\n${(result.stderr || '').replace(new RegExp(temp.replace(/\\/g, '\\\\'), 'g'), relPath)}`);
  }
}

function exportsName(source, name) {
  const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b`);
  const listed = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
  return declared.test(source) || listed.test(source);
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/g;

function walk(entry, visited) {
  if (visited.has(entry)) return;
  visited.add(entry);

  if (!existsExact(entry)) {
    fail(`missing file: ${entry}`);
    return;
  }
  ok(`exists  ${entry}`);
  syntaxCheck(entry);

  const source = fs.readFileSync(path.join(root, entry), 'utf8');
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const [, clause, specifier] = match;
    if (!specifier.startsWith('.')) {
      fail(`${entry} imports "${specifier}", which is not a relative path (extensions cannot use bare imports)`);
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
    if (!existsExact(target)) {
      fail(`${entry} imports "${specifier}" but ${target} does not exist (check name, folder and letter case)`);
      continue;
    }
    const named = clause && clause.match(/\{([^}]*)\}/);
    if (named) {
      const targetSource = fs.readFileSync(path.join(root, target), 'utf8');
      for (const raw of named[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name && !exportsName(targetSource, name)) {
          fail(`${entry} imports "${name}" from ${target}, but that file does not export it (old or partly pasted version?)`);
        }
      }
    }
    walk(target, visited);
  }
}

console.log('Manifest');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok('manifest.json is valid JSON');
} catch (error) {
  fail(`manifest.json problem: ${error.message}`);
}

if (manifest) {
  const worker = manifest.background && manifest.background.service_worker;
  const popup = manifest.action && manifest.action.default_popup;
  const iconPaths = [
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ];

  console.log('\nService worker import tree');
  if (worker) walk(worker, new Set());
  else fail('manifest has no background.service_worker');

  console.log('\nPopup');
  if (popup && existsExact(popup)) {
    ok(`exists  ${popup}`);
    const html = fs.readFileSync(path.join(root, popup), 'utf8');
    for (const [, src] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      if (/^https?:/.test(src)) fail(`${popup} references a remote file: ${src}`);
      else if (src.endsWith('.js')) walk(src, new Set());
      else if (existsExact(src)) ok(`exists  ${src}`);
      else fail(`${popup} references ${src}, which does not exist`);
    }
  } else {
    fail(`popup file missing: ${popup}`);
  }

  console.log('\nIcons');
  for (const icon of new Set(iconPaths)) {
    if (existsExact(icon)) ok(`exists  ${icon}`);
    else fail(`missing icon: ${icon} (run: node tools/make-icons.js)`);
  }
}

console.log(problems === 0 ? '\nAll checks passed.' : `\n${problems} problem(s) found. Fix the FIRST one, then run again.`);
process.exit(problems === 0 ? 0 : 1);