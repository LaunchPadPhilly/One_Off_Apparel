import './load-env.ts';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '$lib/server/mcp/handler';
import { mcpTools } from '$lib/server/mcp/tools';
import { mcpServerName } from '$lib/appConfig';
import { maybeRefreshFormulas, reloadFormulas } from '$lib/server/engine/formulaSettings';

const mcp = createMcpHandler(mcpTools);

// The estimate formulas admins edit at Settings → Formulas live in the database. The web
// app loads them in hooks.server.ts; this process has to do the same, or every estimate
// Claude sees would use the built-in default rates. Never throws (keeps the defaults if
// the database isn't reachable yet); each request below refreshes them once stale.
void reloadFormulas();

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

async function toWebRequest(req: IncomingMessage): Promise<Request> {
	const url = `http://${req.headers.host ?? `${host}:${port}`}${req.url}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}

	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	return new Request(url, {
		method: req.method,
		headers,
		body: hasBody ? (req as unknown as BodyInit) : undefined,
		duplex: hasBody ? 'half' : undefined
	} as RequestInit);
}

async function sendWebResponse(response: Response, res: ServerResponse) {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => res.setHeader(key, value));

	if (!response.body) {
		res.end();
		return;
	}

	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		res.write(value);
	}
	res.end();
}

const server = createServer((req, res) => {
	void (async () => {
		try {
			if (req.url === '/health') {
				res.statusCode = 200;
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ ok: true }));
				return;
			}

			if (req.url !== '/api/mcp') {
				res.statusCode = 404;
				res.end('Not found');
				return;
			}

			maybeRefreshFormulas();
			const webRequest = await toWebRequest(req);
			const webResponse =
				req.method === 'GET' ? await mcp.handleGet(webRequest) : await mcp.handlePost(webRequest);
			await sendWebResponse(webResponse, res);
		} catch (error) {
			console.error('mcp-server request failed:', error);
			if (!res.headersSent) res.statusCode = 500;
			res.end('Internal server error');
		}
	})();
});

server.listen(port, host, () => {
	console.log(`${mcpServerName} listening on ${host}:${port}`);
});
