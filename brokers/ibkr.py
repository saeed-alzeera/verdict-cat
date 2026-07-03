"""
Read-only IBKR Client Portal Web API client.

Requires the CP Gateway running locally (default: https://localhost:5000).
Start it with: docker run -p 5000:5000 ghcr.io/voyz/ibeam/ibeam:latest
Or download from: https://www.interactivebrokers.com/en/trading/ib-api.php

The gateway handles session auth. Once it is running and authenticated,
these read-only calls work without any additional credentials in code.
"""

from __future__ import annotations

import requests
import urllib3
from dataclasses import dataclass, field
from typing import Any

# The gateway uses a self-signed cert by default.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@dataclass
class IBKRClient:
    """Read-only wrapper around the IBKR Client Portal Web API."""

    gateway_url: str = "https://localhost:5000"
    # Set verify=True and supply the cert path if you configured a real cert.
    _verify: bool = field(default=False, repr=False)

    @property
    def _base(self) -> str:
        return f"{self.gateway_url}/v1/api"

    def _get(self, path: str, **params: Any) -> Any:
        url = f"{self._base}/{path.lstrip('/')}"
        resp = requests.get(url, params=params or None, verify=self._verify, timeout=15)
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Auth / session
    # ------------------------------------------------------------------

    def auth_status(self) -> dict:
        """Returns the current session authentication state."""
        return self._get("iserver/auth/status")

    def is_authenticated(self) -> bool:
        status = self.auth_status()
        return bool(status.get("authenticated"))

    def tickle(self) -> dict:
        """Keep the session alive (call at least every 5 minutes)."""
        resp = requests.post(
            f"{self._base}/tickle", verify=self._verify, timeout=15
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Accounts
    # ------------------------------------------------------------------

    def accounts(self) -> list[dict]:
        """List all accounts accessible under the logged-in username."""
        return self._get("portfolio/accounts")

    def account_summary(self, account_id: str) -> dict:
        """
        Full account summary: net liquidation value, cash, buying power, etc.
        account_id example: "U1234567"
        """
        return self._get(f"portfolio/{account_id}/summary")

    def account_ledger(self, account_id: str) -> dict:
        """Per-currency cash ledger for the account."""
        return self._get(f"portfolio/{account_id}/ledger")

    # ------------------------------------------------------------------
    # Positions
    # ------------------------------------------------------------------

    def positions(self, account_id: str, page: int = 0) -> list[dict]:
        """
        Current open positions. Pages of up to 30 positions each.
        Increment page until you get an empty list.
        """
        return self._get(f"portfolio/{account_id}/positions/{page}")

    def all_positions(self, account_id: str) -> list[dict]:
        """Fetch every page of positions and return them combined."""
        result: list[dict] = []
        page = 0
        while True:
            page_data = self.positions(account_id, page)
            if not page_data:
                break
            result.extend(page_data)
            page += 1
        return result

    # ------------------------------------------------------------------
    # Trades / orders (read-only)
    # ------------------------------------------------------------------

    def trades(self) -> list[dict]:
        """All trades for the current day across all accounts."""
        return self._get("iserver/account/trades")

    def live_orders(self) -> dict:
        """All open / live orders (read-only view)."""
        return self._get("iserver/account/orders")

    # ------------------------------------------------------------------
    # Market data (read-only)
    # ------------------------------------------------------------------

    def market_data_snapshot(self, conids: list[int], fields: list[int] | None = None) -> list[dict]:
        """
        Snapshot of market data for a list of contract IDs.
        Common field IDs: 31=last price, 84=bid, 86=ask, 7295=open, 7296=close.
        """
        default_fields = fields or [31, 84, 86, 7295, 7296]
        return self._get(
            "iserver/marketdata/snapshot",
            conids=",".join(str(c) for c in conids),
            fields=",".join(str(f) for f in default_fields),
        )

    def search_contract(self, symbol: str, sec_type: str = "STK") -> list[dict]:
        """Search for a contract by symbol (e.g. 'AAPL')."""
        return self._get(
            "iserver/secdef/search",
            symbol=symbol,
            secType=sec_type,
        )
