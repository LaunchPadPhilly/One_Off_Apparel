import type { RequestHandler } from '@sveltejs/kit';
import { createMcpHandler } from '$lib/server/mcp/handler';
import { mcpTools } from '$lib/server/mcp/tools';

/**
 * Thin same-origin passthrough. Production traffic goes to the standalone process in
 * src/mcp-server/index.ts; this route exists so a single-process deployment (or local
 * development without the second process) still serves MCP at the same path. All
 * protocol/auth logic lives in $lib/server/mcp/handler.ts, shared by both.
 */
const mcp = createMcpHandler(mcpTools);

export const GET: RequestHandler = ({ request }) => mcp.handleGet(request);
export const POST: RequestHandler = ({ request }) => mcp.handlePost(request);
