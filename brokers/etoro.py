"""
Read-only eToro Public API client.

Get your API keys at: https://api-portal.etoro.com/
Set the following env vars (or pass them directly):
    ETORO_API_KEY   — your x-api-key
    ETORO_USER_KEY  — your x-user-key

eToro API docs: https://builders.etoro.com/learn/getting-started-with-etoro-api-v2
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from typing import Any

import requests


_BASE_URL = "https://public-api.etoro.com/api/v1"


@dataclass
class EToroClient:
    """Read-only wrapper around the eToro Public API v1."""

    api_key: str = field(default_factory=lambda: os.environ.get("ETORO_API_KEY", ""))
    user_key: str = field(default_factory=lambda: os.environ.get("ETORO_USER_KEY", ""))
    # Use demo=True to target the virtual/paper portfolio instead of live.
    demo: bool = False

    def __post_init__(self) -> None:
        if not self.api_key or not self.user_key:
            raise ValueError(
                "eToro API key and user key are required. "
                "Set ETORO_API_KEY and ETORO_USER_KEY env vars, "
                "or pass them to EToroClient()."
            )

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "x-user-key": self.user_key,
            "x-request-id": str(uuid.uuid4()),
            "Accept": "application/json",
        }

    def _get(self, path: str, **params: Any) -> Any:
        url = f"{_BASE_URL}/{path.lstrip('/')}"
        resp = requests.get(url, headers=self._headers(), params=params or None, timeout=15)
        resp.raise_for_status()
        return resp.json()

    def _demo_prefix(self, path: str) -> str:
        """Prepend 'demo/' for virtual portfolio endpoints when demo=True."""
        if self.demo:
            return f"trading/info/demo/{path}"
        return f"trading/info/{path}"

    # ------------------------------------------------------------------
    # Portfolio
    # ------------------------------------------------------------------

    def portfolio(self) -> dict:
        """
        Full portfolio snapshot: open positions, pending orders,
        mirror trades, account balances, and P&L.
        """
        return self._get(self._demo_prefix("portfolio"))

    def positions(self) -> list[dict]:
        """Open positions extracted from the portfolio response."""
        data = self.portfolio()
        return data.get("positions", [])

    def balance(self) -> dict:
        """Account cash balance and equity from the portfolio response."""
        data = self.portfolio()
        return {
            "available_cash": data.get("availableCash"),
            "net_equity": data.get("netEquity"),
            "total_portfolio_value": data.get("totalPortfolioValue"),
            "unrealized_pnl": data.get("totalUnrealizedPnL"),
            "realized_pnl": data.get("totalRealizedPnL"),
        }

    # ------------------------------------------------------------------
    # Market / instrument data (public, no user key required)
    # ------------------------------------------------------------------

    def instruments(self, instrument_ids: list[int] | None = None) -> list[dict]:
        """
        Fetch instrument (asset) metadata. Optionally filter by IDs.
        Returns price, category, symbol, and other metadata.
        """
        params: dict[str, Any] = {}
        if instrument_ids:
            params["instrumentIds"] = ",".join(str(i) for i in instrument_ids)
        return self._get("instruments", **params)

    def instrument_prices(self, instrument_ids: list[int]) -> list[dict]:
        """Current bid/ask prices for the given instrument IDs."""
        return self._get(
            "instruments/prices",
            instrumentIds=",".join(str(i) for i in instrument_ids),
        )
