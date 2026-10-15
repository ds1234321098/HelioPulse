from sqlalchemy import (Boolean,Column,DateTime,Float,Integer,String,UniqueConstraint,)
from sqlalchemy.sql import func
from database import Base
class Reading(Base):
    __tablename__ = "readings"
    id = Column(Integer, primary_key=True, index=True)
    time_tag = Column(DateTime(timezone=True), nullable=False, unique=True)
    flux = Column(Float, nullable=False)
    satellite = Column(String, nullable=True)
class Alert(Base):
    __tablename__ = "alerts"
    id = Column(Integer, primary_key=True, index=True)
    level = Column(String, nullable=False)
    flux = Column(Float, nullable=False)
    triggered_at = Column(DateTime(timezone=True),nullable=False,server_default=func.now(),)
    cleared_at = Column(DateTime(timezone=True), nullable=True)
    is_simulated = Column(Boolean, nullable=False, default=False)
class Satellite(Base):
    __tablename__ = "satellites"
    __table_args__ = (UniqueConstraint("name", name="uq_satellites_name"),)
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    orbit_class = Column(String, nullable=False)
    safe_mode = Column(Boolean, nullable=False, default=False)