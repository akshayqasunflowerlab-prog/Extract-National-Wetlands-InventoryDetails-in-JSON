
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { WetlandExtractionResult } from '../models/WetlandDetails.model';

export function saveWetlandExtraction(
  extractedData: WetlandExtractionResult
): string {
  const outputDirectory = path.join(
    process.cwd(),
    'test-results',
    'extracted-data'
  );

  fs.mkdirSync(outputDirectory, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '-');

  const uniqueId = randomUUID().slice(0, 8);

  const fileName =
    `Wetland-Extraction_${timestamp}_${uniqueId}.json`;

  const outputFilePath = path.join(
    outputDirectory,
    fileName
  );

  fs.writeFileSync(
    outputFilePath,
    JSON.stringify(extractedData, null, 2),
    'utf-8'
  );

  console.log('\n========== EXTRACTION RESULT ==========');
  console.log(`JSON file created: ${outputFilePath}`);

  return outputFilePath;
}
