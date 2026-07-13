/**
 * Single source of truth for the tool version. Kept in sync with package.json
 * by the release process. Imported by reports and the CLI so the version is
 * available without reading package.json at runtime (which differs between the
 * dev, dist, and bundled-Action layouts).
 */
export const VERSION = '0.1.0';
export const TOOL_NAME = 'cachemap';
