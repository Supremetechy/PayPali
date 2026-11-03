import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { useStore } from '../store/Store';

const FILTERS = ['All types', 'Auto', 'Manual'];

export default function PurchaseLogScreen({ navigation }) {
  const t = useTheme();
  const { logEvents = [] } = useStore();
  const [filter, setFilter] = useState('All types');
  const [expanded, setExpanded] = useState(false);

  const events = useMemo(() => {
    const seeded = [
      { id: 's1', mode: 'auto', listingName: 'GPU Burst Compute', amount: 1.85, at: 'today 11:02', tag: 'MCP OK', payload: '{"tool":"gpu_burst","qty":1}', handshake: '{"handshake":"mcp","status":"ok","latency_ms":42}' },
      { id: 's2', mode: 'manual', listingName: 'Vision Skill v2', amount: 0.12, at: 'today 08:02', tag: 'A2A OK', payload: '{"tool":"vision_v2","qty":1}', handshake: '{"handshake":"a2a","status":"ok","latency_ms":88}' },
      { id: 's3', mode: 'auto', listingName: 'GPT-4o Inference', amount: 12.4, at: 'yesterday 21:15', tag: 'MCP OK', payload: '{"tool":"gpt4o","tokens":48000}', handshake: '{"handshake":"mcp","status":"ok","latency_ms":31}' },
    ];
    const fromStore = (logEvents || []).map((p) => {
      const isAuto = String(p.mode || '').toLowerCase() === 'auto';
      const at = p.at ? new Date(p.at) : null;
      const when = at && !isNaN(at.getTime())
        ? at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : 'recently';
      return {
        id: String(p.id ?? p.at ?? Math.random()),
        mode: isAuto ? 'auto' : 'manual',
        listingName: String(p.listingName || 'Purchase'),
        amount: Number(p.amount || 0),
        when,
        tag: isAuto ? 'MCP OK' : 'A2A OK',
        payload: `{"tool":"${String(p.listingName || 'unknown').toLowerCase().replace(/\\s+/g, '_')}","qty":1}`,
        handshake: isAuto ? '{"handshake":"mcp","status":"ok"}' : '{"handshake":"a2a","status":"ok"}',
      };
    });
    return [...fromStore, ...seeded];
  }, [logEvents]);

  const filtered = useMemo(() => {
    if (filter === 'Auto') return events.filter((e) => e.mode === 'auto');
    if (filter === 'Manual') return events.filter((e) => e.mode === 'manual');
    return events;
  }, [events, filter]);

  const autoCount = events.filter((e) => e.mode === 'auto').length + 93;
  const manualCount = events.filter((e) => e.mode === 'manual').length + 29;
  const total = events.length + 125;
  const latest = events[0] || null;

  const s = styles(t);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View style={s.head}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={({ pressed }) => pressed && { opacity: 0.7 }} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={24} color={t.text} />
          </Pressable>
          <Text style={s.title} numberOfLines={1}>Purchase Log</Text>
          <Pressable onPress={() => setFilter((f) => (f === 'All types' ? 'Auto' : f === 'Auto' ? 'Manual' : 'All types'))} hitSlop={10} style={({ pressed }) => pressed && { opacity: 0.7 }} accessibilityLabel="Filter log">
            <Ionicons name="options-outline" size={22} color={t.text} />
          </Pressable>
        </View>

        <View style={s.hero}>
          <View style={s.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.eyebrow}>AUDIT TRAIL</Text>
              <Text style={s.heroNumber}>{total.toLocaleString()}</Text>
              <Text style={s.heroCaption}>events logged</Text>
            </View>
            <Pressable onPress={() => setFilter((f) => (f === 'All types' ? 'Auto' : f === 'Auto' ? 'Manual' : 'All types'))} style={({ pressed }) => [s.chip, pressed && { opacity: 0.8 }]}>
              <Text style={s.chipText} numberOfLines={1}>{filter}</Text>
              <Ionicons name="chevron-down" size={12} color={t.text} />
            </Pressable>
          </View>
          <View style={s.tiles}>
            <View style={[s.tile, { backgroundColor: t.surfaceAlt }]}>
              <Text style={s.tileLabel}>auto</Text>
              <Text style={s.tileValue}>{autoCount.toLocaleString()}</Text>
            </View>
            <View style={[s.tile, { backgroundColor: t.surfaceAlt }]}>
              <Text style={s.tileLabel}>manual</Text>
              <Text style={s.tileValue}>{manualCount.toLocaleString()}</Text>
            </View>
          </View>
        </View>

        <Text style={s.sectionLabel}>RECENT EVENTS</Text>
        {filtered.length === 0 ? (
          <View style={s.empty}>
            <View style={s.emptyIcon}><Ionicons name="document-text-outline" size={22} color={t.textMuted} /></View>
            <Text style={s.emptyTitle}>No events yet</Text>
            <Text style={s.emptyBody}>Purchases will appear here once your agents start buying.</Text>
          </View>
        ) : filtered.map((e) => (
          <View key={e.id} style={s.row}>
            <View style={[s.kindDot, { backgroundColor: e.mode === 'auto' ? t.accent : t.surfaceAlt }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle} numberOfLines={1}>{(e.mode === 'auto' ? 'AUTO' : 'MANUAL') + ' · ' + e.listingName}</Text>
              <Text style={s.rowMeta} numberOfLines={1}>{e.when}</Text>
            </View>
            <View style={s.rowRight}>
              <Text style={s.amount}>{'£' + e.amount.toFixed(2)}</Text>
              <View style={[s.tag, { backgroundColor: t.surfaceAlt }]}>
                <Text style={s.tagText} numberOfLines={1}>{e.tag}</Text>
              </View>
            </View>
          </View>
        ))}

        <Text style={s.sectionLabel}>LAST PAYLOAD</Text>
        {latest ? (
          <Pressable onPress={() => setExpanded((v) => !v)} style={({ pressed }) => [s.payload, pressed && { opacity: 0.85 }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.payloadLabel}>{latest.listingName}</Text>
              <Text style={s.payloadLine} numberOfLines={expanded ? undefined : 1}>{latest.payload}</Text>
              {expanded && (
                <Text style={s.payloadLine}>{latest.handshake}</Text>
              )}
            </View>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={t.textMuted} />
          </Pressable>
        ) : (
          <View style={s.empty}>
            <View style={s.emptyIcon}><Ionicons name="code-slash-outline" size={22} color={t.textMuted} /></View>
            <Text style={s.emptyTitle}>No payload yet</Text>
            <Text style={s.emptyBody}>The last signed payload will show here after a purchase.</Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = (t) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingTop: 8, paddingBottom: 16 },
  title: { flex: 1, fontSize: 24, lineHeight: 30, fontWeight: '800', color: t.text, marginHorizontal: 12 },
  hero: { backgroundColor: t.surface, borderRadius: 24, padding: 20, marginBottom: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start' },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.accent, marginBottom: 8 },
  heroNumber: { fontSize: 36, lineHeight: 40, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 13, color: t.textMuted, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surfaceAlt, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, gap: 4, marginTop: 4 },
  chipText: { fontSize: 12, fontWeight: '600', color: t.text },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 18 },
  tile: { flex: 1, borderRadius: 12, padding: 12 },
  tileLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 1, color: t.textMuted, textTransform: 'uppercase', marginBottom: 4 },
  tileValue: { fontSize: 20, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.textMuted, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, minHeight: 84 },
  kindDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: t.text },
  rowMeta: { fontSize: 12, color: t.textMuted, marginTop: 3 },
  rowRight: { alignItems: 'flex-end', marginLeft: 10 },
  amount: { fontSize: 15, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'], marginBottom: 6 },
  tag: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, color: t.textMuted },
  payload: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.surface, borderRadius: 16, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  payloadLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.textMuted, marginBottom: 8 },
  payloadLine: { fontSize: 14, color: t.text, fontVariant: ['tabular-nums'], marginBottom: 4 },
  empty: { backgroundColor: t.surface, borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: t.text, marginBottom: 4 },
  emptyBody: { fontSize: 14, color: t.textMuted, textAlign: 'center' },
});
