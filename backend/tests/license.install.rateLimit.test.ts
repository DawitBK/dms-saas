/**
 * POST /license/install is unauthenticated on purpose (contract section 9), so it is IP rate-limited: ten attempts a
 * minute, the eleventh answers 429 ERR-RATE-LIMIT and is not even looked at. Real express-rate-limit (in-memory store:
 * no Redis in tests); every other licence suite stubs the limiter so its own install calls do not count.
 */
import express from "express";
import request from "supertest";

// No Redis: the limiter uses express-rate-limit's own in-memory store, so the count is this process's alone (the dev Redis
// would carry the previous run's hits for up to a minute).
jest.mock("../src/infrastructure/cache/rateLimitStore.js", () => ({ createRedisRateLimitStore: () => undefined }));
jest.mock("../src/infrastructure/database/sequelize.js", () => ({ sequelize: { query: jest.fn() } }));

import { errorHandler } from "../src/shared/middleware.js";
import { licensePublicRoutes } from "../src/modules/license/license.routes.js";

function build() {
  const app: any = express();
  app.use(express.json());
  app.use("/api/v1", licensePublicRoutes);
  app.use(errorHandler);
  return app;
}

describe("POST /license/install rate limit", () => {
  it("allows ten attempts, then answers 429 with the standard rate-limit body", async () => {
    const app = build();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app).post("/api/v1/license/install").send({});
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body.error.code).toBe("ERR-RATE-LIMIT");
        expect(res.headers["ratelimit-limit"]).toBe("10");
      }
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
