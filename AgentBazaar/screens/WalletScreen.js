import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, RingProgress, EmptyState } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { useStore } from '../store/Store';

const TX = [
  { id: 't1', title: 'GPT-4o Inference', amount: -12.4, at: new Date().toISOString(), status: 'settled', color: '#9AA0B0' },
  { id: 't2', title: 'Vision Skill v2', amount: -0.12, at: new Date().toISOString(), status: 'settled', color: '#9AA0B0' },
  { id: 't3', title: 'A2A settlement', amount: 260, at: new Date(Date.now() - 86400000).toISOString(), status: 'a2a', color: '#4ADE97' },
];

const money = (n) => (n < 0 ? '−£' : '£') + Math.abs(n).toFixed(2);

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'today ' + time;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'yesterday ' + time;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time;
};

export default function WalletScreen({ navigation }) {
  const t = useTheme();
  const { ready, wallet, topUp, transactions } = useStore();
  const [busy, setBusy] = useState(false);

  const balance = ready ? (wallet?.balance ?? 2480) : 2480;
  const cap = ready ? (wallet?.cap ?? 4000) : 4000;
  const spent24 = ready ? (wallet?.spent24h ?? 312) : 312;
  const settled = ready ? (wallet?.a2aSettlements ?? 47) : 47;
  const rows = ready && transactions && transactions.length ? transactions : TX;

  const used = cap > 0 ? Math.min(1, Math.max(0, (cap - balance) / cap)) : 0;
  const pctLabel = Math.round(used * 100);

  const doTopUp = () => {
    setBusy(true);
    setTimeout(() => {
      if (topUp) topUp(500);
      setBusy(false);
      Alert.alert('Top up complete', '£500.00 added to your agent wallet.');
    }, 500);
  };

  const s = styles(t);

  return (
    <Screen>
      <View style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>Agent Wallet</Text>
          <Text style={s.caption} numberOfLines={1}>Credits and settlements</Text>
        </View>
        <Pressable
          onPress={doTopUp}
          disabled={busy}
          style={({ pressed }) => [s.add, pressed && { opacity: 0.7 }, busy && { opacity: 0.5 }]}
          accessibilityLabel="Top up"
        >
          <Ionicons name="add" size={22} color={t.onAccent || '#FFFFFF'} />
        </Pressable>
      </View>

      <View style={s.hero}>
        <View style={s.heroRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.heroEyebrow}>WALLET</Text>
            <Text style={s.heroNumber} numberOfLines={1}>{'£' + balance.toLocaleString()}</Text>
            <Text style={s.heroCaption} numberOfLines={1}>available credit</Text>
          </View>
          <View style={s.ringWrap}>
            <RingProgress value={used} size={108} stroke={9} color="#FFFFFF" track="rgba(255,255,255,0.28)" />
            <View style={s.ringText}>
              <Text style={s.ringNumber}>{pctLabel + '%'}</Text>
              <Text style={s.ringLabel}>used</Text>
            </View>
          </View>
        </View>
        <View style={s.tiles}>
          <View style={[s.tile, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
            <Text style={s.tileLabel} numberOfLines={1}>spent 24h</Text>
            <Text style={s.tileValue} numberOfLines={1}>{'£' + spent24.toLocaleString()}</Text>
          </View>
          <View style={[s.tile, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
            <Text style={s.tileLabel} numberOfLines={1}>A2A settled</Text>
            <Text style={s.tileValue} numberOfLines={1}>{settled.toLocaleString()}</Text>
          </View>
        </View>
      </View>

      <View style={s.actions}>
        <Pressable
          onPress={doTopUp}
          disabled={busy}
          style={({ pressed }) => [s.btn, s.btnPrimary, pressed && { opacity: 0.7 }, busy && { opacity: 0.5 }]}
        >
          <Ionicons name="wallet" size={16} color={t.onAccent || '#FFFFFF'} />
          <Text style={s.btnPrimaryText} numberOfLines={1}>Top up</Text>
        </Pressable>
        <Pressable
          onPress={() => Alert.alert('Export CSV', 'A settlement report will be sent to your agent inbox.')}
          style={({ pressed }) => [s.btn, s.btnGhost, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="download-outline" size={16} color={t.text} />
          <Text style={s.btnGhostText} numberOfLines={1}>Export CSV</Text>
        </Pressable>
      </View>

      <View style={s.sectionHead}>
        <Text style={s.sectionTitle} numberOfLines={1}>Recent transactions</Text>
        <Pressable onPress={() => navigation.navigate('Purchase Log')} hitSlop={8}>
          <Text style={s.sectionLink}>View all</Text>
        </Pressable>
      </View>

      {rows.length === 0 ? (
        <EmptyState
          icon="receipt-outline"
          title="No transactions yet"
          message="Settlements and purchases will appear here."
          actionTitle="Top up"
          onAction={doTopUp}
        />
      ) : (
        <View style={s.card}>
          {rows.map((r, i) => {
            const amt = typeof r.amount === 'number' ? r.amount : 0;
            const positive = amt > 0;
            return (
              <Pressable
                key={r.id || i}
                onPress={() => navigation.navigate('Purchase Log')}
                style={({ pressed }) => [s.row, i > 0 && s.rowLine, pressed && { opacity: 0.7 }]}
              >
                <View style={[s.dot, { backgroundColor: positive ? '#4ADE97' : (r.color || '#9AA0B0') }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName} numberOfLines={1}>{String(r.title || '')}</Text>
                  <Text style={s.rowMeta} numberOfLines={1}>{fmtWhen(r.at)}</Text>
                </View>
                <Text style={[s.rowAmount, { color: positive ? '#4ADE97' : t.text }]} numberOfLines={1}>
                  {money(amt)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = (t) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', paddingTop: 8, paddingBottom: 16 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '800', color: t.text },
  caption: { fontSize: 13, lineHeight: 18, color: t.textMuted, marginTop: 4 },
  add: { width: 36, height: 36, borderRadius: 18, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', marginTop: 6, marginLeft: 10 },
  hero: { backgroundColor: t.accent, borderRadius: 24, padding: 20, marginBottom: 24 },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  heroEyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.6, color: 'rgba(255,255,255,0.85)', marginBottom: 8 },
  heroNumber: { fontSize: 36, lineHeight: 42, fontWeight: '800', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.9)', marginTop: 4 },
  ringWrap: { width: 108, height: 108, alignItems: 'center', justifyContent: 'center', marginLeft: 12 },
  ringText: { position: 'absolute', alignItems: 'center' },
  ringNumber: { fontSize: 20, fontWeight: '800', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  ringLabel: { fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  tiles: { flexDirection: 'row', marginTop: 20 },
  tile: { flex: 1, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, marginRight: 10 },
  tileLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: 'rgba(255,255,255,0.85)', marginBottom: 4 },
  tileValue: { fontSize: 20, lineHeight: 26, fontWeight: '800', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', marginBottom: 24 },
  btn: { flex: 1, height: 48, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  btnPrimary: { backgroundColor: t.accent },
  btnPrimaryText: { fontSize: 15, fontWeight: '700', color: t.onAccent || '#FFFFFF', marginLeft: 8 },
  btnGhost: { backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, marginRight: 0 },
  btnGhostText: { fontSize: 15, fontWeight: '700', color: t.text, marginLeft: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { flex: 1, fontSize: 22, lineHeight: 28, fontWeight: '800', color: t.text },
  sectionLink: { fontSize: 14, fontWeight: '600', color: t.accent },
  card: { backgroundColor: t.surface, borderRadius: 16, paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  rowName: { fontSize: 15, fontWeight: '700', color: t.text },
  rowMeta: { fontSize: 12, color: t.textMuted, marginTop: 2 },
  rowAmount: { fontSize: 14, fontWeight: '700', marginLeft: 10, fontVariant: ['tabular-nums'] },
});
