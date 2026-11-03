import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen, Card, StatTile, Badge, Button } from '../ui/kit';
import { useTheme } from '../ui/theme';
import { useStore } from '../store/Store';
import { viewListing, categoriesOf } from '../ui/listing';

export default function ListingDetailScreen({ navigation, route }) {
  const t = useTheme();
  const { listings, wallet, purchase } = useStore();
  const [copied, setCopied] = useState(false);
  const [bought, setBought] = useState(false);
  const p = route?.params || {};
  const raw = listings.find((l) => l.id === p.id) || {
    id: p.id, name: p.name || '', unit: p.unit || '', price: Number(p.price) || 0,
    cat: p.cat || '', icon: p.icon, color: p.color,
  };
  const listing = viewListing(raw, t, categoriesOf(listings));
  const title = listing.name || '';
  const priceNum = Number(listing.price) || 0;
  const price = listing.priceText;
  const unit = listing.unit || 'per call';
  const cat = listing.catLabel.toUpperCase();
  const endpoint = listing.endpoint || 'mcp://agentbazaar.io/' + (listing.id || 'svc');
  const balance = Number(wallet?.balance) || 0;
  const canAfford = balance >= priceNum;

  const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
  const buy = () => {
    if (bought || !canAfford) return;
    purchase(raw);
    setBought(true);
  };

  const s = styles(t);
  return (
    <Screen>
      <View style={s.head}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8} style={s.iconBtn} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={22} color={t.text} />
        </Pressable>
        <Text style={s.headTitle} numberOfLines={1}>Listing Detail</Text>
        <Pressable hitSlop={8} style={s.iconBtn} accessibilityLabel="Share">
          <Ionicons name="share-outline" size={20} color={t.text} />
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={s.hero}>
          <View style={s.heroTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.eyebrow}>{cat || 'LISTING'}</Text>
              <Text style={s.heroTitle} numberOfLines={1}>{title}</Text>
              <Text style={s.heroPrice}>{price}</Text>
              <Text style={s.heroCaption} numberOfLines={1}>{unit}</Text>
            </View>
            <Badge label={bought ? 'owned' : 'available'} color={bought ? t.success : t.accent} />
          </View>
          <View style={s.tiles}>
            <StatTile label="your balance" value={'£' + balance.toFixed(2)} color={t.accents[1]} style={{ flex: 1 }} />
            <StatTile label="unit price" value={price} color={t.accents[2]} style={{ flex: 1 }} />
          </View>
        </View>

        <Text style={s.sectionLabel}>AGENT NOTES</Text>
        <Card style={{ paddingVertical: 12 }}>
          <Text style={s.note} numberOfLines={3}>
            {'Bought by your agents to extend their own capabilities. Charged from the shared wallet on every call routed through the bazaar.'}
          </Text>
        </Card>

        <Text style={s.sectionLabel}>ENDPOINT</Text>
        <View style={s.endpoint}>
          <Text style={s.endpointLabel}>MCP ENDPOINT</Text>
          <View style={s.endpointRow}>
            <Text style={s.endpointCode} numberOfLines={1}>{endpoint}</Text>
            <Pressable onPress={copy} hitSlop={8} accessibilityLabel="Copy endpoint">
              <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={copied ? t.success : t.accent} />
            </Pressable>
          </View>
          {copied ? <Text style={s.copied}>Copied to clipboard</Text> : null}
        </View>

        <View style={s.buyBand}>
          <Button
            label={bought ? 'Purchased via API' : canAfford ? 'Buy via API' : 'Not enough balance'}
            onPress={buy}
            disabled={bought || !canAfford}
            style={{ height: 52, borderRadius: 16 }}
          />
          {!canAfford && !bought ? (
            <Text style={s.warn} numberOfLines={1}>Top up the Agent Wallet to buy this listing.</Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = (t) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', paddingTop: 4, paddingBottom: 14 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 24, lineHeight: 30, fontWeight: '800', color: t.text },
  hero: { backgroundColor: t.surface, borderRadius: 24, padding: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start' },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.accent, marginBottom: 6 },
  heroTitle: { fontSize: 22, lineHeight: 28, fontWeight: '800', color: t.text },
  heroPrice: { fontSize: 36, lineHeight: 44, fontWeight: '800', color: t.text, marginTop: 8, fontVariant: ['tabular-nums'] },
  heroCaption: { fontSize: 13, color: t.textMuted, marginTop: 2 },
  tiles: { flexDirection: 'row', marginTop: 18, gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.textMuted, marginTop: 24, marginBottom: 10 },
  note: { fontSize: 14, lineHeight: 20, color: t.textMuted },
  warn: { fontSize: 13, color: t.warning, marginTop: 10, textAlign: 'center' },
  endpoint: { backgroundColor: t.surface, borderRadius: 16, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  endpointLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: t.textMuted, marginBottom: 8 },
  endpointRow: { flexDirection: 'row', alignItems: 'center' },
  endpointCode: { flex: 1, fontSize: 14, color: t.text, fontVariant: ['tabular-nums'] },
  copied: { fontSize: 12, color: t.success, marginTop: 8 },
  buyBand: { marginTop: 24 },
});
