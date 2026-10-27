import { createServer } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const server = createServer(env.API_PORT);

console.info(`API listening on ${server.url}`);
