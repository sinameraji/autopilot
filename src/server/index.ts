/**
 * KimiFlare headless HTTP server.
 *
 * Provides a local REST API + SSE event stream for CI integration,
 * editor plugins, and scripting. Built on Node's built-in `http` module
 * to avoid extra dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { KimiConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { setupRoutes } from "./routes.js";
import type { AsterApiRuntime } from "./aster-api.js";

export interface ServerOpts {
  port: number;
  hostname: string;
  config: KimiConfig;
  /** Injectable Aster runtime; defaults to the Hotcell-backed runtime when its env is configured. */
  asterRuntime?: AsterApiRuntime;
}

export async function startServer(opts: ServerOpts): Promise<Server> {
  const { handleRequest, cleanup } = setupRoutes(opts.config, { asterRuntime: opts.asterRuntime });

  const server = createServer((req, res) => {
    const isAsterApi = req.url?.startsWith("/api/v1/") === true;
    if (!isAsterApi) {
      // Legacy local API CORS. Aster is native and deliberately has no wildcard CORS policy.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
    }

    if (req.method === "OPTIONS" && !isAsterApi) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Legacy local API Basic auth. The versioned Aster API authenticates its own scoped bearer token.
    const password = process.env.KIMIFLARE_SERVER_PASSWORD;
    if (!isAsterApi && password) {
      const auth = req.headers.authorization ?? "";
      const expected = "Basic " + Buffer.from(`kimiflare:${password}`).toString("base64");
      if (auth !== expected) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="kimiflare"' });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    void handleRequest(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  server.on("close", () => {
    cleanup();
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("server: shutting down gracefully");
    server.close(() => {
      cleanup();
      process.exit(0);
    });
    // Force close after 10s
    setTimeout(() => {
      logger.warn("server: forced shutdown");
      process.exit(1);
    }, 10000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise((resolve, reject) => {
    server.listen(opts.port, opts.hostname, () => {
      logger.info("server: listening", { hostname: opts.hostname, port: opts.port });
      console.log(`kimiflare serve: http://${opts.hostname}:${opts.port}`);
      console.log(`  API docs: http://${opts.hostname}:${opts.port}/doc`);
      console.log(`  SSE stream: http://${opts.hostname}:${opts.port}/event`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
