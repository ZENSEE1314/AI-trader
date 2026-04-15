"""
Kronos prediction service for the crypto trading bot.
Called by Node.js via child_process — outputs JSON to stdout.

Usage: python kronos-predict.py BTCUSDT 15m 20
Output: {"direction":"DOWN","current":71200,"predicted":69500,"change_pct":-2.3,"confidence":"high","pred_high":71400,"pred_low":69300}
"""

import sys
import os
import json
import urllib.request
import ssl
import warnings

# Suppress HuggingFace symlink warnings on Windows
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
warnings.filterwarnings("ignore")

import pandas as pd
from datetime import datetime, timedelta

# Add Kronos to path — local vendor copy (Docker) or parent Kronos dir (dev)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VENDOR_DIR = os.path.join(SCRIPT_DIR, "kronos_vendor")
KRONOS_DIR = os.path.join(SCRIPT_DIR, "..", "Kronos")

if os.path.isdir(os.path.join(VENDOR_DIR, "model")):
    sys.path.insert(0, VENDOR_DIR)
else:
    sys.path.insert(0, KRONOS_DIR)

BINANCE_APIS = [
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
    "https://fapi.binance.com/fapi/v1/klines",
]

INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000,
    "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
}

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

# Lazy-load model (cached after first call)
_model = None
_tokenizer = None
_predictor = None


def get_predictor():
    global _model, _tokenizer, _predictor
    if _predictor is None:
        from model import Kronos, KronosTokenizer, KronosPredictor
        _tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
        _model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
        _predictor = KronosPredictor(_model, _tokenizer, max_context=512)
    return _predictor


def fetch_candles(symbol, interval, limit=450):
    for api_url in BINANCE_APIS:
        url = f"{api_url}?symbol={symbol}&interval={interval}&limit={limit}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as resp:
                raw = json.loads(resp.read())
            return raw
        except Exception:
            continue
    return None


def predict(symbol, interval="15m", pred_len=20):
    raw = fetch_candles(symbol, interval)
    if not raw:
        return {"error": "Failed to fetch candle data", "direction": "NEUTRAL"}

    rows = []
    for k in raw:
        rows.append({
            "timestamps": datetime.fromtimestamp(k[0] / 1000, tz=None),
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
            "amount": float(k[7]),
        })
    df = pd.DataFrame(rows)

    x_df = df[["open", "high", "low", "close", "volume", "amount"]]
    x_timestamp = df["timestamps"]

    ms = INTERVAL_MS.get(interval, 900_000)
    delta = timedelta(milliseconds=ms)
    last_ts = df["timestamps"].iloc[-1]
    y_timestamp = pd.Series([last_ts + delta * (i + 1) for i in range(pred_len)])

    predictor = get_predictor()
    pred_df = predictor.predict(
        df=x_df,
        x_timestamp=x_timestamp,
        y_timestamp=y_timestamp,
        pred_len=pred_len,
        T=1.0,
        top_p=0.9,
        sample_count=1,
        verbose=False,
    )

    current_price = df["close"].iloc[-1]
    pred_close = float(pred_df["close"].iloc[-1])
    pred_high = float(pred_df["high"].max())
    pred_low = float(pred_df["low"].min())
    change_pct = (pred_close - current_price) / current_price * 100

    # Direction based on predicted close vs current
    if abs(change_pct) < 0.3:
        direction = "NEUTRAL"
    elif pred_close > current_price:
        direction = "LONG"
    else:
        direction = "SHORT"

    # Confidence based on magnitude of predicted move
    abs_change = abs(change_pct)
    if abs_change >= 1.5:
        confidence = "high"
    elif abs_change >= 0.5:
        confidence = "medium"
    else:
        confidence = "low"

    # Trend strength: check if prediction consistently moves in one direction
    pred_closes = pred_df["close"].tolist()
    up_candles = sum(1 for i in range(1, len(pred_closes)) if pred_closes[i] > pred_closes[i - 1])
    trend_ratio = up_candles / max(len(pred_closes) - 1, 1)
    if trend_ratio > 0.65:
        trend = "bullish"
    elif trend_ratio < 0.35:
        trend = "bearish"
    else:
        trend = "mixed"

    return {
        "direction": direction,
        "current": round(current_price, 6),
        "predicted": round(pred_close, 6),
        "change_pct": round(change_pct, 2),
        "confidence": confidence,
        "pred_high": round(pred_high, 6),
        "pred_low": round(pred_low, 6),
        "trend": trend,
        "candles": pred_len,
        "interval": interval,
    }


if __name__ == "__main__":
    symbol = sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT"
    interval = sys.argv[2] if len(sys.argv) > 2 else "15m"
    pred_len = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    result = predict(symbol, interval, pred_len)
    # Output ONLY JSON to stdout — Node.js parses this
    print(json.dumps(result))
