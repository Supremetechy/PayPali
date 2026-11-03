import './ui/native-shim';
import 'react-native-gesture-handler';
import React from 'react';
import { StyleSheet, Platform, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';

import { ThemeProvider, useTheme, guardScreen } from './ui/theme';
import { StoreProvider } from './store/Store';

import MarketplaceScreen from './screens/MarketplaceScreen';
import WalletScreen from './screens/WalletScreen';
import AutomationScreen from './screens/AutomationScreen';
import ListingDetailScreen from './screens/ListingDetailScreen';
import PurchaseLogScreen from './screens/PurchaseLogScreen';

const Tab = createBottomTabNavigator();
const RootStack = createStackNavigator();


const ICONS = {
  "Marketplace": ['ellipse-outline', 'ellipse'],
  "Agent Wallet": ['ellipse-outline', 'ellipse'],
  "Automation Rules": ['ellipse-outline', 'ellipse'],
};

function Tabs() {
  const t = useTheme();
  const labelStyle = StyleSheet.flatten(t.font.caption);
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        tabBarLabelStyle: labelStyle,
        // The web player has no safe area at the bottom, so the tab bar sat on the phone's edge; it gets
        // an iPhone's home-indicator room there (the preview draws the indicator over it).
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, ...(Platform.OS === 'web' ? { height: 78, paddingBottom: 22 } : {}) },
        tabBarIcon: ({ focused, color, size }) => {
          const pair = ICONS[route.name] || ['ellipse-outline', 'ellipse'];
          return <Ionicons name={focused ? pair[1] : pair[0]} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Marketplace" component={guardScreen(MarketplaceScreen, "Marketplace")} />
      <Tab.Screen name="Agent Wallet" component={guardScreen(WalletScreen, "Agent Wallet")} />
      <Tab.Screen name="Automation Rules" component={guardScreen(AutomationScreen, "Automation Rules")} />
    </Tab.Navigator>
  );
}

function Root() {
  const t = useTheme();
  return (
    <NavigationContainer
      theme={{
        ...DefaultTheme,
        dark: !!t.dark,
        colors: { ...DefaultTheme.colors, primary: t.accent, background: t.bg, card: t.surface, text: t.text, border: t.border, notification: t.accent },
      }}
    >
      <RootStack.Navigator initialRouteName="Main" screenOptions={{ cardStyle: { flex: 1 }, headerShown: false }}>
      <RootStack.Screen name="Main" component={guardScreen(Tabs, "Main")} options={{ headerShown: false }} />
      <RootStack.Screen name="Listing Detail" component={guardScreen(ListingDetailScreen, "Listing Detail")} />
      <RootStack.Screen name="Purchase Log" component={guardScreen(PurchaseLogScreen, "Purchase Log")} />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

/* The web preview's player is 285 points wide; this app is laid out for an iPhone's 390 and shrunk
   to fit it, so it looks like a phone's screen scaled down rather than a phone's screen squeezed. */
const PHONE_W = 390;
function WebPhone({ children }) {
  const { width, height } = useWindowDimensions();
  if (Platform.OS !== 'web' || width >= PHONE_W) return children;
  const k = width / PHONE_W;
  return (
    <View style={{ width: PHONE_W, height: height / k, transform: [{ scale: k }], transformOrigin: 'top left' }}>
      {children}
    </View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider dark={true} bg="#0F1117" surface="#181B23" text="#F2F3F7" textMuted="#9AA0B0" accent="#6C5CE7" border="rgba(255,255,255,0.09)">
          <WebPhone>
            <StoreProvider>
              <Root />
            </StoreProvider>
          </WebPhone>
          <StatusBar style="light" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
