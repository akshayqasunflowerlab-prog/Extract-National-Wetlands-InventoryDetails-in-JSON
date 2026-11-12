
import fs from 'fs';
import path from 'path';

export interface AddressTestData {
  featureId: string;
  address: string;
  mapClickX: number;
  mapClickY: number;
}

export function getAddressTestData(): AddressTestData[] {
  const filePath = path.join(
    process.cwd(),
    'Test Data',
    'Address-input.json'
  );

  if (!fs.existsSync(filePath)) {
    throw new Error(`Test data file not found: ${filePath}`);
  }

  const rawData = fs.readFileSync(filePath, 'utf-8');
  const testData: unknown = JSON.parse(rawData);

  if (!Array.isArray(testData) || testData.length === 0) {
    throw new Error('Address-input.json must contain at least one test record.');
  }

  for (const record of testData) {
    if (
      !record.featureId ||
      !record.address ||
      typeof record.mapClickX !== 'number' ||
      typeof record.mapClickY !== 'number'
    ) {
      throw new Error(
        `Invalid address test data: ${JSON.stringify(record)}`
      );
    }
  }

  return testData as AddressTestData[];
}
