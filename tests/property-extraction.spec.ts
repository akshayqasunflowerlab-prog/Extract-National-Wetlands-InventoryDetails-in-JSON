import { test, expect } from '@playwright/test';
import { PropertyViewerPage } from '../pages/property-viewer.page';

import * as fs from 'fs';
import * as path from 'path';

interface AddressTestData {
  featureId: string;
  address: string;
  mapClickX: number;
  mapClickY: number;
}

// STEP 1: Resolve the project root.
function projectRootPath(): string {
  return path.resolve(__dirname, '..');
}

// STEP 2: Load and validate address test data.
function loadAddressTestData(): AddressTestData[] {
  const projectRoot = projectRootPath();

  const inputPath = path.join(
    projectRoot,
    'test-data',
    'address-input.json'
  );

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input JSON file not found: ${inputPath}`);
  }

  const fileContent = fs.readFileSync(inputPath, 'utf-8');
  const data: unknown = JSON.parse(fileContent);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Address-input.json contains no records.');
  }

  for (const item of data) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.featureId !== 'string' ||
      item.featureId.trim() === '' ||
      typeof item.address !== 'string' ||
      item.address.trim() === '' ||
      typeof item.mapClickX !== 'number' ||
      !Number.isFinite(item.mapClickX) ||
      typeof item.mapClickY !== 'number' ||
      !Number.isFinite(item.mapClickY)
    ) {
      throw new Error(
        `Invalid input record: ${JSON.stringify(item)}`
      );
    }
  }

  console.log('Input JSON loaded successfully.');
  console.log('Input file:', inputPath);
  console.log('Total addresses:', data.length);

  return data as AddressTestData[];
}

// STEP 3: Main extraction test.
test(
  'Automatically search address and extract wetland information',
  async ({ page }) => {
    // Three Identify attempts can take up to 90 seconds per address.
    // Allow sufficient time for address search, popup rendering and saving.
    test.setTimeout(300000);

    const addressRecords = loadAddressTestData();
    const baseUrl = process.env.BASE_URL;

    if (!baseUrl) {
      throw new Error('BASE_URL is not configured.');
    }

    const viewer = new PropertyViewerPage(page);

    for (const input of addressRecords) {
      console.log('\n========== START EXTRACTION ==========');
      console.log('Feature ID:', input.featureId);
      console.log('Address:', input.address);

      // STEP 4: Open the website.
      await viewer.open(baseUrl);

      // STEP 5: Search the address.
      await viewer.searchAddress(input.address);

      // STEP 6: Capture GIS wetland information.
      const wetlandFeatures = await viewer.selectMapFeature({
        x: input.mapClickX,
        y: input.mapClickY
      });

      expect(wetlandFeatures.length).toBeGreaterThan(0);

      console.log('\nExtracted GIS wetland information:');
      console.log(JSON.stringify(wetlandFeatures, null, 2));

      // STEP 7: Prepare output location.
      const outputDirectory = path.join(
        projectRootPath(),
        'test-results',
        'json'
      );

      fs.mkdirSync(outputDirectory, {
        recursive: true
      });

      const safeFeatureId = input.featureId.replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      );

      const outputPath = path.join(
        outputDirectory,
        `${safeFeatureId}.json`
      );

      // STEP 8: Save GIS data first.
      // This preserves GIS extraction even if General tab extraction fails.
      const result: {
        featureId: string;
        address: string;
        extractedAt: string;
        wetlandFeatures: typeof wetlandFeatures;
        general: Awaited<
          ReturnType<PropertyViewerPage['extractGeneralTab']>
        > | null;
      } = {
        featureId: input.featureId,
        address: input.address,
        extractedAt: new Date().toISOString(),
        wetlandFeatures,
        general: null
      };

      fs.writeFileSync(
        outputPath,
        JSON.stringify(result, null, 2),
        'utf-8'
      );

      console.log('\nGIS JSON saved successfully:');
      console.log(outputPath);

      // STEP 9: Extract General tab information.
      // This waits for actual field values, not only popup visibility.
      const general = await viewer.extractGeneralTab();

      expect(general.wetlandType).not.toBe('');
      expect(general.classification).not.toBe('');

      console.log('\nExtracted General tab information:');
      console.log(JSON.stringify(general, null, 2));

      // STEP 10: Update JSON with General tab data.
      result.general = general;

      fs.writeFileSync(
        outputPath,
        JSON.stringify(result, null, 2),
        'utf-8'
      );

      console.log('\nFinal JSON updated successfully:');
      console.log(outputPath);

      console.log(
        '\n========== EXTRACTION COMPLETED ==========\n'
      );
    }
  }
);
