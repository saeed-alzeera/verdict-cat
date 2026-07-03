"""
Quick example: print a combined portfolio snapshot from IBKR and eToro.

Usage:
    # Set env vars first:
    export ETORO_API_KEY=your_key
    export ETORO_USER_KEY=your_user_key

    # Make sure IBKR CP Gateway is running on localhost:5000, then:
    python brokers/example.py
"""

import json
from brokers import IBKRClient, EToroClient


def print_section(title: str, data: object) -> None:
    print(f"\n{'=' * 50}")
    print(f"  {title}")
    print("=" * 50)
    print(json.dumps(data, indent=2, default=str))


def ibkr_snapshot() -> None:
    client = IBKRClient()

    if not client.is_authenticated():
        print("[IBKR] Gateway session not authenticated. Start the CP Gateway and log in.")
        return

    accounts = client.accounts()
    account_id = accounts[0]["id"]
    print_section("IBKR Accounts", accounts)

    summary = client.account_summary(account_id)
    print_section(f"IBKR Account Summary ({account_id})", summary)

    positions = client.all_positions(account_id)
    print_section(f"IBKR Positions ({len(positions)} open)", positions)

    trades = client.trades()
    print_section(f"IBKR Today's Trades ({len(trades)})", trades)


def etoro_snapshot() -> None:
    try:
        client = EToroClient()  # reads ETORO_API_KEY / ETORO_USER_KEY from env
    except ValueError as exc:
        print(f"[eToro] {exc}")
        return

    balance = client.balance()
    print_section("eToro Balance", balance)

    positions = client.positions()
    print_section(f"eToro Positions ({len(positions)} open)", positions)


if __name__ == "__main__":
    print("\n>>> IBKR <<<")
    ibkr_snapshot()

    print("\n>>> eToro <<<")
    etoro_snapshot()
