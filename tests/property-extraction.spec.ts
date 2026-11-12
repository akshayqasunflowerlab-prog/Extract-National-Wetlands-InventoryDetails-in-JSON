
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

// STEP 2: Load address test data.
function loadAddressTestData(): AddressTestData[] {
  const projectRoot = projectRootPath();

  const inputPath = path.join(
    projectRoot,
    'test-data',
    'address-input.json'
  );

  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `Input JSON file not found: ${inputPath}`
    );
  }

  const fileContent = fs.readFileSync(inputPath, 'utf-8');

  const data: unknown = JSON.parse(fileContent);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      'Address-input.json contains no records.'
    );
  }

  for (const item of data) {
    if (
      !item.featureId ||
      !item.address ||
      typeof item.mapClickX !== 'number' ||
      typeof item.mapClickY !== 'number'
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

    test.setTimeout(120000);

    const addressRecords = loadAddressTestData();

    const baseUrl = process.env.BASE_URL;

    if (!baseUrl) {
      throw new Error(
        'BASE_URL is not configured.'
      );
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

      console.log(
        JSON.stringify(wetlandFeatures, null, 2)
      );

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
      // This ensures the API extraction is preserved
      // even if General tab extraction encounters an issue.
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
      const general = await viewer.extractGeneralTab();

      expect(general.wetlandType).not.toBe('');
      expect(general.classification).not.toBe('');

      console.log('\nExtracted General tab information:');

      console.log(
        JSON.stringify(general, null, 2)
      );

      // STEP 10: Update the JSON with General tab data.
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
