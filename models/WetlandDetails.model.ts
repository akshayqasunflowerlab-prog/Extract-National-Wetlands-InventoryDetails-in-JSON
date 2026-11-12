

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


export interface WetlandExtractionResult {
    featureId: string;
    address: string;
    extractedAt: string;
    general: WetlandDetails;
}
