from datetime import datetime, timezone
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
import models
def save_readings(db: Session, readings: list[dict]) -> int:
    if not readings:
        return 0
    reading_records = []
    for reading in readings:
        time_tag = reading.get("time_tag")
        flux = reading.get("flux")
        satellite = reading.get("satellite")
        if time_tag is None or flux is None:
            continue
        if isinstance(time_tag, str):
            normalized_time = time_tag.strip()
            if normalized_time.endswith("Z"):
                normalized_time = normalized_time[:-1] + "+00:00"
            time_tag = datetime.fromisoformat(normalized_time)
        if time_tag.tzinfo is None:
            time_tag = time_tag.replace(tzinfo=timezone.utc)
        reading_records.append(
            {
                "time_tag": time_tag,
                "flux": float(flux),
                "satellite": satellite,
            }
        )
    if not reading_records:
        return 0
    statement = (insert(models.Reading).values(reading_records).on_conflict_do_nothing(index_elements=["time_tag"]))
    result = db.execute(statement)
    db.commit()
    return result.rowcount or 0
def open_alert(db: Session,level: str,flux: float,is_simulated: bool = False,) -> models.Alert:
    alert = models.Alert(level=level,flux=flux,is_simulated=is_simulated,)
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert
def close_active_alerts(db: Session) -> int:
    statement = (update(models.Alert).where(models.Alert.cleared_at.is_(None)).values(cleared_at=datetime.now(timezone.utc)))
    result = db.execute(statement)
    db.commit()
    return result.rowcount or 0
def get_active_alerts(db: Session) -> list[models.Alert]:
    statement = (select(models.Alert).where(models.Alert.cleared_at.is_(None)).order_by(models.Alert.triggered_at.desc()))
    result = db.execute(statement)
    return list(result.scalars().all())
def list_satellites(db: Session) -> list[models.Satellite]:
    statement = (select(models.Satellite).order_by(models.Satellite.name))
    result = db.execute(statement)
    return list(result.scalars().all())
def set_safe_mode(db: Session,satellite_id: int,enabled: bool,) -> models.Satellite | None:
    statement = select(models.Satellite).where(models.Satellite.id == satellite_id)
    satellite = db.execute(statement).scalar_one_or_none()
    if satellite is None:
        return None
    satellite.safe_mode = enabled
    db.commit()
    db.refresh(satellite)
    return satellite
def get_recent_readings(db: Session,limit: int = 288,) -> list[models.Reading]:
    if limit < 1:
        return []
    statement = (
        select(models.Reading)
        .order_by(models.Reading.time_tag.desc())
        .limit(limit)
    )
    result = db.execute(statement)
    readings = list(result.scalars().all())
    readings.reverse()
    return readings
def seed_satellites(db: Session) -> int:
    satellite_records = [
        {
            "name": "NOAA-20",
            "orbit_class": "LEO",
            "safe_mode": False,
        },
        {
            "name": "NOAA-21",
            "orbit_class": "LEO",
            "safe_mode": False,
        },
        {
            "name": "GOES-16",
            "orbit_class": "GEO",
            "safe_mode": False,
        },
        {
            "name": "GOES-18",
            "orbit_class": "GEO",
            "safe_mode": False,
        },
        {
            "name": "GOES-19",
            "orbit_class": "GEO",
            "safe_mode": False,
        },
    ]
    statement = (
        insert(models.Satellite)
        .values(satellite_records)
        .on_conflict_do_nothing(
            index_elements=["name"]
        )
    )
    result = db.execute(statement)
    db.commit()
    return result.rowcount or 0