import { RedisClient } from "bun";
import { createServer } from "./app.ts";
import { loadEnv } from "./env.ts";
import { createRedisStore, keepConnected } from "./lib/kv/redis.ts";

const env = loadEnv();
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);
const server = createServer({ port: env.API_PORT, kv: createRedisStore(redis) });

console.info(`API listening on ${server.url}`);
