
import { WetlandDetails } from '../models/WetlandDetails.model';

export function parseGeneralTabText(text: string): WetlandDetails {
    const habitatMatch = text.match(
        /This\s+([\d,.]+\s*acre)\s+(.+?)\s+habitat\s+is\s+classified\s+as\s+a\s+([A-Z0-9]+)/i
    );

    const imageryMatch = text.match(
        /using\s+([\d:,]+)\s+scale,\s+(.+?)\s+imagery\s+from\s+(\d{4})/i
    );

    if (!habitatMatch || !imageryMatch) {
        throw new Error(
            `Unable to parse General tab information. Received text: ${text}`
        );
    }

    return {
        acreage: Number.parseFloat(habitatMatch[1]),
        wetlandType: habitatMatch[2],
        classification: habitatMatch[3],
        imageScale: imageryMatch[1],
        imageryType: imageryMatch[2],
        imageYear: Number(imageryMatch[3]),
        generalDescription: habitatMatch[0],
        imageryDescription: imageryMatch[0]
    };
}
