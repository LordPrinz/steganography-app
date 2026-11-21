import { createDb, createRefreshTokenRepository, createUserRepository } from "@stego/db";
import { createRedisStore, keepConnected } from "@stego/kv";
import { createS3ObjectStore } from "@stego/storage";
import { RedisClient } from "bun";
import { createServer } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const redis = new RedisClient(env.REDIS_URL, { enableOfflineQueue: false });
keepConnected(redis);
const storage = createS3ObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
const db = createDb(env.DATABASE_URL);
const server = createServer({
  port: env.API_PORT,
  kv: createRedisStore(redis),
  storage,
  users: createUserRepository(db),
  refreshTokens: createRefreshTokenRepository(db),
  jwtSecret: env.JWT_SECRET,
  appOrigin: env.APP_ORIGIN,
  trustedProxies: env.TRUSTED_PROXIES,
});

console.info(`API listening on ${server.url}`);
