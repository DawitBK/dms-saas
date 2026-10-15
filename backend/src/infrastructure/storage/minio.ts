import { Client } from "minio";
import { config } from "../../config/env.js";

export const minioClient = new Client({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY
});

/**
 * Create a bucket if it is missing. The catch is not redundant: `bucketExists`
 * itself throws on some S3-compatible backends when the bucket is absent,
 * rather than returning false.
 *
 * Callers decide what a failure means — `initializeStorage()` treats it as
 * "fall back to local disk", which is the platform's documented behaviour.
 */
export async function ensureBucket(name: string) {
  try {
    if (!(await minioClient.bucketExists(name))) {
      await minioClient.makeBucket(name);
    }
  } catch {
    await minioClient.makeBucket(name);
  }
}

export async function putObject(bucket: string, key: string, body: Buffer) {
  await minioClient.putObject(bucket, key, body);
}

export async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const stream = await minioClient.getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
