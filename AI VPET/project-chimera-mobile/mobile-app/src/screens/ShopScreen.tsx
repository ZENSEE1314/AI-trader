import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';

export const ShopScreen = ({ user, onBuy }) => {
  const chips = [
    { id: 'python_expert_01', name: 'Python Expert', price: 500 },
    { id: 'smc_trading_01', name: 'SMC Trading', price: 1200 },
    { id: 'miro_fish_module', name: 'Miro Fish', price: 5000 },
    { id: 'kornos_core', name: 'Kornos Core', price: 5000 },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Skill Shop</Text>
      <Text style={styles.balance}>Balance: 🪙 {user.balance}</Text>

      <FlatList
        data={chips}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.chipItem}>
            <Text style={styles.chipName}>{item.name}</Text>
            <TouchableOpacity
              style={styles.buyButton}
              onPress={() => onBuy(item.id, item.price)}
            >
              <Text style={styles.buyText}>🪙 {item.price}</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#111' },
  title: { fontSize: 24, color: 'white', fontWeight: 'bold', marginTop: 50 },
  balance: { color: '#fbbf24', marginBottom: 20 },
  chipItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 15, backgroundColor: '#222', borderRadius: 10, marginBottom: 10 },
  chipName: { color: 'white', fontSize: 16 },
  buyButton: { backgroundColor: '#fbbf24', padding: 8, borderRadius: 5 },
  buyText: { color: 'black', fontWeight: 'bold' }
});
