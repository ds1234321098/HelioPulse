from datetime import datetime, timezone
from threading import RLock
from typing import Any
MAX_HISTORY_READINGS = 288
_state_lock = RLock()
_latest_reading: dict[str, Any] | None = None
_readings_history: list[dict[str, Any]] = []
_simulated_flux: float | None = None
_safe_mode_cache: dict[str, bool] = {}
def _normalize_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        timestamp = value
    elif isinstance(value, str):
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        timestamp = datetime.fromisoformat(normalized)
    else:
        raise TypeError("Timestamp must be a datetime object or ISO-format string.")
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp
def _normalize_reading(reading: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(reading, dict):
        raise TypeError("Each reading must be a dictionary.")
    if "time_tag" not in reading:
        raise ValueError("Reading is missing time_tag.")
    if "flux" not in reading:
        raise ValueError("Reading is missing flux.")
    timestamp = _normalize_timestamp(reading["time_tag"])
    flux = reading["flux"]
    if isinstance(flux, bool) or not isinstance(flux, (int, float)):
        raise TypeError("Reading flux must be numeric.")
    flux = float(flux)
    if flux < 0 or flux != flux or flux in (float("inf"), float("-inf")):
        raise ValueError("Reading flux must be finite and non-negative.")
    return {
        "time_tag": timestamp,
        "flux": flux,
        "satellite": reading.get("satellite"),
    }
def update(readings: list[dict[str, Any]]) -> None:
    global _latest_reading
    if not readings:
        return
    normalized_readings = [
        _normalize_reading(reading)
        for reading in readings
    ]
    with _state_lock:
        readings_by_timestamp = {
            reading["time_tag"]: reading
            for reading in _readings_history
        }
        for reading in normalized_readings:
            readings_by_timestamp[reading["time_tag"]] = reading
        _readings_history.clear()
        _readings_history.extend(
            sorted(
                readings_by_timestamp.values(),
                key=lambda reading: reading["time_tag"],
            )[-MAX_HISTORY_READINGS:]
        )
        _latest_reading = _readings_history[-1].copy()
def get_live() -> dict[str, Any] | None:
    with _state_lock:
        if _latest_reading is None:
            return None
        live_reading = _latest_reading.copy()
        if _simulated_flux is not None:
            live_reading["flux"] = _simulated_flux
            live_reading["is_simulated"] = True
        else:
            live_reading["is_simulated"] = False
        return live_reading
def get_history() -> list[dict[str, Any]]:
    with _state_lock:
        return [
            reading.copy()
            for reading in _readings_history
        ]
def inject_flare(flux: float) -> dict[str, Any]:
    global _simulated_flux
    if isinstance(flux, bool) or not isinstance(flux, (int, float)):
        raise TypeError("Simulated flux must be numeric.")
    flux = float(flux)
    if flux < 0 or flux != flux or flux in (float("inf"), float("-inf")):
        raise ValueError("Simulated flux must be finite and non-negative.")
    with _state_lock:
        _simulated_flux = flux
    live_reading = get_live()
    if live_reading is None:
        live_reading = {
            "time_tag": datetime.now(timezone.utc),
            "flux": flux,
            "satellite": None,
            "is_simulated": True,
        }
    return live_reading
def clear_flare() -> None:
    global _simulated_flux
    with _state_lock:
        _simulated_flux = None
def set_safe_mode_cache(satellite_name: str,enabled: bool,) -> None:
    if not satellite_name or not satellite_name.strip():
        raise ValueError("Satellite name cannot be empty.")
    if not isinstance(enabled, bool):
        raise TypeError("Safe-mode status must be a boolean.")
    with _state_lock:
        _safe_mode_cache[satellite_name] = enabled
def get_safe_mode_cache() -> dict[str, bool]:
    with _state_lock:
        return _safe_mode_cache.copy()
def clear_state() -> None:
    global _latest_reading
    global _simulated_flux
    with _state_lock:
        _latest_reading = None
        _readings_history.clear()
        _simulated_flux = None
        _safe_mode_cache.clear()