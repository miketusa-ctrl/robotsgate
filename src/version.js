// Single source of the deployed version (v0.2.9: split out of app.js so mcp.js / agentdocs.js can import it
// without a circular import). app.js re-exports it, so `import { VERSION } from './app.js'` keeps working.
export const VERSION = '0.3.2';
