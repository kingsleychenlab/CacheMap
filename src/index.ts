/**
 * Public library API. Consumers can parse and analyze workflows programmatically
 * without going through the CLI.
 */
export { runEngine } from './engine.js';
export type { EngineOptions, EngineResult } from './engine.js';
export { parseWorkflow, WorkflowParseError } from './parser/workflow.js';
export { expandMatrix } from './parser/matrices.js';
export { buildGraph } from './graph/builder.js';
export { computeCriticalPath, detectCycles, markCriticalPath } from './graph/criticalPath.js';
export { analyzeWorkflow } from './analysis/runner.js';
export { loadConfig, parseConfig, configJsonSchema, ConfigError } from './config.js';
export type { ResolvedConfig } from './config.js';
export { renderTextReport } from './reports/text.js';
export { renderJsonReport, buildJsonReport } from './reports/json.js';
export { renderMarkdownReport } from './reports/markdown.js';
export { renderSarifReport, buildSarifReport } from './reports/sarif.js';
export { renderMermaid, renderDot, renderGraphJson } from './reports/graph.js';
export { JSON_SCHEMA_VERSION } from './reports/model.js';
export { VERSION, TOOL_NAME } from './version.js';
export * from './types.js';
