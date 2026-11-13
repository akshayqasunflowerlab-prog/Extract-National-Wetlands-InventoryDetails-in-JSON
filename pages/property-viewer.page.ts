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

interface IdentifyAttemptDiagnostic {
  attempt: number;
  startedAt: string;
  durationMs: number;
  status: number | null;
  responseReceived: boolean;
  responseFeatureCount: number;
  wetlandFeatureCount: number;
  error: string | null;
}

// Convert either JSON or JSONP response into a JSON object.
function parseIdentifyResponse(responseText: string): IdentifyApiResponse {
  const trimmedResponse = responseText.trim();

  if (!trimmedResponse) {
    throw new Error('GIS Identify response body is empty.');
  }

  let jsonText = trimmedResponse;

  if (!trimmedResponse.startsWith('{')) {
    // JSONP response: callbackFunction({...});
    const openingBracket = trimmedResponse.indexOf('(');
    const closingBracket = trimmedResponse.lastIndexOf(')');

    if (
      openingBracket === -1 ||
      closingBracket === -1 ||
      closingBracket <= openingBracket
    ) {
      throw new Error('Unable to identify JSONP response boundaries.');
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

  private readonly identifyEndpoint =
    '/FWSWetlandsMapper/Wetlands/MapServer/identify';

  private readonly identifyTimeoutMs = 30000;
  private readonly maxIdentifyAttempts = 3;
  private readonly popupTimeoutMs = 15000;

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

    // Allow the address autocomplete suggestions to populate.
    await this.page.waitForTimeout(1500);

    await this.addressSearch.press('ArrowDown');
    await this.addressSearch.press('Enter');

    await this.page.getByText('Go', {
      exact: true
    }).click();

    // The map application needs time to reposition after address search.
    await this.page.waitForTimeout(3000);

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
  // Retry only when the GIS response is missing or invalid.
  // A slow popup after a valid GIS response does not trigger another map click.
  async selectMapFeature(
    coordinates: MapClick
  ): Promise<WetlandIdentifyFeature[]> {
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
    const attemptDiagnostics: IdentifyAttemptDiagnostic[] = [];

    const requestListener = (request: Request): void => {
      if (request.url().includes(this.identifyEndpoint)) {
        capturedRequests.push({
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType()
        });
      }
    };

    const responseListener = (response: Response): void => {
      if (response.url().includes(this.identifyEndpoint)) {
        capturedResponses.push({
          url: response.url(),
          status: response.status(),
          resourceType: response.request().resourceType(),
          contentType: response.headers()['content-type'] ?? ''
        });

        console.log(
          `Identify response event: HTTP ${response.status()}`
        );
      }
    };

    const requestFinishedListener = (request: Request): void => {
      if (request.url().includes(this.identifyEndpoint)) {
        capturedFinishedRequests.push(request.url());
      }
    };

    const requestFailedListener = (request: Request): void => {
      if (request.url().includes(this.identifyEndpoint)) {
        capturedFailures.push({
          url: request.url(),
          errorText: request.failure()?.errorText ?? 'Unknown error'
        });
      }
    };

    this.page.on('request', requestListener);
    this.page.on('response', responseListener);
    this.page.on('requestfinished', requestFinishedListener);
    this.page.on('requestfailed', requestFailedListener);

    let successfulResponse: Response | null = null;
    let successfulResponseBody = '';
    let successfulParsedResponse: IdentifyApiResponse = {};
    let successfulFeatures: WetlandIdentifyFeature[] = [];
    let successfulMapExtent: string | null = null;

    let mapBounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;

    let initialHitTest: unknown = null;
    let finalHitTest: unknown = null;
    let popupReady = false;
    let popupReadinessError: string | null = null;
    let lastError = 'No Identify attempt was completed.';

    const overallStart = Date.now();

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

      if (
        !Number.isFinite(coordinates.x) ||
        !Number.isFinite(coordinates.y) ||
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
        `Map selection coordinates: X=${coordinates.x}, Y=${coordinates.y}`
      );

      for (
        let attempt = 1;
        attempt <= this.maxIdentifyAttempts;
        attempt++
      ) {
        const attemptStart = Date.now();
        const startedAt = new Date().toISOString();

        let attemptResponse: Response | null = null;
        let attemptBody = '';
        let attemptParsed: IdentifyApiResponse = {};
        let attemptFeatures: WetlandIdentifyFeature[] = [];
        let attemptError: string | null = null;

        let originalPointerEvents: string | null = null;
        let panelPointerEventsChanged = false;

        console.log(
          `Identify attempt ${attempt}/${this.maxIdentifyAttempts} started.`
        );

        try {
          // Check which element will receive the map click.
          initialHitTest = await this.page.evaluate(
            ({ x, y }) => {
              const target = document.elementFromPoint(x, y);
              const mapElement = document.querySelector('#mapDiv_gc');

              return {
                tagName: target?.tagName ?? null,
                id: target?.id ?? null,
                className:
                  typeof target?.className === 'string'
                    ? target.className
                    : null,
                insideMap: !!target && !!mapElement?.contains(target),
                insideWetlandPanel: !!target?.closest('#wetlandDiv')
              };
            },
            { x: absoluteX, y: absoluteY }
          );

          console.log('Map hit test:', initialHitTest);

          const hitTest = initialHitTest as {
            insideMap: boolean;
            insideWetlandPanel: boolean;
          };

          if (!hitTest.insideMap && hitTest.insideWetlandPanel) {
            const wetlandPanel = this.page.locator('#wetlandDiv');

            originalPointerEvents = await wetlandPanel.evaluate(
              element => (element as HTMLElement).style.pointerEvents
            );

            await wetlandPanel.evaluate(element => {
              (element as HTMLElement).style.pointerEvents = 'none';
            });

            panelPointerEventsChanged = true;

            finalHitTest = await this.page.evaluate(
              ({ x, y }) => {
                const target = document.elementFromPoint(x, y);

                return {
                  tagName: target?.tagName ?? null,
                  id: target?.id ?? null,
                  insideMap: !!target &&
                    !!document.querySelector('#mapDiv_gc')?.contains(target)
                };
              },
              { x: absoluteX, y: absoluteY }
            );

            console.log('Hit test after panel adjustment:', finalHitTest);

            const finalResult = finalHitTest as {
              insideMap: boolean;
            };

            if (!finalResult.insideMap) {
              throw new Error(
                'The map is still blocked after adjusting #wetlandDiv.'
              );
            }
          } else if (!hitTest.insideMap) {
            throw new Error(
              'The map click is blocked by an unexpected element. ' +
              `Hit test: ${JSON.stringify(initialHitTest)}`
            );
          }

          // Register the response waiter BEFORE clicking.
          // Convert rejection into a result so it cannot become unhandled
          // if the mouse click itself fails.
          const responseResultPromise = this.page.waitForResponse(
            response =>
              response.url().includes(this.identifyEndpoint),
            {
              timeout: this.identifyTimeoutMs
            }
          ).then(
            response => ({
              response,
              error: null as Error | null
            }),
            error => ({
              response: null,
              error: error as Error
            })
          );

          console.log(
            `Waiting up to ${this.identifyTimeoutMs / 1000} seconds ` +
            'for the GIS Identify response...'
          );

          await this.page.mouse.click(absoluteX, absoluteY);

          const responseResult = await responseResultPromise;

          if (!responseResult.response) {
            throw new Error(
              `Identify response timeout: ${
                responseResult.error?.message ?? 'No response received.'
              }`
            );
          }

          attemptResponse = responseResult.response;

          console.log(
            `Identify response received in ${Date.now() - attemptStart} ms.`
          );

          if (!attemptResponse.ok()) {
            throw new Error(
              `GIS Identify API returned HTTP ${attemptResponse.status()}.`
            );
          }

          attemptBody = await attemptResponse.text();
          attemptParsed = parseIdentifyResponse(attemptBody);

          if (attemptParsed.error) {
            throw new Error(
              `GIS Identify error: ${
                attemptParsed.error.message ?? 'Unknown GIS error'
              }`
            );
          }

          const identifyResults = attemptParsed.results ?? [];

          attemptFeatures = identifyResults.filter(
            feature => feature.layerId === 1
          );

          if (attemptFeatures.length === 0) {
            throw new Error(
              'Identify response did not contain a Layer 1 ' +
              'Wetlands_CONUS_East feature.'
            );
          }

          // A valid GIS response has been received. Do not repeat the
          // map click merely because the popup takes longer to render.
          successfulResponse = attemptResponse;
          successfulResponseBody = attemptBody;
          successfulParsedResponse = attemptParsed;
          successfulFeatures = attemptFeatures;

          const requestUrl = new URL(attemptResponse.url());
          successfulMapExtent =
            requestUrl.searchParams.get('mapExtent');

          attemptDiagnostics.push({
            attempt,
            startedAt,
            durationMs: Date.now() - attemptStart,
            status: attemptResponse.status(),
            responseReceived: true,
            responseFeatureCount: identifyResults.length,
            wetlandFeatureCount: attemptFeatures.length,
            error: null
          });

          console.log(
            `Valid wetland response received. ` +
            `Wetland feature count: ${attemptFeatures.length}.`
          );

          break;
        } catch (error) {
          attemptError =
            error instanceof Error ? error.message : String(error);

          lastError = attemptError;

          attemptDiagnostics.push({
            attempt,
            startedAt,
            durationMs: Date.now() - attemptStart,
            status: attemptResponse?.status() ?? null,
            responseReceived: attemptResponse !== null,
            responseFeatureCount: attemptParsed.results?.length ?? 0,
            wetlandFeatureCount: attemptFeatures.length,
            error: attemptError
          });

          console.error(
            `Identify attempt ${attempt} failed: ${attemptError}`
          );

          if (attempt < this.maxIdentifyAttempts) {
            console.log('Preparing controlled retry...');
          }
        } finally {
          // Always restore the panel's original inline setting.
          if (panelPointerEventsChanged) {
            await this.page.locator('#wetlandDiv').evaluate(
              (element, originalValue) => {
                (element as HTMLElement).style.pointerEvents =
                  originalValue ?? '';
              },
              originalPointerEvents
            ).catch(() => undefined);
          }
        }

        if (successfulResponse) {
          break;
        }

        if (attempt < this.maxIdentifyAttempts) {
          await this.page.waitForTimeout(1000);
        }
      }
    } finally {
      this.page.off('request', requestListener);
      this.page.off('response', responseListener);
      this.page.off('requestfinished', requestFinishedListener);
      this.page.off('requestfailed', requestFailedListener);
    }

    // The popup is a secondary UI confirmation. Its delay must not
    // invalidate a successful GIS API response.
    if (successfulResponse && successfulFeatures.length > 0) {
      const popupStart = Date.now();

      try {
        await this.waitForGeneralTab(this.popupTimeoutMs);
        popupReady = true;

        console.log(
          `General tab became ready in ${Date.now() - popupStart} ms.`
        );
      } catch (error) {
        popupReadinessError =
          error instanceof Error ? error.message : String(error);

        console.warn(
          'GIS data is valid, but General tab content is not ready yet: ' +
          popupReadinessError
        );
      }
    }

    const diagnosticData = {
      capturedAt: new Date().toISOString(),
      totalDurationMs: Date.now() - overallStart,
      configuredCoordinates: coordinates,
      mapBounds,
      mapExtent: successfulMapExtent,
      initialHitTest,
      finalHitTest,
      retryConfiguration: {
        maxAttempts: this.maxIdentifyAttempts,
        responseTimeoutMs: this.identifyTimeoutMs
      },
      attempts: attemptDiagnostics,
      capturedRequests,
      capturedResponses,
      capturedFinishedRequests,
      capturedFailures,
      identifyResponseDetails: {
        received: successfulResponse !== null,
        status: successfulResponse?.status() ?? null,
        resourceType:
          successfulResponse?.request().resourceType() ?? null,
        totalResultCount:
          successfulParsedResponse.results?.length ?? 0,
        wetlandFeatureCount: successfulFeatures.length
      },
      applicationResponse: {
        generalTabReady: popupReady,
        popupReadinessError
      },
      lastError,
      identifyResponseData: successfulResponse
        ? {
            url: successfulResponse.url(),
            status: successfulResponse.status(),
            contentType:
              successfulResponse.headers()['content-type'] ?? '',
            body: successfulResponseBody
          }
        : null
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
      'IDENTIFY DIAGNOSTICS:',
      JSON.stringify(diagnosticData, null, 2)
    );

    if (!successfulResponse || successfulFeatures.length === 0) {
      throw new Error(
        `Unable to identify a valid wetland feature after ` +
        `${this.maxIdentifyAttempts} attempts. Last error: ${lastError}. ` +
        'Check test-results/diagnostics/map-structure.json.'
      );
    }

    console.log(
      `Successfully extracted ${successfulFeatures.length} wetland feature(s).`
    );

    return successfulFeatures;
  }

  // STEP 4: Wait until General tab fields are visible AND populated.
  private async waitForGeneralTab(
    timeout = 30000
  ): Promise<void> {
    await expect(this.generalInfo).toBeVisible({
      timeout
    });

    const requiredFields = [
      '#acreage',
      '#wetlandType',
      '#wetlandCode'
    ];

    for (const selector of requiredFields) {
      const field = this.generalInfo.locator(selector);

      await expect(field).toBeVisible({
        timeout
      });

      await expect(field).not.toHaveText(/^\s*$/, {
        timeout
      });
    }
  }

  // STEP 5: Extract only General tab information.
  async extractGeneralTab(): Promise<WetlandDetails> {
    await this.waitForGeneralTab(30000);

    const acreageText = (
      await this.generalInfo.locator('#acreage').innerText()
    ).trim();

    const wetlandType = (
      await this.generalInfo.locator('#wetlandType').innerText()
    ).trim();

    const classification = (
      await this.generalInfo.locator('#wetlandCode').innerText()
    ).trim();

    const imageScaleLocator = this.generalInfo
      .locator('#imageScalePopup b')
      .first();

    const imageryTypeLocator = this.generalInfo
      .locator('#sourceTypePopup b')
      .nth(0);

    const imageYearLocator = this.generalInfo
      .locator('#sourceTypePopup b')
      .nth(1);

    await expect(imageScaleLocator).not.toHaveText(/^\s*$/);
    await expect(imageryTypeLocator).not.toHaveText(/^\s*$/);
    await expect(imageYearLocator).not.toHaveText(/^\s*$/);

    const imageScale = (await imageScaleLocator.innerText()).trim();
    const imageryType = (await imageryTypeLocator.innerText()).trim();
    const imageYearText = (await imageYearLocator.innerText()).trim();

    const acreage = Number(acreageText);
    const imageYear = Number(imageYearText);

    if (
      Number.isNaN(acreage) ||
      Number.isNaN(imageYear) ||
      !wetlandType ||
      !classification ||
      !imageScale ||
      !imageryType
    ) {
      throw new Error(
        'Invalid or incomplete information extracted from General tab. ' +
        JSON.stringify({
          acreageText,
          wetlandType,
          classification,
          imageScale,
          imageryType,
          imageYearText
        })
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
