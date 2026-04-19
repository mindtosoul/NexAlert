import { point, nearestPointOnLine, bearing, destination, polygon, booleanPointInPolygon } from '@turf/turf';
import { FeatureCollection, LineString } from 'geojson';
import { TelemetryPayload, IntruderAlert, ConstructionOverrideState, ConstructionOverrideZone } from '../types.js';
import { broadcast } from '../server.js';
import { performance } from 'node:perf_hooks';

// In-memory state
let roadNetwork: FeatureCollection<LineString> | null = null;

const MAP_MATCH_MAX_DISTANCE_KM = Number(process.env.MAP_MATCH_MAX_DISTANCE_KM ?? 0.05);
const WRONG_WAY_DELTA_ONEWAY_DEG = Number(process.env.WRONG_WAY_DELTA_ONEWAY_DEG ?? 120);
const WRONG_WAY_DELTA_REVERSE_MAX_DEG = Number(process.env.WRONG_WAY_DELTA_REVERSE_MAX_DEG ?? 60);
const ANOMALY_STREAK_FOR_DANGER = Math.max(1, Number(process.env.ANOMALY_STREAK_FOR_DANGER ?? 3));
const CONE_LENGTH_KM = Number(process.env.CONE_LENGTH_KM ?? 1.0);
const CONE_SPREAD_DEGREES = Number(process.env.CONE_SPREAD_DEGREES ?? 30);
const DANGER_CONE_UPDATE_INTERVAL_MS = Math.max(50, Number(process.env.DANGER_CONE_UPDATE_INTERVAL_MS ?? 250));

type AlertState = 'SAFE' | 'MONITORING' | 'DANGER';

interface VehicleDetectionState {
  consecutiveAnomalies: number;
  lastAlertState: AlertState;
  lastDangerBroadcastAtMs?: number;
}

interface DetectionStats {
  wrongWayEvents: number;
  alertsSent: number;
  falsePositives: number;
  suppressedAlerts: number;
  processedTelemetryCount: number;
  totalProcessingMs: number;
}

const vehicleState = new Map<string, VehicleDetectionState>();
const seenVehicleIds = new Set<string>();
const detectionStats: DetectionStats = {
  wrongWayEvents: 0,
  alertsSent: 0,
  falsePositives: 0,
  suppressedAlerts: 0,
  processedTelemetryCount: 0,
  totalProcessingMs: 0,
};

const constructionOverrideState: ConstructionOverrideState = {
  active: false,
  zones: [],
  updatedAt: Date.now(),
};

// Expose a way to set the network after fetching
export const setRoadNetwork = (network: FeatureCollection<LineString>) => {
  roadNetwork = network;
};

export const resetDetectionStats = () => {
  detectionStats.wrongWayEvents = 0;
  detectionStats.alertsSent = 0;
  detectionStats.falsePositives = 0;
  detectionStats.suppressedAlerts = 0;
  detectionStats.processedTelemetryCount = 0;
  detectionStats.totalProcessingMs = 0;
  seenVehicleIds.clear();
};

export const recordDetectionFeedback = (feedback: 'false_positive' | 'confirmed') => {
  if (feedback === 'false_positive') {
    detectionStats.falsePositives += 1;
  }
};

export const getDetectionStats = () => {
  const avgResponseTimeMs = detectionStats.processedTelemetryCount > 0
    ? detectionStats.totalProcessingMs / detectionStats.processedTelemetryCount
    : 0;

  return {
    wrongWayEvents: detectionStats.wrongWayEvents,
    alertsSent: detectionStats.alertsSent,
    falsePositives: detectionStats.falsePositives,
    suppressedAlerts: detectionStats.suppressedAlerts,
    avgResponseTimeMs,
    vehiclesMonitored: seenVehicleIds.size,
    processedTelemetryCount: detectionStats.processedTelemetryCount,
  };
};

const normalizeZoneCoordinates = (coordinates: [number, number][]) => {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return null;
  const filtered = coordinates.filter((c) => (
    Array.isArray(c) &&
    c.length === 2 &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    c[1] >= -90 &&
    c[1] <= 90 &&
    c[0] >= -180 &&
    c[0] <= 180
  )) as [number, number][];
  if (filtered.length < 3) return null;
  const [firstLon, firstLat] = filtered[0];
  const [lastLon, lastLat] = filtered[filtered.length - 1];
  const closed = (firstLon === lastLon && firstLat === lastLat)
    ? filtered
    : [...filtered, filtered[0]];
  return closed;
};

const pointInsideConstructionZone = (lon: number, lat: number) => {
  if (!constructionOverrideState.active || constructionOverrideState.zones.length === 0) {
    return null;
  }

  const vehiclePoint = point([lon, lat]);
  for (const zone of constructionOverrideState.zones) {
    if (!zone.active) continue;
    const ring = normalizeZoneCoordinates(zone.coordinates);
    if (!ring) continue;
    const zonePolygon = polygon([ring]);
    if (booleanPointInPolygon(vehiclePoint, zonePolygon)) {
      return zone;
    }
  }
  return null;
};

export const getConstructionOverrideState = () => constructionOverrideState;

export const setConstructionOverrideActive = (active: boolean) => {
  constructionOverrideState.active = active;
  constructionOverrideState.updatedAt = Date.now();
  return constructionOverrideState;
};

export const upsertConstructionOverrideZone = (input: {
  id?: string;
  name?: string;
  coordinates: [number, number][];
  active?: boolean;
  reason?: string;
}) => {
  const now = Date.now();
  const ring = normalizeZoneCoordinates(input.coordinates);
  if (!ring) {
    throw new Error('Construction override polygon needs at least 3 valid points.');
  }

  const zoneId = input.id?.trim() || `co-${now}`;
  const nextZone: ConstructionOverrideZone = {
    id: zoneId,
    name: input.name?.trim() || undefined,
    coordinates: ring,
    active: input.active ?? true,
    reason: input.reason?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  const existingIndex = constructionOverrideState.zones.findIndex((z) => z.id === zoneId);
  if (existingIndex >= 0) {
    nextZone.createdAt = constructionOverrideState.zones[existingIndex].createdAt;
    constructionOverrideState.zones[existingIndex] = nextZone;
  } else {
    constructionOverrideState.zones.push(nextZone);
  }
  constructionOverrideState.updatedAt = now;
  return nextZone;
};

export const removeConstructionOverrideZone = (zoneId: string) => {
  const before = constructionOverrideState.zones.length;
  constructionOverrideState.zones = constructionOverrideState.zones.filter((z) => z.id !== zoneId);
  const removed = constructionOverrideState.zones.length !== before;
  if (removed) {
    constructionOverrideState.updatedAt = Date.now();
  }
  return removed;
};

// Returns a normalized bearing between 0 and 360
const normalizeBearing = (b: number) => (b + 360) % 360;

// The Core Engine
export const processTelemetry = (telemetry: TelemetryPayload) => {
  const startMs = performance.now();
  const finalize = () => {
    detectionStats.processedTelemetryCount += 1;
    detectionStats.totalProcessingMs += performance.now() - startMs;
  };

  seenVehicleIds.add(telemetry.vehicleId);

  if (!roadNetwork || roadNetwork.features.length === 0) return;

  const vehiclePoint = point([telemetry.lon, telemetry.lat]);
  
  let closestRoad: any = null;
  let closestSnap: any = null;
  let minDistance = Infinity;

  // 1. Map Matching
  // Find the nearest road segment
  for (const road of roadNetwork.features) {
    const snapped = nearestPointOnLine(road, vehiclePoint);
    const dist = snapped.properties.dist; // distance in km
    
    if (dist !== undefined && dist < minDistance) {
      minDistance = dist;
      closestRoad = road;
      closestSnap = snapped;
    }
  }

  // If vehicle is too far from any road (e.g. > 50 meters), ignore
  if (minDistance > MAP_MATCH_MAX_DISTANCE_KM) {
    finalize();
    return;
  }

  if (!closestRoad) {
    finalize();
    return;
  }

  // 2. Bearing Delta Calculator
  // Calculate road bearing (simplified: from first point to last point)
  // For better accuracy, we should find the bearing of the specific segment the car is on.
  // But for the hackathon prototype, calculating the bearing of the snapped line segment works.
  const coords = closestRoad.geometry.coordinates;
  // Reuse snap from map matching loop to avoid duplicate nearest-point work.
  const index = closestSnap?.properties?.index || 0;
  const nextIndex = Math.min(index + 1, coords.length - 1);
  
  if (index === nextIndex) {
    finalize();
    return;
  }

  const pt1 = point(coords[index]);
  const pt2 = point(coords[nextIndex]);
  const roadBearing = normalizeBearing(bearing(pt1, pt2));
  const carBearing = normalizeBearing(telemetry.heading);

  // Calculate delta
  let delta = Math.abs(roadBearing - carBearing);
  if (delta > 180) delta = 360 - delta;

  // 3. Context Switcher
  const oneway = closestRoad.properties?.oneway;
  let isWrongWay = false;

  if (oneway === 'yes') {
    // If it's one-way, delta shouldn't be close to 180 (opposite direction)
    // We consider > 120 degrees as wrong way
    if (delta > WRONG_WAY_DELTA_ONEWAY_DEG) {
      isWrongWay = true;
    }
  } else if (oneway === '-1') {
    // Reverse one-way
    if (delta < WRONG_WAY_DELTA_REVERSE_MAX_DEG) {
      isWrongWay = true;
    }
  } else {
    // oneway=no or undefined -> bidirectional
    // Context Switcher: suppress strict alerts to prevent false positives
    // For prototype, we do not flag wrong-way on two-way roads unless we implement relative anomaly detection.
    isWrongWay = false;
  }

  const suppressionZone = pointInsideConstructionZone(telemetry.lon, telemetry.lat);
  const isSuppressedByConstructionOverride = Boolean(suppressionZone && isWrongWay);
  if (isSuppressedByConstructionOverride) {
    isWrongWay = false;
    detectionStats.suppressedAlerts += 1;
  }

  // 4. Confidence Score Engine
  const state: VehicleDetectionState = vehicleState.get(telemetry.vehicleId) || {
    consecutiveAnomalies: 0,
    lastAlertState: 'SAFE',
    lastDangerBroadcastAtMs: 0,
  };

  if (isWrongWay) {
    state.consecutiveAnomalies += 1;
  } else {
    if (isSuppressedByConstructionOverride) {
      // Inside an override zone we force-clear anomaly memory immediately.
      state.consecutiveAnomalies = 0;
    } else {
      // Decay confidence quickly if normal
      state.consecutiveAnomalies = Math.max(0, state.consecutiveAnomalies - 1);
    }
  }

  // Evaluate Confidence Score (0 to 100%)
  // 1 anomaly = 33%, 2 = 66%, 3+ = 100%
  const confidenceScore = Math.min(100, Math.round((state.consecutiveAnomalies / ANOMALY_STREAK_FOR_DANGER) * 100));

  // Calculate Blast Radius (Danger Cone) if confidence is 100%
  let blastRadiusFeature: any = null;
  if (confidenceScore >= 100) {
    // Cone parameters
    const coneLengthKm = CONE_LENGTH_KM;
    const coneSpreadDegrees = CONE_SPREAD_DEGREES;
    
    // Calculate points for the polygon
    const p1 = [telemetry.lon, telemetry.lat]; // Car position (tip of cone)
    
    // Left point of cone
    const p2Feature = destination(
      vehiclePoint, 
      coneLengthKm, 
      normalizeBearing(telemetry.heading - (coneSpreadDegrees / 2))
    );
    const p2 = p2Feature.geometry.coordinates;

    // Right point of cone
    const p3Feature = destination(
      vehiclePoint, 
      coneLengthKm, 
      normalizeBearing(telemetry.heading + (coneSpreadDegrees / 2))
    );
    const p3 = p3Feature.geometry.coordinates;

    // Create Turf Polygon (must close the loop by repeating first point)
    blastRadiusFeature = polygon([[p1, p2, p3, p1]]);
  }

  const nextAlertState: AlertState = confidenceScore >= 100
    ? 'DANGER'
    : (confidenceScore > 0 ? 'MONITORING' : 'SAFE');

  if (state.lastAlertState !== nextAlertState) {
    if (nextAlertState === 'DANGER') {
      detectionStats.wrongWayEvents += 1;
    }

    const alert: IntruderAlert = {
      type: nextAlertState,
      vehicleId: telemetry.vehicleId,
      confidenceScore,
      message: nextAlertState === 'DANGER'
        ? 'Wrong-Way Driver Detected!'
        : (nextAlertState === 'MONITORING'
          ? 'Monitoring anomaly...'
          : (isSuppressedByConstructionOverride
            ? `Construction override active${suppressionZone?.name ? ` (${suppressionZone.name})` : ''}. Alert suppressed.`
            : 'Vehicle returned to safe behavior.')),
      blastRadius: nextAlertState === 'DANGER' ? blastRadiusFeature : undefined,
      suppressed: isSuppressedByConstructionOverride,
      suppressionReason: isSuppressedByConstructionOverride
        ? (suppressionZone?.reason ?? 'construction_override')
        : undefined,
    };
    broadcast(alert);
    if (nextAlertState === 'DANGER') {
      state.lastDangerBroadcastAtMs = Date.now();
    }

    if (nextAlertState !== 'SAFE') {
      detectionStats.alertsSent += 1;
    }
    if (nextAlertState === 'DANGER') {
      console.log(`[ALARM] Vehicle ${telemetry.vehicleId} is driving WRONG WAY! Confidence: ${confidenceScore}%`);
    }
  } else if (nextAlertState === 'DANGER') {
    const now = Date.now();
    if (now - (state.lastDangerBroadcastAtMs ?? 0) < DANGER_CONE_UPDATE_INTERVAL_MS) {
      state.lastAlertState = nextAlertState;
      vehicleState.set(telemetry.vehicleId, state);
      finalize();
      return;
    }
    state.lastDangerBroadcastAtMs = now;
    // Keep broadcasting updated cone geometry while danger persists,
    // so the UI cone follows the moving intruder instead of freezing.
    const alert: IntruderAlert = {
      type: 'DANGER',
      vehicleId: telemetry.vehicleId,
      confidenceScore,
      message: 'Wrong-Way Driver Detected!',
      blastRadius: blastRadiusFeature,
    };
    broadcast(alert);
  }

  state.lastAlertState = nextAlertState;
  vehicleState.set(telemetry.vehicleId, state);
  finalize();
};
