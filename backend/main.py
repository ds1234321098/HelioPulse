import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import requests
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
import crud
import models
import noaa
import risk
import state
from database import Base, SessionLocal, engine, get_db
logging.basicConfig(level=logging.INFO,format="%(asctime)s | %(levelname)s | %(message)s",)
logger = logging.getLogger(__name__)
POLL_INTERVAL_SECONDS = 300
BACKEND_DIRECTORY = Path(__file__).resolve().parent
FRONTEND_ORIGIN = os.getenv(
    "FRONTEND_ORIGIN",
    "http://localhost:5173",
)
class FlareSimulationRequest(BaseModel):
    flux: float = Field(gt=0,le=1_000_000_000,description="Simulated proton flux in pfu.",)
class SafeModeRequest(BaseModel):
    satellite_id: int = Field(gt=0)
    enabled: bool
_polling_stop_event = threading.Event()
_polling_thread: threading.Thread | None = None
def poll_noaa_once() -> None:
    db = SessionLocal()
    try:
        readings = noaa.fetch()
        state.update(readings)
        crud.save_readings(db,readings,)
        live_reading = state.get_live()
        if live_reading is None:
            logger.warning("NOAA returned readings, but no live reading is available.")
            return
        flux = live_reading["flux"]
        storm_level = risk.get_storm_level(flux)
        active_alerts = crud.get_active_alerts(db)
        active_real_alerts = [
            alert
            for alert in active_alerts
            if not alert.is_simulated
        ]
        previous_level = (
            active_real_alerts[0].level
            if active_real_alerts
            else "S0"
        )
        previous_level_number = int(previous_level[1])
        current_level_number = int(storm_level[1])
        if current_level_number > 0:
            if current_level_number != previous_level_number:
                crud.close_active_alerts(db)
                crud.open_alert(
                    db,
                    level=storm_level,
                    flux=flux,
                    is_simulated=False,
                )
                logger.info(
                    "Opened %s alert at flux %.3f pfu.",
                    storm_level,
                    flux,
                )
        elif active_real_alerts:
            crud.close_active_alerts(db)
            logger.info("Cleared active real-data alerts because flux returned to S0.")
        logger.info("NOAA polling completed. Flux: %.3f pfu; storm level: %s.",flux,storm_level,)
    except (requests.RequestException, ValueError) as exc:
        db.rollback()
        logger.error("Unable to fetch or process NOAA data: %s",exc,)
    except Exception:
        db.rollback()
        logger.exception("Unexpected error during NOAA polling.")
    finally:
        db.close()
def polling_loop() -> None:
    while not _polling_stop_event.is_set():
        poll_noaa_once()
        _polling_stop_event.wait(POLL_INTERVAL_SECONDS)
def start_polling_thread() -> None:
    global _polling_thread
    if _polling_thread is not None and _polling_thread.is_alive():
        return
    _polling_stop_event.clear()
    _polling_thread = threading.Thread(
        target=polling_loop,
        name="noaa-polling-thread",
        daemon=True,
    )
    _polling_thread.start()
def stop_polling_thread() -> None:
    _polling_stop_event.set()
    if _polling_thread is not None:
        _polling_thread.join(timeout=20)
def restore_readings_from_database() -> None:
    db = SessionLocal()
    try:
        readings = crud.get_recent_readings(
            db,
            limit=288,
        )
        if not readings:
            return
        restored_readings = [
            {
                "time_tag": reading.time_tag,
                "flux": reading.flux,
                "satellite": reading.satellite,
            }
            for reading in readings
        ]
        state.update(restored_readings)
        logger.info("Restored %d readings from PostgreSQL.",len(restored_readings),)
    except Exception:
        logger.exception("Unable to restore historical readings from PostgreSQL.")
    finally:
        db.close()
def restore_safe_mode_cache() -> None:
    db = SessionLocal()
    try:
        satellites = crud.list_satellites(db)
        for satellite in satellites:
            state.set_safe_mode_cache(
                satellite.name,
                satellite.safe_mode,
            )
    except Exception:
        logger.exception(
            "Unable to restore the safe-mode cache."
        )
    finally:
        db.close()
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        crud.seed_satellites(db)
    finally:
        db.close()
    restore_readings_from_database()
    restore_safe_mode_cache()
    start_polling_thread()
    logger.info("HelioPulse backend started.")
    try:
        yield
    finally:
        stop_polling_thread()

        logger.info("HelioPulse backend stopped.")
app = FastAPI(
    title="HelioPulse API",
    description=(
        "A space-weather monitoring dashboard using NOAA proton flux data."
    ),
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        FRONTEND_ORIGIN,
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
def serialize_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat()
def serialize_reading(reading: Any,is_simulated: bool = False,) -> dict[str, Any]:
    return {
        "time_tag": serialize_datetime(
            reading["time_tag"]
        ),
        "flux": reading["flux"],
        "satellite": reading.get("satellite"),
        "is_simulated": is_simulated,
    }
def serialize_alert(alert: models.Alert) -> dict[str, Any]:
    return {
        "id": alert.id,
        "level": alert.level,
        "flux": alert.flux,
        "triggered_at": serialize_datetime(
            alert.triggered_at
        ),
        "cleared_at": serialize_datetime(
            alert.cleared_at
        ),
        "is_simulated": alert.is_simulated,
    }
def serialize_satellite(satellite: models.Satellite,) -> dict[str, Any]:
    return {
        "id": satellite.id,
        "name": satellite.name,
        "orbit_class": satellite.orbit_class,
        "safe_mode": satellite.safe_mode,
    }
@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "Welcome to HelioPulse API.",
        "docs": "/docs",
    }
@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "HelioPulse API",
    }
@app.get("/api/weather/live")
def get_live_weather() -> dict[str, Any]:
    live_reading = state.get_live()
    if live_reading is None:
        raise HTTPException(
            status_code=503,
            detail=("No NOAA readings are available yet. ""Check the backend logs and NOAA connectivity."),)
    flux = live_reading["flux"]
    storm_level = risk.get_storm_level(flux)
    return {
        "reading": serialize_reading(
            live_reading,
            is_simulated=live_reading.get(
                "is_simulated",
                False,
            ),
        ),
        "storm_level": storm_level,
        "risk_status": "active" if storm_level != "S0" else "normal",
    }
@app.get("/api/weather/history")
def get_weather_history() -> dict[str, Any]:
    readings = state.get_history()
    return {
        "count": len(readings),
        "readings": [
            serialize_reading(reading)
            for reading in readings
        ],
    }
@app.get("/api/risk-matrix")
def get_satellite_risk_matrix(db: Session = Depends(get_db),) -> dict[str, Any]:
    live_reading = state.get_live()
    if live_reading is None:
        raise HTTPException(status_code=503,detail="No NOAA readings are available yet.",)
    satellites = crud.list_satellites(db)
    flux = live_reading["flux"]
    matrix = risk.get_risk_matrix(
        flux,
        satellites,
    )
    return {
        "flux": flux,
        "storm_level": risk.get_storm_level(flux),
        "satellites": matrix,
    }
@app.get("/api/alerts")
def get_alerts(
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    alerts = crud.get_active_alerts(db)
    return {
        "count": len(alerts),
        "alerts": [
            serialize_alert(alert)
            for alert in alerts
        ],
    }
@app.post("/api/simulate/flare")
def simulate_flare(
    request: FlareSimulationRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    live_reading = state.inject_flare(
        request.flux
    )
    storm_level = risk.get_storm_level(
        request.flux
    )
    simulated_alert = None
    if storm_level != "S0":
        simulated_alert = crud.open_alert(
            db,
            level=storm_level,
            flux=request.flux,
            is_simulated=True,
        )
    return {
        "message": "Simulated flare activated.",
        "reading": serialize_reading(
            live_reading,
            is_simulated=True,
        ),
        "storm_level": storm_level,
        "alert": (
            serialize_alert(simulated_alert)
            if simulated_alert is not None
            else None
        ),
    }
@app.post("/api/simulate/flare/clear")
def clear_simulated_flare(db: Session = Depends(get_db),) -> dict[str, str]:
    state.clear_flare()
    active_alerts = crud.get_active_alerts(db)
    for alert in active_alerts:
        if alert.is_simulated:
            alert.cleared_at = datetime.now(timezone.utc)
    db.commit()
    return {
        "message": "Simulated flare cleared.",
    }
@app.post("/api/safe-mode")
def update_safe_mode(request: SafeModeRequest,db: Session = Depends(get_db),) -> dict[str, Any]:
    satellite = crud.set_safe_mode(
        db,
        satellite_id=request.satellite_id,
        enabled=request.enabled,
    )
    if satellite is None:
        raise HTTPException(
            status_code=404,
            detail="Satellite not found.",
        )
    state.set_safe_mode_cache(
        satellite.name,
        satellite.safe_mode,
    )
    return {
        "message": "Safe-mode status updated.",
        "satellite": serialize_satellite(satellite),
    }
@app.get("/api/satellites")
def get_satellites(db: Session = Depends(get_db),) -> dict[str, Any]:
    satellites = crud.list_satellites(db)
    return {
        "count": len(satellites),
        "satellites": [
            serialize_satellite(satellite)
            for satellite in satellites
        ],
    }