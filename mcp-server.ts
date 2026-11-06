#!/usr/bin/env bun
process.env.HONCHO_HOST = process.env.HONCHO_HOST || "jcode";
import { runMcpServer } from "./src/mcp/server.js";
await runMcpServer();
