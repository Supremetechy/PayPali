import { Platform as ShimPlatform, StyleSheet as ShimStyleSheet } from 'react-native';

if (ShimPlatform.OS === 'web') {
  // Web-preview guard for the "Cannot set indexed properties on this object"
  // red screen (Chrome: "Failed to set an indexed property [0] on
  // 'CSSStyleDeclaration'"). Proven with a debugger on the real player
  // (2026-09-08): react-native-svg's web bundle hands React DOM the style prop
  // as written, React DOM's style setter walks an ARRAY's keys and writes
  // style["0"] on the SVG node, the browser rejects it, and the whole preview
  // dies at first render with no file or stack. Every element passes through
  // createElement / jsx, so flatten a style array for DOM-tag elements there.
  // React Native's own components never reach this branch (their style is
  // resolved before the DOM tag is created). This module is the entry's first
  // import, so it runs before react-native-svg or any screen is evaluated.
  try {
    const flat = (s) => {
      if (!Array.isArray(s)) return s;
      try { const f = ShimStyleSheet.flatten(s); if (f && typeof f === 'object' && !Array.isArray(f)) return f; } catch (e) {}
      const out = {};
      const walk = (x) => { if (!x) return; if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) walk(x[i]); } else if (typeof x === 'object') Object.assign(out, x); };
      walk(s);
      return out;
    };
    const applied = [];
    const guard = (mod, key, label) => {
      const orig = mod ? mod[key] : null;
      if (typeof orig !== 'function') return;
      if (orig.__wronStyleGuard) { applied.push(label); return; }
      const wrapped = function () {
        // Hot path for every element of every render: decide with two reads
        // and only copy arguments in the rare svg-array case.
        const type = arguments[0], props = arguments[1];
        if (props && Array.isArray(props.style) && (typeof type === 'string' || (type && typeof type === 'object' && typeof type.type === 'string'))) {
          const args = Array.prototype.slice.call(arguments);
          const next = Object.assign({}, props);
          next.style = flat(props.style);
          args[1] = next;
          return orig.apply(this, args);
        }
        return orig.apply(this, arguments);
      };
      wrapped.__wronStyleGuard = true;
      try { mod[key] = wrapped; } catch (e) { return; }
      if (mod[key] === wrapped) applied.push(label);
    };
    const guardMod = (mod, name, keys) => {
      if (!mod) return;
      for (let i = 0; i < keys.length; i++) {
        guard(mod, keys[i], name + '.' + keys[i]);
        if (mod.default && mod.default !== mod && typeof mod.default === 'object') guard(mod.default, keys[i], name + '.default.' + keys[i]);
      }
    };
    // Literal module names only: the preview's module loader resolves
    // require() statically and a computed name throws (measured).
    let reactMod = null, jsxMod = null;
    try { reactMod = require('react'); } catch (e) {}
    try { jsxMod = require('react/jsx-runtime'); } catch (e) {}
    guardMod(reactMod, 'react', ['createElement', 'cloneElement']);
    guardMod(jsxMod, 'react/jsx-runtime', ['jsx', 'jsxs']);
    globalThis.__wronStyleGuard = applied.length ? applied.join(',') : 'none';
  } catch (e) {
    try { globalThis.__wronStyleGuard = 'error'; } catch (x) {}
  }
}


