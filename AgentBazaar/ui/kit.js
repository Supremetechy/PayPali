import './native-shim';
import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Animated, Easing, Image, Platform, StyleSheet, Switch as KitSwitch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Svg, { Path, Circle, Polyline, Defs, Stop, LinearGradient as SvgGradient } from 'react-native-svg';
import { useTheme, leadingFix, readableOn } from './theme';

// Wron UI kit. Every component reads the active theme — screens built from
// these are automatically cohesive, and a dark-mode toggle is one setTheme call.

function shadow(t) {
  return t.dark
    ? { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 3 }
    : { shadowColor: '#1A1A2E', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 3 };
}

// Deterministic color from a string → one of the theme's accent hues. Icons and
// badges auto-vary by category WITHOUT relying on the model to pass colors, so a
// screen of icons is vibrant and multi-colored by default, never all one hue.
function hueFor(t, seed) {
  var s = String(seed || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return t.accents[h % t.accents.length];
}

// Safe percentage: 0 when the denominator is 0/missing, so a brand-new app with
// no history shows 0% instead of NaN%. Use for EVERY ratio/progress calculation.
export function pct(done, total) {
  var d = Number(done) || 0;
  var t = Number(total) || 0;
  if (t <= 0) return 0;
  var p = Math.round((d / t) * 100);
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

// Coerce anything non-finite to a safe fallback — guards displayed numbers.
function num(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : (fallback || 0);
}

export function Screen(props) {
  const t = useTheme();
  const pad = props.padded === false ? 0 : t.spacing.md;
  const inner = props.scroll === false
    ? React.createElement(View, { style: [{ flex: 1, paddingHorizontal: pad }, props.style] }, props.children)
    : React.createElement(ScrollView, {
        style: { flex: 1 },
        contentContainerStyle: [{ paddingHorizontal: pad, paddingBottom: 96 }, props.style],
        showsVerticalScrollIndicator: false,
      }, props.children);
  // The web player has no status bar inset, so content sat under the phone's island (2026-10-15).
  const webInset = Platform.OS === 'web' ? { paddingTop: 47 } : null;
  return React.createElement(SafeAreaView, { style: [{ flex: 1, backgroundColor: t.bg }, webInset], edges: ['top'] }, inner);
}

export function Header(props) {
  const t = useTheme();
  return React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: t.spacing.lg } },
    React.createElement(View, { style: { flex: 1, paddingRight: t.spacing.md } },
      props.eyebrow ? React.createElement(Text, { style: [t.font.caption, { color: t.accent, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 4 }] }, props.eyebrow) : null,
      React.createElement(Text, { style: [t.font.title, { color: t.text }] }, props.title),
      props.subtitle ? React.createElement(Text, { style: [t.font.body, { color: t.textMuted, marginTop: 4 }] }, props.subtitle) : null
    ),
    props.right || null
  );
}

export function HeroCard(props) {
  const t = useTheme();
  const colors = props.colors || [t.accent, t.accents[1] || t.accent];
  return React.createElement(LinearGradient, {
    colors: colors, start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
    style: [{ borderRadius: t.radius.xl, padding: t.spacing.lg, marginBottom: t.spacing.lg }, shadow(t), props.style],
  }, props.children);
}

export function Card(props) {
  const t = useTheme();
  const style = [
    { backgroundColor: t.surface, borderRadius: t.radius.lg, padding: t.spacing.md, marginBottom: t.spacing.sm + 4, borderWidth: 1, borderColor: t.border },
    shadow(t), props.style,
  ];
  if (props.onPress) {
    return React.createElement(Pressable, {
      onPress: props.onPress,
      style: function (s) { return [style, s.pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]; },
    }, props.children);
  }
  return React.createElement(View, { style: style }, props.children);
}

export function SectionTitle(props) {
  const t = useTheme();
  return React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: t.spacing.md, marginBottom: t.spacing.sm } },
    React.createElement(Text, { style: [t.font.heading, { color: t.text }] }, props.title),
    props.action ? React.createElement(Pressable, { onPress: props.onAction }, React.createElement(Text, { style: [t.font.label, { color: t.accent }] }, props.action)) : null
  );
}

export function IconBadge(props) {
  const t = useTheme();
  // Explicit color wins; otherwise auto-vary by icon name so categories are
  // multi-colored by default instead of all one accent.
  const color = props.color || hueFor(t, props.icon);
  const size = props.size || 40;
  return React.createElement(View, {
    style: { width: size, height: size, borderRadius: t.radius.md, backgroundColor: color + '22', alignItems: 'center', justifyContent: 'center' },
  }, React.createElement(Ionicons, { name: props.icon, size: size * 0.5, color: color }));
}

export function StatTile(props) {
  const t = useTheme();
  // One color per tile, auto-varied by its icon/label so a row of stats is
  // multi-colored by default; icon badge and unit share it.
  const c = props.color || hueFor(t, props.icon || props.label);
  // Non-finite numbers (NaN from a 0/0 division) render as '0', never "NaN".
  const shown = (typeof props.value === 'number' && !isFinite(props.value)) ? '0' : String(props.value == null ? '0' : props.value);
  return React.createElement(Card, { style: [{ flex: 1, alignItems: 'flex-start' }, props.style] },
    React.createElement(IconBadge, { icon: props.icon, color: c, size: 34 }),
    React.createElement(Text, { style: [t.font.title, { color: t.text, marginTop: t.spacing.sm }] },
      shown,
      props.unit ? React.createElement(Text, { style: [t.font.label, { color: c }] }, ' ' + props.unit) : null
    ),
    React.createElement(Text, { style: [t.font.caption, { color: t.textMuted, marginTop: 2 }] }, props.label)
  );
}

export function Row(props) {
  const t = useTheme();
  const inner = React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center' } },
    props.icon ? React.createElement(IconBadge, { icon: props.icon, color: props.color }) : null,
    React.createElement(View, { style: { flex: 1, marginLeft: props.icon ? t.spacing.sm + 4 : 0 } },
      React.createElement(Text, { style: [t.font.body, { color: t.text, fontWeight: '600' }] }, props.title),
      props.subtitle ? React.createElement(Text, { style: [t.font.caption, { color: t.textMuted, marginTop: 2 }] }, props.subtitle) : null
    ),
    props.right !== undefined ? props.right : (props.onPress ? React.createElement(Ionicons, { name: 'chevron-forward', size: 18, color: t.textMuted }) : null)
  );
  return React.createElement(Card, { onPress: props.onPress, style: props.style }, inner);
}

export function Chip(props) {
  const t = useTheme();
  const color = props.color || t.accent;
  const active = !!props.active;
  return React.createElement(Pressable, {
    onPress: props.onPress,
    style: function (s) {
      return [{
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: t.radius.pill, marginRight: t.spacing.sm,
        backgroundColor: active ? color : t.surfaceAlt, borderWidth: 1, borderColor: active ? color : t.border,
      }, s.pressed && { opacity: 0.8 }];
    },
  }, React.createElement(Text, { style: [t.font.label, { color: active ? readableOn(color) : t.textMuted }] }, props.label));
}

export function Button(props) {
  const t = useTheme();
  const variant = props.variant || 'primary';
  const bg = variant === 'primary' ? t.accent : variant === 'soft' ? t.accentSoft : 'transparent';
  // t.onAccent, not a guess from t.dark: the accent is routinely overridden, and
  // a light mint accent in a light theme gave white text on a near-white fill.
  const fg = variant === 'primary' ? t.onAccent : t.accent;
  return React.createElement(Pressable, {
    onPress: props.onPress, disabled: props.disabled || props.loading,
    style: function (s) {
      return [{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        backgroundColor: bg, borderRadius: t.radius.md, paddingVertical: 14, paddingHorizontal: t.spacing.lg,
        borderWidth: variant === 'ghost' ? 1 : 0, borderColor: t.border,
        opacity: props.disabled ? 0.5 : 1, marginVertical: t.spacing.xs,
      }, s.pressed && { opacity: 0.85 }, props.style];
    },
  },
    props.loading ? React.createElement(ActivityIndicator, { size: 'small', color: fg }) : null,
    props.icon && !props.loading ? React.createElement(Ionicons, { name: props.icon, size: 17, color: fg, style: { marginRight: 7 } }) : null,
    props.loading ? null : React.createElement(Text, { style: [t.font.label, { color: fg, fontSize: 15 }] }, props.label)
  );
}

export function EmptyState(props) {
  const t = useTheme();
  return React.createElement(View, { style: { alignItems: 'center', paddingVertical: t.spacing.xl * 1.5, paddingHorizontal: t.spacing.lg } },
    React.createElement(IconBadge, { icon: props.icon || 'sparkles-outline', size: 56, color: props.color }),
    React.createElement(Text, { style: [t.font.heading, { color: t.text, marginTop: t.spacing.md, textAlign: 'center' }] }, props.title),
    props.body ? React.createElement(Text, { style: [t.font.body, { color: t.textMuted, marginTop: t.spacing.sm, textAlign: 'center', lineHeight: 21 }] }, props.body) : null,
    props.actionLabel ? React.createElement(Button, { label: props.actionLabel, onPress: props.onAction, style: { marginTop: t.spacing.lg, alignSelf: 'stretch' } }) : null
  );
}

export function ProgressBar(props) {
  const t = useTheme();
  const value = Math.max(0, Math.min(1, num(props.value, 0)));
  return React.createElement(View, { style: [{ height: props.height || 8, borderRadius: t.radius.pill, backgroundColor: t.surfaceAlt, overflow: 'hidden' }, props.style] },
    React.createElement(View, { style: { width: (value * 100) + '%', height: '100%', borderRadius: t.radius.pill, backgroundColor: props.color || t.accent } })
  );
}

export function BarChart(props) {
  const t = useTheme();
  const data = props.data || [];
  const max = Math.max.apply(null, data.map(function (d) { return num(d.value, 0); }).concat([1]));
  const h = props.height || 120;
  return React.createElement(View, { style: { flexDirection: 'row', alignItems: 'flex-end', height: h + 24, gap: 8 } },
    data.map(function (d, i) {
      const barH = Math.max(4, (num(d.value, 0) / max) * h);
      return React.createElement(View, { key: String(i), style: { flex: 1, alignItems: 'center' } },
        React.createElement(View, { style: { width: '100%', maxWidth: 34, height: barH, borderRadius: 6, backgroundColor: d.color || t.accents[i % t.accents.length] } }),
        React.createElement(Text, { style: [t.font.caption, { color: t.textMuted, marginTop: 6, fontSize: 10 }] }, d.label)
      );
    })
  );
}

export function Badge(props) {
  const t = useTheme();
  const color = props.color || t.accent;
  return React.createElement(View, { style: { backgroundColor: color + '22', borderRadius: t.radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' } },
    React.createElement(Text, { style: [t.font.caption, { color: color, fontWeight: '700' }] }, props.label)
  );
}

export function Avatar(props) {
  const t = useTheme();
  const size = props.size || 40;
  // Real photo when a uri/image/source is passed; initials fallback otherwise —
  // so people, not just placeholder monograms, show up in lists and headers.
  const uri = props.uri || props.image || (typeof props.source === 'string' ? props.source : null);
  if (uri) {
    return React.createElement(Image, {
      source: { uri: uri },
      resizeMode: 'cover',
      style: [{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.surfaceAlt }, props.style],
    });
  }
  const initials = (props.name || '?').split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  const color = props.color || t.accents[(props.name || '').length % t.accents.length];
  return React.createElement(View, { style: [{ width: size, height: size, borderRadius: size / 2, backgroundColor: color + '33', alignItems: 'center', justifyContent: 'center' }, props.style] },
    React.createElement(Text, { style: { color: color, fontWeight: '700', fontSize: size * 0.38 } }, initials)
  );
}

export function FAB(props) {
  const t = useTheme();
  return React.createElement(Pressable, {
    onPress: props.onPress,
    style: function (s) {
      return [{
        position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
        backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center',
      }, shadow(t), s.pressed && { transform: [{ scale: 0.94 }] }];
    },
  }, React.createElement(Ionicons, { name: props.icon || 'add', size: 26, color: t.onAccent }));
}

// ── Apple-shaped primitives ──────────────────────────────────────────────────
// The inset grouped list is the most recognisable thing in iOS: rounded sections
// on a grey page, rows the system's height, separators hairline-thin and inset
// to where the text starts rather than running to the card edge. Building lists
// out of generic Cards is the clearest tell that an app was not made for iOS.

// A grouped section. Its title prop is the small header above it.
export function ListSection(props) {
  const t = useTheme();
  const kids = React.Children.toArray(props.children).filter(Boolean);
  return React.createElement(
    View,
    { style: [{ marginBottom: 32 }, props.style] },
    props.title
      ? React.createElement(
          Text,
          { style: [t.font.footnote, { color: t.textMuted, marginLeft: 16, marginBottom: 7 }] },
          props.title,
        )
      : null,
    React.createElement(
      View,
      { style: { backgroundColor: t.surface, borderRadius: 10, overflow: 'hidden', marginHorizontal: 16 } },
      kids.map((child, i) =>
        React.createElement(
          View,
          { key: i },
          child,
          i < kids.length - 1
            ? React.createElement(View, {
                // Inset to the text, not the card edge — that inset is the detail
                // that makes a list look native.
                style: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: props.inset == null ? 16 : props.inset },
              })
            : null,
        ),
      ),
    ),
    props.footer
      ? React.createElement(
          Text,
          { style: [t.font.footnote, { color: t.textMuted, marginHorizontal: 16, marginTop: 7 }] },
          props.footer,
        )
      : null,
  );
}

// One row of a grouped list: optional leading icon tile, a title, an optional
// secondary line, and on the right either a value, a switch, or a chevron.
export function ListRow(props) {
  const t = useTheme();
  const right = [];
  if (props.value != null)
    right.push(React.createElement(Text, { key: 'v', style: [t.font.body, { color: t.textMuted }] }, String(props.value)));
  if (props.accessory === 'switch')
    right.push(React.createElement(KitSwitch, { key: 's', value: !!props.on, onValueChange: props.onToggle, trackColor: { true: t.accent } }));
  if (props.accessory !== 'switch' && (props.onPress || props.accessory === 'chevron'))
    right.push(React.createElement(Text, { key: 'c', style: { color: t.textMuted, fontSize: 17, marginLeft: 6, marginTop: -1 } }, '›'));
  const body = React.createElement(
    View,
    { style: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 16 } },
    props.icon
      ? React.createElement(
          View,
          { style: { width: 29, height: 29, borderRadius: 7, backgroundColor: props.iconBg || t.accent, alignItems: 'center', justifyContent: 'center', marginRight: 12 } },
          typeof props.icon === 'string'
            ? React.createElement(Ionicons, { name: props.icon, size: 17, color: readableOn(props.iconBg || t.accent) })
            : props.icon,
        )
      : null,
    React.createElement(
      View,
      { style: { flex: 1 } },
      React.createElement(Text, { style: [t.font.body, { color: t.text }], numberOfLines: 1 }, props.title),
      props.subtitle
        ? React.createElement(Text, { style: [t.font.footnote, { color: t.textMuted, marginTop: 1 }], numberOfLines: 1 }, props.subtitle)
        : null,
    ),
    React.createElement(View, { style: { flexDirection: 'row', alignItems: 'center', gap: 6 } }, right),
  );
  if (!props.onPress) return body;
  return React.createElement(Pressable, { onPress: props.onPress, style: (s) => ({ opacity: s.pressed ? 0.6 : 1 }) }, body);
}

// The iOS segmented control. The track is a TRANSLUCENT grey system fill and the
// selected segment is a raised white (dark: grey) thumb carrying a hairline and a
// soft shadow. The accent colour never fills it — a solid accent pill here is the
// single clearest sign a control was drawn rather than taken from the system.
export function Segmented(props) {
  const t = useTheme();
  const items = props.items || [];
  const value = props.value != null ? props.value : items[0];
  return React.createElement(
    View,
    {
      style: [
        { flexDirection: 'row', backgroundColor: t.fill.tertiary, borderRadius: 9, padding: 2, marginHorizontal: 16 },
        props.style,
      ],
    },
    items.map((item, i) => {
      const label = typeof item === 'string' ? item : item.label;
      const key = typeof item === 'string' ? item : (item.value != null ? item.value : item.label);
      const on = key === value || label === value;
      return React.createElement(
        Pressable,
        {
          key: i,
          onPress: () => props.onChange && props.onChange(key),
          style: [
            { flex: 1, minHeight: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 8 },
            on
              ? {
                  backgroundColor: t.dark ? '#636366' : '#FFFFFF',
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: t.dark ? 0.24 : 0.12,
                  shadowRadius: 3,
                  elevation: 1,
                }
              : null,
          ],
        },
        React.createElement(
          Text,
          { style: [t.font.footnote, { fontWeight: on ? '600' : '400', color: t.text }], numberOfLines: 1 },
          label,
        ),
      );
    }),
  );
}

// The other two button roles. Apple pairs ONE filled primary with these: a grey
// system-fill secondary and a red destructive that is text on grey, never a solid
// red block. Two solid blocks of colour on one screen is the mistake.
export function SecondaryButton(props) {
  const t = useTheme();
  return React.createElement(
    Pressable,
    {
      onPress: props.onPress,
      disabled: props.disabled,
      style: (st) => [
        {
          minHeight: 50,
          borderRadius: props.pill === false ? 12 : 25,
          backgroundColor: t.fill.tertiary,
          alignItems: 'center',
          justifyContent: 'center',
          marginHorizontal: 16,
          paddingHorizontal: 20,
          opacity: st.pressed ? 0.7 : 1,
        },
        props.style,
      ],
    },
    React.createElement(
      Text,
      { style: [t.font.headline, { color: props.destructive ? t.danger : t.accent }] },
      props.title ?? props.children,
    ),
  );
}

// The iOS large title: the biggest text on the screen, left aligned, sitting on
// the page's own background with nothing behind it.
export function LargeTitle(props) {
  const t = useTheme();
  return React.createElement(
    View,
    { style: [{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, props.style] },
    React.createElement(Text, { style: [t.font.largeTitle, { color: t.text, flex: 1 }], numberOfLines: 1 }, props.children ?? props.title),
    props.right || null,
  );
}

// The one prominent action on a screen: solid accent, 17 semibold, 50 tall,
// inset to the margin and sitting above the home indicator. Everything else on
// the screen is plain tinted text, never a second block of colour.
export function PrimaryButton(props) {
  const t = useTheme();
  return React.createElement(
    Pressable,
    {
      onPress: props.onPress,
      disabled: props.disabled,
      style: (st) => [
        {
          minHeight: 50,
          borderRadius: props.pill === false ? 12 : 25,
          backgroundColor: props.disabled ? t.border : t.accent,
          alignItems: 'center',
          justifyContent: 'center',
          marginHorizontal: 16,
          paddingHorizontal: 20,
          opacity: st.pressed ? 0.85 : 1,
        },
        props.style,
      ],
    },
    React.createElement(
      Text,
      { style: [t.font.headline, { color: props.disabled ? t.textMuted : t.onAccent }] },
      props.title ?? props.children,
    ),
  );
}

export function Divider() {
  const t = useTheme();
  return React.createElement(View, { style: { height: 1, backgroundColor: t.border, marginVertical: t.spacing.md } });
}

// ── Imagery ───────────────────────────────────────────────────────────────
// Real photos (built-in RN Image — renders in the web preview AND on device).
// Pass a remote URL string or an { uri } source. Use for hero images, cards,
// thumbnails, cover art, real people/products — never leave a visual app image-free.
export function AppImage(props) {
  const t = useTheme();
  const uri = typeof props.source === 'string' ? props.source : (props.uri || (props.source && props.source.uri) || null);
  // contentFit is this component's own prop, but resizeMode is what react-native
  // calls it and therefore what anyone writes from muscle memory. Accepting both
  // costs nothing; rejecting one silently falls through to 'cover' and crops the
  // image — which is invisible on a photo and ruins a cut-out mascot.
  const fitProp = props.contentFit || props.resizeMode;
  const fit = fitProp === 'contain' ? 'contain' : fitProp === 'fill' ? 'stretch' : 'cover';
  // Built-in RN Image (not the Expo image module): it is preloaded in the Snack web
  // player, so real photos render in the browser preview AND on device. The Expo
  // image module's web build isn't preloaded and can fail to bundle, blanking images.
  return React.createElement(Image, {
    source: uri ? { uri: uri } : props.source,
    resizeMode: fit,
    // A rounded grey tile is the right placeholder for a PHOTO: it holds the
    // space and reads as loading. It is wrong for artwork — a transparent mascot
    // or logotype ends up sitting on a permanent grey rounded rectangle, which is
    // exactly what the cut-out was for. contentFit 'contain' is the signal: you
    // letterbox artwork and logos, you crop photographs. So 'contain' gets no
    // tile and no corner rounding unless the caller asks for them.
    style: [{
      width: props.width || '100%',
      height: props.height || 180,
      borderRadius: props.radius != null ? props.radius : (fit === 'contain' ? 0 : t.radius.lg),
      backgroundColor: props.background != null ? props.background : (fit === 'contain' ? 'transparent' : t.surfaceAlt),
    }, props.style],
  });
}

// The generated app and its native shell now use the same Expo SDK, so the
// package's own BlurView can select its native view on each platform.
export function Blur(props) {
  return React.createElement(BlurView, { intensity: props.intensity, tint: props.tint, style: props.style }, props.children);
}

// Frosted-glass surface (kit Blur, see above). Great for floating headers, overlays on
// imagery, and premium cards. Put content as children.
export function GlassCard(props) {
  const t = useTheme();
  return React.createElement(Blur, {
    intensity: props.intensity || 40,
    tint: t.dark ? 'dark' : 'light',
    style: [{ borderRadius: t.radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: t.border, padding: t.spacing.md, marginBottom: t.spacing.sm + 4 }, props.style],
  }, props.children);
}

// ── Motion (built-in Animated API — always renders in the Snack preview, no
// babel plugin needed). Reanimated is also available to app code for advanced
// gesture work, but these cover the everyday polish. ──────────────────────────

// Shimmering placeholder shown while data loads — the difference between "loading
// spinner" and "feels fast". Match its size to the content it stands in for.
export function Skeleton(props) {
  const t = useTheme();
  const opacity = React.useRef(new Animated.Value(0.45)).current;
  React.useEffect(function () {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return function () { loop.stop(); };
  }, []);
  return React.createElement(Animated.View, {
    style: [{ backgroundColor: t.surfaceAlt, borderRadius: props.radius != null ? props.radius : t.radius.md, width: props.width || '100%', height: props.height || 16, opacity: opacity }, props.style],
  });
}

// Entrance animation — fades and slides content up on mount. Wrap cards, list
// items (stagger with delay={index*60}), or whole screens.
export function FadeInView(props) {
  const v = React.useRef(new Animated.Value(0)).current;
  React.useEffect(function () {
    Animated.timing(v, { toValue: 1, duration: props.duration || 420, delay: props.delay || 0, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [props.offset != null ? props.offset : 12, 0] });
  return React.createElement(Animated.View, { style: [{ opacity: v, transform: [{ translateY: translateY }] }, props.style] }, props.children);
}

// Count-up number for stats/totals — animates from 0 to value on mount. Supports
// prefix ('$'), suffix ('%'), and decimals.
export function AnimatedNumber(props) {
  const t = useTheme();
  const target = num(props.value, 0);
  const anim = React.useRef(new Animated.Value(0)).current;
  const state = React.useState('0');
  const display = state[0], setDisplay = state[1];
  React.useEffect(function () {
    const id = anim.addListener(function (s) {
      const val = props.decimals ? s.value.toFixed(props.decimals) : String(Math.round(s.value));
      setDisplay((props.prefix || '') + val + (props.suffix || ''));
    });
    Animated.timing(anim, { toValue: target, duration: props.duration || 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return function () { anim.removeListener(id); };
  }, [target]);
  // A style array merges PER PROPERTY, so style={{ fontSize: 52 }} raises the
  // size and leaves title's lineHeight of 34 in place, and the digits are cropped
  // to a band through their middle. This is the single most common way the bug
  // reached a screen, because a counting hero number is exactly what this
  // component is for and 28 is never the size anyone wants it at.
  //
  // The caller's own style is flattened over the step first, so what is compared
  // is what the text will actually measure, however the size arrived: inline,
  // through a StyleSheet member, or through a nested array.
  const over = StyleSheet.flatten([t.font.title, props.style]) || {};
  const lead = leadingFix(over.fontSize, over.lineHeight);
  return React.createElement(Text, { style: [t.font.title, { color: props.color || t.text }, props.style, lead ? { lineHeight: lead } : null] }, display);
}

// ── Charts (react-native-svg — real vector charts, not flexbox rectangles). ──

// Tiny inline trend line for cards/rows. data = array of numbers.
export function Sparkline(props) {
  const t = useTheme();
  const data = (props.data || []).map(function (v) { return num(v, 0); });
  const w = props.width || 84, h = props.height || 28;
  const color = props.color || t.accent;
  if (data.length < 2) return React.createElement(View, { style: { width: w, height: h } });
  const max = Math.max.apply(null, data), min = Math.min.apply(null, data), range = (max - min) || 1;
  const pts = data.map(function (v, i) {
    const x = (i / (data.length - 1)) * w;
    const y = h - 3 - ((v - min) / range) * (h - 6);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return React.createElement(Svg, { width: w, height: h },
    React.createElement(Polyline, { points: pts, fill: 'none', stroke: color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' })
  );
}

// Full line chart with a soft gradient area fill. data = array of numbers, or of
// { value, label }. Fills its container width.
export function LineChart(props) {
  const t = useTheme();
  const raw = props.data || [];
  const vals = raw.map(function (d) { return typeof d === 'number' ? num(d, 0) : num(d && d.value, 0); });
  const H = props.height || 170, P = 10;
  const color = props.color || t.accent;
  if (vals.length < 2) return React.createElement(View, { style: { height: H } });
  const W = 320;
  const max = Math.max.apply(null, vals), min = Math.min.apply(null, vals), range = (max - min) || 1;
  const xy = vals.map(function (v, i) {
    return [P + (i / (vals.length - 1)) * (W - 2 * P), P + (1 - (v - min) / range) * (H - 2 * P)];
  });
  const line = xy.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
  const area = line + ' L' + xy[xy.length - 1][0].toFixed(1) + ' ' + (H - P) + ' L' + xy[0][0].toFixed(1) + ' ' + (H - P) + ' Z';
  const gid = 'g' + Math.round(Math.random() * 1e9).toString(36);
  return React.createElement(Svg, { width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
    React.createElement(Defs, null,
      React.createElement(SvgGradient, { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
        React.createElement(Stop, { offset: '0', stopColor: color, stopOpacity: '0.28' }),
        React.createElement(Stop, { offset: '1', stopColor: color, stopOpacity: '0' })
      )
    ),
    React.createElement(Path, { d: area, fill: 'url(#' + gid + ')', stroke: 'none' }),
    React.createElement(Path, { d: line, fill: 'none', stroke: color, strokeWidth: 2.5, strokeLinejoin: 'round', strokeLinecap: 'round' })
  );
}

// Circular progress / donut. value is 0..1. Put a label or AnimatedNumber inside
// via children (rendered centered).
export function RingProgress(props) {
  const t = useTheme();
  const size = props.size || 120, stroke = props.stroke || 12;
  const value = Math.max(0, Math.min(1, num(props.value, 0)));
  const color = props.color || t.accent;
  const r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  return React.createElement(View, { style: [{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, props.style] },
    React.createElement(Svg, { width: size, height: size },
      React.createElement(Circle, { cx: size / 2, cy: size / 2, r: r, stroke: t.surfaceAlt, strokeWidth: stroke, fill: 'none' }),
      React.createElement(Circle, {
        cx: size / 2, cy: size / 2, r: r, stroke: color, strokeWidth: stroke, fill: 'none',
        strokeLinecap: 'round', strokeDasharray: circ, strokeDashoffset: circ * (1 - value),
        rotation: -90, originX: size / 2, originY: size / 2,
      })
    ),
    props.children != null ? React.createElement(View, { style: { position: 'absolute', alignItems: 'center', justifyContent: 'center' } }, props.children) : null
  );
}
