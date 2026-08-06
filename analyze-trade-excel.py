#!/usr/bin/env python3
"""
analyze-trade-excel.py — real stats from a trade_history.xlsx export.

Reads the sheet in this exact format (columns; repeated header blocks are fine):
  date | Long/Short | time of entry | entry | stop loss | exit |
  Date of exit | time of exit | position size | leverage | Qty | P&L | percentage

Computes what actually decides whether a book makes money — win rate AND, more
importantly, reward:risk and expectancy, with winners and LOSERS both counted.
Flags the one thing that matters most: do losers stop out near ~1R, or blow past
the stop (which quietly eats the winners)?

  pip install openpyxl
  python3 analyze-trade-excel.py <path-to.xlsx>
"""
import sys, statistics as st

def f(x):
    try: return float(x)
    except (TypeError, ValueError): return None

def load(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    rows = []
    for r in ws.iter_rows(values_only=True):
        if r and isinstance(r[1], str) and r[1].strip() in ('Long', 'Short'):
            e, sl, ex = f(r[3]), f(r[4]), f(r[5])
            pnl, pct = f(r[11]), f(r[12])
            if None in (e, sl, ex): continue
            side = r[1].strip()
            risk = abs(e - sl) / e
            reward = ((ex - e) if side == 'Long' else (e - ex)) / e   # signed: <0 = loser
            # stop breach: for a Long, did exit go below SL (past the stop)? (approx from exit)
            past_stop = (ex < sl) if side == 'Long' else (ex > sl)
            rows.append(dict(date=str(r[0])[:10], side=side, entry=e, sl=sl, exit=ex,
                             risk=risk, reward=reward, pnl=pnl, pct=pct, past_stop=past_stop,
                             R=(reward / risk if risk else 0.0)))
    return rows

def pctl(a, p):
    if not a: return 0.0
    a = sorted(a); k = (len(a) - 1) * p / 100
    lo = int(k); hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (k - lo)

def main():
    if len(sys.argv) < 2:
        print("usage: python3 analyze-trade-excel.py <trade_history.xlsx>"); sys.exit(1)
    t = load(sys.argv[1])
    if not t:
        print("No Long/Short trades found."); sys.exit(1)
    n = len(t)
    wins = [x for x in t if x['reward'] > 0]
    loss = [x for x in t if x['reward'] <= 0]
    wr = len(wins) / n
    Rs = [x['R'] for x in t]
    avg_win_R = st.mean([x['R'] for x in wins]) if wins else 0
    avg_los_R = st.mean([x['R'] for x in loss]) if loss else 0
    exp = st.mean(Rs)                                   # expectancy per trade, in R
    pnl_known = [x['pnl'] for x in t if x['pnl'] is not None]

    print(f"══════════ Trade history — {n} trades ══════════")
    print(f"Dates: {min(x['date'] for x in t)} → {max(x['date'] for x in t)}")
    print(f"Long {sum(1 for x in t if x['side']=='Long')} / Short {sum(1 for x in t if x['side']=='Short')}")
    print()
    print(f"Win rate:            {wr*100:.1f}%   ({len(wins)}W / {len(loss)}L)")
    print(f"Avg reward:risk:     {st.mean([x['risk'] for x in t])*100:.3f}% risk → expectancy below")
    print(f"Avg WIN:             {avg_win_R:+.2f}R")
    print(f"Avg LOSS:            {avg_los_R:+.2f}R")
    print(f"Expectancy/trade:    {exp:+.2f}R   (this × trades = your edge)")
    if pnl_known:
        print(f"Net P&L (as logged): {sum(pnl_known):+.2f}   avg {st.mean(pnl_known):+.2f}")
    print()
    # The number that matters most: do losers respect the stop?
    breaches = [x for x in loss if x['past_stop']]
    worst_los = min((x['R'] for x in loss), default=0.0)
    print("── Risk discipline (the make-or-break) ──")
    if not loss:
        print("  No losing trades in this file — can't assess. EXPORT THE LOSERS: a book with")
        print("  only winners hides the one stat that decides profitability.")
    else:
        print(f"  Worst loss: {worst_los:.2f}R   |   losers beyond the stop: {len(breaches)}/{len(loss)}")
        if breaches:
            print(f"  ⚠ {len(breaches)} loss(es) ran PAST the stop — that's how one trade eats many winners.")
        else:
            print("  ✓ Losers stopped at/above -1R — tight risk control. This is what keeps R:R real.")
    print()
    # Break-even win rate given the average R:R.
    if avg_win_R > 0:
        be = 1 / (1 + avg_win_R)          # WR needed if losers = -1R and wins = avg_win_R
        print(f"── Reality check ──")
        print(f"  At your avg win of {avg_win_R:.1f}R (losers = -1R), break-even win rate = {be*100:.0f}%.")
        print(f"  You do NOT need to win them all — protect the R:R, not the win streak.")
    # Per-trade table
    print("\n#   date        dir     R      reward%   note")
    for i, x in enumerate(t, 1):
        note = 'WIN' if x['reward'] > 0 else ('LOSS-past-stop' if x['past_stop'] else 'LOSS')
        print(f"{i:>2}  {x['date']:<10} {x['side']:>5}  {x['R']:>5.1f}  {x['reward']*100:>7.2f}%   {note}")

if __name__ == '__main__':
    main()
