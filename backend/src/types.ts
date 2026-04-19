export interface TelemetryPayload {
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
  blastRadius?: any; // Turf polygon for danger cone
  suppressed?: boolean;
  suppressionReason?: string;
}

export type ConstructionOverrideZone = {
  id: string;
  name?: string;
  coordinates: [number, number][];
  active: boolean;
  reason?: string;
  createdAt: number;
  updatedAt: number;
};

export type ConstructionOverrideState = {
  active: boolean;
  zones: ConstructionOverrideZone[];
  updatedAt: number;
};
