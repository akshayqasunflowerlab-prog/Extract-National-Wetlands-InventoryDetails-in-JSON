# Wetlands Mapper extraction

This Playwright TypeScript project extracts the six fields shown in the map's
General tab and saves one JSON record per configured map feature.

## Setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`. Update `BASE_URL` and `MAP_SELECTOR` if the
   mapper URL or map element selector changes.
3. Edit `test-data/pin-input.json` with the feature IDs and click coordinates you
   verified in the mapper. Coordinates are relative to the map element, not the
   browser window. The checked-in `400, 250` values are examples and are not
   verified wetland locations.
4. Install Chromium with `npx playwright install chromium`.

## Run

- `npm test` runs the extraction test.
- `npm run test:headed` runs with a visible browser.
- `npm run test:debug` opens Playwright Inspector.
- `npm run report` opens the HTML test report.

Successful extraction writes `test-results/wetland-extraction.json`.
Description, Reports, and About tab data are intentionally excluded.
