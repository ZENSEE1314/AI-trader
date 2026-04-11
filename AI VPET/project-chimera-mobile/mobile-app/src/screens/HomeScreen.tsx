import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';

export const HomeScreen = ({ user, onChat }) => (
  <View style={styles.container}>
    <Text style={styles.title}>Chimera Home</Text>

    <View style={styles.petContainer}>
      <Text style={styles.sprite}>🤖</Text>
      <Text style={styles.status}>IDLE</Text>
    </View>

    <View style={styles.statsRow}>
      <Text>🪙 {user.balance}</Text>
      <Text>⚡ {user.energy}/{user.maxEnergy}</Text>
    </View>

    <TouchableOpacity style={styles.button} onPress={onChat}>
      <Text style={styles.buttonText}>Summon for Work</Text>
    </TouchableOpacity>

    <TouchableOpacity style={[styles.button, { backgroundColor: '#ef4444' }]}>
      <Text style={styles.buttonText}>Enter Arena</Text>
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#111', alignItems: 'center' },
  title: { fontSize: 24, color: 'white', fontWeight: 'bold', marginTop: 50 },
  petContainer: { marginVertical: 50, alignItems: 'center' },
  sprite: { fontSize: 80 },
  status: { color: '#818cf8', fontWeight: 'bold', marginTop: 10 },
  statsRow: { flexDirection: 'row', gap: 20, marginBottom: 30 },
  button: { backgroundColor: '#4f46e5', padding: 15, borderRadius: 10, width: '100%', alignItems: 'center', marginBottom: 10 },
  buttonText: { color: 'white', fontWeight: 'bold' }
});
