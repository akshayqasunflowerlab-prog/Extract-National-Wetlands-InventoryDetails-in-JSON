
export interface WetlandDetails {
    acreage: number;
    wetlandType: string;
    classification: string;
    imageScale: string;
    imageryType: string;
    imageYear: number;
    generalDescription: string;
    imageryDescription: string;
}

export interface WetlandIdentifyFeature {
    layerId: number;
    layerName: string;
    displayFieldName?: string;
    value?: string;
    attributes: Record<string, unknown>;
    geometryType?: string;
    geometry?: unknown;
}

export interface WetlandExtractionResult {
    featureId: string;
    address: string;
    extractedAt: string;
    wetlandFeatures: WetlandIdentifyFeature[];
    general: WetlandDetails | null;
}
