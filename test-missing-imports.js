'use strict';

/**
 * Static scan: a destructured relative require name must exist on the
 * target module's exports. This is the passesPublishFloor bug class
 * (the binding is undefined, then the call throws or a constant is NaN).
 * Handlers are not invoked. A require that throws falls back to a static
 * export parse of the target file.
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const fnDir = path.join(root, 'netlify/functions');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      out += '  ';
      i += 2;
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') {
          i += 1;
          if (i < src.length) out += src[i];
          i += 1;
          continue;
        }
        if (src[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function importedNames(inner) {
  const names = [];
  for (const part of inner.split(',')) {
    const raw = part.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (!raw || raw.startsWith('...')) continue;
    const imported = raw.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(imported)) names.push(imported);
  }
  return names;
}

function resolveSpec(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  if (!base.endsWith('.js') && !base.endsWith('.json')) {
    candidates.push(`${base}.js`, `${base}.json`, path.join(base, 'index.js'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function staticHasExport(file, name) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
  const stripped = stripComments(src);
  const ident = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`exports\\.${ident}\\s*=`).test(stripped)) return true;
  if (new RegExp(`\\b${ident}\\s*:`).test(stripped) && /module\.exports\s*=/.test(stripped)) return true;
  const block = stripped.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (block && new RegExp(`(^|[,{\\s])${ident}\\s*(,|})`).test(block[1])) return true;
  return false;
}

function bindingMissing(mod, name) {
  if (mod == null || (typeof mod !== 'object' && typeof mod !== 'function')) return true;
  return mod[name] === undefined;
}

// Flat destructure only. A brace inside the pattern is a different
// statement, not this require, and must not be swallowed.
const re = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*(['"])(\.[^'"]+)\2\s*\)/g;
const missing = [];
let checked = 0;

for (const file of walk(fnDir, [])) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[3];
    const names = importedNames(m[1]);
    const line = src.slice(0, m.index).split('\n').length;
    const target = resolveSpec(file, spec);
    const rel = path.relative(root, file);
    if (!target) {
      for (const name of names) {
        missing.push(`${rel}:${line} ${spec} ${name} (module file not found)`);
      }
      continue;
    }
    let loaded;
    let loadError = null;
    try {
      loaded = require(target);
    } catch (e) {
      loadError = e;
      loaded = null;
    }
    for (const name of names) {
      checked += 1;
      if (loaded != null && !bindingMissing(loaded, name)) continue;
      if (loaded == null && staticHasExport(target, name)) continue;
      const why = loadError ? ` require failed: ${loadError.message}` : '';
      missing.push(`${rel}:${line} ${spec} ${name}${why}`);
    }
  }
}

if (missing.length) {
  console.error(`missing imports: ${missing.length}`);
  for (const row of missing) console.error(row);
  process.exit(1);
}

console.log(`missing imports: 0 (checked ${checked} destructured names)`);
