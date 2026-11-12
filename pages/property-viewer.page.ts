
import { Page, Locator, expect } from '@playwright/test';
import type { Request, Response } from '@playwright/test';
import type { WetlandDetails } from '../models/WetlandDetails.model';
import * as fs from 'fs';
import * as path from 'path';

export interface MapClick {
  x: number;
  y: number;
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

interface IdentifyApiResponse {
  results?: WetlandIdentifyFeature[];
  error?: {
    code?: number;
    message?: string;
  };
}

// Convert either JSON or JSONP response into a JSON object.
function parseIdentifyResponse(
  responseText: string
): IdentifyApiResponse {
  const trimmedResponse = responseText.trim();

  if (!trimmedResponse) {
    throw new Error('GIS Identify response body is empty.');
  }

  let jsonText = trimmedResponse;

  // Standard JSON response.
  if (trimmedResponse.startsWith('{')) {
    jsonText = trimmedResponse;
  } else {
    // JSONP response:
    // callbackFunction({...});
    const openingBracket = trimmedResponse.indexOf('(');
    const closingBracket = trimmedResponse.lastIndexOf(')');

    if (
      openingBracket === -1 ||
      closingBracket === -1 ||
      closingBracket <= openingBracket
    ) {
      throw new Error(
        'Unable to identify JSONP response boundaries.'
      );
    }

    jsonText = trimmedResponse.substring(
      openingBracket + 1,
      closingBracket
    );
  }

  return JSON.parse(jsonText) as IdentifyApiResponse;
}

export class PropertyViewerPage {
  private readonly page: Page;
  private readonly map: Locator;
  private readonly addressSearch: Locator;
  private readonly generalInfo: Locator;

  constructor(page: Page) {
    this.page = page;
    this.map = page.locator('#mapDiv_gc');
    this.addressSearch = page.locator('#geosearch_input');
    this.generalInfo = page.locator('#generalInfo');
  }

  // STEP 1: Open website and close disclaimer.
  async open(url: string): Promise<void> {
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded'
    });

    await this.map.waitFor({
      state: 'visible',
      timeout: 60000
    });

    const disclaimer = this.page.locator('#disclaimerModal');

    if (await disclaimer.isVisible().catch(() => false)) {
      await disclaimer.getByText('x', {
        exact: true
      }).click();

      await expect(disclaimer).toBeHidden();
    }
  }

  // STEP 2: Automatically search the address.
  async searchAddress(address: string): Promise<void> {
    await this.page.getByRole('button', {
      name: /Find Location/i
    }).click();

    await this.addressSearch.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await this.addressSearch.fill('');

    await this.addressSearch.pressSequentially(address, {
      delay: 100
    });

    await this.page.waitForTimeout(1500);

    await this.addressSearch.press('ArrowDown');
    await this.addressSearch.press('Enter');

    await this.page.getByText('Go', {
      exact: true
    }).click();

    await this.page.waitForTimeout(3000);

    // Close visible Dismiss buttons.
    const dismissButtons = this.page.getByRole('button', {
      name: 'Dismiss',
      exact: true
    });

    const dismissCount = await dismissButtons.count();

    for (let i = 0; i < dismissCount; i++) {
      const button = dismissButtons.nth(i);

      if (await button.isVisible().catch(() => false)) {
        console.log('Closing visible modal using Dismiss button.');

        await button.click();
        await this.page.waitForTimeout(500);
      }
    }

    await this.map.waitFor({
      state: 'visible',
      timeout: 30000
    });

    console.log(`Address searched successfully: ${address}`);
  }

  // STEP 3: Select a map location and capture GIS Identify response.
  async selectMapFeature(
    coordinates: MapClick
  ): Promise<WetlandIdentifyFeature[]> {

    const identifyEndpoint =
      '/FWSWetlandsMapper/Wetlands/MapServer/identify';

    const capturedRequests: Array<{
      method: string;
      url: string;
      resourceType: string;
    }> = [];

    const capturedResponses: Array<{
      url: string;
      status: number;
      resourceType: string;
      contentType: string;
    }> = [];

    const capturedFailures: Array<{
      url: string;
      errorText: string;
    }> = [];

    const capturedFinishedRequests: string[] = [];

    const requestListener = (request: Request): void => {
      const url = request.url();

      if (url.includes(identifyEndpoint)) {
        capturedRequests.push({
          method: request.method(),
          url,
          resourceType: request.resourceType()
        });
      }
    };

    const responseListener = (response: Response): void => {
      const url = response.url();

      if (url.includes(identifyEndpoint)) {
        capturedResponses.push({
          url,
          status: response.status(),
          resourceType: response.request().resourceType(),
          contentType:
            response.headers()['content-type'] ?? ''
        });

        console.log(
          'Identify response event captured:',
          response.status(),
          response.request().resourceType()
        );
      }
    };

    const requestFinishedListener = (request: Request): void => {
      if (request.url().includes(identifyEndpoint)) {
        capturedFinishedRequests.push(request.url());
      }
    };

    const requestFailedListener = (request: Request): void => {
      const url = request.url();

      if (url.includes(identifyEndpoint)) {
        capturedFailures.push({
          url,
          errorText: request.failure()?.errorText ?? 'Unknown error'
        });
      }
    };

    this.page.on('request', requestListener);
    this.page.on('response', responseListener);
    this.page.on('requestfinished', requestFinishedListener);
    this.page.on('requestfailed', requestFailedListener);

    let identifyResponse: Response | null = null;
    let clickError: unknown = null;
    let responseBody = '';
    let parsedResponse: IdentifyApiResponse = {};

    let responseParsingError: string | null = null;

    let originalPointerEvents: string | null = null;
    let panelPointerEventsChanged = false;

    let mapExtent: string | null = null;
    let mapBounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;

    let initialHitTest: unknown = null;
    let finalHitTest: unknown = null;

    // Response event promise.
    let resolveIdentifyResponse:
      (response: Response | null) => void = () => { };

    const identifyResponsePromise = new Promise<Response | null>(
      resolve => {
        resolveIdentifyResponse = resolve;
      }
    );

    // This listener is registered before the map click.
    const identifyResponseListener = (response: Response): void => {
      if (
        response.url().includes(identifyEndpoint)
      ) {
        resolveIdentifyResponse(response);
      }
    };

    this.page.on('response', identifyResponseListener);

    let responseTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await this.map.waitFor({
        state: 'visible',
        timeout: 30000
      });

      const mapBox = await this.map.boundingBox();

      if (!mapBox) {
        throw new Error('Unable to retrieve map dimensions.');
      }

      mapBounds = {
        x: mapBox.x,
        y: mapBox.y,
        width: mapBox.width,
        height: mapBox.height
      };

      // Validate configured coordinates.
      if (
        coordinates.x < 0 ||
        coordinates.y < 0 ||
        coordinates.x >= mapBox.width ||
        coordinates.y >= mapBox.height
      ) {
        throw new Error(
          `Map coordinates (${coordinates.x}, ${coordinates.y}) ` +
          `are outside map dimensions (${mapBox.width}, ${mapBox.height}).`
        );
      }

      const absoluteX = mapBox.x + coordinates.x;
      const absoluteY = mapBox.y + coordinates.y;

      console.log(
        `Clicking map at X: ${coordinates.x}, Y: ${coordinates.y}`
      );

      // Check which element receives the mouse click.
      initialHitTest = await this.page.evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y);

          return {
            tagName: target?.tagName ?? null,
            id: target?.id ?? null,
            className:
              typeof target?.className === 'string'
                ? target.className
                : null,
            insideMap: !!target &&
              document.querySelector('#mapDiv_gc')?.contains(target),
            insideWetlandPanel: !!target?.closest('#wetlandDiv')
          };
        },
        {
          x: absoluteX,
          y: absoluteY
        }
      );

      console.log('Initial map hit test:', initialHitTest);

      const hitTestResult = initialHitTest as {
        insideMap: boolean;
        insideWetlandPanel: boolean;
      };

      // If the wetland information panel blocks the map,
      // temporarily allow the click to pass through it.
      if (
        !hitTestResult.insideMap &&
        hitTestResult.insideWetlandPanel
      ) {
        const wetlandPanel = this.page.locator('#wetlandDiv');

        originalPointerEvents = await wetlandPanel.evaluate(
          element => (element as HTMLElement).style.pointerEvents
        );

        await wetlandPanel.evaluate(element => {
          (element as HTMLElement).style.pointerEvents = 'none';
        });

        panelPointerEventsChanged = true;

        await this.page.waitForTimeout(200);

        finalHitTest = await this.page.evaluate(
          ({ x, y }) => {
            const target = document.elementFromPoint(x, y);

            return {
              tagName: target?.tagName ?? null,
              id: target?.id ?? null,
              insideMap: !!target &&
                document.querySelector('#mapDiv_gc')?.contains(target)
            };
          },
          {
            x: absoluteX,
            y: absoluteY
          }
        );

        console.log('Hit test after panel adjustment:', finalHitTest);

        const finalResult = finalHitTest as {
          insideMap: boolean;
        };

        if (!finalResult.insideMap) {
          throw new Error(
            'The map is still blocked after temporarily adjusting #wetlandDiv.'
          );
        }
      } else if (!hitTestResult.insideMap) {
        throw new Error(
          'The map click is blocked by an unexpected element. ' +
          `Hit test: ${JSON.stringify(initialHitTest)}`
        );
      }

      // Set up a timeout for the response event.
      // The listener was registered before the click.
      const responseTimeoutPromise = new Promise<null>(resolve => {
        responseTimeout = setTimeout(() => {
          resolve(null);
        }, 20000);
      });

      console.log('Waiting for GIS Identify response...');

      // Perform exactly one mouse click.
      await this.page.mouse.click(absoluteX, absoluteY);

      identifyResponse = await Promise.race([
        identifyResponsePromise,
        responseTimeoutPromise
      ]);

      if (identifyResponse) {
        console.log('IDENTIFY RESPONSE RECEIVED.');
        console.log(
          'IDENTIFY RESPONSE STATUS:',
          identifyResponse.status()
        );

        console.log(
          'IDENTIFY RESOURCE TYPE:',
          identifyResponse.request().resourceType()
        );

        if (!identifyResponse.ok()) {
          throw new Error(
            `GIS Identify API returned HTTP ${identifyResponse.status()}`
          );
        }

        responseBody = await identifyResponse.text();

        console.log(
          'IDENTIFY RESPONSE BODY:',
          responseBody
        );

        try {
          parsedResponse = parseIdentifyResponse(responseBody);

        } catch (error) {
          responseParsingError = String(error);

          throw new Error(
            `Unable to parse GIS Identify response: ${responseParsingError}`
          );
        }

        const requestUrl = new URL(identifyResponse.url());
        mapExtent = requestUrl.searchParams.get('mapExtent');

      } else {
        console.error(
          'No Identify response event was received within 20 seconds.'
        );
      }

      await this.page.waitForTimeout(1000);

    } catch (error) {
      clickError = error;

    } finally {
      if (responseTimeout) {
        clearTimeout(responseTimeout);
      }

      // Restore the original panel setting.
      if (panelPointerEventsChanged) {
        await this.page.locator('#wetlandDiv').evaluate(
          (element, originalValue) => {
            (element as HTMLElement).style.pointerEvents =
              originalValue ?? '';
          },
          originalPointerEvents
        ).catch(() => undefined);
      }

      this.page.off('request', requestListener);
      this.page.off('response', responseListener);
      this.page.off('response', identifyResponseListener);
      this.page.off('requestfinished', requestFinishedListener);
      this.page.off('requestfailed', requestFailedListener);
    }

    const identifyFeatures = parsedResponse.results ?? [];

    // Keep only actual wetland features from Layer 1.
    const wetlandFeatures = identifyFeatures.filter(
      feature => feature.layerId === 1
    );

    const identifyPanelVisible = await this.generalInfo
      .isVisible()
      .catch(() => false);

    // Save diagnostics.
    const diagnosticData = {
      capturedAt: new Date().toISOString(),

      clickedCoordinates: coordinates,

      mapBounds,

      mapExtent,

      initialHitTest,

      finalHitTest,

      capturedRequests,

      capturedResponses,

      capturedFinishedRequests,

      capturedFailures,

      identifyResponseDetails: {
        received: identifyResponse !== null,
        status: identifyResponse?.status() ?? null,
        resourceType:
          identifyResponse?.request().resourceType() ?? null,
        count: identifyFeatures.length,
        wetlandFeatureCount: wetlandFeatures.length,
        parsingError: responseParsingError
      },

      identifyResponseData: identifyResponse
        ? {
          url: identifyResponse.url(),
          status: identifyResponse.status(),
          contentType:
            identifyResponse.headers()['content-type'] ?? '',
          body: responseBody
        }
        : null,

      applicationResponse: {
        identifyPanelVisible
      }
    };

    const diagnosticDirectory = path.join(
      process.cwd(),
      'test-results',
      'diagnostics'
    );

    fs.mkdirSync(diagnosticDirectory, {
      recursive: true
    });

    fs.writeFileSync(
      path.join(diagnosticDirectory, 'map-structure.json'),
      JSON.stringify(diagnosticData, null, 2),
      'utf-8'
    );

    console.log(
      'MAP DIAGNOSTICS:',
      JSON.stringify(diagnosticData, null, 2)
    );

    if (clickError) {
      throw clickError;
    }

    if (!identifyResponse) {
      throw new Error(
        'Identify response was not received within 20 seconds. ' +
        'Check capturedRequests, capturedResponses, ' +
        'capturedFinishedRequests and capturedFailures in map-structure.json.'
      );
    }

    if (parsedResponse.error) {
      throw new Error(
        `GIS Identify error: ${parsedResponse.error.message ?? 'Unknown error'}`
      );
    }

    if (wetlandFeatures.length === 0) {
      throw new Error(
        'The Identify response did not contain a Layer 1 wetland feature.'
      );
    }

    console.log(
      `Successfully extracted ${wetlandFeatures.length} wetland feature(s).`
    );

    return wetlandFeatures;
  }

  // STEP 4: Wait for General tab data.
  private async waitForGeneralTab(): Promise<void> {
    await expect(this.generalInfo).toBeVisible({
      timeout: 30000
    });

    await expect(
      this.generalInfo.locator('#acreage')
    ).toBeVisible({
      timeout: 30000
    });
  }

  // STEP 5: Extract only General tab information.
  async extractGeneralTab(): Promise<WetlandDetails> {
    await this.waitForGeneralTab();

    const acreageText = (
      await this.generalInfo.locator('#acreage').innerText()
    ).trim();

    const wetlandType = (
      await this.generalInfo.locator('#wetlandType').innerText()
    ).trim();

    const classification = (
      await this.generalInfo.locator('#wetlandCode').innerText()
    ).trim();

    const imageScale = (
      await this.generalInfo
        .locator('#imageScalePopup b')
        .first()
        .innerText()
    ).trim();

    const imageryType = (
      await this.generalInfo
        .locator('#sourceTypePopup b')
        .nth(0)
        .innerText()
    ).trim();

    const imageYearText = (
      await this.generalInfo
        .locator('#sourceTypePopup b')
        .nth(1)
        .innerText()
    ).trim();

    const acreage = Number(acreageText);
    const imageYear = Number(imageYearText);

    if (
      Number.isNaN(acreage) ||
      Number.isNaN(imageYear)
    ) {
      throw new Error(
        'Invalid acreage or image year extracted from General tab.'
      );
    }

    return {
      acreage,
      wetlandType,
      classification,
      imageScale,
      imageryType,
      imageYear,

      generalDescription:
        `This ${acreageText} acre ${wetlandType} habitat ` +
        `is classified as a ${classification}.`,

      imageryDescription:
        `The wetlands and deepwater habitats in this area ` +
        `were photo interpreted using ${imageScale} scale, ` +
        `${imageryType} imagery from ${imageYearText}.`
    };
  }
}
