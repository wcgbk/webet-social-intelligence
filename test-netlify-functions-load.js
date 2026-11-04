'use strict';

/**
 * Static load check for Netlify function entries.
 * For every top-level netlify/functions/*.js, plus a directory function's
 * index.js or <dir>/<dir>.js, resolve each relative require() / import
 * and walk those files the same way. Missing files fail the process.
 * Handlers are not executed.
 *
 * Non-omega functions may list a known-missing edge in ALLOW_MISSING.
 * An omega function (rerank-picks-omega, narrate-card-omega, post-card-omega,
 * and any other function whose file name contains "omega") cannot.
 * Each allowlist line is "repo/relative/file.js -> ./spec".
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname);
const fnDir = path.join(root, 'netlify/functions');

// Pre-existing gaps in functions that are not part of the omega card path.
// Empty while every relative edge in this tree resolves.
const ALLOW_MISSING = [
];

const MUST_SCAN = [
  'rerank-picks-omega.js',
  'narrate-card-omega.js',
  'post-card-omega.js',
];

function listEntries() {
  const out = [];
  for (const name of fs.readdirSync(fnDir)) {
    const full = path.join(fnDir, name);
    const st = fs.statSync(full);
    if (st.isFile() && name.endsWith('.js')) {
      out.push(full);
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const rel of ['index.js', `${name}.js`]) {
      const entry = path.join(full, rel);
      if (fs.existsSync(entry) && fs.statSync(entry).isFile()) out.push(entry);
    }
  }
  return out;
}

function isIdent(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

function readString(src, i) {
  const q = src[i];
  let spec = '';
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      spec += src[i + 1] || '';
      i += 2;
      continue;
    }
    if (src[i] === q) return { spec, next: i + 1 };
    spec += src[i];
    i += 1;
  }
  return { spec, next: i };
}

/** Relative specifiers in require(), import(), and import/export ... from. */
function relativeSpecs(src) {
  const specs = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
              i = readString(src, i).next;
              continue;
            }
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if ((src.startsWith('require', i) || src.startsWith('import', i)) && !isIdent(src[i - 1])) {
      const kw = src.startsWith('require', i) ? 'require' : 'import';
      let j = i + kw.length;
      if (isIdent(src[j])) { i += 1; continue; }
      while (j < n && /\s/.test(src[j])) j += 1;
      if (src[j] === '(') {
        j += 1;
        while (j < n && /\s/.test(src[j])) j += 1;
        if (src[j] === "'" || src[j] === '"') {
          const parsed = readString(src, j);
          if (parsed.spec.startsWith('.')) specs.push(parsed.spec);
        }
      } else if (kw === 'import' && (src[j] === "'" || src[j] === '"')) {
        const parsed = readString(src, j);
        if (parsed.spec.startsWith('.')) specs.push(parsed.spec);
      }
      i += kw.length;
      continue;
    }
    if (src.startsWith('from', i) && !isIdent(src[i - 1]) && !isIdent(src[i + 4])) {
      let j = i + 4;
      while (j < n && /\s/.test(src[j])) j += 1;
      if (src[j] === "'" || src[j] === '"') {
        const parsed = readString(src, j);
        if (parsed.spec.startsWith('.')) specs.push(parsed.spec);
      }
      i += 4;
      continue;
    }
    i += 1;
  }
  return specs;
}

function asFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  } catch (_) {
    return null;
  }
}

function resolveSpec(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const direct = asFile(base);
  if (direct) return direct;
  for (const ext of ['.js', '.json', '.cjs', '.mjs', '.node']) {
    const hit = asFile(base + ext);
    if (hit) return hit;
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    const pkgPath = path.join(base, 'package.json');
    if (asFile(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.main) {
          const mainBase = path.resolve(base, pkg.main);
          const mainHit = asFile(mainBase) || asFile(mainBase + '.js') || asFile(path.join(mainBase, 'index.js'));
          if (mainHit) return mainHit;
        }
      } catch (_) { /* unreadable package.json is not a resolution */ }
    }
    for (const name of ['index.js', 'index.json', 'index.cjs', 'index.mjs', 'index.node']) {
      const hit = asFile(path.join(base, name));
      if (hit) return hit;
    }
  }
  return null;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isOmegaEntry(file) {
  return /omega/i.test(path.basename(file));
}

function edgeKey(file, spec) {
  return `${rel(file)} -> ${spec}`;
}

function main() {
  const allow = new Set(ALLOW_MISSING.map((line) => String(line).trim()).filter(Boolean));
  const entries = listEntries();
  if (entries.length === 0) {
    console.error('no netlify function entries found');
    process.exit(1);
  }
  const scanned = new Set(entries.map((file) => path.basename(file)));
  for (const name of MUST_SCAN) {
    if (!scanned.has(name)) {
      console.error(`omega function was not scanned: ${name}`);
      process.exit(1);
    }
  }

  const failures = [];
  const usedAllow = new Set();
  const specCache = new Map();

  function specsOf(file) {
    if (specCache.has(file)) return specCache.get(file);
    const src = fs.readFileSync(file, 'utf8');
    const specs = relativeSpecs(src);
    specCache.set(file, specs);
    return specs;
  }

  for (const entry of entries) {
    const omega = isOmegaEntry(entry);
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const file = queue.shift();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (file.split(path.sep).includes('node_modules')) continue;
      let specs;
      try { specs = specsOf(file); } catch (err) {
        failures.push(`${rel(entry)}: cannot read ${rel(file)} (${err.message})`);
        continue;
      }
      for (const spec of specs) {
        const hit = resolveSpec(file, spec);
        if (hit) {
          if (/\.(js|cjs|mjs)$/.test(hit) && !hit.split(path.sep).includes('node_modules')) queue.push(hit);
          continue;
        }
        const key = edgeKey(file, spec);
        if (!omega && allow.has(key)) {
          usedAllow.add(key);
          continue;
        }
        const why = omega ? 'omega function graph' : 'not on the non-omega allowlist';
        failures.push(`${rel(entry)}: missing ${key} (${why})`);
      }
    }
  }

  for (const line of allow) {
    if (!usedAllow.has(line)) failures.push(`allowlist entry is not a current miss: ${line}`);
  }

  if (failures.length) {
    console.error(`FAIL netlify functions load (${failures.length})`);
    for (const line of failures) console.error(line);
    process.exit(1);
  }
  console.log(`PASS netlify functions load (${entries.length} functions, static)`);
}

main();
