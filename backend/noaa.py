import requests
NOAA_PROTON_URL = (
    "https://services.swpc.noaa.gov/json/goes/primary/"
    "integral-protons-1-day.json"
)
REQUEST_TIMEOUT = 15
def fetch() -> list[dict]:
    response = requests.get(
        NOAA_PROTON_URL,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise ValueError("Unexpected NOAA response format.")
    readings = []
    for record in data:
        if not isinstance(record, dict):
            continue
        time_tag = record.get("time_tag")
        flux = record.get("flux")
        energy = record.get("energy")
        satellite = record.get("satellite")
        if not time_tag or flux is None:
            continue
        if energy is not None:
            energy_text = str(energy).strip().lower()
            if energy_text not in {
                ">=10 mev",
                ">= 10 mev",
                "10 mev",
            }:
                continue
        try:
            flux_value = float(flux)
        except (TypeError, ValueError):
            continue
        if flux_value < 0:
            continue
        readings.append(
            {
                "time_tag": time_tag,
                "flux": flux_value,
                "satellite": (
                    str(satellite)
                    if satellite is not None
                    else None
                ),
            }
        )
    if not readings:
        raise ValueError("NOAA returned no usable proton flux measurements.")
    return readings