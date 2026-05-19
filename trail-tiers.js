// ── Trail Tier Tables — single source of truth ────────────────
// Shared between cycle.js and trail-watchdog.js.
//
// Dashboard settings (v4_config tsl_* keys) are loaded by cycle.js and
// pushed here via setDynamicTiers() so both processes use identical tables.
// trail-watchdog.js reads the same tables via calculateTrailingStep().
//
// Capital % = price move % × leverage.
// e.g. at 75x leverage: +0.4% price move = +30% capital.
//
// Tier tables (capital %):
//   100x — BTC / ETH / BNB : T1 46→45, T2 51→50, T3 61→60, then +10% steps
//    75x — SOL / ADA / AVAX : T1 31→30, T2 41→40, T3 51→50, then +10% steps
//    50x — Other tokens      : T1 21→20, T2 31→30, T3 38→35, then +11% steps

'use strict';

const TAKER_FEE_BOTH_LEGS    = 0.0008; // 0.04% entry + 0.04% exit taker
const NET_PROFIT_TARGET      = 0.10;   // +10% capital NET profit the user keeps after ALL fees
const FUNDING_RATE_EST       = 0.0001; // ~0.01% per 8h funding rate (conservative estimate)
const FUNDING_BUFFER_PERIODS = 1;      // buffer for 1 funding period (8 hours)
const SAFETY_TRAIL_LOCK      = 0.10;   // legacy floor — actual lock is computed dynamically below
const SAFETY_TRAIL_TRIGGER   = 0.20;   // legacy — actual trigger is lock + SAFETY_GAP below
const SAFETY_GAP             = 0.10;   // gap between safety trigger and safety lock (10% capital)
//
// WHY dynamic safety lock:
//   At 125x (BTC), taker fees = 0.0008 × 125 = 10% capital.
//   Old lock at +10% → net = 0% after fees (before funding).
//   Add 1 funding period (0.01% × 125 = 1.25% capital) → net = -1.25% LOSS.
//   New lock = NET_PROFIT_TARGET + takerFees + fundingBuffer — guarantees user
//   keeps +10% capital after all fees, regardless of leverage.

// ── Hardcoded defaults — match the dashboard screenshot exactly ──

// 100x — BTC / ETH / BNB
const TRAILING_TIERS_100X = [
  { trigger: 0.46, lock: 0.45 }, // +46% → lock +45%
  { trigger: 0.51, lock: 0.50 }, // +51% → lock +50%
  { trigger: 0.61, lock: 0.60 }, // +61% → lock +60%
  { trigger: 0.71, lock: 0.70 },
  { trigger: 0.81, lock: 0.80 },
  { trigger: 0.91, lock: 0.90 },
  { trigger: 1.01, lock: 1.00 },
  { trigger: 1.11, lock: 1.10 },
  { trigger: 1.21, lock: 1.20 },
  { trigger: 1.51, lock: 1.50 },
  { trigger: 2.01, lock: 2.00 },
  { trigger: 3.01, lock: 3.00 },
];

// 75x — BTC / ETH / SOL (all symbols at uniform 75x)
// Profit-lock: fires when price moves +0.21% from entry (~+16% capital at 75x),
// locks SL to entry +0.40% (+30% capital) — matches backtest-proven trigger 0.5×SL.
const TRAILING_TIERS_75X = [
  { trigger: 0.16, lock: 0.30 }, // +16% → lock +30% (profit-lock: ~+0.21% price → SL at entry+0.40%)
  { trigger: 0.41, lock: 0.40 }, // +41% → lock +40%
  { trigger: 0.51, lock: 0.50 }, // +51% → lock +50%
  { trigger: 0.61, lock: 0.60 },
  { trigger: 0.71, lock: 0.70 },
  { trigger: 0.81, lock: 0.80 },
  { trigger: 0.91, lock: 0.90 },
  { trigger: 1.01, lock: 1.00 },
  { trigger: 1.21, lock: 1.20 },
  { trigger: 1.51, lock: 1.50 },
  { trigger: 2.01, lock: 2.00 },
];

// 50x — Other tokens
const TRAILING_TIERS_50X = [
  { trigger: 0.21, lock: 0.20 }, // +21% → lock +20%
  { trigger: 0.31, lock: 0.30 }, // +31% → lock +30%
  { trigger: 0.38, lock: 0.35 }, // +38% → lock +35%
  { trigger: 0.49, lock: 0.45 },
  { trigger: 0.60, lock: 0.55 },
  { trigger: 0.71, lock: 0.65 },
  { trigger: 0.82, lock: 0.75 },
  { trigger: 0.93, lock: 0.85 },
  { trigger: 1.04, lock: 0.95 },
  { trigger: 1.15, lock: 1.05 },
  { trigger: 1.26, lock: 1.15 },
  { trigger: 1.50, lock: 1.40 },
  { trigger: 2.00, lock: 1.90 },
  { trigger: 3.00, lock: 2.90 },
];

// ── Dynamic tiers — set by loadV4Config() in cycle.js ───────────
// trail-watchdog.js also calls setDynamicTiers() after loading v4_config.
// Falls back to hardcoded defaults when null.
let _dynamicTslTiers = null;

function setDynamicTiers(tiers) {
  _dynamicTslTiers = tiers;
}

// ── buildTierTable ────────────────────────────────────────────────
// Builds a full tier table from 3 admin-configured base tiers + a step.
// Auto-extends beyond tier 3 up to 500% capital using the step size.
// All inputs are capital % as integers (e.g. 46 = 46%).
function buildTierTable(t1Trig, t1Lock, t2Trig, t2Lock, t3Trig, t3Lock, stepPct) {
  const step = stepPct / 100;
  const tiers = [
    { trigger: t1Trig / 100, lock: t1Lock / 100 },
    { trigger: t2Trig / 100, lock: t2Lock / 100 },
    { trigger: t3Trig / 100, lock: t3Lock / 100 },
  ];
  let trig = t3Trig / 100;
  let lock = t3Lock / 100;
  while (trig < 5.0) {
    trig = parseFloat((trig + step).toFixed(4));
    lock = parseFloat((lock + step).toFixed(4));
    tiers.push({ trigger: trig, lock });
  }
  return tiers;
}

// ── tierTableForLev ───────────────────────────────────────────────
// Returns the correct tier table for the given leverage.
// Uses dynamic DB-loaded tiers when available; falls back to hardcoded defaults.
function tierTableForLev(leverage) {
  if (_dynamicTslTiers) {
    if (leverage >= 100) return _dynamicTslTiers['100'];
    if (leverage >= 75)  return _dynamicTslTiers['75'];
    return _dynamicTslTiers['50'];
  }
  if (leverage >= 100) return TRAILING_TIERS_100X;
  if (leverage >= 75)  return TRAILING_TIERS_75X;
  return TRAILING_TIERS_50X;
}

// ── calculateTrailingStep ─────────────────────────────────────────
// Capital%-based trailing SL. Converts capital lock % back to price %
// when computing the new SL price.
//
// lastStep  : last capital % lock applied (stored in DB). Prevents SL moving back.
// leverage  : token leverage — determines which tier table to use.
// userTrailStepPct : custom step in capital % (0 = use tier table).
// smcMode   : skip tiers below +60% capital (session open — let trade run).
//
// Returns { stepped, newSlPrice, newLastStep } or null (not ready yet).
function calculateTrailingStep(
  entryPrice, currentPrice, isLong, lastStep,
  leverage = 20, userTrailStepPct = 0, smcMode = false
) {
  const pricePct   = isLong
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const capitalPct = pricePct * leverage;

  // ── Safety tier: fee-aware lock guarantees +10% net capital after all fees ──
  // safetyLock  = NET_PROFIT_TARGET + taker fees (both legs) + 1 funding period
  // safetyTrigger = safetyLock + SAFETY_GAP  (always 10% above lock)
  //
  // Example at 125x (BTC):
  //   takerFeesCap = 0.0008 × 125 = 10%   fundingCap = 0.0001 × 125 = 1.25%
  //   safetyLock   = 10% + 10% + 1.25%   = 21.25%   (user nets ≈ +10% after fees)
  //   safetyTrigger = 21.25% + 10%        = 31.25%   (fires well before T1 at 46%)
  //
  // Example at 75x (ETH):
  //   safetyLock = 10% + 6% + 0.75% = 16.75%   trigger = 26.75%  (T1 at 31% ✓)
  if (userTrailStepPct === 0) {
    const takerFeesCap  = TAKER_FEE_BOTH_LEGS * leverage;
    const fundingCap    = FUNDING_RATE_EST * FUNDING_BUFFER_PERIODS * leverage;
    const safetyLock    = Math.max(SAFETY_TRAIL_LOCK, NET_PROFIT_TARGET + takerFeesCap + fundingCap);
    const safetyTrigger = safetyLock + SAFETY_GAP;

    if (capitalPct >= safetyTrigger && lastStep < safetyLock) {
      const tiers = tierTableForLev(leverage);
      const firstMainTrigger = smcMode
        ? (tiers.find(t => t.lock >= 0.60)?.trigger ?? 0.61)
        : tiers[0].trigger;
      if (capitalPct < firstMainTrigger) {
        const lockPricePct = safetyLock / leverage;
        const newSlPrice   = isLong
          ? entryPrice * (1 + lockPricePct)
          : entryPrice * (1 - lockPricePct);
        return { stepped: true, newSlPrice, newLastStep: safetyLock };
      }
    }
  }

  let bestLockCapitalPct = null;

  if (userTrailStepPct > 0) {
    // Custom step trailing
    const stepPct = userTrailStepPct / 100;
    if (capitalPct >= stepPct) {
      const stepsAbove   = Math.floor((capitalPct + 1e-10) / stepPct);
      bestLockCapitalPct = (stepsAbove - 1) * stepPct;
    }
  } else {
    // Fixed tier table
    const tiers = tierTableForLev(leverage);
    for (const tier of tiers) {
      if (smcMode && tier.lock < 0.60) continue; // session mode: skip early locks
      if (capitalPct >= tier.trigger) bestLockCapitalPct = tier.lock;
    }
    // Extend beyond last tier using the step pattern
    const lastTier     = tiers[tiers.length - 1];
    const triggerStep  = leverage <= 50 ? 0.11 : 0.10;
    const lockStep     = 0.10;
    if (capitalPct > lastTier.trigger) {
      const stepsAbove = Math.floor((capitalPct - lastTier.trigger) / triggerStep);
      const extraLock  = lastTier.lock + stepsAbove * lockStep;
      if (extraLock > (bestLockCapitalPct || 0)) bestLockCapitalPct = extraLock;
    }
  }

  if (bestLockCapitalPct === null) return null;
  // Ratchet: SL only moves in the profitable direction
  if (bestLockCapitalPct <= lastStep) return null;

  // Minimum first-lock: must cover fees + small profit buffer
  if (lastStep === 0) {
    const feeCapitalPct   = (TAKER_FEE_BOTH_LEGS + 0.0003) * leverage;
    const MIN_PROFIT_BUFFER = 0.05; // 5% capital
    const minFirstLock    = feeCapitalPct + MIN_PROFIT_BUFFER;
    if (bestLockCapitalPct < minFirstLock) bestLockCapitalPct = minFirstLock;
  }

  const lockPricePct = bestLockCapitalPct / leverage;
  const newSlPrice   = isLong
    ? entryPrice * (1 + lockPricePct)
    : entryPrice * (1 - lockPricePct);

  return { stepped: true, newSlPrice, newLastStep: bestLockCapitalPct };
}

module.exports = {
  TRAILING_TIERS_100X,
  TRAILING_TIERS_75X,
  TRAILING_TIERS_50X,
  SAFETY_TRAIL_TRIGGER,
  SAFETY_TRAIL_LOCK,
  setDynamicTiers,
  buildTierTable,
  tierTableForLev,
  calculateTrailingStep,
};
