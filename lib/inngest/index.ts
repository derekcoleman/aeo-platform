export {
  inngest,
  auditRequested,
  auditCompleted,
  auditFailed,
  demandMineRequested,
  demandMineCompleted,
  serpTrackRequested,
  serpTrackCompleted,
  connectorSyncRequested,
  connectorSyncCompleted,
  connectorWebhookReceived,
  approvalDecided,
  contentPipelineRequested,
  contentPublished,
  contentPipelineFailed,
  approvalRequested,
  opportunitiesScanRequested,
  contextIngestRequested,
  contextIngestCompleted,
  contextFactsExtractRequested,
  contextFactsExtractCompleted,
  contextSignalsScanRequested,
  siteHealthCheckRequested,
  siteHealthChanged,
  sitePreflightRequested,
  sitePreflightCompleted,
  siteVerified,
  strategyCompetitorsAnalyzeRequested,
  publishingPushRequested,
} from "./client";
import { analyticsFunctions } from "./analytics";
import { auditFunction } from "./audit";
import { connectorFunctions } from "./connectors";
import { contextFunctions } from "./context";
import { demandFunctions } from "./demand";
import { pipelineFunctions } from "./pipeline";
import { publishingFunctions } from "./publishing";
import { retentionFunctions } from "./retention";
import { strategyFunctions } from "./strategy";
import { siteFunctions } from "./site";

/** Every function served from /api/inngest. Add new jobs here. */
export const functions = [auditFunction, ...demandFunctions, ...connectorFunctions, ...pipelineFunctions, ...contextFunctions, ...siteFunctions, ...analyticsFunctions, ...retentionFunctions, ...strategyFunctions, ...publishingFunctions];
