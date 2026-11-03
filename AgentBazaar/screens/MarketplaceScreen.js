import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { useStore } from '../store/Store';
import { ALL, categoriesOf, categoryLabel, viewListing, catalogStats, formatCount } from '../ui/listing';

export default function MarketplaceScreen({ navigation }) {
  const t = useTheme();
  const { ready, listings } = useStore();
  const [cat, setCat] = useState(ALL);
  const [q, setQ] = useState('');

  const all = Array.isArray(listings) ? listings : [];
  // Category chips come from the catalog itself, so a new category shows up without code changes.
  const cats = useMemo(() => categoriesOf(all), [all]);
  const items = useMemo(() => all.map((l) => viewListing(l, t, cats)), [all, t, cats]);
  const stats = useMemo(() => catalogStats(all), [all]);
  const active = cats.includes(cat) ? cat : ALL;

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((l) => (active === ALL || l.cat === active) &&
      (!term || [l.name, l.description, l.catLabel].some((f) => (f || '').toLowerCase().includes(term))));
  }, [active, q, items]);

  const s = styles(t);

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={s.head}>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>AGENT BAZAAR</Text>
            <Text style={s.title} numberOfLines={1}>Marketplace</Text>
            <Text style={s.caption} numberOfLines={1}>Agents shop their own upgrades</Text>
          </View>
          <Pressable
            onPress={() => { setCat(ALL); setQ(''); }}
            style={({ pressed }) => [s.add, pressed && { opacity: 0.7 }]}
            accessibilityLabel="Reset filters"
          >
            <Ionicons name="refresh" size={20} color={t.onAccent || '#FFFFFF'} />
          </Pressable>
        </View>

        <View style={s.hero}>
          <Text style={s.heroLabel}>LIVE CATALOG</Text>
          <Text style={s.heroNumber}>{ready ? stats.count : '–'}</Text>
          <Text style={s.heroCaption}>{stats.count === 1 ? 'live listing' : 'live listings'}</Text>
          <View style={s.tiles}>
            <View style={s.tile}>
              <Text style={s.tileLabel}>calls 24h</Text>
              <Text style={s.tileValue}>{ready ? formatCount(stats.calls24h) : '–'}</Text>
            </View>
            <View style={s.tile}>
              <Text style={s.tileLabel}>median latency</Text>
              <Text style={s.tileValue}>{ready && stats.medianLatencyMs !== null ? stats.medianLatencyMs + 'ms' : '–'}</Text>
            </View>
          </View>
        </View>

        <View style={s.searchWrap}>
          <Ionicons name="search" size={16} color={t.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search listings"
            placeholderTextColor={t.textMuted}
            style={s.search}
            autoCorrect={false}
            returnKeyType="search"
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ('')} hitSlop={8} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={16} color={t.textMuted} />
            </Pressable>
          )}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {cats.map((c) => {
            const on = c === active;
            return (
              <Pressable
                key={c}
                onPress={() => setCat(c)}
                style={({ pressed }) => [s.chip, on && s.chipOn, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>{categoryLabel(c)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>{active === ALL ? 'All listings' : categoryLabel(active)}</Text>
          <Text style={s.sectionCount}>{rows.length + (rows.length === 1 ? ' result' : ' results')}</Text>
        </View>

        {!ready ? (
          <View style={s.card}><Text style={s.empty}>Loading catalog…</Text></View>
        ) : rows.length === 0 ? (
          <View style={s.emptyBox}>
            <View style={s.emptyIcon}><Ionicons name="pricetags-outline" size={24} color={t.accent} /></View>
            <Text style={s.emptyTitle}>No listings found</Text>
            <Text style={s.emptyLine}>Try another category or clear your search.</Text>
            <Pressable onPress={() => { setCat(ALL); setQ(''); }} style={({ pressed }) => [s.emptyBtn, pressed && { opacity: 0.7 }]}>
              <Text style={s.emptyBtnText}>Clear filters</Text>
            </Pressable>
          </View>
        ) : rows.map((l) => (
          <Pressable
            key={l.id}
            onPress={() => navigation.navigate('Listing Detail', { id: l.id, name: l.name || '', unit: l.unit, price: l.price || 0, cat: l.cat, icon: l.icon, color: l.color })}
            style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel={`${l.name}, ${l.priceText} ${l.unit}`}
          >
            <View style={[s.rowIcon, { backgroundColor: (l.color || t.accent) + '26' }]}>
              <Ionicons name={l.icon} size={18} color={l.color} />
            </View>
            <View style={s.rowBody}>
              <Text style={s.rowName} numberOfLines={1}>{l.name || ''}</Text>
              <Text style={s.rowUnit} numberOfLines={1}>{l.catLabel}{l.latencyMs ? ' · ' + l.latencyMs + 'ms' : ''}</Text>
            </View>
            <View style={s.rowPriceCol}>
              <Text style={s.rowPrice} numberOfLines={1}>{l.priceText}</Text>
              <Text style={s.rowPer} numberOfLines={1}>{l.unit}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={t.textMuted} style={{ marginLeft: 6 }} />
          </Pressable>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = (t) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 8, paddingBottom: 16 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.accent, marginBottom: 6 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '800', color: t.text },
  caption: { fontSize: 13, color: t.textMuted, marginTop: 4 },
  add: { width: 36, height: 36, borderRadius: 18, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginTop: 12, marginLeft: 10 },
  hero: { backgroundColor: t.surface, borderRadius: 24, padding: 20, marginBottom: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  heroLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.accent, marginBottom: 8 },
  heroNumber: { fontSize: 36, lineHeight: 42, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 13, color: t.textMuted, marginTop: 2 },
  tiles: { flexDirection: 'row', marginTop: 16 },
  tile: { flex: 1, backgroundColor: t.surfaceAlt, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginRight: 10 },
  tileLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: t.textMuted, marginBottom: 4 },
  tileValue: { fontSize: 20, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  searchWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, paddingHorizontal: 12, height: 44, marginBottom: 14 },
  search: { flex: 1, marginLeft: 8, fontSize: 16, color: t.text, paddingVertical: 0 },
  chips: { paddingHorizontal: 0, paddingBottom: 16 },
  chip: { height: 40, borderRadius: 20, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', marginRight: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, backgroundColor: t.surface },
  chipOn: { backgroundColor: t.accent, borderColor: t.accent },
  chipText: { fontSize: 14, fontWeight: '600', color: t.textMuted },
  chipTextOn: { color: t.onAccent || '#FFFFFF' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '800', color: t.text },
  sectionCount: { fontSize: 13, color: t.textMuted },
  card: { backgroundColor: t.surface, borderRadius: 16, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  empty: { fontSize: 14, color: t.textMuted },
  emptyBox: { alignItems: 'center', backgroundColor: t.surface, borderRadius: 16, paddingVertical: 28, paddingHorizontal: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  emptyIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: t.text, marginBottom: 4 },
  emptyLine: { fontSize: 14, color: t.textMuted, textAlign: 'center', marginBottom: 16 },
  emptyBtn: { height: 44, paddingHorizontal: 22, borderRadius: 22, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { fontSize: 15, fontWeight: '700', color: t.onAccent || '#FFFFFF' },
  row: { flexDirection: 'row', alignItems: 'center', height: 72, backgroundColor: t.surface, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 15, fontWeight: '700', color: t.text },
  rowUnit: { fontSize: 12, color: t.textMuted, marginTop: 3 },
  rowPriceCol: { alignItems: 'flex-end', marginLeft: 8, maxWidth: '40%' },
  rowPrice: { fontSize: 15, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  rowPer: { fontSize: 11, color: t.textMuted, marginTop: 2 },
});
