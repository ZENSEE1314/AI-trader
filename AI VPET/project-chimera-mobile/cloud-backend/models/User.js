const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  balance: { type: Number, default: 100 },
  energy: { type: Number, default: 100 },
  maxEnergy: { type: Number, default: 100 },
  lastEnergyUpdate: { type: Date, default: Date.now },
  pet: {
    name: { type: String, default: 'Chimera' },
    stats: {
      INT: { type: Number, default: 10 },
      ATK: { type: Number, default: 10 },
      PRC: { type: Number, default: 10 },
      LUK: { type: Number, default: 10 }
    },
    equippedChips: [{ type: String }]
  },
  inventory: [{ type: String }] // IDs of owned skill chips
});

module.exports = mongoose.model('User', UserSchema);
