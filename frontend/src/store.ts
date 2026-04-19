import { create } from 'zustand';

export interface Telemetry {
  vehicleId: string;
  timestamp: number;
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
}

export interface IntruderAlert {
  type: 'DANGER' | 'MONITORING' | 'SAFE';
  vehicleId: string;
  confidenceScore: number;
  message: string;
  blastRadius?: GeoJSON.Feature<GeoJSON.Polygon>; // GeoJSON polygon
}

interface AppState {
  vehicles: Record<string, Telemetry>;
  alerts: Record<string, IntruderAlert>;
  updateTelemetry: (data: Telemetry) => void;
  updateTelemetryBatch: (data: Record<string, Telemetry>) => void;
  updateAlert: (alert: IntruderAlert) => void;
}

export const useStore = create<AppState>((set) => ({
  vehicles: {},
  alerts: {},
  updateTelemetry: (data) => set((state) => ({
    vehicles: { ...state.vehicles, [data.vehicleId]: data }
  })),
  updateTelemetryBatch: (data) => set((state) => {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return state;
    }
    let changed = false;
    const nextVehicles = { ...state.vehicles };
    for (const [vehicleId, telemetry] of entries) {
      const prev = state.vehicles[vehicleId];
      if (
        prev &&
        prev.timestamp === telemetry.timestamp &&
        prev.lat === telemetry.lat &&
        prev.lon === telemetry.lon &&
        prev.heading === telemetry.heading &&
        prev.speedKmh === telemetry.speedKmh
      ) {
        continue;
      }
      nextVehicles[vehicleId] = telemetry;
      changed = true;
    }
    if (!changed) {
      return state;
    }
    return { vehicles: nextVehicles };
  }),
  updateAlert: (alert) => set((state) => {
    if (alert.type === 'SAFE') {
      const newAlerts = { ...state.alerts };
      delete newAlerts[alert.vehicleId];
      return { alerts: newAlerts };
    }
    return { alerts: { ...state.alerts, [alert.vehicleId]: alert } };
  })
}));
