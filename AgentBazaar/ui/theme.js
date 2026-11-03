import './native-shim';
import React, { createContext, useContext, useState, useEffect } from 'react';
import { View as KitRootView, Text as KitText, Pressable as KitPressable } from 'react-native';
import * as KitFontLoader from 'expo-font';
import { FONTS } from './fonts';

// ── Preview crash telemetry ─────────────────────────────────────────────────
// Every generated app imports this module, so this runs once at app start.
// In PREVIEW contexts only (__DEV__: Snack player, Expo Go via QR) it reports
// uncaught errors and unhandled rejections back to Wron, so a failure on a
// user's phone is seen by the platform instead of only by the user. Release
// builds (__DEV__ false: TestFlight, App Store) never report. Every line is
// guarded — this must be inert in any environment that lacks the pieces.
(() => {
  try {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return;
    if (typeof fetch !== 'function') return;
    const seen = new Set(); let sent = 0;
    const report = (msg, stack, fatal) => {
      try {
        const key = String(msg == null ? 'unknown error' : msg).slice(0, 300);
        if (seen.has(key) || sent >= 5) return;
        seen.add(key); sent += 1;
        fetch('https://www.wron.ai/api/preview-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: '__WRON_CHAT_ID__',
            message: key,
            stack: String(stack || '').slice(0, 1500),
            fatal: !!fatal,
            platform: (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') ? 'native' : 'web',
          }),
        }).catch(() => {});
      } catch (e) {}
    };
    // The screen boundary below reports through the same channel.
    try { globalThis.__wronReportPreviewError = report; } catch (e) {}
    if (typeof ErrorUtils !== 'undefined' && ErrorUtils && ErrorUtils.getGlobalHandler) {
      const prev = ErrorUtils.getGlobalHandler();
      ErrorUtils.setGlobalHandler((e, isFatal) => {
        // The native-host shim drops one known-spurious error (see ui/native-shim.js);
        // do not report it, just hand it down so the shim can swallow it.
        if (typeof globalThis !== 'undefined' && typeof globalThis.__wronIsSpuriousError === 'function' && globalThis.__wronIsSpuriousError(e)) { if (typeof prev === 'function') prev(e, isFatal); return; }
        report(e && e.message ? e.message : e, e && e.stack, isFatal);
        if (typeof prev === 'function') prev(e, isFatal);
      });
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('unhandledrejection', (ev) => {
        const r = ev && ev.reason;
        report('Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)), r && r.stack, false);
      });
    }
  } catch (e) {}
})();

// ── Themes ──────────────────────────────────────────────────────────────────
// Each theme is a complete palette. accents[] drives category colors, chart
// bars, avatars, tag chips — the "no monochrome apps" rule made concrete.
const base = {
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 },
  // Apple's translucent system fills — one grey (#787880) at four opacities,
  // adapting to light and dark. These are the furniture of iOS: search fields,
  // segmented tracks, chips, secondary buttons and any inert grey surface. They
  // are TRANSLUCENT on purpose, so whatever is behind tints them; a solid grey
  // in their place is the reason a screen looks drawn rather than rendered.
  fill: {
    primary:    'rgba(120,120,128,0.20)',
    secondary:  'rgba(120,120,128,0.16)',
    tertiary:   'rgba(120,120,128,0.12)',
    quaternary: 'rgba(120,120,128,0.08)',
  },

  // Apple's iOS text styles, at their real sizes. The old ramp had body at 15,
  // which is a WEB body size — it is the single clearest reason a screen reads
  // as a web page in a phone frame. Apple's body is 17, the ramp is tight, and
  // hierarchy comes from weight and grey rather than from inventing more sizes.
  font: {
    // The two DISPLAY steps are not Apple's; they are the hero number a tracker
    // puts at the top of its home screen. They exist because the ramp used to
    // stop at 34, so every app that wanted a big number reached for
    // [t.font.title, { fontSize: 52 }], which keeps title's lineHeight of 34
    // and crops the digits to a band through their middle. A size the model
    // needs and cannot name is a size it will invent badly.
    // No lineHeight on either, deliberately. A hero number is one line, so it
    // has nothing to lead, and leaving it out hands the spacing to the face's
    // own metrics, which by definition hold the glyph. A number that cannot be
    // cropped is the entire point of these two steps existing.
    display:    { fontSize: 56, fontWeight: '700', letterSpacing: -1 },
    display2:   { fontSize: 44, fontWeight: '700', letterSpacing: -0.8 },
    largeTitle: { fontSize: 34, fontWeight: '700', lineHeight: 41, letterSpacing: 0.37 },
    title:      { fontSize: 28, fontWeight: '700', lineHeight: 34, letterSpacing: 0.36 },
    title2:     { fontSize: 22, fontWeight: '700', lineHeight: 28, letterSpacing: 0.35 },
    title3:     { fontSize: 20, fontWeight: '600', lineHeight: 25, letterSpacing: 0.38 },
    heading:    { fontSize: 20, fontWeight: '600', lineHeight: 25, letterSpacing: 0.38 },
    headline:   { fontSize: 17, fontWeight: '600', lineHeight: 22, letterSpacing: -0.41 },
    body:       { fontSize: 17, fontWeight: '400', lineHeight: 22, letterSpacing: -0.41 },
    callout:    { fontSize: 16, fontWeight: '400', lineHeight: 21, letterSpacing: -0.32 },
    subhead:    { fontSize: 15, fontWeight: '400', lineHeight: 20, letterSpacing: -0.24 },
    label:      { fontSize: 15, fontWeight: '600', lineHeight: 20, letterSpacing: -0.24 },
    footnote:   { fontSize: 13, fontWeight: '400', lineHeight: 18, letterSpacing: -0.08 },
    caption:    { fontSize: 12, fontWeight: '400', lineHeight: 16 },
    caption2:   { fontSize: 11, fontWeight: '400', lineHeight: 13, letterSpacing: 0.07 },
  },
};

export const themes = {
  midnight: { dark: true,  bg: '#0B0E14', surface: '#151A23', surfaceAlt: '#1D2430', text: '#F2F5F9', textMuted: '#8B95A7', border: '#232B38', accent: '#5B8CFF', accentSoft: '#16233F', success: '#3DD68C', warning: '#F5B84B', danger: '#F4645C', accents: ['#5B8CFF', '#9D7BFF', '#3DD6C3', '#F5B84B', '#FF7BAC', '#3DD68C'] },
  violet:   { dark: true,  bg: '#0E0A1F', surface: '#191330', surfaceAlt: '#231B41', text: '#F4F1FF', textMuted: '#9C93BF', border: '#2B2250', accent: '#8B6CFF', accentSoft: '#241B4A', success: '#4ADE97', warning: '#FBBF4B', danger: '#F87171', accents: ['#8B6CFF', '#5B8CFF', '#EC6BBE', '#FBBF4B', '#4ADE97', '#38BDF8'] },
  ember:    { dark: true,  bg: '#131010', surface: '#1E1917', surfaceAlt: '#292220', text: '#F7F2EE', textMuted: '#A39588', border: '#332A26', accent: '#FF8A4C', accentSoft: '#332014', success: '#7BC97F', warning: '#F5C04E', danger: '#EF5F5F', accents: ['#FF8A4C', '#F5C04E', '#E76B8B', '#7BC97F', '#5BA8C9', '#C98ADB'] },
  forest:   { dark: true,  bg: '#0C120E', surface: '#151D17', surfaceAlt: '#1E2A21', text: '#EFF5F0', textMuted: '#8FA396', border: '#25332A', accent: '#4CC38A', accentSoft: '#132A1E', success: '#4CC38A', warning: '#E8C468', danger: '#E5726A', accents: ['#4CC38A', '#8FD14F', '#E8C468', '#5BB8D4', '#B89BE8', '#E58E6A'] },
  paper:    { dark: false, bg: '#F7F5F0', surface: '#FFFFFF', surfaceAlt: '#EFECE4', text: '#1C1A15', textMuted: '#79746A', border: '#E4E0D6', accent: '#C56A3F', accentSoft: '#F6E5DB', success: '#3E8E5A', warning: '#C08A2D', danger: '#C4544A', accents: ['#C56A3F', '#3E8E5A', '#4A76B8', '#8E5FB0', '#C08A2D', '#B85479'] },
  cloud:    { dark: false, bg: '#F4F6FA', surface: '#FFFFFF', surfaceAlt: '#EAEEF5', text: '#171B26', textMuted: '#6C7688', border: '#E1E6EF', accent: '#3B6EF6', accentSoft: '#E4EBFE', success: '#2E9E68', warning: '#D08E23', danger: '#D9544E', accents: ['#3B6EF6', '#7B5CE8', '#2E9E68', '#D08E23', '#DB5C93', '#2AA5BF'] },
  blossom:  { dark: false, bg: '#FBF4F6', surface: '#FFFFFF', surfaceAlt: '#F5E9ED', text: '#26141C', textMuted: '#8D7480', border: '#EEDEE4', accent: '#D9548C', accentSoft: '#F9E1EC', success: '#3E9E71', warning: '#CE9032', danger: '#D25050', accents: ['#D9548C', '#8E5FB0', '#3E9E71', '#CE9032', '#4A76B8', '#D97B54'] },
  mono:     { dark: true,  bg: '#0A0A0A', surface: '#161616', surfaceAlt: '#212121', text: '#F5F5F5', textMuted: '#909090', border: '#2A2A2A', accent: '#F5F5F5', accentSoft: '#262626', success: '#6BCB8B', warning: '#E6C25A', danger: '#E66A62', accents: ['#F5F5F5', '#B0B0B0', '#6BCB8B', '#E6C25A', '#7FA8E8', '#E66A62'] },
};

export const themeNames = Object.keys(themes);

// A base theme supplies the polished neutral foundation (backgrounds, surfaces,
// text). Optional overrides let an EXPLICIT user color request drive the accents
// without losing that foundation — so "make it red and blue" keeps a clean base
// but recolors buttons, icons, and highlights.
// Rec. 601 luma of a hex colour, 0-255; null for anything unparseable.
function lumaOf(hex) {
  var h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Near-black on a light fill, near-white on a dark one. Not pure #000/#fff:
// both read as harsh against a saturated ground.
export function readableOn(bg) {
  var l = lumaOf(bg);
  if (l === null) return '#FFFFFF';
  return l > 150 ? '#141414' : '#FFFFFF';
}

// Which loaded face each step of the ramp is set in.
//
// ui/fonts.js carries five ROLES, not thirteen steps, because that is how many
// faces are worth downloading. Every step has to name one of them. Before this
// map existed the lookup was FONTS.scale[key], so the five steps whose names
// happened to match a role got the design's typeface and the other eight
// silently fell back to the system font: largeTitle among them, which the
// prompt tells the model to open every screen with. One app, two typefaces,
// and nothing anywhere reported it.
const FONT_ROLE = {
  display: 'title', display2: 'title', largeTitle: 'title', title: 'title', title2: 'title',
  title3: 'heading', heading: 'heading',
  headline: 'label', label: 'label',
  body: 'body', callout: 'body', subhead: 'body', footnote: 'body',
  caption: 'caption', caption2: 'caption',
};

// Leading a custom face needs, as a multiple of its size.
//
// The numbers in the ramp above are Apple's, and they are measured against San
// Francisco, whose ascent and descent fit inside about 1.2em. Most families on
// Google Fonts do not: Poppins, Nunito and Baloo all draw taller than that, and
// React Native crops a glyph to its line box rather than letting it overflow.
// So a step keeps its own leading when that is already generous and is given
// this much when it is not. It only applies where a custom face is in use;
// nothing changes for an app rendering in the system font.
const CUSTOM_FONT_LEADING = 1.32;

// The smallest multiple of the font size that holds a full glyph. Mirrored in
// src/lib/type-clipping.ts, which checks generated screens for the same thing.
const MIN_LEADING = 1.15;

// The line height a piece of text needs, or null when what it already has is
// enough.
//
// Its own function, and exported, because the two-line version of it inside
// AnimatedNumber was wrong and nothing could run it to find out: it asked
// whether the CALLER had set a lineHeight, and a caller passing
// [t.font.title, { fontSize: 52 }] has set one, inherited from the step, at 34.
// So the guard saw a line height, decided all was well, and left the number
// cropped. What matters is not whether a line height exists but whether it is
// big enough for the size it ends up next to.
export function leadingFix(size, lead) {
  if (!size || !lead) return null;
  return lead < size * MIN_LEADING ? Math.round(size * CUSTOM_FONT_LEADING) : null;
}

function resolve(name, ov, fontsReady) {
  const t = themes[name] || themes.midnight;
  const m = Object.assign({}, base, t, { name: themes[name] ? name : 'midnight' });
  if (ov) {
    if (ov.accent) m.accent = ov.accent;
    if (ov.accentSoft) m.accentSoft = ov.accentSoft;
    if (ov.accents && ov.accents.length) m.accents = ov.accents;
    // The neutrals, for when a preset is the right FAMILY but the wrong cast.
    // Eight presets cannot cover every ground a design commits to: an approved
    // mockup on neutral grey #F2F2F0 could only be reached through 'paper',
    // whose #F7F5F0 is warm, and the design review came back "background is a
    // warm beige where the design is neutral grey" on every screen — with no way
    // to answer it, because accent overrides cannot move the ground. Each key is
    // independent and optional, so a theme passed none behaves exactly as before.
    // Semantic colours travel with the rest now. Left to the preset they were the
    // last place a design's palette leaked: a build whose every neutral and accent
    // came from the approved designs still drew "Delayed" in the preset's amber
    // and "On Time" in the preset's green, so three colours on the screen came
    // from a theme nobody chose.
    var NEUTRALS = ['bg', 'surface', 'surfaceAlt', 'text', 'textMuted', 'border', 'success', 'warning', 'danger'];
    for (var i = 0; i < NEUTRALS.length; i++) {
      var k = NEUTRALS[i];
      if (ov[k]) m[k] = ov[k];
    }
    // Whoever sets the ground decides light or dark, not the preset it started
    // from: dark drives the status bar and every isDark branch in the kit, so
    // leaving it stale is how you get white status-bar text on a white app.
    if (ov.dark === true || ov.dark === false) m.dark = ov.dark;
  }
  // Readable text ON a filled accent surface. Every generated screen needs this
  // — a primary button, a selected chip, a checked circle — and without a token
  // for it the model writes '#FFFFFF', which is right for a deep accent and
  // invisible on a light one (a mint or amber accent gets white-on-white). It is
  // COMPUTED rather than stored per theme because the accent is routinely
  // overridden above, and a stored value would then describe the old colour.
  m.onAccent = readableOn(m.accent);
  // The typeface the approved designs are set in, applied to the whole type
  // scale at once. Every kit component and every generated screen reads
  // t.font.title / heading / body / label / caption, so one assignment here
  // reaches all of them and no screen has to remember a fontFamily.
  //
  // fontWeight is REMOVED where a family is applied. React Native does not
  // synthesise weight for a custom font: asking for '800' on a family loaded at
  // 400 silently renders regular, which reads as a design that ignored its own
  // hierarchy. Each weight is loaded as its own family instead, and the scale
  // names the family for the weight it wants.
  if (fontsReady && FONTS && FONTS.scale) {
    var scaled = {};
    var keys = Object.keys(base.font);
    for (var fi = 0; fi < keys.length; fi++) {
      var key = keys[fi];
      var fam = FONTS.scale[FONT_ROLE[key] || key];
      if (!fam) { scaled[key] = base.font[key]; continue; }
      var step = base.font[key];
      var next = Object.assign({}, step, { fontFamily: fam, fontWeight: undefined });
      // A step that sets no leading keeps setting none: the face's own metrics
      // are already enough, and giving it a number here could only make it worse.
      if (step.lineHeight) next.lineHeight = Math.max(step.lineHeight, Math.round(step.fontSize * CUSTOM_FONT_LEADING));
      scaled[key] = next;
    }
    m.font = scaled;
  }
  return m;
}

// Load the design's typeface. Never blocks: the app renders in the system font
// and re-renders into the real one the moment it arrives, because a font that
// 404s or a phone that is offline must not be able to produce a blank app.
function useKitFonts() {
  var [ready, setReady] = useState(false);
  useEffect(function () {
    if (!FONTS || !FONTS.files || !FONTS.files.length) return;
    var map = {};
    for (var i = 0; i < FONTS.files.length; i++) map[FONTS.files[i].family] = FONTS.files[i].url;
    var live = true;
    var done = function () { if (live) setReady(true); };
    try {
      var p = KitFontLoader.loadAsync(map);
      if (p && p.then) p.then(done, done); else done();
    } catch (e) { done(); }
    return function () { live = false; };
  }, []);
  return ready;
}

// ── Provider ────────────────────────────────────────────────────────────────
const ThemeContext = createContext(resolve('midnight'));
const ThemeSetterContext = createContext(function () {});
// True below the outermost ThemeProvider, so a nested one (a per-screen theme
// override) stays layout-transparent instead of adding a second sized root.
const KitNestedContext = createContext(false);

export function ThemeProvider(props) {
  const [name, setName] = useState(props.theme || 'midnight');
  const fontsReady = useKitFonts();
  const nested = useContext(KitNestedContext);
  // accent / accents / accentSoft props (if provided) override the preset —
  // this is how explicit user-requested colors are honored.
  const ov = { accent: props.accent, accentSoft: props.accentSoft, accents: props.accents,
    bg: props.bg, surface: props.surface, surfaceAlt: props.surfaceAlt,
    text: props.text, textMuted: props.textMuted, border: props.border,
    success: props.success, warning: props.warning, danger: props.danger, dark: props.dark };
  // The app's root, bounded on web. In the web player (and any browser) the
  // host root is not a flex context, so the app's flex:1 chain resolves to
  // content height: every ScrollView grows to its content, the overflow is
  // clipped at the root, and nothing scrolls — seen live on a recipe box whose
  // list container measured 1306px inside a 757px screen. A definite viewport
  // height here re-bounds the whole tree so lists shrink and scroll; native
  // gets only the flex:1 it already had.
  var rootStyle = [{ flex: 1 }, typeof document !== 'undefined' ? { height: '100vh', maxHeight: '100vh', overflow: 'hidden' } : null];
  var body = nested ? props.children : React.createElement(KitRootView, { style: rootStyle }, props.children);
  return React.createElement(
    ThemeContext.Provider,
    { value: resolve(name, ov, fontsReady) },
    React.createElement(ThemeSetterContext.Provider, { value: setName },
      React.createElement(KitNestedContext.Provider, { value: true }, body))
  );
}

export function useTheme() { return useContext(ThemeContext); }
export function useSetTheme() { return useContext(ThemeSetterContext); }

// ── Screen boundary ─────────────────────────────────────────────────────────
// A screen that throws while rendering must not take the whole app down with
// a red screen. Every navigator registration is wrapped at build time
// (guardNavigatorScreens in the builder), so a crash inside one screen shows
// this card, keeps every other tab alive, and is reported with the screen's
// name so it can be fixed from the chat. Release builds behave the same; the
// report itself only fires in preview contexts (see the reporter above).
function ScreenFallback(props) {
  const t = useTheme() || {};
  const bg = t.bg || '#0B0E14', surface = t.surface || '#151A23', text = t.text || '#F2F5F9', muted = t.textMuted || '#8B95A7', accent = t.accent || '#5B8CFF';
  const message = String(props.error && props.error.message ? props.error.message : props.error || 'Unknown error').slice(0, 220);
  return React.createElement(KitRootView, { style: { flex: 1, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', padding: 24 } },
    React.createElement(KitRootView, { style: { width: '100%', maxWidth: 420, backgroundColor: surface, borderRadius: 20, padding: 22 } },
      React.createElement(KitText, { style: { color: text, fontSize: 19, fontWeight: '800', marginBottom: 8 } }, 'This screen hit a problem'),
      React.createElement(KitText, { style: { color: muted, fontSize: 14, lineHeight: 20, marginBottom: 14 } }, 'The rest of the app still works. This has been logged so it can be fixed from the chat.'),
      React.createElement(KitText, { style: { color: muted, fontSize: 12, lineHeight: 17, marginBottom: 18, fontFamily: typeof document !== 'undefined' ? 'monospace' : undefined } }, (props.name ? props.name + ': ' : '') + message),
      React.createElement(KitPressable, { onPress: props.onRetry, accessibilityRole: 'button', style: { backgroundColor: accent, borderRadius: 12, paddingVertical: 12, alignItems: 'center' } },
        React.createElement(KitText, { style: { color: bg, fontSize: 15, fontWeight: '700' } }, 'Try again'))));
}

export class ScreenBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; this.retry = this.retry.bind(this); }
  static getDerivedStateFromError(error) { return { error: error || new Error('Unknown error') }; }
  componentDidCatch(error, info) {
    try {
      const name = this.props.name || 'screen';
      const message = String(error && error.message ? error.message : error).slice(0, 300);
      const stack = String((error && error.stack) || '') + (info && info.componentStack ? '\n' + String(info.componentStack).slice(0, 600) : '');
      const rep = typeof globalThis !== 'undefined' ? globalThis.__wronReportPreviewError : null;
      if (typeof rep === 'function') rep('Screen "' + name + '" crashed: ' + message, stack, false);
      // In the web preview the builder page listens for this and shows its
      // "preview crashed" banner with the fix button, exactly as for a red screen.
      if (typeof window !== 'undefined' && window.parent && window.parent !== window && typeof window.parent.postMessage === 'function') {
        window.parent.postMessage({ type: 'wron:screen-crash', screen: name, message: message, stack: stack.slice(0, 1200) }, '*');
      }
    } catch (e) {}
  }
  retry() { this.setState({ error: null }); }
  render() {
    if (this.state.error) return React.createElement(ScreenFallback, { name: this.props.name, error: this.state.error, onRetry: this.retry });
    return this.props.children;
  }
}

// guardScreen(Component, "Name") returns the component wrapped in a
// ScreenBoundary, once per component (a fresh wrapper on every render would
// remount the screen each time the navigator re-renders).
const guardedCache = typeof WeakMap === 'function' ? new WeakMap() : null;
export function guardScreen(Component, name) {
  if (typeof Component !== 'function' && !(Component && typeof Component === 'object')) return Component;
  if (guardedCache && guardedCache.has(Component)) return guardedCache.get(Component);
  const screenName = name || Component.displayName || Component.name || 'screen';
  const Guarded = function (props) {
    return React.createElement(ScreenBoundary, { name: screenName }, React.createElement(Component, props));
  };
  Guarded.displayName = Component.displayName || Component.name || screenName;
  if (guardedCache) { try { guardedCache.set(Component, Guarded); } catch (e) {} }
  return Guarded;
}
