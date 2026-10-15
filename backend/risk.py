from typing import Any
STORM_THRESHOLDS = {
    "S1": 10,
    "S2": 100,
    "S3": 1_000,
    "S4": 10_000,
    "S5": 100_000,
}
STORM_LEVELS = {
    0: "S0",
    1: "S1",
    2: "S2",
    3: "S3",
    4: "S4",
    5: "S5",
}
def get_storm_level(flux: float) -> str:
    if isinstance(flux, bool) or not isinstance(flux, (int, float)):
        raise TypeError("Flux must be a numeric value.")
    if flux < 0 or flux != flux or flux == float("inf") or flux == float("-inf"):
        raise ValueError("Flux must be a finite, non-negative value.")
    if flux >= STORM_THRESHOLDS["S5"]:
        return "S5"
    if flux >= STORM_THRESHOLDS["S4"]:
        return "S4"
    if flux >= STORM_THRESHOLDS["S3"]:
        return "S3"
    if flux >= STORM_THRESHOLDS["S2"]:
        return "S2"
    if flux >= STORM_THRESHOLDS["S1"]:
        return "S1"
    return "S0"
def get_risk_level(flux: float, orbit_class: str) -> str:
    storm_level = get_storm_level(flux)
    orbit = orbit_class.strip().upper()
    if orbit not in {"LEO", "GEO"}:
        raise ValueError("Orbit class must be LEO or GEO.")
    storm_number = int(storm_level[1])
    if storm_number == 0:
        return "Low"
    if orbit == "GEO":
        if storm_number >= 3:
            return "Severe"
        return "Medium"
    if storm_number >= 4:
        return "Severe"
    if storm_number >= 2:
        return "Medium"
    return "Low"
def get_risk_matrix(flux: float,satellites: list[Any],) -> list[dict[str, Any]]:
    storm_level = get_storm_level(flux)
    risk_matrix = []
    for satellite in satellites:
        if isinstance(satellite, dict):
            name = satellite.get("name")
            orbit_class = satellite.get("orbit_class")
        else:
            name = getattr(satellite, "name", None)
            orbit_class = getattr(satellite, "orbit_class", None)
        if not name or not orbit_class:
            continue
        risk_level = get_risk_level(flux, orbit_class)
        risk_matrix.append(
            {
                "satellite": name,
                "orbit_class": orbit_class.upper(),
                "storm_level": storm_level,
                "risk_level": risk_level,
            }
        )
    return risk_matrix