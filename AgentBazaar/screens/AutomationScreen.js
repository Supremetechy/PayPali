import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { useStore } from '../store/Store';

export default function AutomationScreen({ navigation }) {
  const t = useTheme();
  const { ready, rules, toggle, add, remove } = useStore();
  const list = ready && rules && rules.length ? rules : [];
  const active = list.filter((r) => r.enabled).length;
  const runs = list.reduce((n, r) => n + (r.runs24h || 0), 0);
  const saved = list.reduce((n, r) => n + (typeof r.saved === 'number' ? r.saved : 0), 0);
  const [master, setMaster] = useState(true);
  const s = styles(t);

  const toggleRule = (id) => {
    if (toggle) toggle('rules', id);
  };

  const addRule = () => {
    if (add) add('rules', { name: 'New rule → review listing', trigger: 'Manual', action: 'Notify', enabled: false, runs24h: 0, saved: 0 });
  };

  return (
    <Screen>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>Automation Rules</Text>
          <Text style={s.caption} numberOfLines={1}>Triggers that buy on your behalf</Text>
        </View>
        <Pressable
          onPress={addRule}
          style={({ pressed }) => [s.add, pressed && { opacity: 0.7 }]}
          accessibilityLabel="Add rule"
        >
          <Ionicons name="add" size={22} color={t.onAccent} />
        </Pressable>
      </View>

      <View style={s.hero}>
        <View style={s.heroRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>AUTOMATION</Text>
            <Text style={s.heroNumber}>{active}</Text>
            <Text style={s.heroCaption} numberOfLines={1}>active rules</Text>
          </View>
          <Switch
            value={master}
            onValueChange={setMaster}
            trackColor={{ false: t.border, true: t.accent }}
            thumbColor={t.onAccent}
            ios_backgroundColor={t.border}
          />
        </View>
        <View style={s.tiles}>
          <View style={s.tile}>
            <Text style={s.tileLabel} numberOfLines={1}>runs 24h</Text>
            <Text style={s.tileValue} numberOfLines={1}>{runs}</Text>
          </View>
          <View style={s.tile}>
            <Text style={s.tileLabel} numberOfLines={1}>saved</Text>
            <Text style={s.tileValue} numberOfLines={1}>{'£' + saved}</Text>
          </View>
        </View>
      </View>

      <Text style={s.sectionLabel}>ACTIVE TRIGGERS</Text>

      {list.length === 0 ? (
        <View style={s.emptyWrap}>
          <View style={s.emptyIcon}><Ionicons name="flash-outline" size={26} color={t.accent} /></View>
          <Text style={s.emptyTitle}>No rules yet</Text>
          <Text style={s.emptyBody}>Add a rule so your agent can buy upgrades on its own.</Text>
          <Pressable onPress={addRule} style={({ pressed }) => [s.emptyBtn, pressed && { opacity: 0.7 }]}>
            <Text style={s.emptyBtnText}>Add a rule</Text>
          </Pressable>
        </View>
      ) : list.map((r) => (
        <View key={r.id} style={s.row}>
          <View style={s.rowMain}>
            <Text style={s.rowTitle} numberOfLines={1}>{r.name}</Text>
            <View style={s.tag}>
              <Text style={s.tagText}>{r.trigger}</Text>
            </View>
          </View>
          <Switch
            value={!!r.enabled}
            onValueChange={() => toggleRule(r.id)}
            trackColor={{ false: t.border, true: t.accent }}
            thumbColor={t.onAccent}
            ios_backgroundColor={t.border}
          />
        </View>
      ))}

      <Text style={s.footer}>Rules run via MCP and A2A protocols.</Text>
    </Screen>
  );
}

const styles = (t) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 8, paddingBottom: 16 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '800', color: t.text },
  caption: { fontSize: 13, lineHeight: 18, color: t.textMuted, marginTop: 4 },
  add: { width: 36, height: 36, borderRadius: 18, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginTop: 6, marginLeft: 10 },
  hero: { backgroundColor: t.surface, borderRadius: 24, padding: 20, marginBottom: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.accent, marginBottom: 6 },
  heroNumber: { fontSize: 36, lineHeight: 42, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 13, color: t.textMuted, marginTop: 4 },
  tiles: { flexDirection: 'row', marginTop: 18 },
  tile: { flex: 1, backgroundColor: t.surfaceAlt, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginRight: 10 },
  tileLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 1, color: t.textMuted, textTransform: 'uppercase', marginBottom: 4 },
  tileValue: { fontSize: 20, lineHeight: 26, fontWeight: '800', color: t.text, fontVariant: ['tabular-nums'] },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.textMuted, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', height: 76, backgroundColor: t.surface, borderRadius: 16, paddingHorizontal: 16, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  rowMain: { flex: 1, marginRight: 12 },
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: t.text },
  tag: { alignSelf: 'flex-start', backgroundColor: t.surfaceAlt, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, marginTop: 8 },
  tagText: { fontSize: 10, fontWeight: '700', letterSpacing: 1, color: t.accent },
  footer: { fontSize: 13, lineHeight: 18, color: t.textMuted, marginTop: 6, marginBottom: 8 },
  emptyWrap: { alignItems: 'center', paddingVertical: 28, backgroundColor: t.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginBottom: 12 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: t.text, marginBottom: 4 },
  emptyBody: { fontSize: 14, color: t.textMuted, textAlign: 'center', paddingHorizontal: 24, marginBottom: 16 },
  emptyBtn: { backgroundColor: t.accent, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12 },
  emptyBtnText: { fontSize: 15, fontWeight: '700', color: t.onAccent },
});
