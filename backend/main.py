from __future__ import annotations

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from scipy.spatial import cKDTree
from skyfield.api import EarthSatellite, load, wgs84

Group = Literal["stations", "active", "debris", "rocket-body"]

GROUPS: dict[str, str] = {
    "stations": "stations",
    "active": "active",
    "debris": "debris",
    "rocket-body": "rocket-body",
}
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php"
CACHE_SECONDS = 900
STALE_AFTER = timedelta(days=14)
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
WGS84_SEMI_MAJOR_KM = 6378.137
WGS84_ECCENTRICITY_SQUARED = 6.69437999014e-3
logger = logging.getLogger("orbital_guard")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="ORBITAL GUARD API",
    description="Положения и орбитальные параметры на основе открытых данных CelesTrak GP.",
    version="0.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

timescale = load.timescale(builtin=True)


@dataclass
class GroupCache:
    records: list[dict[str, Any]]
    fetched_at: datetime
    upstream_error: str | None = None


group_cache: dict[str, GroupCache] = {}
cache_lock = asyncio.Lock()


def load_disk_cache(group: str) -> GroupCache | None:
    cache_path = CACHE_DIR / f"{group}.json"
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        records = payload["records"]
        fetched_at = datetime.fromisoformat(payload["fetched_at"])
        if not isinstance(records, list):
            raise ValueError("Cached catalog records must be a list")
        return GroupCache(records=records, fetched_at=fetched_at)
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError) as error:
        logger.warning("Ignoring invalid cached catalog %s: %s", cache_path, error)
        return None


def save_disk_cache(group: str, catalog: GroupCache) -> None:
    cache_path = CACHE_DIR / f"{group}.json"
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps(
                {
                    "fetched_at": catalog.fetched_at.isoformat(),
                    "records": catalog.records,
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    except OSError as error:
        logger.warning("Unable to persist CelesTrak cache %s: %s", cache_path, error)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def fetch_group(group: str) -> GroupCache:
    if group not in GROUPS:
        raise HTTPException(status_code=422, detail="Неизвестная категория объектов.")

    cached = group_cache.get(group)
    if cached is None:
        cached = load_disk_cache(group)
        if cached:
            group_cache[group] = cached
    if cached and (utc_now() - cached.fetched_at).total_seconds() < CACHE_SECONDS:
        return cached

    async with cache_lock:
        cached = group_cache.get(group)
        if cached and (utc_now() - cached.fetched_at).total_seconds() < CACHE_SECONDS:
            return cached
        records: Any = None
        last_error: httpx.HTTPError | ValueError | None = None
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            for attempt in range(3):
                try:
                    response = await client.get(
                        CELESTRAK_URL,
                        params={"GROUP": GROUPS[group], "FORMAT": "json"},
                        headers={"User-Agent": "ORBITAL-GUARD/0.1 (open-data prototype)"},
                    )
                    response.raise_for_status()
                    records = response.json()
                    last_error = None
                    break
                except httpx.HTTPStatusError as error:
                    last_error = error
                    if error.response.status_code not in (429, 500, 502, 503, 504):
                        break
                    if attempt < 2:
                        await asyncio.sleep(0.5 * (2**attempt))
                except (httpx.RequestError, ValueError) as error:
                    last_error = error
                    if attempt < 2:
                        await asyncio.sleep(0.5 * (2**attempt))

        if last_error is not None:
            error_message = str(last_error)
            if isinstance(last_error, httpx.HTTPStatusError) and last_error.response.text.strip():
                error_message = (
                    f"{error_message}; {last_error.response.text.strip()[:250]}"
                )
            logger.error("CelesTrak request failed after retries for group %s: %s", group, error_message)
            if cached:
                logger.warning("Returning cached %s catalog after upstream failure", group)
                return GroupCache(
                    records=cached.records,
                    fetched_at=cached.fetched_at,
                    upstream_error=error_message,
                )
            raise HTTPException(
                status_code=502,
                detail=f"Не удалось получить данные CelesTrak: {error_message}",
            ) from last_error

        if not isinstance(records, list):
            raise HTTPException(
                status_code=502,
                detail="CelesTrak вернул данные каталога в неожиданном формате.",
            )
        result = GroupCache(records=records, fetched_at=utc_now())
        group_cache[group] = result
        save_disk_cache(group, result)
        return result


def make_satellite(record: dict[str, Any]) -> EarthSatellite:
    return EarthSatellite.from_omm(timescale, record)


def position_at(satellite: EarthSatellite, instant: datetime) -> tuple[float, float, float]:
    geocentric = satellite.at(timescale.from_datetime(instant))
    subpoint = wgs84.subpoint(geocentric)
    return (
        float(subpoint.latitude.degrees),
        float(subpoint.longitude.degrees),
        float(subpoint.elevation.km),
    )


def epoch_of(record: dict[str, Any]) -> datetime:
    epoch = datetime.fromisoformat(str(record["EPOCH"]).replace("Z", "+00:00"))
    if epoch.tzinfo is None:
        return epoch.replace(tzinfo=timezone.utc)
    return epoch.astimezone(timezone.utc)


def object_data(record: dict[str, Any], group: str, now: datetime) -> dict[str, Any] | None:
    try:
        satellite = make_satellite(record)
        latitude, longitude, altitude = position_at(satellite, now)
        epoch = epoch_of(record)
        return {
            "catalog_id": int(record["NORAD_CAT_ID"]),
            "name": str(record.get("OBJECT_NAME") or "Без названия"),
            "international_designator": record.get("OBJECT_ID"),
            "category": group,
            "inclination_deg": float(record["INCLINATION"]),
            "eccentricity": float(record["ECCENTRICITY"]),
            "mean_motion_rev_day": float(record["MEAN_MOTION"]),
            "epoch": epoch.isoformat(),
            "tle_age_hours": max(0.0, (now - epoch).total_seconds() / 3600),
            "latitude_deg": latitude,
            "longitude_deg": longitude,
            "altitude_km": altitude,
        }
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as error:
        logger.warning(
            "Skipping invalid CelesTrak record %s: %s",
            record.get("NORAD_CAT_ID", "unknown"),
            error,
        )
        return None


def select_records(records: list[dict[str, Any]], search: str) -> list[dict[str, Any]]:
    term = search.strip().casefold()
    if not term:
        return records
    return [
        record
        for record in records
        if term in str(record.get("OBJECT_NAME", "")).casefold()
        or term in str(record.get("OBJECT_ID", "")).casefold()
        or term in str(record.get("NORAD_CAT_ID", ""))
    ]


async def object_snapshot(
    group: str,
    search: str,
    limit: int,
) -> tuple[GroupCache, list[dict[str, Any]], int, datetime]:
    catalog = await fetch_group(group)
    matching = select_records(catalog.records, search)
    now = utc_now()
    objects = [
        result
        for record in matching[:limit]
        if (result := object_data(record, group, now)) is not None
    ]
    return catalog, objects, len(matching), now


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ORBITAL GUARD API"}


@app.get("/api/objects")
async def get_objects(
    group: Group = "active",
    search: str = Query(default="", max_length=100),
    limit: int = Query(default=2000, ge=1, le=5000),
) -> dict[str, Any]:
    catalog, objects, available, now = await object_snapshot(group, search, limit)
    skipped = max(min(available, limit) - len(objects), 0)
    warnings = []
    if catalog.upstream_error:
        warnings.append(
            "CelesTrak временно недоступен; показан кэш от "
            f"{catalog.fetched_at.isoformat()}. Ошибка: {catalog.upstream_error}"
        )
    if skipped:
        warnings.append(f"{skipped} записей не удалось распространить по SGP4 или они превышают лимит.")
    if available > limit:
        warnings.append(f"Показана выборка из {len(objects)} объектов; всего в этой категории {available}.")
    return {
        "source": "CelesTrak GP (OMM JSON)",
        "source_url": CELESTRAK_URL,
        "fetched_at": catalog.fetched_at.isoformat(),
        "calculated_at": now.isoformat(),
        "group": group,
        "available": available,
        "returned": len(objects),
        "objects": objects,
        "warnings": warnings,
    }


@app.get("/api/objects/{catalog_id}/orbit")
async def get_orbit(
    catalog_id: int,
    group: Group = "active",
) -> dict[str, Any]:
    catalog = await fetch_group(group)
    record = next(
        (
            candidate
            for candidate in catalog.records
            if str(candidate.get("NORAD_CAT_ID", "")) == str(catalog_id)
        ),
        None,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Объект не найден в выбранной категории.")

    try:
        satellite = make_satellite(record)
        now = utc_now()
        epoch = epoch_of(record)
        mean_motion = float(record["MEAN_MOTION"])
        if mean_motion <= 0:
            raise ValueError("Некорректная частота обращения")
        period_minutes = 1440 / mean_motion
        span_minutes = min(max(period_minutes * 1.1, 30), 1440)
        count = 120
        points = []
        for index in range(count + 1):
            moment = now + timedelta(minutes=span_minutes * index / count)
            latitude, longitude, altitude = position_at(satellite, moment)
            points.append(
                {
                    "latitude_deg": latitude,
                    "longitude_deg": longitude,
                    "altitude_km": altitude,
                }
            )
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as error:
        logger.exception("Unable to propagate orbit for NORAD %s", catalog_id)
        raise HTTPException(status_code=422, detail=f"Не удалось рассчитать орбиту: {error}") from error

    return {
        "catalog_id": catalog_id,
        "source": "CelesTrak GP (OMM JSON)",
        "fetched_at": catalog.fetched_at.isoformat(),
        "calculated_at": now.isoformat(),
        "element_epoch": epoch.isoformat(),
        "period_minutes": period_minutes,
        "span_minutes": span_minutes,
        "points": points,
    }


@app.get("/api/analysis")
async def get_analysis(
    group: Group = "active",
    limit: int = Query(default=2000, ge=2, le=5000),
) -> dict[str, Any]:
    _, objects, available, now = await object_snapshot(group, "", limit)
    stale = sum(
        1 for item in objects if now - epoch_of({"EPOCH": item["epoch"]}) > STALE_AFTER
    )

    pairs: dict[tuple[int, int], dict[str, Any]] = {}
    if len(objects) > 1:
        xyz = []
        for item in objects:
            latitude = math.radians(item["latitude_deg"])
            longitude = math.radians(item["longitude_deg"])
            sin_latitude = math.sin(latitude)
            prime_vertical_radius = WGS84_SEMI_MAJOR_KM / math.sqrt(
                1 - WGS84_ECCENTRICITY_SQUARED * sin_latitude**2
            )
            xyz.append(
                (
                    (prime_vertical_radius + item["altitude_km"])
                    * math.cos(latitude)
                    * math.cos(longitude),
                    (prime_vertical_radius + item["altitude_km"])
                    * math.cos(latitude)
                    * math.sin(longitude),
                    (
                        prime_vertical_radius * (1 - WGS84_ECCENTRICITY_SQUARED)
                        + item["altitude_km"]
                    )
                    * sin_latitude,
                )
            )
        distances, indices = cKDTree(np.asarray(xyz)).query(np.asarray(xyz), k=2)
        for index, (neighbor_distances, neighbors) in enumerate(
            zip(distances, indices, strict=True)
        ):
            other_index = int(neighbors[1])
            if other_index == index:
                continue
            pair = tuple(sorted((index, other_index)))
            pairs[pair] = {
                "object_a": objects[pair[0]]["name"],
                "object_b": objects[pair[1]]["name"],
                "separation_km": round(float(neighbor_distances[1]), 3),
            }
    closest = sorted(pairs.values(), key=lambda pair: pair["separation_km"])[:5]

    return {
        "group": group,
        "analyzed": len(objects),
        "available": available,
        "stale_elements": stale,
        "stale_after_days": STALE_AFTER.days,
        "closest_pairs": closest,
        "calculated_at": now.isoformat(),
        "notice": (
            "Расстояния рассчитаны между положениями на один момент времени в ограниченной выборке. "
            "Совпадения позиций могут относиться к одному орбитальному комплексу или одинаковым элементам. "
            "Это не прогноз сближения: неопределённость орбит, ковариации и вероятность столкновения "
            "не рассчитываются."
        ),
    }
