const User = require('../models/User');

class EconomyManager {
  static async regenerateEnergy(user) {
    const now = new Date();
    const diffMs = now.getTime() - user.lastEnergyUpdate.getTime();
    const unitsToRecover = Math.floor(diffMs / (5 * 60 * 1000)); // 1 energy every 5 mins

    if (unitsToRecover > 0) {
      user.energy = Math.min(user.maxEnergy, user.energy + unitsToRecover);
      user.lastEnergyUpdate = now;
      await user.save();
    }
    return user;
  }

  static async spendEnergy(userId, amount) {
    const user = await User.findById(userId);
    await this.regenerateEnergy(user);

    if (user.energy < amount) {
      throw new Error("Insufficient energy! Wait for recharge or buy more.");
    }

    user.energy -= amount;
    await user.save();
    return user;
  }

  static async addCoins(userId, amount) {
    const user = await User.findById(userId);
    user.balance += amount;
    await user.save();
    return user;
  }

  static async purchaseChip(userId, chipId, price) {
    const user = await User.findById(userId);
    if (user.balance < price) {
      throw new Error("Not enough coins to hire this skill!");
    }

    user.balance -= price;
    if (!user.inventory.includes(chipId)) {
      user.inventory.push(chipId);
    }
    await user.save();
    return user;
  }
}

module.exports = EconomyManager;
