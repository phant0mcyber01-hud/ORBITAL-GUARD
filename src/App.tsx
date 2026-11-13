import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Cartesian3,
  Cartesian2,
  Color,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  Math as CesiumMath,
  PolylineGlowMaterialProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  Viewer as CesiumViewer,
} from 'cesium'
import {
  AlertTriangle,
  ArrowUpRight,
  Crosshair,
  Database,
  Orbit,
  Radio,
  RefreshCw,
  Satellite,
  Search,
  ShieldAlert,
  Signal,
  X,
} from 'lucide-react'
import 'cesium/Build/Cesium/Widgets/widgets.css'

type Group = 'stations' | 'active' | 'debris' | 'rocket-body'

type OrbitalObject = {
  catalog_id: number
  name: string
  international_designator: string | null
  category: Group
  inclination_deg: number
  eccentricity: number
  mean_motion_rev_day: number
  epoch: string
  tle_age_hours: number
  latitude_deg: number
  longitude_deg: number
  altitude_km: number
}

type ObjectsResponse = {
  source: string
  fetched_at: string
  calculated_at: string
  group: Group
  available: number
  returned: number
  objects: OrbitalObject[]
  warnings: string[]
}

type OrbitResponse = {
  calculated_at: string
  element_epoch: string
  period_minutes: number
  points: { latitude_deg: number; longitude_deg: number; altitude_km: number }[]
}

type AnalysisResponse = {
  group: Group
  analyzed: number
  stale_elements: number
  stale_after_days: number
  closest_pairs: {
    object_a: string
    object_b: string
    separation_km: number
  }[]
  notice: string
}

const EMPTY_OBJECTS: OrbitalObject[] = []

const GROUPS: { id: Group; label: string; color: string }[] = [
  { id: 'active', label: 'Спутники', color: '#67e8f9' },
  { id: 'debris', label: 'Обломки', color: '#fb7185' },
  { id: 'rocket-body', label: 'Ступени ракет', color: '#fbbf24' },
  { id: 'stations', label: 'Станции', color: '#a78bfa' },
]

const API_BASE = '/api'

function resetCamera(viewer: CesiumViewer) {
  viewer.camera.lookAt(
    Cartesian3.fromDegrees(12, 16, 0),
    new HeadingPitchRange(0, CesiumMath.toRadians(-90), 16_000_000),
  )
}

function formatTime(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value)) + ' UTC'
}

function App() {
  const globeElement = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<CesiumViewer | null>(null)
  const selectedMarkerRef = useRef<ReturnType<CesiumViewer['entities']['add']> | null>(null)
  const orbitEntityRef = useRef<ReturnType<CesiumViewer['entities']['add']> | null>(null)
  const [viewerReady, setViewerReady] = useState(false)
  const [group, setGroup] = useState<Group>('stations')
  const [query, setQuery] = useState('')
  const [objectsResponse, setObjectsResponse] = useState<ObjectsResponse | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [orbitData, setOrbitData] = useState<OrbitResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [orbitError, setOrbitError] = useState('')

  const objects = objectsResponse?.group === group ? objectsResponse.objects : EMPTY_OBJECTS
  const visibleAnalysis = analysis?.group === group ? analysis : null
  const selectedObject = useMemo(
    () => objects.find((object) => object.catalog_id === selectedId) ?? null,
    [objects, selectedId],
  )

  useEffect(() => {
    if (!globeElement.current) return

    const viewer = new CesiumViewer(globeElement.current, {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      timeline: false,
    })
    viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        credit: '© OpenStreetMap contributors',
        maximumLevel: 19,
      }),
    )
    viewer.scene.globe.enableLighting = true
    viewer.scene.globe.baseColor = Color.fromCssColorString('#08111f')
    viewer.scene.backgroundColor = Color.fromCssColorString('#050a12')
    resetCamera(viewer)
    viewerRef.current = viewer

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction(
      (movement: { position: Cartesian2 }) => {
        const picked = viewer.scene.pick(movement.position) as
          | { id?: { properties?: { catalogId?: { getValue: () => number } } } }
          | undefined
        const id = picked?.id?.properties?.catalogId?.getValue()
        if (typeof id === 'number') setSelectedId(id)
      },
      ScreenSpaceEventType.LEFT_CLICK,
    )
    setViewerReady(true)

    return () => {
      handler.destroy()
      viewer.destroy()
      setViewerReady(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ group, limit: '2000' })
        if (query.trim()) params.set('search', query.trim())
        const response = await fetch(`${API_BASE}/objects?${params}`, {
          signal: controller.signal,
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.detail ?? `Ошибка сервера (${response.status})`)
        }
        const data = (await response.json()) as ObjectsResponse
        setObjectsResponse(data)
      } catch (requestError) {
        if (requestError instanceof Error && requestError.name === 'AbortError') return
        setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить каталог')
        setObjectsResponse(null)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [group, query])

  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return
    const viewer = viewerRef.current
    viewer.entities.removeAll()
    selectedMarkerRef.current = null
    orbitEntityRef.current = null

    for (const object of objects) {
      const color = Color.fromCssColorString(
        GROUPS.find((item) => item.id === object.category)?.color ?? '#67e8f9',
      )
      viewer.entities.add({
        id: `object-${object.catalog_id}`,
        name: object.name,
        position: Cartesian3.fromDegrees(
          object.longitude_deg,
          object.latitude_deg,
          object.altitude_km * 1000,
        ),
        point: {
          color,
          outlineColor: Color.fromCssColorString('#dbeafe').withAlpha(0.7),
          outlineWidth: 1,
          pixelSize: object.category === 'stations' ? 8 : 5,
        },
        properties: { catalogId: object.catalog_id },
      })
    }
  }, [objects, viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewerReady || !viewer) return
    if (selectedMarkerRef.current) viewer.entities.remove(selectedMarkerRef.current)
    selectedMarkerRef.current = null
    if (!selectedObject) return
    selectedMarkerRef.current = viewer.entities.add({
      name: selectedObject.name,
      position: Cartesian3.fromDegrees(
        selectedObject.longitude_deg,
        selectedObject.latitude_deg,
        selectedObject.altitude_km * 1000,
      ),
      point: {
        color: Color.fromCssColorString('#f0fdff'),
        outlineColor: Color.fromCssColorString('#67e8f9'),
        outlineWidth: 2,
        pixelSize: 11,
      },
    })
  }, [selectedObject, viewerReady])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API_BASE}/analysis?group=${group}&limit=2000`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Ошибка аналитики (${response.status})`)
        return (await response.json()) as AnalysisResponse
      })
      .then(setAnalysis)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== 'AbortError') {
          setAnalysis(null)
        }
      })
    return () => controller.abort()
  }, [group, objectsResponse?.fetched_at])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewerReady || !viewer || !selectedObject) {
      setOrbitData(null)
      setOrbitError('')
      return
    }
    const controller = new AbortController()
    setOrbitData(null)
    setOrbitError('')
    fetch(`${API_BASE}/objects/${selectedObject.catalog_id}/orbit?group=${group}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.detail ?? `Ошибка расчёта орбиты (${response.status})`)
        }
        return (await response.json()) as OrbitResponse
      })
      .then((data) => {
        if (controller.signal.aborted || !viewerRef.current) return
        setOrbitData(data)
        const positions = data.points.flatMap((point) => [
          point.longitude_deg,
          point.latitude_deg,
          point.altitude_km * 1000,
        ])
        orbitEntityRef.current = viewer.entities.add({
          name: `Орбита: ${selectedObject.name}`,
          polyline: {
            positions: Cartesian3.fromDegreesArrayHeights(positions),
            width: 2,
            material: new PolylineGlowMaterialProperty({
              color: Color.fromCssColorString('#67e8f9').withAlpha(0.78),
              glowPower: 0.12,
            }),
          },
        })
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name !== 'AbortError') {
          setOrbitError(requestError.message)
        }
      })
    return () => {
      controller.abort()
      if (orbitEntityRef.current && viewerRef.current) {
        viewerRef.current.entities.remove(orbitEntityRef.current)
        orbitEntityRef.current = null
      }
    }
  }, [group, selectedObject, viewerReady])

  const freshness = objectsResponse ? formatTime(objectsResponse.fetched_at) : 'Ожидание данных'

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="ORBITAL GUARD — главная">
          <span className="brand-mark"><Orbit size={21} strokeWidth={1.7} /></span>
          <span className="brand-copy">
            <strong>ORBITAL<span> GUARD</span></strong>
            <small>SPACE OBJECT MONITOR</small>
          </span>
        </a>
        <div className="topbar-center"><span className="live-dot" /> СИСТЕМА АКТИВНА <i /> ОТКРЫТЫЕ ДАННЫЕ</div>
        <div className="topbar-meta"><span><Radio size={14} /> CelesTrak GP</span><time>{objectsResponse?.calculated_at.slice(0, 10) ?? '—'}</time></div>
      </header>

      <section className="workspace">
        <aside className="left-rail">
          <div className="section-heading">
            <div>
              <span className="eyebrow">КАТАЛОГ</span>
              <h1>Объекты</h1>
            </div>
            <span className="count-badge">{objectsResponse?.available.toLocaleString('ru-RU') ?? '—'}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => {
                setSelectedId(null)
                setQuery(event.target.value)
              }}
              placeholder="Название или NORAD ID"
              aria-label="Поиск по названию или NORAD ID"
            />
            {query && <button className="icon-button clear-search" onClick={() => setQuery('')} aria-label="Очистить поиск"><X size={15} /></button>}
          </label>

          <div className="filter-title"><span>КАТЕГОРИИ</span><span>{objectsResponse?.returned ?? 0} загружено</span></div>
          <div className="category-list">
            {GROUPS.map((item) => (
              <button
                key={item.id}
                className={`category-button ${group === item.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(null)
                  setGroup(item.id)
                }}
              >
                <span className="category-indicator" style={{ backgroundColor: item.color }} />
                <span>{item.label}</span>
                {group === item.id && <span className="active-mark">●</span>}
              </button>
            ))}
          </div>

          <div className="list-heading">
            <span>ОБЪЕКТЫ НА КАРТЕ</span>
            <span>{loading ? <RefreshCw className="spin" size={13} /> : objects.length}</span>
          </div>
          <div className="object-list">
            {error ? (
              <div className="list-message error-message"><AlertTriangle size={16} />{error}</div>
            ) : loading && objects.length === 0 ? (
              <div className="list-message"><RefreshCw className="spin" size={16} />Загрузка данных CelesTrak…</div>
            ) : objects.length === 0 ? (
              <div className="list-message">По запросу ничего не найдено</div>
            ) : objects.slice(0, 120).map((object) => (
              <button
                className={`object-row ${selectedId === object.catalog_id ? 'selected' : ''}`}
                key={object.catalog_id}
                onClick={() => setSelectedId(object.catalog_id)}
              >
                <span className="object-dot" style={{ backgroundColor: GROUPS.find((item) => item.id === object.category)?.color }} />
                <span className="object-row-copy">
                  <strong>{object.name}</strong>
                  <small>NORAD {object.catalog_id} <i /> {object.altitude_km.toFixed(0)} km</small>
                </span>
                <ArrowUpRight size={14} className="row-arrow" />
              </button>
            ))}
            {objects.length > 120 && <div className="list-footnote">Показаны первые 120. Используйте поиск для остальных.</div>}
          </div>

          <div className="source-card">
            <div className="source-icon"><Database size={16} /></div>
            <div><strong>Источник данных</strong><span>Последняя загрузка</span><small>{freshness}</small></div>
            <span className="source-status" title="Источник подключён"><Signal size={14} /></span>
          </div>
        </aside>

        <section className="main-stage">
          <div className="stage-toolbar">
            <div>
              <span className="eyebrow">ОКОЛОЗЕМНОЕ ПРОСТРАНСТВО</span>
              <h2>Орбитальная карта <span className="view-tag">3D VIEW</span></h2>
            </div>
            <button className="tool-button" onClick={() => viewerRef.current && resetCamera(viewerRef.current)}>
              <Crosshair size={15} /> Сбросить вид
            </button>
          </div>
          {objectsResponse?.group === group && objectsResponse.warnings.length > 0 && (
            <div className="catalog-warning"><AlertTriangle size={14} />{objectsResponse.warnings.join(' ')}</div>
          )}
          <div className="globe-frame">
            <div ref={globeElement} className="globe-canvas" />
            <div className="globe-vignette" />
            <div className="map-coordinates"><span>ЗЕМЛЯ · WGS84</span><span>НАЖМИТЕ НА ОБЪЕКТ ДЛЯ ДЕТАЛЕЙ</span></div>
            <div className="map-live"><span className="live-dot" /> ПОЛОЖЕНИЯ РАССЧИТАНЫ НА {formatTime(objectsResponse?.calculated_at)}</div>
            {selectedObject && (
              <div className="selected-card">
                <button className="icon-button close-card" onClick={() => setSelectedId(null)} aria-label="Закрыть карточку"><X size={16} /></button>
                <span className="eyebrow">ВЫБРАННЫЙ ОБЪЕКТ</span>
                <h3>{selectedObject.name}</h3>
                <div className="selected-id">NORAD {selectedObject.catalog_id} <span>·</span> {selectedObject.international_designator ?? 'Международное обозначение недоступно'}</div>
                <div className="quick-stats">
                  <div><span>ВЫСОТА</span><strong>{selectedObject.altitude_km.toFixed(1)} <small>км</small></strong></div>
                  <div><span>НАКЛОНЕНИЕ</span><strong>{selectedObject.inclination_deg.toFixed(2)}°</strong></div>
                  <div><span>ЭКСЦЕНТРИСИТЕТ</span><strong>{selectedObject.eccentricity.toFixed(5)}</strong></div>
                  <div><span>ПЕРИОД</span><strong>{orbitData ? `${orbitData.period_minutes.toFixed(1)} мин` : `${(1440 / selectedObject.mean_motion_rev_day).toFixed(1)} мин`}</strong></div>
                </div>
                <div className="selected-footer"><span>Эпоха элементов: {formatTime(selectedObject.epoch)}</span>{orbitError && <span className="inline-error">{orbitError}</span>}</div>
              </div>
            )}
            {loading && objects.length > 0 && <div className="map-refresh"><RefreshCw className="spin" size={14} /> ОБНОВЛЕНИЕ КАТАЛОГА</div>}
            <div className="map-zoom-hint"><span>+</span><span>−</span></div>
          </div>
          <div className="map-legend">
            {GROUPS.slice(0, 3).map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.label}</span>)}
            <span className="drag-hint">Перетаскивайте · колесо мыши для масштаба</span>
          </div>
          <div className="bottom-stats">
            <div className="stat-card"><span className="stat-icon cyan"><Satellite size={16} /></span><span className="stat-copy"><small>НА КАРТЕ</small><strong>{objects.length.toLocaleString('ru-RU')} <em>объектов</em></strong></span></div>
            <div className="stat-card"><span className="stat-icon violet"><Orbit size={16} /></span><span className="stat-copy"><small>РАССМАТРИВАЕМЫЙ НАБОР</small><strong>{objectsResponse?.available.toLocaleString('ru-RU') ?? '—'} <em>в каталоге</em></strong></span></div>
            <div className="stat-card"><span className={`stat-icon ${visibleAnalysis?.stale_elements ? 'amber' : 'green'}`}><ShieldAlert size={16} /></span><span className="stat-copy"><small>УСТАРЕВШИЕ ЭЛЕМЕНТЫ</small><strong>{visibleAnalysis ? visibleAnalysis.stale_elements.toLocaleString('ru-RU') : '—'} <em>старше {visibleAnalysis?.stale_after_days ?? 14} дней</em></strong></span></div>
          </div>
        </section>

        <aside className="right-rail">
          <section className="panel-section">
            <div className="panel-title"><span className="panel-title-icon"><Orbit size={16} /></span><div><span className="eyebrow">АНАЛИТИКА</span><h2>Состояние каталога</h2></div></div>
            <div className="analysis-status">
              <span className="status-ring"><Signal size={17} /></span>
              <div><strong>Орбитальные элементы</strong><span>{visibleAnalysis ? `${visibleAnalysis.analyzed.toLocaleString('ru-RU')} объектов проверено` : 'Ожидание расчёта'}</span></div>
            </div>
            <div className="quality-row"><span>Элементы младше 14 дней</span><strong>{visibleAnalysis ? `${Math.max(0, visibleAnalysis.analyzed - visibleAnalysis.stale_elements).toLocaleString('ru-RU')}` : '—'}</strong></div>
            <div className="quality-bar"><span style={{ width: visibleAnalysis && visibleAnalysis.analyzed ? `${Math.max(0, 100 * (visibleAnalysis.analyzed - visibleAnalysis.stale_elements) / visibleAnalysis.analyzed)}%` : '0%' }} /></div>
            <p className="analysis-note">Возраст элементов — индикатор свежести, а не оценка точности или вероятности столкновения.</p>
          </section>

          <section className="panel-section proximity-section">
            <div className="panel-title"><span className="panel-title-icon amber-bg"><AlertTriangle size={16} /></span><div><span className="eyebrow">СНИМОК ПОЗИЦИЙ</span><h2>Близкие объекты</h2></div></div>
            <p className="panel-description">Минимальные мгновенные расстояния в загруженной выборке. Это не прогнозы сближений.</p>
            {visibleAnalysis?.closest_pairs.length ? (
              <div className="proximity-list">{visibleAnalysis.closest_pairs.map((pair, index) => (
                <div className="proximity-row" key={`${pair.object_a}-${pair.object_b}`}>
                  <span className="proximity-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div><strong>{pair.object_a}</strong><span>{pair.object_b}</span></div>
                  <b>{pair.separation_km.toFixed(1)}<small> km</small></b>
                </div>
              ))}</div>
            ) : <div className="empty-analysis">{visibleAnalysis ? 'Близкие пары не обнаружены в загруженной выборке' : 'Расчёт недоступен'}</div>}
            {visibleAnalysis && <div className="caution-note"><AlertTriangle size={15} /><span>{visibleAnalysis.notice}</span></div>}
          </section>

          <section className="panel-section selected-panel">
            <div className="panel-title"><span className="panel-title-icon"><Crosshair size={16} /></span><div><span className="eyebrow">КАРТОЧКА ОБЪЕКТА</span><h2>Параметры</h2></div></div>
            {selectedObject ? (
              <div className="detail-list">
                <div><span>Название</span><strong>{selectedObject.name}</strong></div>
                <div><span>Тип / источник</span><strong>{GROUPS.find((item) => item.id === selectedObject.category)?.label} · CelesTrak</strong></div>
                <div><span>Страна / владелец</span><strong className="muted-value">Нет в наборе GP</strong></div>
                <div><span>Эпоха TLE/OMM</span><strong>{formatTime(selectedObject.epoch)}</strong></div>
                <div><span>Возраст элементов</span><strong className={selectedObject.tle_age_hours > 336 ? 'warning-value' : ''}>{selectedObject.tle_age_hours.toFixed(1)} ч</strong></div>
                <div><span>Среднее движение</span><strong>{selectedObject.mean_motion_rev_day.toFixed(5)} об/сут</strong></div>
                <div><span>Орбитальная траектория</span><strong>{orbitData ? `Рассчитана · ${orbitData.points.length} точек` : orbitError || 'Расчёт…'}</strong></div>
              </div>
            ) : (
              <div className="no-selection"><Satellite size={23} /><span>Выберите объект на карте или в списке, чтобы увидеть его параметры и орбиту.</span></div>
            )}
          </section>

          <div className="accuracy-card"><div className="accuracy-icon"><AlertTriangle size={15} /></div><p><strong>Важно о точности</strong> SGP4 и TLE/OMM подходят для визуализации и предварительного анализа. Здесь нет ковариаций и вероятности столкновения.</p></div>
        </aside>
      </section>

      <footer className="footer"><span><span className="footer-dot" /> ДАННЫЕ: {objectsResponse?.source ?? 'CELESTRAK'} · ОБНОВЛЕНО {freshness}</span><span>Положения вычислены по SGP4 / Skyfield · Карта © OpenStreetMap</span><span>ORBITAL GUARD <b>·</b> NASA SPACE APPS PROTOTYPE</span></footer>
    </main>
  )
}

export default App
