// One place that turns a Store listing into what the screens draw.
// Store listings look like: { id, name, category, description, price (number), priceUnit, latencyMs, calls24h, mcpEndpoint, tiers }
// Older or hand-made listings may use cat / unit / icon / color instead; those are honored too.

const CATEGORY = {
  inference: { label: 'Inference', icon: 'flash-outline' },
  skills: { label: 'Skills', icon: 'extension-puzzle-outline' },
  compute: { label: 'Compute', icon: 'hardware-chip-outline' },
  mcp: { label: 'MCP', icon: 'git-network-outline' },
};

export const ALL = 'All';

export function categoryOf(l) {
  return String((l && (l.category || l.cat)) || 'other').toLowerCase();
}

export function categoryLabel(key) {
  if (key === ALL) return ALL;
  const meta = CATEGORY[key];
  return meta ? meta.label : key.charAt(0).toUpperCase() + key.slice(1);
}

/** Category keys in the order they first appear in the catalog, preceded by "All". */
export function categoriesOf(listings) {
  const seen = [];
  for (const l of listings || []) {
    const c = categoryOf(l);
    if (!seen.includes(c)) seen.push(c);
  }
  return [ALL, ...seen];
}

/** £ with enough decimals to show sub-penny API prices (0.00013 stays 0.00013, 1.85 stays 1.85). */
export function formatPrice(price) {
  const n = Number(price) || 0;
  if (n === 0) return '£0';
  if (n >= 0.01) return '£' + n.toFixed(2);
  return '£' + n.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

/** Normalized view of a listing. `t` is the theme (for category colors). */
export function viewListing(l, t, cats) {
  const cat = categoryOf(l);
  const idx = Math.max(0, (cats || []).indexOf(cat) - 1);
  const accents = (t && t.accents) || [];
  const meta = CATEGORY[cat] || {};
  return {
    ...l,
    cat,
    catLabel: categoryLabel(cat),
    unit: l.unit || l.priceUnit || '',
    priceText: formatPrice(l.price),
    icon: l.icon || meta.icon || 'pricetag-outline',
    color: l.color || accents[idx % (accents.length || 1)] || (t && t.accent) || '#5B8CFF',
    endpoint: l.mcpEndpoint || '',
  };
}

/** Catalog headline figures, computed from the listings themselves. */
export function catalogStats(listings) {
  const all = listings || [];
  const calls = all.reduce((a, l) => a + (Number(l.calls24h) || 0), 0);
  const lat = all.map((l) => Number(l.latencyMs)).filter((x) => x > 0).sort((a, b) => a - b);
  const median = lat.length ? (lat.length % 2 ? lat[(lat.length - 1) / 2] : Math.round((lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2)) : null;
  return { count: all.length, calls24h: calls, medianLatencyMs: median };
}
