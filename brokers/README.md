# Broker Read-Only API Clients

Python clients for read-only programmatic access to IBKR and eToro accounts.

---

## Interactive Brokers (IBKR)

IBKR uses the **Client Portal Web API** — a local gateway process that handles
browser-based OAuth for you, then exposes a REST API at `localhost:5000`.

### Setup

1. **Start the CP Gateway** (Docker is the easiest way):
   ```bash
   docker run -p 5000:5000 \
     -e IBEAM_ACCOUNT=your_username \
     -e IBEAM_PASSWORD=your_password \
     ghcr.io/voyz/ibeam/ibeam:latest
   ```
   Or download the Java-based gateway from [IBKR's site](https://www.interactivebrokers.com/en/trading/ib-api.php).

2. **Wait for authentication** — the gateway opens a browser tab for 2FA the first time.

3. **Run:**
   ```python
   from brokers import IBKRClient

   client = IBKRClient()  # default: https://localhost:5000
   accounts = client.accounts()
   account_id = accounts[0]["id"]

   print(client.account_summary(account_id))
   print(client.all_positions(account_id))
   print(client.trades())
   ```

### Key methods

| Method | Description |
|---|---|
| `is_authenticated()` | Check if the gateway session is live |
| `accounts()` | List all sub-accounts |
| `account_summary(id)` | Net liq, cash, buying power |
| `account_ledger(id)` | Per-currency cash breakdown |
| `all_positions(id)` | All open positions (auto-pages) |
| `trades()` | Today's executed trades |
| `live_orders()` | Open / pending orders |
| `market_data_snapshot(conids)` | Bid/ask/last for contract IDs |
| `search_contract(symbol)` | Look up a symbol's contract ID |

> **Note:** IBKR Pro account required. Paper trading also works (use the paper account ID).

---

## eToro

eToro launched a public REST API in 2025. Get credentials at
[api-portal.etoro.com](https://api-portal.etoro.com/).

### Setup

1. Sign up at the [eToro Builders Portal](https://builders.etoro.com/) and request API access.
2. Generate an API key with **read** scope.
3. Export credentials:
   ```bash
   export ETORO_API_KEY=your_api_key
   export ETORO_USER_KEY=your_user_key
   ```

4. **Run:**
   ```python
   from brokers import EToroClient

   client = EToroClient()          # reads env vars automatically
   # client = EToroClient(demo=True)  # use virtual/paper portfolio

   print(client.balance())
   print(client.positions())
   ```

### Key methods

| Method | Description |
|---|---|
| `portfolio()` | Full snapshot: positions, orders, P&L, balances |
| `positions()` | Open positions (extracted from portfolio) |
| `balance()` | Cash, net equity, total value, P&L |
| `instruments(ids)` | Instrument metadata |
| `instrument_prices(ids)` | Current bid/ask prices |

---

## Combined example

```bash
pip install -r brokers/requirements.txt
python brokers/example.py
```
