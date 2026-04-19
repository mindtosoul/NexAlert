import React, { useEffect, useMemo, useState, useRef } from 'react';
import MapView, { Marker, Source, Layer, MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Telemetry, useStore } from '../store';
import { Car, ShieldAlert, ScanSearch, Loader2, Route, Shuffle, MapPin } from 'lucide-react';
import axios from 'axios';

// Using a free, open-source tile style instead of Mapbox's proprietary dark mode
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';
const WS_URL = import.meta.env.VITE_WS_URL ?? API_BASE_URL.replace(/^http/, 'ws');
const SIGNAL_STRONG_MAX_AGE_MS = Number(import.meta.env.VITE_SIGNAL_STRONG_MAX_AGE_MS ?? 1000);
const SIGNAL_MEDIUM_MAX_AGE_MS = Number(import.meta.env.VITE_SIGNAL_MEDIUM_MAX_AGE_MS ?? 3000);
const FOLLOW_CAM_ZOOM = Number(import.meta.env.VITE_FOLLOW_CAM_ZOOM ?? 17);
const FOLLOW_CAM_PITCH = Number(import.meta.env.VITE_FOLLOW_CAM_PITCH ?? 50);
const STATS_POLL_MS = Number(import.meta.env.VITE_STATS_POLL_MS ?? 1000);
const TELEMETRY_FLUSH_MS = Math.max(16, Number(import.meta.env.VITE_TELEMETRY_FLUSH_MS ?? 50));
const SAME_PATH_MAX_ROAD_DISTANCE_M = Number(import.meta.env.VITE_SAME_PATH_MAX_ROAD_DISTANCE_M ?? 40);
const ALERT_PATH_MAX_M = Number(import.meta.env.VITE_ALERT_PATH_MAX_M ?? import.meta.env.VITE_ALERT_PATH_LENGTH_M ?? 400);
const FEEDER_LOOKBACK_M = Number(import.meta.env.VITE_FEEDER_LOOKBACK_M ?? 500);
const FEEDER_MAX_PATH_M = Number(import.meta.env.VITE_FEEDER_MAX_PATH_M ?? 50);
const DANGER_PULSE_PERIOD_MS = Math.max(1200, Number(import.meta.env.VITE_DANGER_PULSE_PERIOD_MS ?? 2400));
const FEEDER_JUNCTION_MATCH_M = Number(import.meta.env.VITE_FEEDER_JUNCTION_MATCH_M ?? 12);
const FEEDER_SEED_MAX_ALONG_M = Number(import.meta.env.VITE_FEEDER_SEED_MAX_ALONG_M ?? 140);
const DANGER_BRANCH_FIRST_NODE_MAX = Math.max(1, Number(import.meta.env.VITE_DANGER_BRANCH_FIRST_NODE_MAX ?? 1));
const DANGER_BRANCH_NEXT_NODE_MAX = Math.max(1, Number(import.meta.env.VITE_DANGER_BRANCH_NEXT_NODE_MAX ?? 1));
const DANGER_MIN_PATH_M = Number(import.meta.env.VITE_DANGER_MIN_PATH_M ?? 200);
const DANGER_MAX_INTERSECTIONS = Math.max(1, Number(import.meta.env.VITE_DANGER_MAX_INTERSECTIONS ?? 3));
const DANGER_HIGHWAY_MAX_MULTIPLIER = Math.max(1, Number(import.meta.env.VITE_DANGER_HIGHWAY_MAX_MULTIPLIER ?? 1.8));
const DANGER_EXTEND_PAST_FIRST_INTERSECTION = String(import.meta.env.VITE_DANGER_EXTEND_PAST_FIRST_INTERSECTION ?? 'false').toLowerCase() === 'true';

type HazardState = 'GREEN' | 'YELLOW' | 'RED';
type Coord = [number, number];
type ConstructionZoneFeature = GeoJSON.Feature<GeoJSON.Polygon, {
  id: string;
  name?: string;
  reason?: string;
  active: boolean;
}>;

interface RoadFeatureMeta {
  id: string;
  coordinates: Coord[];
  lengthMeters: number;
  startNode: string;
  endNode: string;
  roadKey: string;
  highwayType: string;
  oneway: 'yes' | '-1' | 'no';
}

const MIN_GRAPH_EDGE_LENGTH_M = Number(import.meta.env.VITE_MIN_GRAPH_EDGE_LENGTH_M ?? 2);

const closePolygonRing = (points: Coord[]) => {
  if (points.length < 3) return null;
  const [firstLon, firstLat] = points[0];
  const [lastLon, lastLat] = points[points.length - 1];
  if (firstLon === lastLon && firstLat === lastLat) return points;
  return [...points, points[0]];
};

const toConstructionZoneFeature = (input: {
  id: string;
  coordinates: Coord[];
  active: boolean;
  name?: string;
  reason?: string;
}): ConstructionZoneFeature | null => {
  const ring = closePolygonRing(input.coordinates);
  if (!ring) return null;
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
    properties: {
      id: input.id,
      name: input.name,
      reason: input.reason,
      active: input.active,
    },
  };
};

const headingToCompass = (headingDeg: number) => {
  const normalized = ((headingDeg % 360) + 360) % 360;
  const sectors = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];
  const index = Math.round(normalized / 45) % sectors.length;
  return sectors[index];
};

const computeSignalLabel = (timestamp: number, nowMs: number) => {
  const ageMs = Math.max(0, nowMs - timestamp);
  if (ageMs <= SIGNAL_STRONG_MAX_AGE_MS) return 'Strong';
  if (ageMs <= SIGNAL_MEDIUM_MAX_AGE_MS) return 'Medium';
  return 'Weak';
};

const computeDistanceAndClosing = (ego: Telemetry, other: Telemetry) => {
  const latAvgRad = ((ego.lat + other.lat) / 2) * Math.PI / 180;
  const dxMeters = (other.lon - ego.lon) * 111320 * Math.cos(latAvgRad);
  const dyMeters = (other.lat - ego.lat) * 110540;
  const distanceMeters = Math.hypot(dxMeters, dyMeters);
  if (distanceMeters < 1e-3) {
    return { distanceMeters: 0, closingSpeedMps: 0 };
  }

  const egoSpeedMps = ego.speedKmh / 3.6;
  const otherSpeedMps = other.speedKmh / 3.6;
  const egoHeadingRad = ego.heading * Math.PI / 180;
  const otherHeadingRad = other.heading * Math.PI / 180;
  const egoVelX = egoSpeedMps * Math.sin(egoHeadingRad);
  const egoVelY = egoSpeedMps * Math.cos(egoHeadingRad);
  const otherVelX = otherSpeedMps * Math.sin(otherHeadingRad);
  const otherVelY = otherSpeedMps * Math.cos(otherHeadingRad);
  const relVelX = otherVelX - egoVelX;
  const relVelY = otherVelY - egoVelY;
  const relPosUnitX = dxMeters / distanceMeters;
  const relPosUnitY = dyMeters / distanceMeters;
  const closingSpeedMps = -(relVelX * relPosUnitX + relVelY * relPosUnitY);

  return { distanceMeters, closingSpeedMps };
};

const pointToSegmentDistanceMeters = (
  pointLon: number,
  pointLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number
) => {
  const refLatRad = ((pointLat + aLat + bLat) / 3) * Math.PI / 180;
  const x = (pointLon - aLon) * 111320 * Math.cos(refLatRad);
  const y = (pointLat - aLat) * 110540;
  const bx = (bLon - aLon) * 111320 * Math.cos(refLatRad);
  const by = (bLat - aLat) * 110540;
  const segLenSq = bx * bx + by * by;
  if (segLenSq <= 1e-6) {
    return Math.hypot(x, y);
  }
  const t = Math.max(0, Math.min(1, (x * bx + y * by) / segLenSq));
  const projX = t * bx;
  const projY = t * by;
  return Math.hypot(x - projX, y - projY);
};

const roadKeyForFeature = (feature: GeoJSON.Feature<GeoJSON.LineString>, index: number) => {
  const props: any = feature.properties ?? {};
  const ref = props.ref ?? props.name ?? props['@id'] ?? feature.id ?? `feature-${index}`;
  const cls = props.highway ?? 'road';
  return `${cls}|${String(ref)}`;
};

const normalizeHeading = (heading: number) => ((heading % 360) + 360) % 360;

const headingDeltaDeg = (a: number, b: number) => {
  const da = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return da > 180 ? 360 - da : da;
};


const sliceLineByDistanceMeters = (
  coords: [number, number][],
  startMeters: number,
  endMeters: number
) => {
  if (coords.length < 2) return [];
  const low = Math.max(0, Math.min(startMeters, endMeters));
  const high = Math.max(startMeters, endMeters);
  const out: [number, number][] = [];
  let cumulative = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const refLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const segLen = Math.hypot(
      (b[0] - a[0]) * 111320 * Math.cos(refLatRad),
      (b[1] - a[1]) * 110540
    );
    const segStart = cumulative;
    const segEnd = cumulative + segLen;
    if (segEnd < low || segStart > high) {
      cumulative = segEnd;
      continue;
    }
    const clampT = (m: number) => (segLen <= 1e-6 ? 0 : Math.max(0, Math.min(1, (m - segStart) / segLen)));
    const t0 = clampT(low);
    const t1 = clampT(high);
    const p0: [number, number] = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
    const p1: [number, number] = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];

    if (out.length === 0) out.push(p0);
    if (Math.hypot(out[out.length - 1][0] - p0[0], out[out.length - 1][1] - p0[1]) > 1e-9) {
      out.push(p0);
    }
    if (Math.hypot(out[out.length - 1][0] - p1[0], out[out.length - 1][1] - p1[1]) > 1e-9) {
      out.push(p1);
    }
    cumulative = segEnd;
  }

  return out;
};

const coordKey = ([lon, lat]: Coord) => `${lon.toFixed(5)},${lat.toFixed(5)}`;

const lineLengthMeters = (coords: Coord[]) => {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLon, aLat] = coords[i];
    const [bLon, bLat] = coords[i + 1];
    const refLatRad = ((aLat + bLat) / 2) * Math.PI / 180;
    total += Math.hypot((bLon - aLon) * 111320 * Math.cos(refLatRad), (bLat - aLat) * 110540);
  }
  return total;
};

const segmentLengthMeters = (a: Coord, b: Coord) => {
  const refLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180;
  return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(refLatRad), (b[1] - a[1]) * 110540);
};

const feederLengthToFirstIntersectionFromJunction = (
  orientedTowardJunction: Coord[],
  vertexUsageCount: Record<string, number>
) => {
  if (orientedTowardJunction.length < 2) return 0;
  let distanceFromJunction = 0;
  // orientedTowardJunction ends at the danger junction. Walk upstream from the end.
  for (let i = orientedTowardJunction.length - 1; i > 0; i--) {
    const curr = orientedTowardJunction[i];
    const prev = orientedTowardJunction[i - 1];
    distanceFromJunction += segmentLengthMeters(prev, curr);
    const prevKey = coordKey(prev);
    // First shared-vertex intersection away from the junction stops feeder extension.
    if ((vertexUsageCount[prevKey] ?? 0) >= 3) {
      break;
    }
  }
  return distanceFromJunction;
};

const findFirstIntersectionAlongEdge = (
  coords: Coord[],
  startAlongMeters: number,
  forward: boolean,
  vertexUsageCount: Record<string, number>
) => {
  if (coords.length < 2) return null;
  const cumulative: number[] = [0];
  for (let i = 0; i < coords.length - 1; i++) {
    cumulative.push(cumulative[i] + segmentLengthMeters(coords[i], coords[i + 1]));
  }
  const EPS = 0.5; // meters
  if (forward) {
    for (let i = 0; i < coords.length; i++) {
      if (cumulative[i] <= startAlongMeters + EPS) continue;
      if ((vertexUsageCount[coordKey(coords[i])] ?? 0) >= 3) {
        return { distanceAlong: cumulative[i], nodeKey: coordKey(coords[i]) };
      }
    }
    return null;
  }
  for (let i = coords.length - 1; i >= 0; i--) {
    if (cumulative[i] >= startAlongMeters - EPS) continue;
    if ((vertexUsageCount[coordKey(coords[i])] ?? 0) >= 3) {
      return { distanceAlong: cumulative[i], nodeKey: coordKey(coords[i]) };
    }
  }
  return null;
};

const parseOneWay = (feature: GeoJSON.Feature<GeoJSON.LineString>): 'yes' | '-1' | 'no' => {
  const raw = String((feature.properties as any)?.oneway ?? '').toLowerCase();
  if (raw === '-1' || raw === 'reverse') return '-1';
  if (raw === 'yes' || raw === '1' || raw === 'true') return 'yes';
  return 'no';
};

const isHighwayClass = (highwayType: string) =>
  ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(highwayType);

const dangerLengthBySpeedMeters = (speedKmh: number) => {
  const s = Math.max(0, speedKmh);
  if (s <= 30) return 200 * (s / 30);
  if (s <= 60) return 200 + (s - 30) * (200 / 30);
  if (s <= 100) return 400 + (s - 60) * (200 / 40);
  return Math.min(900, 600 + (s - 100) * 3);
};

const distanceToFeatureCollectionMeters = (
  vehicle: Telemetry,
  fc: GeoJSON.FeatureCollection<GeoJSON.LineString>
) => {
  let minDistance = Number.POSITIVE_INFINITY;
  for (const f of fc.features) {
    const coords = f.geometry.coordinates as Coord[];
    for (let i = 0; i < coords.length - 1; i++) {
      const [aLon, aLat] = coords[i];
      const [bLon, bLat] = coords[i + 1];
      const d = pointToSegmentDistanceMeters(vehicle.lon, vehicle.lat, aLon, aLat, bLon, bLat);
      if (d < minDistance) {
        minDistance = d;
      }
    }
  }
  return minDistance;
};

const distanceFromPointToLineCoordsMeters = (pt: Coord, lineCoords: Coord[]) => {
  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lineCoords.length - 1; i++) {
    const [aLon, aLat] = lineCoords[i];
    const [bLon, bLat] = lineCoords[i + 1];
    const d = pointToSegmentDistanceMeters(pt[0], pt[1], aLon, aLat, bLon, bLat);
    if (d < minDistance) minDistance = d;
  }
  return minDistance;
};

const MapDashboard: React.FC = () => {
  const { vehicles, alerts } = useStore();
  const [networkData, setNetworkData] = useState<GeoJSON.FeatureCollection | null>(null);
  const mapRef = useRef<MapRef | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgressText, setScanProgressText] = useState<string>('');
  const [simMode, setSimMode] = useState<'RANDOM' | 'SPECIFIC_PATH'>('RANDOM');
  const [selectedPoints, setSelectedPoints] = useState<[number, number][]>([]);
  const [isSelectingPoints, setIsSelectingPoints] = useState(false);
  const [focusedVehicleId, setFocusedVehicleId] = useState<string | null>(null);
  const [specificPathVehicleCount, setSpecificPathVehicleCount] = useState<number>(8);
  const [isApplyingSpecificCount, setIsApplyingSpecificCount] = useState(false);
  const [isFollowCam, setIsFollowCam] = useState(true);
  const [constructionZones, setConstructionZones] = useState<ConstructionZoneFeature[]>([]);
  const [isConstructionOverrideActive, setIsConstructionOverrideActive] = useState(false);
  const [isDrawingConstructionZone, setIsDrawingConstructionZone] = useState(false);
  const [draftConstructionZonePoints, setDraftConstructionZonePoints] = useState<Coord[]>([]);
  const [constructionZoneName, setConstructionZoneName] = useState('');
  const [constructionZoneReason, setConstructionZoneReason] = useState('');
  const [isSavingConstructionZone, setIsSavingConstructionZone] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [simulationActive, setSimulationActive] = useState(false);
  const [hasNetwork, setHasNetwork] = useState(false);
  const [isStartingSimulation, setIsStartingSimulation] = useState(false);
  const [isStoppingSimulation, setIsStoppingSimulation] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvSpeedMultiplier, setCsvSpeedMultiplier] = useState(1);
  const [isStartingCsvReplay, setIsStartingCsvReplay] = useState(false);
  const [isStoppingCsvReplay, setIsStoppingCsvReplay] = useState(false);
  const [csvReplayStatus, setCsvReplayStatus] = useState({
    running: false,
    cursor: 0,
    totalRows: 0,
    speedMultiplier: 1,
  });
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const lastDangerLengthByIntruderRef = useRef<Record<string, number>>({});
  const isSelectingPointsRef = useRef(false);
  const focusedVehicleIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastHardwareAlertPayloadRef = useRef<string>('');
  const [stats, setStats] = useState({
    wrongWayEvents: 0,
    alertsSent: 0,
    avgResponseTimeMs: 0,
    falsePositives: 0,
  });

  const onMapRef = React.useCallback((node: MapRef | null) => {
    if (node !== null) {
      (mapRef as React.MutableRefObject<MapRef | null>).current = node;
      setMapLoaded(true);
    }
  }, []);
  const vehicleList = useMemo(() => Object.values(vehicles), [vehicles]);

  const syncConstructionOverride = React.useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/construction-override`);
      const rawZones = Array.isArray(res.data?.zones) ? res.data.zones : [];
      const parsed: ConstructionZoneFeature[] = [];
      for (const zone of rawZones) {
        if (!Array.isArray(zone?.coordinates)) continue;
        const points = zone.coordinates
          .filter((c: any) => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
          .map((c: [number, number]) => [Number(c[0]), Number(c[1])] as Coord);
        const feature = toConstructionZoneFeature({
          id: String(zone.id ?? ''),
          coordinates: points,
          active: Boolean(zone.active),
          name: typeof zone.name === 'string' ? zone.name : undefined,
          reason: typeof zone.reason === 'string' ? zone.reason : undefined,
        });
        if (feature) parsed.push(feature);
      }
      setConstructionZones(parsed);
      setIsConstructionOverrideActive(Boolean(res.data?.active));
    } catch (err) {
      console.error('Failed to fetch construction override zones:', err);
    }
  }, []);

  useEffect(() => {
    isSelectingPointsRef.current = isSelectingPoints;
  }, [isSelectingPoints]);

  useEffect(() => {
    focusedVehicleIdRef.current = focusedVehicleId;
  }, [focusedVehicleId]);

  useEffect(() => {
    // Connect WebSocket
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'BIND_HARDWARE_VEHICLE',
        payload: { vehicleId: focusedVehicleIdRef.current ?? null },
      }));
    };
    
    // Buffer for telemetry updates to avoid excessive rerenders
    let telemetryBuffer: Record<string, Telemetry> = {};
    let hasBufferedTelemetry = false;
    let flushIntervalId: number;

    const flushBuffer = () => {
      if (hasBufferedTelemetry) {
        useStore.getState().updateTelemetryBatch(telemetryBuffer);
        telemetryBuffer = {};
        hasBufferedTelemetry = false;
      }
    };
    
    flushIntervalId = window.setInterval(flushBuffer, TELEMETRY_FLUSH_MS);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'TELEMETRY') {
        telemetryBuffer[data.payload.vehicleId] = data.payload;
        hasBufferedTelemetry = true;
      } else if (data.type === 'TELEMETRY_BATCH' && Array.isArray(data.payload)) {
        for (const entry of data.payload) {
          if (!entry?.vehicleId) continue;
          telemetryBuffer[entry.vehicleId] = entry;
        }
        hasBufferedTelemetry = true;
      } else if (data.type === 'DANGER' || data.type === 'MONITORING' || data.type === 'SAFE') {
        useStore.getState().updateAlert(data);
      } else if (data.type === 'ACKNOWLEDGE' && typeof data.vehicleId === 'string') {
        // UI-side ACK handling fallback: clear active alert for acknowledged vehicle.
        useStore.getState().updateAlert({
          type: 'SAFE',
          vehicleId: data.vehicleId,
          confidenceScore: 0,
          message: 'Alert acknowledged.',
        });
      } else if (data.type === 'SCAN_PROGRESS') {
        const text = data?.message || 'Scanning region...';
        setScanProgressText(text);
      } else if (data.type === 'CSV_REPLAY_COMPLETE') {
        setCsvReplayStatus((prev) => ({ ...prev, running: false }));
      } else if (data.type === 'CONSTRUCTION_OVERRIDE_UPDATED') {
        const payload = data.payload ?? {};
        const zones = Array.isArray(payload.zones) ? payload.zones : [];
        const parsed: ConstructionZoneFeature[] = [];
        for (const zone of zones) {
          if (!Array.isArray(zone?.coordinates)) continue;
          const points = zone.coordinates
            .filter((c: any) => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
            .map((c: [number, number]) => [Number(c[0]), Number(c[1])] as Coord);
          const feature = toConstructionZoneFeature({
            id: String(zone.id ?? ''),
            coordinates: points,
            active: Boolean(zone.active),
            name: typeof zone.name === 'string' ? zone.name : undefined,
            reason: typeof zone.reason === 'string' ? zone.reason : undefined,
          });
          if (feature) parsed.push(feature);
        }
        setConstructionZones(parsed);
        setIsConstructionOverrideActive(Boolean(payload.active));
      } else if (data.type === 'SIMULATION_RESET') {
        telemetryBuffer = {};
        useStore.setState({ vehicles: {}, alerts: {} });
        setFocusedVehicleId(null);
        if ((data.mode === 'RANDOM' || data.mode === 'SPECIFIC_PATH') && !(isSelectingPointsRef.current && data.mode === 'RANDOM')) {
          setSimMode(data.mode);
        }
        if (typeof data.simulationActive === 'boolean') {
          setSimulationActive(data.simulationActive);
        }
        if (Number.isFinite(data.vehicleCount)) {
          setSpecificPathVehicleCount(Math.max(1, Math.floor(data.vehicleCount)));
        }
      }
    };

    const initializeSession = async () => {
      try {
        await axios.post(`${API_BASE_URL}/reset-session`);
        useStore.setState({ vehicles: {}, alerts: {} });
        setNetworkData(null);
        setHasNetwork(false);
        setSimulationActive(false);
        setSelectedPoints([]);
        setIsSelectingPoints(false);
        setFocusedVehicleId(null);

        const statusRes = await axios.get(`${API_BASE_URL}/simulation-status`);
        setSimMode(statusRes.data.mode);
        if (Number.isFinite(statusRes.data.specificPathVehicleCount)) {
          setSpecificPathVehicleCount(Math.max(1, Math.floor(statusRes.data.specificPathVehicleCount)));
        }
        await syncConstructionOverride();
      } catch (err) {
        console.error('Failed to initialize clean session:', err);
      } finally {
        setIsInitializingSession(false);
      }
    };

    initializeSession();

    return () => {
      wsRef.current = null;
      ws.close();
      window.clearInterval(flushIntervalId);
    };
  }, [syncConstructionOverride]);

  useEffect(() => {
    let mounted = true;
    const fetchStats = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/stats`);
        if (!mounted) return;
        setStats({
          wrongWayEvents: Number(res.data?.wrongWayEvents ?? 0),
          alertsSent: Number(res.data?.alertsSent ?? 0),
          avgResponseTimeMs: Number(res.data?.avgResponseTimeMs ?? 0),
          falsePositives: Number(res.data?.falsePositives ?? 0),
        });
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      }
    };

    fetchStats();
    const interval = window.setInterval(fetchStats, STATS_POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const refreshCsvStatus = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL}/csv-replay/status`);
        if (!mounted) return;
        setCsvReplayStatus({
          running: Boolean(res.data?.running),
          cursor: Number(res.data?.cursor ?? 0),
          totalRows: Number(res.data?.totalRows ?? 0),
          speedMultiplier: Number(res.data?.speedMultiplier ?? 1),
        });
      } catch (err) {
        console.error('Failed to fetch CSV replay status:', err);
      }
    };
    refreshCsvStatus();
    const interval = window.setInterval(refreshCsvStatus, 1000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const injectIntruder = () => {
    axios.post(`${API_BASE_URL}/inject-intruder`).catch(console.error);
  };

  const scanCurrentArea = async () => {
    if (!mapRef.current) return;
    const map = mapRef.current.getMap();
    const bounds = map.getBounds();
    const bbox = {
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
    };

    console.log("Scanning BBOX:", bbox);

    setIsScanning(true);
    setScanProgressText('Preparing area scan...');
    try {
      const res = await axios.post(`${API_BASE_URL}/update-region`, bbox);
      setNetworkData(res.data.network);
      setHasNetwork(Array.isArray(res.data?.network?.features) && res.data.network.features.length > 0);
      setSimulationActive(false);
      // Clean up frontend state of old cars
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err) {
      console.error('Failed to scan area:', err);
      setScanProgressText('Scan failed. Try smaller area or retry.');
    } finally {
      setIsScanning(false);
      setTimeout(() => setScanProgressText(''), 1500);
    }
  };

  const toggleSimMode = async (mode: 'RANDOM' | 'SPECIFIC_PATH') => {
    if (isDrawingConstructionZone) {
      window.alert('Finish or cancel Construction Override drawing first.');
      return;
    }
    setSimMode(mode);
    if (mode === 'SPECIFIC_PATH') {
      setIsSelectingPoints(true);
      setSelectedPoints([]);
      // Don't change mode until points are selected
      setSimulationActive(false);
      return;
    }
    
    setIsSelectingPoints(false);
    setSelectedPoints([]);

    try {
      await axios.post(`${API_BASE_URL}/set-simulation-mode`, { mode });
      setSimulationActive(false);
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err) {
      console.error('Failed to set simulation mode:', err);
    }
  };

  const handleMapClick = async (e: any) => {
    if (isDrawingConstructionZone) {
      setDraftConstructionZonePoints((prev) => [...prev, [e.lngLat.lng, e.lngLat.lat] as Coord]);
      return;
    }
    if (!isSelectingPoints) return;

    const newPoints = [...selectedPoints, [e.lngLat.lng, e.lngLat.lat] as [number, number]];
    setSelectedPoints(newPoints);

    if (newPoints.length === 2) {
      setIsSelectingPoints(false);
      try {
        await axios.post(`${API_BASE_URL}/set-simulation-mode`, { 
          mode: 'SPECIFIC_PATH',
          pointA: newPoints[0],
          pointB: newPoints[1],
          vehicleCount: specificPathVehicleCount
        });
        setSimMode('SPECIFIC_PATH');
        setSimulationActive(false);
        useStore.setState({ vehicles: {}, alerts: {} });
      } catch (err: any) {
        const message = err?.response?.data?.error || 'Could not find a connected road path between the selected points.';
        console.error('Failed to set simulation mode with points:', err);
        window.alert(message);
        setSelectedPoints([]);
        setSimMode('RANDOM');
      }
    }
  };

  const startConstructionZoneDrawing = () => {
    if (!hasNetwork) {
      window.alert('Choose area first, then draw Construction Override zone.');
      return;
    }
    setIsSelectingPoints(false);
    setSelectedPoints([]);
    setIsDrawingConstructionZone(true);
    setDraftConstructionZonePoints([]);
  };

  const cancelConstructionZoneDrawing = () => {
    setIsDrawingConstructionZone(false);
    setDraftConstructionZonePoints([]);
  };

  const saveConstructionZone = async () => {
    if (draftConstructionZonePoints.length < 3) {
      window.alert('Add at least 3 points to make a polygon.');
      return;
    }
    setIsSavingConstructionZone(true);
    try {
      await axios.post(`${API_BASE_URL}/construction-override`, {
        name: constructionZoneName.trim() || undefined,
        reason: constructionZoneReason.trim() || undefined,
        coordinates: draftConstructionZonePoints,
        active: true,
        globalActive: true,
      });
      setConstructionZoneName('');
      setConstructionZoneReason('');
      setDraftConstructionZonePoints([]);
      setIsDrawingConstructionZone(false);
      await syncConstructionOverride();
    } catch (err: any) {
      const message = err?.response?.data?.error || 'Failed to save construction override zone.';
      window.alert(message);
    } finally {
      setIsSavingConstructionZone(false);
    }
  };

  const toggleConstructionOverrideActive = async () => {
    try {
      await axios.post(`${API_BASE_URL}/construction-override/active`, {
        active: !isConstructionOverrideActive,
      });
      await syncConstructionOverride();
    } catch (err) {
      console.error('Failed to toggle construction override active state:', err);
    }
  };

  const removeConstructionZone = async (zoneId: string) => {
    try {
      await axios.delete(`${API_BASE_URL}/construction-override/${encodeURIComponent(zoneId)}`);
      await syncConstructionOverride();
    } catch (err) {
      console.error('Failed to delete construction override zone:', err);
    }
  };

  const focusVehicleOnMap = (vehicle: Telemetry) => {
    setFocusedVehicleId(vehicle.vehicleId);
    mapRef.current?.flyTo({
      center: [vehicle.lon, vehicle.lat],
      zoom: FOLLOW_CAM_ZOOM,
      duration: 900,
      essential: true,
    });
  };

  const applySpecificPathVehicleCount = async () => {
    if (simMode !== 'SPECIFIC_PATH') return;
    setIsApplyingSpecificCount(true);
    try {
      const res = await axios.post(`${API_BASE_URL}/set-simulation-mode`, {
        mode: 'SPECIFIC_PATH',
        vehicleCount: specificPathVehicleCount
      });
      if (Number.isFinite(res.data?.vehicleCount)) {
        setSpecificPathVehicleCount(Math.max(1, Math.floor(res.data.vehicleCount)));
      }
      setSimulationActive(false);
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err) {
      console.error('Failed to update specific-path vehicle count:', err);
    } finally {
      setIsApplyingSpecificCount(false);
    }
  };

  const startSimulationNow = async () => {
    const requiresSpecificPoints = simMode === 'SPECIFIC_PATH';
    if (isDrawingConstructionZone) {
      window.alert('Finish Construction Override drawing before starting simulation.');
      return;
    }
    if (csvReplayStatus.running) {
      window.alert('Stop CSV replay before starting simulation.');
      return;
    }
    if (!hasNetwork) {
      window.alert('Scan/select an area first.');
      return;
    }
    if (requiresSpecificPoints && selectedPoints.length < 2) {
      window.alert('Select Start (A) and End (B) points first.');
      return;
    }

    setIsStartingSimulation(true);
    try {
      const payload: any = {
        mode: simMode,
        vehicleCount: specificPathVehicleCount,
      };
      if (requiresSpecificPoints) {
        payload.pointA = selectedPoints[0];
        payload.pointB = selectedPoints[1];
      }
      await axios.post(`${API_BASE_URL}/start-simulation`, payload);
      setSimulationActive(true);
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err: any) {
      const message = err?.response?.data?.error || 'Failed to start simulation.';
      window.alert(message);
    } finally {
      setIsStartingSimulation(false);
    }
  };

  const stopSimulationNow = async () => {
    setIsStoppingSimulation(true);
    try {
      await axios.post(`${API_BASE_URL}/stop-simulation`);
      setSimulationActive(false);
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err) {
      console.error('Failed to stop simulation:', err);
    } finally {
      setIsStoppingSimulation(false);
    }
  };

  const startCsvReplayNow = async () => {
    if (!csvText.trim()) {
      window.alert('Paste CSV content first.');
      return;
    }
    setIsStartingCsvReplay(true);
    try {
      await axios.post(`${API_BASE_URL}/csv-replay/start`, {
        csvText,
        speedMultiplier: csvSpeedMultiplier,
      });
      setCsvReplayStatus((prev) => ({
        ...prev,
        running: true,
        speedMultiplier: csvSpeedMultiplier,
      }));
      useStore.setState({ vehicles: {}, alerts: {} });
    } catch (err: any) {
      const message = err?.response?.data?.error || 'Failed to start CSV replay.';
      window.alert(message);
    } finally {
      setIsStartingCsvReplay(false);
    }
  };

  const stopCsvReplayNow = async () => {
    setIsStoppingCsvReplay(true);
    try {
      await axios.post(`${API_BASE_URL}/csv-replay/stop`);
      setCsvReplayStatus((prev) => ({ ...prev, running: false }));
    } catch (err) {
      console.error('Failed to stop CSV replay:', err);
    } finally {
      setIsStoppingCsvReplay(false);
    }
  };

  const onCsvFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    event.target.value = '';
  };

  const focusedVehicle = focusedVehicleId ? vehicles[focusedVehicleId] : null;

  useEffect(() => {
    if (!isFollowCam || !focusedVehicle || !mapRef.current) return;
    mapRef.current.easeTo({
      center: [focusedVehicle.lon, focusedVehicle.lat],
      bearing: focusedVehicle.heading,
      zoom: FOLLOW_CAM_ZOOM,
      pitch: FOLLOW_CAM_PITCH,
      duration: 250,
      essential: true,
    });
  }, [focusedVehicle, isFollowCam]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'BIND_HARDWARE_VEHICLE',
      payload: { vehicleId: focusedVehicleId ?? null },
    }));
  }, [focusedVehicleId]);

  const hazardOverlay = useMemo(() => {
    const empty = {
      dangerPathData: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection<GeoJSON.LineString>,
      feederPathData: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection<GeoJSON.LineString>,
      vehicleStateById: {} as Record<string, { state: HazardState; feederDistanceM?: number }>,
      vehicleKinematicsById: {} as Record<string, {
        mapMatchDistanceM: number;
        roadBearingDeg: number;
        vehicleHeadingDeg: number;
        bearingDeltaDeg: number;
        oneway: 'yes' | '-1' | 'no';
      }>,
      intruderIds: new Set<string>(),
    };
    if (!networkData) return empty;

    const metas: RoadFeatureMeta[] = (networkData.features as GeoJSON.Feature<GeoJSON.LineString>[])
      .filter((f) => f.geometry?.type === 'LineString' && (f.geometry.coordinates?.length ?? 0) >= 2)
      .map((f, i) => {
        const coords = f.geometry.coordinates as Coord[];
        const len = lineLengthMeters(coords);
        const highwayType = String((f.properties as any)?.highway ?? '').toLowerCase();
        return {
          id: `edge-${i}`,
          coordinates: coords,
          lengthMeters: len,
          startNode: coordKey(coords[0]),
          endNode: coordKey(coords[coords.length - 1]),
          roadKey: roadKeyForFeature(f, i),
          highwayType,
          oneway: parseOneWay(f),
        };
      })
      .filter((e) => e.lengthMeters >= MIN_GRAPH_EDGE_LENGTH_M);
    type EdgeProjection = {
      edge: RoadFeatureMeta;
      distanceMeters: number;
      distanceAlongMeters: number;
      segmentBearingDeg: number;
    };

    const edgeById: Record<string, RoadFeatureMeta> = {};
    const undirectedByNode: Record<string, string[]> = {};
    const incomingByNode: Record<string, Array<{ edgeId: string; fromNode: string }>> = {};
    const addUndirected = (node: string, edgeId: string) => {
      if (!undirectedByNode[node]) undirectedByNode[node] = [];
      undirectedByNode[node].push(edgeId);
    };
    const addIncoming = (toNode: string, edgeId: string, fromNode: string) => {
      if (!incomingByNode[toNode]) incomingByNode[toNode] = [];
      incomingByNode[toNode].push({ edgeId, fromNode });
    };

    for (const edge of metas) {
      edgeById[edge.id] = edge;
      addUndirected(edge.startNode, edge.id);
      addUndirected(edge.endNode, edge.id);
      if (edge.oneway === 'yes') {
        addIncoming(edge.endNode, edge.id, edge.startNode);
      } else if (edge.oneway === '-1') {
        addIncoming(edge.startNode, edge.id, edge.endNode);
      } else {
        addIncoming(edge.endNode, edge.id, edge.startNode);
        addIncoming(edge.startNode, edge.id, edge.endNode);
      }
    }
    const nodeDegree: Record<string, number> = {};
    for (const [node, edges] of Object.entries(undirectedByNode)) {
      nodeDegree[node] = edges.length;
    }
    const vertexUsageCount: Record<string, number> = {};
    for (const edge of metas) {
      const seenInEdge = new Set<string>();
      for (const c of edge.coordinates) {
        const key = coordKey(c);
        if (seenInEdge.has(key)) continue;
        seenInEdge.add(key);
        vertexUsageCount[key] = (vertexUsageCount[key] ?? 0) + 1;
      }
    }

    const projectToEdge = (vehicle: Telemetry): EdgeProjection | null => {
      let best: EdgeProjection | null = null;
      for (const edge of metas) {
        let cumulativeMeters = 0;
        for (let j = 0; j < edge.coordinates.length - 1; j++) {
          const [aLon, aLat] = edge.coordinates[j];
          const [bLon, bLat] = edge.coordinates[j + 1];
          const refLatRad = ((vehicle.lat + aLat + bLat) / 3) * Math.PI / 180;
          const x = (vehicle.lon - aLon) * 111320 * Math.cos(refLatRad);
          const y = (vehicle.lat - aLat) * 110540;
          const bx = (bLon - aLon) * 111320 * Math.cos(refLatRad);
          const by = (bLat - aLat) * 110540;
          const segLenSq = bx * bx + by * by;
          const segLen = Math.sqrt(segLenSq);
          const t = segLenSq <= 1e-6 ? 0 : Math.max(0, Math.min(1, (x * bx + y * by) / segLenSq));
          const projX = t * bx;
          const projY = t * by;
          const dist = Math.hypot(x - projX, y - projY);
          if (!best || dist < best.distanceMeters) {
            best = {
              edge,
              distanceMeters: dist,
              distanceAlongMeters: cumulativeMeters + t * segLen,
              segmentBearingDeg: normalizeHeading((Math.atan2(bx, by) * 180) / Math.PI),
            };
          }
          cumulativeMeters += segLen;
        }
      }
      return best;
    };

    const matchedByVehicleId: Record<string, EdgeProjection | null> = {};
    const projectToEdgeCached = (vehicle: Telemetry): EdgeProjection | null => {
      const cached = matchedByVehicleId[vehicle.vehicleId];
      if (cached !== undefined) return cached;
      const matched = projectToEdge(vehicle);
      matchedByVehicleId[vehicle.vehicleId] = matched;
      return matched;
    };

    const dangerFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    const feederFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    const dangerEdgeIds = new Set<string>();
    const feederEdgeIds = new Set<string>();
    const feederDistanceByEdge: Record<string, number> = {};
    const feederJunctionAtEndByEdge: Record<string, boolean> = {};
    const feederJunctionIntruderDistByEdge: Record<string, number> = {};
    const dangerNodeDistGlobal: Record<string, number> = {};
    const intruderIds = new Set<string>();
    const pulse = 0.7 + 0.3 * Math.sin((nowMs / DANGER_PULSE_PERIOD_MS) * Math.PI * 2);

    for (const [vehicleId, alert] of Object.entries(alerts)) {
      if (alert.type !== 'DANGER') continue;
      const intruder = vehicles[vehicleId];
      if (!intruder) continue;
      const matched = projectToEdgeCached(intruder);
      if (!matched || matched.distanceMeters > SAME_PATH_MAX_ROAD_DISTANCE_M) continue;
      if (matched.edge.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) continue;
      intruderIds.add(vehicleId);

      const speedBasedTarget = Math.max(DANGER_MIN_PATH_M, dangerLengthBySpeedMeters(intruder.speedKmh));
      const maxCap = isHighwayClass(matched.edge.highwayType)
        ? ALERT_PATH_MAX_M * DANGER_HIGHWAY_MAX_MULTIPLIER
        : ALERT_PATH_MAX_M;
      const target = Math.min(maxCap, speedBasedTarget);
      const prev = lastDangerLengthByIntruderRef.current[vehicleId] ?? target;
      const smoothed = target >= prev ? target : Math.max(target, prev - 80);
      lastDangerLengthByIntruderRef.current[vehicleId] = smoothed;

      const forwardToEnd = headingDeltaDeg(intruder.heading, matched.segmentBearingDeg) <= 90;
      const edge = matched.edge;
      const start = matched.distanceAlongMeters;
      const boundaryEnd = forwardToEnd ? edge.lengthMeters : 0;
      const boundaryNodeKey = forwardToEnd ? edge.endNode : edge.startNode;
      const intersectionStop = findFirstIntersectionAlongEdge(edge.coordinates, start, forwardToEnd, vertexUsageCount);

      let clippedEnd = forwardToEnd
        ? Math.min(edge.lengthMeters, start + smoothed)
        : Math.max(0, start - smoothed);

      let firstNodeKey: string | null = null;
      if (!DANGER_EXTEND_PAST_FIRST_INTERSECTION && intersectionStop) {
        clippedEnd = forwardToEnd
          ? Math.min(clippedEnd, intersectionStop.distanceAlong)
          : Math.max(clippedEnd, intersectionStop.distanceAlong);
        firstNodeKey = intersectionStop.nodeKey;
      } else if (Math.abs(clippedEnd - boundaryEnd) <= 0.5) {
        firstNodeKey = boundaryNodeKey;
      }

      let firstCoords = sliceLineByDistanceMeters(edge.coordinates, start, clippedEnd);
      if (!forwardToEnd) firstCoords = firstCoords.reverse();
      const firstLen = Math.abs(clippedEnd - start);
      if (firstCoords.length >= 2) {
        dangerFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: firstCoords },
          properties: { opacity: 0.95 * pulse },
        });
        dangerEdgeIds.add(edge.id);
      }

      const queue: Array<{ node: string; remaining: number; traveled: number; fromEdgeId: string; depth: number; intersectionsCrossed: number }> = [{
        node: firstNodeKey ?? boundaryNodeKey,
        remaining: Math.max(0, smoothed - firstLen),
        traveled: firstLen,
        fromEdgeId: edge.id,
        depth: 0,
        intersectionsCrossed: 0,
      }];
      const dangerNodeDist = new Map<string, number>();
      const firstNode = firstNodeKey ?? boundaryNodeKey;
      if (firstNodeKey) {
        dangerNodeDist.set(firstNode, firstLen);
      }
      const visited = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        const existingNodeDist = dangerNodeDist.get(current.node);
        if (existingNodeDist == null || current.traveled < existingNodeDist) {
          dangerNodeDist.set(current.node, current.traveled);
        }
        if (!DANGER_EXTEND_PAST_FIRST_INTERSECTION) {
          // Uncertain turn choice at junction: do not project danger beyond first intersection.
          continue;
        }
        if (current.remaining <= 0) continue;
        const candidates = undirectedByNode[current.node] ?? [];
        const rankedCandidates = candidates
          .map((edgeId) => {
            const e = edgeById[edgeId];
            if (!e) return null;
            if (e.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) return null;
            if (edgeId === current.fromEdgeId) return null;
            const fromStart = e.startNode === current.node;
            const oriented = fromStart ? e.coordinates : [...e.coordinates].reverse();
            if (oriented.length < 2) return null;
            const [aLon, aLat] = oriented[0];
            const [bLon, bLat] = oriented[1];
            const refLatRad = ((aLat + bLat) / 2) * Math.PI / 180;
            const bearingDeg = normalizeHeading((Math.atan2((bLon - aLon) * 111320 * Math.cos(refLatRad), (bLat - aLat) * 110540) * 180) / Math.PI);
            const headingScore = headingDeltaDeg(bearingDeg, intruder.heading);
            return { edgeId, headingScore };
          })
          .filter((v): v is { edgeId: string; headingScore: number } => Boolean(v))
          .sort((a, b) => a.headingScore - b.headingScore);
        const branchLimit = current.depth === 0 ? DANGER_BRANCH_FIRST_NODE_MAX : DANGER_BRANCH_NEXT_NODE_MAX;
        for (const candidate of rankedCandidates.slice(0, branchLimit)) {
          const edgeId = candidate.edgeId;
          if (edgeId === current.fromEdgeId) {
            // Prevent immediate backtracking that creates danger path behind the intruder.
            continue;
          }
          const key = `${current.node}|${edgeId}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const e = edgeById[edgeId];
          if (!e) continue;
          if (e.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) continue;
          const fromStart = e.startNode === current.node;
          const oriented = fromStart ? e.coordinates : [...e.coordinates].reverse();
          const takeLen = Math.min(e.lengthMeters, current.remaining);
          const part = sliceLineByDistanceMeters(oriented, 0, takeLen);
          if (part.length >= 2) {
            const fade = Math.max(0.2, 1 - (current.traveled / Math.max(smoothed, 1)));
            dangerFeatures.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: part },
              properties: { opacity: fade * pulse },
            });
            dangerEdgeIds.add(e.id);
          }
          if (takeLen < e.lengthMeters) continue;
          const nextNode = fromStart ? e.endNode : e.startNode;
          const nextIntersections = current.intersectionsCrossed + ((nodeDegree[nextNode] ?? 0) >= 3 ? 1 : 0);
          if (nextIntersections > DANGER_MAX_INTERSECTIONS) {
            continue;
          }
          const nextTravel = current.traveled + e.lengthMeters;
          const existingNextDist = dangerNodeDist.get(nextNode);
          if (existingNextDist == null || nextTravel < existingNextDist) {
            dangerNodeDist.set(nextNode, nextTravel);
          }
          queue.push({
            node: nextNode,
            remaining: current.remaining - e.lengthMeters,
            traveled: nextTravel,
            fromEdgeId: e.id,
            depth: current.depth + 1,
            intersectionsCrossed: nextIntersections,
          });
        }
      }
      for (const [nodeKey, dist] of dangerNodeDist.entries()) {
        const prev = dangerNodeDistGlobal[nodeKey];
        if (prev == null || dist < prev) {
          dangerNodeDistGlobal[nodeKey] = dist;
        }
      }

      // Feeder roads: incoming edges into forward danger-corridor nodes.
      // We intentionally keep this local (non-recursive) so it marks true approaching branches,
      // not random distant roads behind the network.
      const feederSeen = new Set<string>();
      for (const [seedNode, seedDistOnDanger] of dangerNodeDist.entries()) {
        if (!Number.isFinite(seedDistOnDanger)) continue;
        // Limit feeder warnings to near-term junctions along intruder forward corridor.
        if (seedDistOnDanger > Math.min(smoothed + 1, FEEDER_SEED_MAX_ALONG_M)) continue;
        if ((nodeDegree[seedNode] ?? 0) < 3) continue; // only true intersections/junctions
        const incoming = incomingByNode[seedNode] ?? [];
        for (const hop of incoming) {
          const e = edgeById[hop.edgeId];
          if (!e) continue;
          if (e.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) continue;
          if (dangerEdgeIds.has(e.id)) continue;
          const seenKey = `${seedNode}|${e.id}`;
          if (feederSeen.has(seenKey)) continue;
          feederSeen.add(seenKey);

          feederEdgeIds.add(e.id);
          const oriented = hop.fromNode === e.startNode ? e.coordinates : [...e.coordinates].reverse();
          const firstIntersectionLen = feederLengthToFirstIntersectionFromJunction(oriented, vertexUsageCount);
          const feederLen = Math.min(FEEDER_LOOKBACK_M, FEEDER_MAX_PATH_M, e.lengthMeters, firstIntersectionLen || e.lengthMeters);
          feederDistanceByEdge[e.id] = Math.min(feederDistanceByEdge[e.id] ?? Number.POSITIVE_INFINITY, feederLen);
          feederJunctionAtEndByEdge[e.id] = hop.fromNode === e.startNode;
          feederJunctionIntruderDistByEdge[e.id] = Math.min(
            feederJunctionIntruderDistByEdge[e.id] ?? Number.POSITIVE_INFINITY,
            seedDistOnDanger
          );
          // Draw feeder highlight close to the danger junction (seed node), not at the far end.
          // `oriented` is from feeder side -> seed node, so we slice the tail segment.
          const feederStart = Math.max(0, e.lengthMeters - feederLen);
          const partial = sliceLineByDistanceMeters(oriented, feederStart, e.lengthMeters);
          if (partial.length < 2) continue;
          feederFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: partial },
            properties: {
              opacity: Math.max(0.3, 1 - (feederLen / FEEDER_LOOKBACK_M)) * (0.6 + 0.25 * pulse),
            },
          });
        }
      }

      // Additional feeder rule:
      // If red path stops at first intersection, also warn the straight continuation road from that node.
      // This alerts vehicles approaching that same junction from ahead.
      const continuationCandidates = (undirectedByNode[firstNode] ?? [])
        .filter((edgeId) => edgeId !== edge.id && !dangerEdgeIds.has(edgeId))
        .map((edgeId) => {
          const e = edgeById[edgeId];
          if (!e || e.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) return null;
          const fromStart = e.startNode === firstNode;
          const orientedAwayFromJunction = fromStart ? e.coordinates : [...e.coordinates].reverse();
          if (orientedAwayFromJunction.length < 2) return null;
          const [aLon, aLat] = orientedAwayFromJunction[0];
          const [bLon, bLat] = orientedAwayFromJunction[1];
          const refLatRad = ((aLat + bLat) / 2) * Math.PI / 180;
          const bearingDeg = normalizeHeading((Math.atan2((bLon - aLon) * 111320 * Math.cos(refLatRad), (bLat - aLat) * 110540) * 180) / Math.PI);
          const headingScore = headingDeltaDeg(bearingDeg, intruder.heading);
          return { e, headingScore };
        })
        .filter((v): v is { e: RoadFeatureMeta; headingScore: number } => Boolean(v))
        .sort((a, b) => a.headingScore - b.headingScore);

      const straightCandidate = continuationCandidates[0]?.e;
      if (straightCandidate) {
        const junctionAtEnd = straightCandidate.endNode === firstNode;
        const junctionAtStart = straightCandidate.startNode === firstNode;
        const canApproachJunction =
          straightCandidate.oneway === 'no' ||
          (straightCandidate.oneway === 'yes' && junctionAtEnd) ||
          (straightCandidate.oneway === '-1' && junctionAtStart);
        if (canApproachJunction) {
          feederEdgeIds.add(straightCandidate.id);
          const orientedTowardJunction = junctionAtEnd
            ? straightCandidate.coordinates
            : [...straightCandidate.coordinates].reverse();
          const firstIntersectionLen = feederLengthToFirstIntersectionFromJunction(orientedTowardJunction, vertexUsageCount);
          const feederLen = Math.min(
            FEEDER_LOOKBACK_M,
            FEEDER_MAX_PATH_M,
            straightCandidate.lengthMeters,
            firstIntersectionLen || straightCandidate.lengthMeters
          );
          feederDistanceByEdge[straightCandidate.id] = Math.min(
            feederDistanceByEdge[straightCandidate.id] ?? Number.POSITIVE_INFINITY,
            feederLen
          );
          feederJunctionAtEndByEdge[straightCandidate.id] = junctionAtEnd;
          feederJunctionIntruderDistByEdge[straightCandidate.id] = Math.min(
            feederJunctionIntruderDistByEdge[straightCandidate.id] ?? Number.POSITIVE_INFINITY,
            firstLen
          );
          const feederStart = Math.max(0, straightCandidate.lengthMeters - feederLen);
          const partial = sliceLineByDistanceMeters(orientedTowardJunction, feederStart, straightCandidate.lengthMeters);
          if (partial.length >= 2) {
            feederFeatures.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: partial },
              properties: {
                opacity: Math.max(0.35, 1 - (feederLen / FEEDER_LOOKBACK_M)) * (0.65 + 0.25 * pulse),
              },
            });
          }
        }
      }

      // Geometry-based feeder detection:
      // catches roads visually merging into red corridor even if OSM topology is not perfectly node-linked.
      const dangerCoordsSet = dangerFeatures.map((f) => f.geometry.coordinates as Coord[]);
      for (const e of metas) {
        if (dangerEdgeIds.has(e.id)) continue;
        if (e.lengthMeters < MIN_GRAPH_EDGE_LENGTH_M) continue;

        const startCoord = e.coordinates[0];
        const endCoord = e.coordinates[e.coordinates.length - 1];
        const startToDanger = Math.min(...dangerCoordsSet.map((dc) => distanceFromPointToLineCoordsMeters(startCoord, dc)));
        const endToDanger = Math.min(...dangerCoordsSet.map((dc) => distanceFromPointToLineCoordsMeters(endCoord, dc)));
        const touchesFromStart = startToDanger <= FEEDER_JUNCTION_MATCH_M;
        const touchesFromEnd = endToDanger <= FEEDER_JUNCTION_MATCH_M;
        if (!touchesFromStart && !touchesFromEnd) continue;

        const junctionAtEnd = touchesFromEnd && (!touchesFromStart || endToDanger <= startToDanger);
        const junctionAtStart = touchesFromStart && (!touchesFromEnd || startToDanger < endToDanger);

        // Direction filter: only include directions where traffic can actually approach the danger junction.
        const canApproachJunction =
          e.oneway === 'no' ||
          (e.oneway === 'yes' && junctionAtEnd) ||
          (e.oneway === '-1' && junctionAtStart);
        if (!canApproachJunction) continue;

        feederEdgeIds.add(e.id);
        const orientedTowardJunction = junctionAtEnd ? e.coordinates : [...e.coordinates].reverse();
        const firstIntersectionLen = feederLengthToFirstIntersectionFromJunction(orientedTowardJunction, vertexUsageCount);
        const feederLen = Math.min(FEEDER_LOOKBACK_M, FEEDER_MAX_PATH_M, e.lengthMeters, firstIntersectionLen || e.lengthMeters);
        feederDistanceByEdge[e.id] = Math.min(feederDistanceByEdge[e.id] ?? Number.POSITIVE_INFINITY, feederLen);
        feederJunctionAtEndByEdge[e.id] = junctionAtEnd;
        const junctionNode = junctionAtEnd ? e.endNode : e.startNode;
        if (dangerNodeDistGlobal[junctionNode] != null) {
          feederJunctionIntruderDistByEdge[e.id] = Math.min(
            feederJunctionIntruderDistByEdge[e.id] ?? Number.POSITIVE_INFINITY,
            dangerNodeDistGlobal[junctionNode]
          );
        }
        const feederStart = Math.max(0, e.lengthMeters - feederLen);
        const partial = sliceLineByDistanceMeters(orientedTowardJunction, feederStart, e.lengthMeters);
        if (partial.length < 2) continue;
        feederFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: partial },
          properties: {
            opacity: Math.max(0.35, 1 - (feederLen / FEEDER_LOOKBACK_M)) * (0.65 + 0.25 * pulse),
          },
        });
      }
    }

    const dangerPathData = { type: 'FeatureCollection', features: dangerFeatures } as GeoJSON.FeatureCollection<GeoJSON.LineString>;
    const feederPathData = { type: 'FeatureCollection', features: feederFeatures } as GeoJSON.FeatureCollection<GeoJSON.LineString>;
    const vehicleStateById: Record<string, { state: HazardState; feederDistanceM?: number }> = {};
    const vehicleKinematicsById: Record<string, {
      mapMatchDistanceM: number;
      roadBearingDeg: number;
      vehicleHeadingDeg: number;
      bearingDeltaDeg: number;
      oneway: 'yes' | '-1' | 'no';
    }> = {};
    const intruderList = Array.from(intruderIds)
      .map((id) => vehicles[id])
      .filter((v): v is Telemetry => Boolean(v));

    for (const v of Object.values(vehicles)) {
      if (intruderIds.has(v.vehicleId)) {
        vehicleStateById[v.vehicleId] = { state: 'RED', feederDistanceM: 0 };
        continue;
      }
      const matched = projectToEdgeCached(v);
      if (!matched || matched.distanceMeters > SAME_PATH_MAX_ROAD_DISTANCE_M) {
        vehicleStateById[v.vehicleId] = { state: 'GREEN' };
        continue;
      }
      vehicleKinematicsById[v.vehicleId] = {
        mapMatchDistanceM: matched.distanceMeters,
        roadBearingDeg: matched.segmentBearingDeg,
        vehicleHeadingDeg: normalizeHeading(v.heading),
        bearingDeltaDeg: headingDeltaDeg(v.heading, matched.segmentBearingDeg),
        oneway: matched.edge.oneway,
      };
      let nearestIntruderThreat: { distanceMeters: number; closingSpeedMps: number; intruderId: string } | null = null;
      for (const intr of intruderList) {
        const rel = computeDistanceAndClosing(v, intr);
        if (!nearestIntruderThreat || rel.distanceMeters < nearestIntruderThreat.distanceMeters) {
          nearestIntruderThreat = {
            distanceMeters: rel.distanceMeters,
            closingSpeedMps: rel.closingSpeedMps,
            intruderId: intr.vehicleId,
          };
        }
      }

      const onDangerEdge = dangerEdgeIds.has(matched.edge.id);
      const onFeederEdge = feederEdgeIds.has(matched.edge.id);
      const distanceToDangerPath = distanceToFeatureCollectionMeters(v, dangerPathData);
      const distanceToFeederPath = distanceToFeatureCollectionMeters(v, feederPathData);
      if (
        (onDangerEdge || onFeederEdge) &&
        nearestIntruderThreat &&
        nearestIntruderThreat.closingSpeedMps > 0 &&
        (distanceToDangerPath <= SAME_PATH_MAX_ROAD_DISTANCE_M || distanceToFeederPath <= SAME_PATH_MAX_ROAD_DISTANCE_M)
      ) {
        // Impact-based hazard: on danger/feeder corridor and intruder trajectory is approaching.
        // This is graph/path driven, not plain radial range.
        let d = Math.round(nearestIntruderThreat.distanceMeters);
        if (onFeederEdge) {
          const junctionAtEnd = feederJunctionAtEndByEdge[matched.edge.id] !== false;
          const alongToJunction = junctionAtEnd
            ? Math.max(0, matched.edge.lengthMeters - matched.distanceAlongMeters)
            : Math.max(0, matched.distanceAlongMeters);
          const feederCap = feederDistanceByEdge[matched.edge.id] ?? FEEDER_MAX_PATH_M;
          const intruderToJunction = feederJunctionIntruderDistByEdge[matched.edge.id] ?? 0;
          d = Math.round(Math.min(alongToJunction, feederCap) + intruderToJunction);
        } else if (onDangerEdge) {
          const intruder = vehicles[nearestIntruderThreat.intruderId];
          const intruderMatched = intruder ? projectToEdgeCached(intruder) : null;
          if (intruderMatched && intruderMatched.edge.id === matched.edge.id) {
            d = Math.round(Math.abs(intruderMatched.distanceAlongMeters - matched.distanceAlongMeters));
          } else {
            const viaStart = dangerNodeDistGlobal[matched.edge.startNode] != null
              ? matched.distanceAlongMeters + dangerNodeDistGlobal[matched.edge.startNode]
              : Number.POSITIVE_INFINITY;
            const viaEnd = dangerNodeDistGlobal[matched.edge.endNode] != null
              ? (matched.edge.lengthMeters - matched.distanceAlongMeters) + dangerNodeDistGlobal[matched.edge.endNode]
              : Number.POSITIVE_INFINITY;
            const graphDist = Math.min(viaStart, viaEnd);
            d = Number.isFinite(graphDist) ? Math.round(graphDist) : Math.round(nearestIntruderThreat.distanceMeters);
          }
        }
        vehicleStateById[v.vehicleId] = { state: 'YELLOW', feederDistanceM: Math.max(0, Math.round(d)) };
        continue;
      }
      vehicleStateById[v.vehicleId] = { state: 'GREEN' };
    }

    return {
      dangerPathData,
      feederPathData,
      vehicleStateById,
      vehicleKinematicsById,
      intruderIds,
    };
  }, [alerts, vehicles, networkData, nowMs]);

  const focusDashboard = useMemo(() => {
    if (!focusedVehicle) return null;
    const signal = computeSignalLabel(focusedVehicle.timestamp, nowMs);
    const headingLabel = headingToCompass(focusedVehicle.heading);
    const anomalyType = alerts[focusedVehicle.vehicleId]?.type ?? 'SAFE';
    const hazardState = hazardOverlay.vehicleStateById[focusedVehicle.vehicleId]?.state ?? 'GREEN';
    const feederDistanceM = hazardOverlay.vehicleStateById[focusedVehicle.vehicleId]?.feederDistanceM;
    const kinematics = hazardOverlay.vehicleKinematicsById[focusedVehicle.vehicleId];

    let nearestIntruder: {
      vehicleId: string;
      distanceMeters: number;
      closingSpeedMps: number;
      ttiSeconds: number;
    } | undefined;
    for (const [id, a] of Object.entries(alerts)) {
      if (a.type !== 'DANGER' || !vehicles[id] || id === focusedVehicle.vehicleId) continue;
      const intr = vehicles[id];
      const rel = computeDistanceAndClosing(focusedVehicle, intr);
      if (!nearestIntruder || rel.distanceMeters < nearestIntruder.distanceMeters) {
        nearestIntruder = {
          vehicleId: id,
          distanceMeters: rel.distanceMeters,
          closingSpeedMps: rel.closingSpeedMps,
          ttiSeconds: rel.closingSpeedMps > 0 ? rel.distanceMeters / rel.closingSpeedMps : Number.POSITIVE_INFINITY,
        };
      }
    }

    return {
      speedKmh: Math.round(focusedVehicle.speedKmh),
      signal,
      headingLabel,
      anomalyType,
      hazardState,
      feederDistanceM,
      kinematics,
      nearestIntruder,
    };
  }, [focusedVehicle, nowMs, hazardOverlay, alerts, vehicles]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !focusedVehicleId) return;

    const hazardState = focusDashboard?.hazardState ?? 'GREEN';
    const anomalyType = focusDashboard?.anomalyType ?? 'SAFE';
    const distanceM = focusDashboard?.nearestIntruder?.distanceMeters
      ?? focusDashboard?.feederDistanceM
      ?? null;
    const ttiSeconds = focusDashboard?.nearestIntruder?.ttiSeconds ?? null;
    const headingDeltaDeg = focusDashboard?.kinematics?.bearingDeltaDeg ?? null;
    const mode: 'SAFE' | 'WARN' | 'DANGER' = (
      anomalyType === 'DANGER'
        ? 'DANGER'
        : (hazardState === 'YELLOW' || anomalyType === 'MONITORING' ? 'WARN' : 'SAFE')
    );

    const payload = {
      type: 'HARDWARE_DRIVER_ALERT',
      payload: {
        vehicleId: focusedVehicleId,
        mode,
        distanceM,
        ttiSeconds,
        headingDeltaDeg,
        message: mode === 'DANGER'
          ? 'Wrong-way threat close by.'
          : (mode === 'WARN' ? 'Hazard approaching.' : 'Road clear.'),
      },
    };

    const serialized = JSON.stringify(payload);
    if (serialized === lastHardwareAlertPayloadRef.current) return;
    lastHardwareAlertPayloadRef.current = serialized;
    ws.send(serialized);
  }, [focusedVehicleId, focusDashboard]);

  const getVehicleUiState = (vehicleId: string) => {
    const anomalyType = alerts[vehicleId]?.type ?? 'SAFE';
    const hazardState = hazardOverlay.vehicleStateById[vehicleId]?.state ?? 'GREEN';
    const anomalyConfidence = alerts[vehicleId]?.confidenceScore ?? 0;

    if (anomalyType === 'DANGER') {
      return {
        markerColor: '#ef4444',
        markerClass: 'drop-shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse',
        badgeClass: 'bg-red-500/20 text-red-400',
        label: 'WRONG-WAY',
        meterClass: 'bg-red-500',
        meterWidth: 100,
        subtext: `${Math.max(1, anomalyConfidence)}% anomaly`,
      };
    }
    if (anomalyType === 'MONITORING') {
      return {
        markerColor: '#eab308',
        markerClass: 'drop-shadow-[0_0_8px_rgba(234,179,8,0.7)]',
        badgeClass: 'bg-yellow-500/20 text-yellow-400',
        label: 'ANOMALY WATCH',
        meterClass: 'bg-yellow-500',
        meterWidth: Math.max(20, anomalyConfidence),
        subtext: `${Math.max(1, anomalyConfidence)}% anomaly`,
      };
    }
    if (hazardState === 'YELLOW') {
      return {
        markerColor: '#f59e0b',
        markerClass: 'drop-shadow-[0_0_8px_rgba(245,158,11,0.7)]',
        badgeClass: 'bg-orange-500/20 text-orange-300',
        label: 'HAZARD AHEAD',
        meterClass: 'bg-orange-500',
        meterWidth: 45,
        subtext: 'feeder-corridor alert',
      };
    }
    return {
      markerColor: '#4ade80',
      markerClass: '',
      badgeClass: 'bg-green-500/20 text-green-400',
      label: 'SAFE',
      meterClass: 'bg-green-500',
      meterWidth: 10,
      subtext: 'normal',
    };
  };

  const constructionZoneData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon>>(() => ({
    type: 'FeatureCollection',
    features: constructionZones,
  }), [constructionZones]);

  const constructionDraftPolygon = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon>>(() => {
    const draft = toConstructionZoneFeature({
      id: 'draft-zone',
      coordinates: draftConstructionZonePoints,
      active: true,
      name: 'Draft',
    });
    return {
      type: 'FeatureCollection',
      features: draft ? [draft] : [],
    };
  }, [draftConstructionZonePoints]);

  const constructionDraftLine = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString>>(() => ({
    type: 'FeatureCollection',
    features: draftConstructionZonePoints.length >= 2
      ? [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: draftConstructionZonePoints },
        properties: {},
      }]
      : [],
  }), [draftConstructionZonePoints]);

  return (
    <div className="w-full h-screen flex relative bg-zinc-900">
      <div className="w-3/4 h-full relative">
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2 w-[95%] max-w-5xl">
          <div className="w-full grid grid-cols-5 gap-2 bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 rounded-xl p-2 shadow-lg">
            <div className="rounded-lg bg-zinc-900/70 border border-zinc-800 px-3 py-2">
              <div className="text-[11px] uppercase text-zinc-500">Vehicles Monitored</div>
              <div className="text-white font-semibold">{vehicleList.length}</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 border border-zinc-800 px-3 py-2">
              <div className="text-[11px] uppercase text-zinc-500">Wrong-Way Events</div>
              <div className="text-red-400 font-semibold">{stats.wrongWayEvents}</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 border border-zinc-800 px-3 py-2">
              <div className="text-[11px] uppercase text-zinc-500">Alerts Sent</div>
              <div className="text-yellow-400 font-semibold">{stats.alertsSent}</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 border border-zinc-800 px-3 py-2">
              <div className="text-[11px] uppercase text-zinc-500">Avg Response</div>
              <div className="text-blue-300 font-semibold">{Math.max(0, Math.round(stats.avgResponseTimeMs))} ms</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 border border-zinc-800 px-3 py-2">
              <div className="text-[11px] uppercase text-zinc-500">False Positives</div>
              <div className="text-emerald-400 font-semibold">{stats.falsePositives}</div>
            </div>
          </div>
          {isSelectingPoints && (
            <div className="bg-purple-600/90 text-white px-6 py-2 rounded-full font-semibold shadow-lg shadow-purple-900/30 backdrop-blur-sm border border-purple-400/30 animate-pulse">
              {selectedPoints.length === 0 ? "Click to set Start Point (A)" : "Click to set End Point (B)"}
            </div>
          )}
          {isDrawingConstructionZone && (
            <div className="bg-amber-600/90 text-white px-6 py-2 rounded-full font-semibold shadow-lg shadow-amber-900/30 backdrop-blur-sm border border-amber-400/30">
              Construction Override draw mode: click map to add polygon points ({draftConstructionZonePoints.length} points)
            </div>
          )}
          <button 
            onClick={scanCurrentArea}
            disabled={isInitializingSession || isScanning || !mapLoaded || isSelectingPoints || isDrawingConstructionZone}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-600 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-full shadow-lg shadow-blue-900/30 transition-all border border-blue-400/30 backdrop-blur-sm cursor-pointer pointer-events-auto"
          >
            {isScanning ? <Loader2 className="animate-spin" size={20} /> : <ScanSearch size={20} />}
            {isScanning ? 'Loading Area...' : 'Choose This Area'}
          </button>
          {isScanning && scanProgressText && (
            <div className="bg-zinc-950/90 border border-zinc-700 text-zinc-200 px-4 py-2 rounded-lg text-sm">
              {scanProgressText}
            </div>
          )}
          {isInitializingSession && (
            <div className="bg-zinc-950/90 border border-zinc-700 text-zinc-200 px-4 py-2 rounded-lg text-sm">
              Initializing session...
            </div>
          )}
          {!hasNetwork && (
            <div className="bg-zinc-950/90 border border-zinc-700 text-zinc-200 px-4 py-2 rounded-lg text-sm">
              Step 1: Move map to your target region, then click <span className="font-semibold">Choose This Area</span>.
            </div>
          )}
        </div>

        <MapView
          ref={onMapRef}
          onLoad={(e) => {
            if (!mapRef.current) {
              (mapRef as React.MutableRefObject<MapRef | null>).current = e.target as unknown as MapRef;
              setMapLoaded(true);
            }
          }}
          initialViewState={{
            longitude: 77.64,
            latitude: 12.93,
            zoom: 14
          }}
          mapStyle={MAP_STYLE}
          onClick={handleMapClick}
          cursor={(isSelectingPoints || isDrawingConstructionZone) ? 'crosshair' : 'grab'}
        >
          {/* Render Selected Points */}
          {selectedPoints.map((pt, i) => (
            <Marker key={`pt-${i}`} longitude={pt[0]} latitude={pt[1]}>
              <MapPin size={32} color={i === 0 ? '#3b82f6' : '#a855f7'} className="-translate-y-1/2 drop-shadow-md" />
            </Marker>
          ))}
          {draftConstructionZonePoints.map((pt, i) => (
            <Marker key={`co-draft-pt-${i}`} longitude={pt[0]} latitude={pt[1]}>
              <MapPin size={24} color="#f59e0b" className="-translate-y-1/2 drop-shadow-md" />
            </Marker>
          ))}
          {/* Render Road Network */}
          {networkData && (
            <Source id="road-network" type="geojson" data={networkData}>
              <Layer
                id="roads"
                type="line"
                paint={{
                  'line-color': '#4a5568',
                  'line-width': 3,
                  'line-opacity': 0.5
                }}
              />
            </Source>
          )}

          {/* Danger path: red road-aligned forward corridors */}
          {hazardOverlay.dangerPathData.features.length > 0 && (
            <Source id="alert-corridors" type="geojson" data={hazardOverlay.dangerPathData}>
              <Layer
                id="alert-corridor-line"
                type="line"
                paint={{
                  'line-color': '#ef4444',
                  'line-width': 6,
                  'line-opacity': ['coalesce', ['get', 'opacity'], 0.85],
                }}
              />
            </Source>
          )}
          {/* Feeder roads: dashed orange upstream warnings */}
          {hazardOverlay.feederPathData.features.length > 0 && (
            <Source id="feeder-corridors" type="geojson" data={hazardOverlay.feederPathData}>
              <Layer
                id="feeder-corridor-line"
                type="line"
                paint={{
                  'line-color': '#fbbf24',
                  'line-width': 5,
                  'line-opacity': ['coalesce', ['get', 'opacity'], 0.8],
                  'line-dasharray': [1.2, 1.6],
                }}
              />
            </Source>
          )}
          {constructionZoneData.features.length > 0 && (
            <Source id="construction-zones" type="geojson" data={constructionZoneData}>
              <Layer
                id="construction-zone-fill"
                type="fill"
                paint={{
                  'fill-color': isConstructionOverrideActive ? '#f59e0b' : '#78716c',
                  'fill-opacity': 0.22,
                }}
              />
              <Layer
                id="construction-zone-outline"
                type="line"
                paint={{
                  'line-color': isConstructionOverrideActive ? '#f59e0b' : '#a8a29e',
                  'line-width': 3,
                  'line-opacity': 0.95,
                }}
              />
            </Source>
          )}
          {constructionDraftLine.features.length > 0 && (
            <Source id="construction-zone-draft-line" type="geojson" data={constructionDraftLine}>
              <Layer
                id="construction-zone-draft-line-layer"
                type="line"
                paint={{
                  'line-color': '#fbbf24',
                  'line-width': 3,
                  'line-dasharray': [1.2, 1.4],
                }}
              />
            </Source>
          )}
          {constructionDraftPolygon.features.length > 0 && (
            <Source id="construction-zone-draft-polygon" type="geojson" data={constructionDraftPolygon}>
              <Layer
                id="construction-zone-draft-fill"
                type="fill"
                paint={{
                  'fill-color': '#fbbf24',
                  'fill-opacity': 0.15,
                }}
              />
            </Source>
          )}

          {/* Render Vehicles */}
          {vehicleList.map((v) => {
            const ui = getVehicleUiState(v.vehicleId);
            // Only render vehicles within a certain bounding box if we want to limit, 
            // but the simulator spawns them within the view.
            return (
              <Marker
                key={v.vehicleId}
                longitude={v.lon}
                latitude={v.lat}
                anchor="center"
                onClick={(event) => {
                  event.originalEvent.stopPropagation();
                  focusVehicleOnMap(v);
                }}
                style={{ transition: 'all 200ms linear' }}
              >
                <div
                  className={`transition-all duration-200 ease-linear`}
                  style={{ transform: `rotate(${v.heading}deg)` }}
                >
                  <Car 
                    size={24} 
                    color={ui.markerColor}
                    className={ui.markerClass}
                  />
                </div>
              </Marker>
            );
          })}
        </MapView>
      </div>

      {/* Telemetry Panel */}
      <div className="w-1/4 h-full bg-zinc-950 border-l border-zinc-800 p-6 flex flex-col gap-4 overflow-y-auto">
        <h1 className="text-2xl font-bold text-white mb-2 flex items-center gap-2">
          <ShieldAlert className="text-red-500" />
          V2X Control Center
        </h1>
        
        <div className="flex flex-col gap-2 p-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
          <h2 className="text-zinc-400 uppercase text-xs font-semibold tracking-wider mb-1">Simulation Mode</h2>
          <div className="text-[11px] text-zinc-500">
            {!hasNetwork ? 'Choose area first' : (simulationActive ? 'Simulation running' : 'Configured, waiting to start')}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => toggleSimMode('RANDOM')}
              disabled={isInitializingSession || !hasNetwork || isStartingSimulation || isDrawingConstructionZone || csvReplayStatus.running}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                simMode === 'RANDOM' 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              <Shuffle size={16} />
              Random
            </button>
            <button
              onClick={() => toggleSimMode('SPECIFIC_PATH')}
              disabled={isInitializingSession || !hasNetwork || isStartingSimulation || isDrawingConstructionZone || csvReplayStatus.running}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-medium text-sm transition-all ${
                simMode === 'SPECIFIC_PATH' || isSelectingPoints
                  ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/20' 
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              <Route size={16} />
              {isSelectingPoints ? 'Selecting...' : 'Specific Path'}
            </button>
          </div>
          {(simMode === 'SPECIFIC_PATH' || isSelectingPoints) && (
            <>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={specificPathVehicleCount}
                  onChange={(e) => setSpecificPathVehicleCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-24 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
                />
                <button
                  type="button"
                  onClick={applySpecificPathVehicleCount}
                  disabled={simMode !== 'SPECIFIC_PATH' || isSelectingPoints || isApplyingSpecificCount}
                  className="flex-1 bg-purple-700 hover:bg-purple-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
                >
                  {isApplyingSpecificCount ? 'Applying...' : 'Apply Specific Count'}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">Specific-path only: choose how many cars spawn on the selected route.</p>
            </>
          )}
          <button
            type="button"
            onClick={startSimulationNow}
            disabled={
              !hasNetwork ||
              isInitializingSession ||
              isSelectingPoints ||
              isDrawingConstructionZone ||
              isStartingSimulation ||
              isStoppingSimulation ||
              csvReplayStatus.running ||
              (simMode === 'SPECIFIC_PATH' && selectedPoints.length < 2)
            }
            className="mt-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
          >
            {isStartingSimulation ? 'Starting...' : (simulationActive ? 'Restart Simulation' : 'Start Simulation')}
          </button>
          <button
            type="button"
            onClick={stopSimulationNow}
            disabled={!simulationActive || isStoppingSimulation || isStartingSimulation}
            className="mt-1 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
          >
            {isStoppingSimulation ? 'Stopping...' : 'Stop Simulation'}
          </button>
          {simMode === 'SPECIFIC_PATH' && selectedPoints.length < 2 && (
            <p className="text-[11px] text-zinc-500">Select A and B points on map, then start simulation.</p>
          )}
        </div>

        <div className="flex flex-col gap-2 p-4 bg-zinc-900/50 rounded-xl border border-zinc-800">
          <h2 className="text-zinc-400 uppercase text-xs font-semibold tracking-wider mb-1">Construction Override</h2>
          <div className="text-[11px] text-zinc-500">
            {isConstructionOverrideActive ? 'Suppression enabled inside zones' : 'Suppression disabled'}
          </div>
          <button
            type="button"
            onClick={toggleConstructionOverrideActive}
            disabled={isDrawingConstructionZone}
            className={`py-2 px-3 rounded-lg text-sm font-semibold transition-colors ${
              isConstructionOverrideActive
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
            } disabled:bg-zinc-800 disabled:text-zinc-500`}
          >
            {isConstructionOverrideActive ? 'Disable Override' : 'Enable Override'}
          </button>
          {!isDrawingConstructionZone && (
            <button
              type="button"
              onClick={startConstructionZoneDrawing}
              disabled={!hasNetwork}
              className="py-2 px-3 rounded-lg text-sm font-semibold bg-amber-700 hover:bg-amber-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white transition-colors"
            >
              Draw New Zone
            </button>
          )}
          {isDrawingConstructionZone && (
            <div className="mt-1 flex flex-col gap-2">
              <div className="text-xs text-amber-300">
                Click map to place vertices. Add at least 3 points, then save.
              </div>
              <div className="text-[11px] text-zinc-500">
                Current vertices: {draftConstructionZonePoints.length}
              </div>
              <input
                type="text"
                value={constructionZoneName}
                onChange={(e) => setConstructionZoneName(e.target.value)}
                placeholder="Zone name (optional)"
                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
              />
              <input
                type="text"
                value={constructionZoneReason}
                onChange={(e) => setConstructionZoneReason(e.target.value)}
                placeholder="Reason (optional)"
                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveConstructionZone}
                  disabled={draftConstructionZonePoints.length < 3 || isSavingConstructionZone}
                  className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
                >
                  {isSavingConstructionZone ? 'Saving...' : 'Save Zone'}
                </button>
                <button
                  type="button"
                  onClick={() => setDraftConstructionZonePoints((prev) => prev.slice(0, -1))}
                  disabled={draftConstructionZonePoints.length === 0 || isSavingConstructionZone}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
                >
                  Undo Point
                </button>
                <button
                  type="button"
                  onClick={cancelConstructionZoneDrawing}
                  disabled={isSavingConstructionZone}
                  className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="mt-1 flex flex-col gap-1 max-h-36 overflow-y-auto">
            {constructionZones.length === 0 && (
              <div className="text-[11px] text-zinc-500">No zones created yet.</div>
            )}
            {constructionZones.map((zone) => (
              <div key={zone.properties.id} className="flex items-center justify-between gap-2 rounded bg-zinc-950/60 border border-zinc-800 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="text-xs text-zinc-200 truncate">
                    {zone.properties.name?.trim() || zone.properties.id}
                  </div>
                  {zone.properties.reason && (
                    <div className="text-[10px] text-zinc-500 truncate">{zone.properties.reason}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeConstructionZone(zone.properties.id)}
                  className="text-[11px] px-2 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-900/60"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>

        <button 
          onClick={injectIntruder}
          disabled={!simulationActive || isDrawingConstructionZone}
          className="bg-red-600 hover:bg-red-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-bold py-3 rounded-lg transition-colors shadow-lg shadow-red-900/20 mt-2"
        >
          Inject Intruder
        </button>

        <div className="p-4 bg-zinc-900/50 rounded-xl border border-zinc-800 flex flex-col gap-2">
          <h2 className="text-zinc-400 uppercase text-xs font-semibold tracking-wider">CSV Replay</h2>
          <div className="text-[11px] text-zinc-500">
            {csvReplayStatus.running
              ? `Running: ${csvReplayStatus.cursor}/${csvReplayStatus.totalRows}`
              : 'Load historical telemetry and replay it live'}
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onCsvFileSelected}
            className="text-xs text-zinc-300 file:mr-2 file:rounded file:border-0 file:bg-zinc-700 file:px-2 file:py-1 file:text-zinc-200"
          />
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder="vehicleId,timestamp,lat,lon,heading,speedKmh&#10;car-1,1710000000000,12.93,77.64,90,42"
            className="h-24 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 resize-y"
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-400">Speed x</label>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={csvSpeedMultiplier}
              onChange={(e) => setCsvSpeedMultiplier(Math.max(0.1, Number(e.target.value) || 1))}
              className="w-20 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={startCsvReplayNow}
              disabled={isStartingCsvReplay || isStoppingCsvReplay || !csvText.trim()}
              className="flex-1 bg-emerald-700 hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
            >
              {isStartingCsvReplay ? 'Starting...' : 'Start Replay'}
            </button>
            <button
              type="button"
              onClick={stopCsvReplayNow}
              disabled={!csvReplayStatus.running || isStoppingCsvReplay}
              className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white rounded px-3 py-1.5 text-sm font-medium"
            >
              {isStoppingCsvReplay ? 'Stopping...' : 'Stop Replay'}
            </button>
          </div>
        </div>

        <div className="mt-2 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-zinc-300 text-sm font-semibold">Follow Car Dashboard</h2>
            <button
              type="button"
              onClick={() => setIsFollowCam((prev) => !prev)}
              disabled={!focusedVehicle}
              className={`text-xs px-2 py-1 rounded ${
                isFollowCam ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-300'
              } disabled:bg-zinc-800/70 disabled:text-zinc-500`}
            >
              {isFollowCam ? 'Follow ON' : 'Follow OFF'}
            </button>
          </div>
          {!focusedVehicle && (
            <div className="text-xs text-zinc-500">Select a car from map/list to view live perspective metrics.</div>
          )}
          {focusedVehicle && focusDashboard && (
            <div className="text-sm text-zinc-300 space-y-1">
              <div>Speed: {focusDashboard.speedKmh} kmph</div>
              <div>Signal: {focusDashboard.signal}</div>
              <div>Heading: {focusDashboard.headingLabel}</div>
              {focusDashboard.kinematics && (
                <>
                  <div>Bearing delta: {Math.round(focusDashboard.kinematics.bearingDeltaDeg)}°</div>
                  <div className="text-xs text-zinc-500">
                    Road {Math.round(focusDashboard.kinematics.roadBearingDeg)}° vs Vehicle {Math.round(focusDashboard.kinematics.vehicleHeadingDeg)}°
                  </div>
                  <div className="text-xs text-zinc-500">
                    Match offset: {Math.max(0, Math.round(focusDashboard.kinematics.mapMatchDistanceM))}m | Oneway: {focusDashboard.kinematics.oneway}
                  </div>
                </>
              )}
              {focusDashboard.anomalyType === 'SAFE' && focusDashboard.hazardState === 'GREEN' && (
                <div className="text-emerald-400 font-semibold">Status: ALL CLEAR</div>
              )}
              {focusDashboard.anomalyType === 'MONITORING' && (
                <>
                  <div className="text-yellow-400 font-semibold">Status: ANOMALY WATCH (SELF)</div>
                  <div>Vehicle behavior is inconsistent with road direction.</div>
                </>
              )}
              {focusDashboard.anomalyType === 'SAFE' && focusDashboard.hazardState === 'YELLOW' && (
                <>
                  <div className="text-yellow-400 font-semibold">Status: HAZARD AHEAD</div>
                  <div>Wrong-way vehicle on connected feeder corridor</div>
                  <div>Distance to danger: {Math.max(1, Math.round(focusDashboard.feederDistanceM ?? FEEDER_LOOKBACK_M))}m</div>
                  <div>Alert cadence: {(focusDashboard.feederDistanceM ?? FEEDER_LOOKBACK_M) > 300 ? '1 beep / 3s' : '1 beep / 1s'}</div>
                </>
              )}
              {focusDashboard.anomalyType === 'DANGER' && (
                <>
                  <div className="text-red-400 font-semibold">Status: WRONG-WAY VEHICLE DETECTED</div>
                  {focusDashboard.nearestIntruder && (
                    <>
                      <div>Distance: {Math.round(focusDashboard.nearestIntruder.distanceMeters)}m and closing</div>
                      <div>Time to impact: {Math.max(1, Math.round(focusDashboard.nearestIntruder.ttiSeconds))} seconds</div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-300 flex flex-col gap-1">
          <div className="font-semibold text-zinc-200">Hazard Guide</div>
          <div><span className="text-red-400 font-semibold">WRONG-WAY</span>: intruder moving opposite one-way direction (high confidence).</div>
          <div><span className="text-yellow-400 font-semibold">ANOMALY WATCH</span>: heading mismatch is building confidence.</div>
          <div><span className="text-orange-300 font-semibold">HAZARD AHEAD</span>: feeder corridor risk from a nearby intruder route.</div>
          <div className="text-zinc-500">Rule of thumb: one-way wrong-way is usually large bearing delta (around 120°+).</div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <h2 className="text-zinc-400 uppercase text-sm font-semibold tracking-wider">Live Telemetry</h2>
          {vehicleList.map(vehicle => {
            const ui = getVehicleUiState(vehicle.vehicleId);
            const isFocused = focusedVehicleId === vehicle.vehicleId;
            const kinematics = hazardOverlay.vehicleKinematicsById[vehicle.vehicleId];
            return (
            <button
              type="button"
              role="listitem"
              key={vehicle.vehicleId}
              onClick={() => focusVehicleOnMap(vehicle)}
              className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                ui.label === 'WRONG-WAY'
                  ? 'bg-red-950/30 border-red-800/50 hover:bg-red-950/45'
                  : ((ui.label === 'ANOMALY WATCH' || ui.label === 'HAZARD AHEAD')
                    ? 'bg-yellow-950/20 border-yellow-800/40 hover:bg-yellow-950/35'
                    : 'bg-zinc-900/50 border-zinc-800 hover:bg-zinc-800/80')
              } ${isFocused ? 'ring-2 ring-blue-500/70' : 'ring-0'}`}
              title="Focus this vehicle on map"
            >
              <div className="flex justify-between items-center mb-2">
                <span className="font-mono text-sm text-zinc-300">{vehicle.vehicleId}</span>
                <span className={`text-xs font-bold px-2 py-1 rounded ${ui.badgeClass}`}>{ui.label}</span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 mb-1">
                <div 
                  className={`h-2.5 rounded-full ${ui.meterClass}`} 
                  style={{ width: `${ui.meterWidth}%` }}
                ></div>
              </div>
              <div className="text-xs text-zinc-500 flex justify-between">
                <span>Speed: {Math.round(vehicle.speedKmh)} km/h</span>
                <span>{ui.subtext}</span>
              </div>
              {kinematics && (
                <div className="mt-1 text-[11px] text-zinc-500 flex justify-between">
                  <span>delta {Math.round(kinematics.bearingDeltaDeg)}°</span>
                  <span>road {Math.round(kinematics.roadBearingDeg)}° / car {Math.round(kinematics.vehicleHeadingDeg)}°</span>
                </div>
              )}
              {kinematics && (
                <div className="text-[11px] text-zinc-600 flex justify-between">
                  <span>match {Math.max(0, Math.round(kinematics.mapMatchDistanceM))}m</span>
                  <span>oneway {kinematics.oneway}</span>
                </div>
              )}
            </button>
            );
          })}
          {vehicleList.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-8 border border-dashed border-zinc-800 rounded-xl">
              All vehicles nominal. No anomalies detected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MapDashboard;
