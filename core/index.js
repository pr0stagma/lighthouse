/**
 * @license Copyright 2016 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import log from 'lighthouse-logger';

import {Runner} from './runner.js';
import {CriConnection} from './legacy/gather/connections/cri.js';
import {Config} from './legacy/config/config.js';
import UrlUtils from './lib/url-utils.js';
import {Driver} from './legacy/gather/driver.js';
import {initializeConfig} from './config/config.js';
import {UserFlow, auditGatherSteps} from './user-flow.js';
import {ReportGenerator} from '../report/generator/report-generator.js';
import {startTimespanGather} from './gather/timespan-runner.js';
import {snapshotGather} from './gather/snapshot-runner.js';
import {navigationGather} from './gather/navigation-runner.js';

/** @typedef {import('./legacy/gather/connections/connection.js').Connection} Connection */

/*
 * The relationship between these root modules:
 *
 *   index.js  - the require('lighthouse') hook for Node modules (including the CLI)
 *
 *   runner.js - marshalls the actions that must be taken (Gather / Audit)
 *               config file is used to determine which of these actions are needed
 *
 *         cli \
 *                         -- core/index.js ----> runner.js ----> [Gather / Audit]
 *                clients /
 */

/**
 * Run Lighthouse.
 * @param {string=} url The URL to test. Optional if running in auditMode.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @param {LH.Config.Json=} configJSON Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {LH.Puppeteer.Page=} page
 * @return {Promise<LH.RunnerResult|undefined>}
 */
async function lighthouse(url, flags = {}, configJSON, page) {
  return navigation(page, url, {config: configJSON, flags});
}

/**
 * Run Lighthouse using the legacy navigation runner.
 * This is left in place for any clients that don't support FR navigations yet (e.g. Lightrider)
 * @deprecated
 * @param {string=} url The URL to test. Optional if running in auditMode.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @param {LH.Config.Json=} configJSON Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {Connection=} userConnection
 * @return {Promise<LH.RunnerResult|undefined>}
 */
async function legacyNavigation(url, flags = {}, configJSON, userConnection) {
  // set logging preferences, assume quiet
  flags.logLevel = flags.logLevel || 'error';
  log.setLevel(flags.logLevel);

  const config = await generateLegacyConfig(configJSON, flags);
  const computedCache = new Map();
  const options = {config, computedCache};
  const connection = userConnection || new CriConnection(flags.port, flags.hostname);

  // kick off a lighthouse run
  const artifacts = await Runner.gather(() => {
    const requestedUrl = UrlUtils.normalizeUrl(url);
    return Runner._gatherArtifactsFromBrowser(requestedUrl, options, connection);
  }, options);
  return Runner.audit(artifacts, options);
}

/**
 * @param {LH.Puppeteer.Page} page
 * @param {LH.UserFlow.Options} [options]
 */
async function startFlow(page, options) {
  return new UserFlow(page, options);
}

/**
 * @param {LH.Puppeteer.Page|undefined} page
 * @param {LH.NavigationRequestor|undefined} requestor
 * @param {{config?: LH.Config.Json, flags?: LH.Flags}} [options]
 * @return {Promise<LH.RunnerResult|undefined>}
 */
async function navigation(page, requestor, options) {
  const gatherResult = await navigationGather(page, requestor, options);
  return Runner.audit(gatherResult.artifacts, gatherResult.runnerOptions);
}

/**
 * @param {LH.Puppeteer.Page} page
 * @param {{config?: LH.Config.Json, flags?: LH.Flags}} [options]
 * @return {Promise<LH.RunnerResult|undefined>}
 */
async function snapshot(page, options) {
  const gatherResult = await snapshotGather(page, options);
  return Runner.audit(gatherResult.artifacts, gatherResult.runnerOptions);
}

/**
 * @param {LH.Puppeteer.Page} page
 * @param {{config?: LH.Config.Json, flags?: LH.Flags}} [options]
 * @return {Promise<{endTimespan: () => Promise<LH.RunnerResult|undefined>}>}
 */
async function startTimespan(page, options) {
  const {endTimespanGather} = await startTimespanGather(page, options);
  const endTimespan = async () => {
    const gatherResult = await endTimespanGather();
    return Runner.audit(gatherResult.artifacts, gatherResult.runnerOptions);
  };
  return {endTimespan};
}

/**
 * @template {LH.Result|LH.FlowResult} R
 * @param {R} result
 * @param {[R] extends [LH.Result] ? LH.OutputMode : Exclude<LH.OutputMode, 'csv'>} [format]
 * @return {string}
 */
function generateReport(result, format = 'html') {
  const reportOutput = ReportGenerator.generateReport(result, format);
  if (Array.isArray(reportOutput)) {
    // In theory the output should never be an array.
    // This is mostly for type checking.
    return reportOutput[0];
  } else {
    return reportOutput;
  }
}

/**
 * @param {LH.UserFlow.FlowArtifacts} flowArtifacts
 * @param {LH.Config.Json} [config]
 */
async function auditFlowArtifacts(flowArtifacts, config) {
  const {gatherSteps, name} = flowArtifacts;
  return await auditGatherSteps(gatherSteps, {name, config});
}

/**
 * Generate a Lighthouse Config.
 * @param {LH.Config.Json=} configJson Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @param {LH.Gatherer.GatherMode=} gatherMode Gather mode used to collect artifacts. If present
 *   the config may override certain settings based on the mode.
 * @return {Promise<LH.Config.FRConfig>}
 */
async function generateConfig(configJson, flags = {}, gatherMode = 'navigation') {
  const {config} = await initializeConfig(gatherMode, configJson, flags);
  return config;
}

/**
 * Generate a legacy Lighthouse Config.
 * @deprecated
 * @param {LH.Config.Json=} configJson Configuration for the Lighthouse run. If
 *   not present, the default config is used.
 * @param {LH.Flags=} flags Optional settings for the Lighthouse run. If present,
 *   they will override any settings in the config.
 * @return {Promise<Config>}
 */
function generateLegacyConfig(configJson, flags) {
  return Config.fromJson(configJson, flags);
}

function getAuditList() {
  return Runner.getAuditList();
}

const traceCategories = Driver.traceCategories;

export default lighthouse;
export {Audit} from './audits/audit.js';
export {default as Gatherer} from './gather/base-gatherer.js';
export {NetworkRecords} from './computed/network-records.js';
export {default as defaultConfig} from './config/default-config.js';
export {default as desktopConfig} from './config/desktop-config.js';
export {
  legacyNavigation,
  startFlow,
  navigation,
  startTimespan,
  snapshot,
  generateReport,
  auditFlowArtifacts,
  generateConfig,
  generateLegacyConfig,
  getAuditList,
  traceCategories,
};
