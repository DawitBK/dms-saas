// R-01 (audit 2026-09-03): behaviour AT and PAST the concurrency
// ceiling.
//
// tenantContext holds one pooled DB connection for the full lifetime of every
// authenticated request, so DB_POOL_MAX is a hard ceiling — and what used to
// happen at it was the real defect. Every request past the pool queued for
// DB_POOL_ACQUIRE_MS (30s) holding a socket, a parsed body and its whole async
// context, then failed with a 500 that told the caller not to retry. A burst
// became thousands of requests waiting half a minute to be refused, memory
// climbing, clients timing out and retrying into the same queue.
//
// Two mechanisms, tested here:
//   - admissionControl: refuse past the limit, immediately and cheaply, with
//     503 + Retry-After, and — critically — never leak a slot, since a leaked
//     slot ratchets the counter until the process refuses everything.
//   - isCapacityError: classify the three ways the DB says "not now" so they
//     surface as 503 rather than 500.

import type { NextFunction, Request, Response } from "express";
import { EventEmitter } from "node:events";

import {
  __resetAdmissionControl,
  admissionControl,
  currentInFlightRequests,
} from "../src/shared/middleware.js";
import { isCapacityError, isInvalidTextRepresentation } from "../src/shared/dbErrors.js";
import { config } from "../src/config/env.js";

/**
 * A Response double that behaves like the parts of Express's Response this
 * middleware touches: `once` for finish/close, and a chainable
 * status/json/setHeader.
 */
function makeRes() {
  const emitter = new EventEmitter();
  const captured = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    once: (event: string, listener: () => void) => {
      emitter.once(event, listener);
      return res;
    },
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
      return res;
    },
    status: (code: number) => {
      captured.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured, emit: (event: string) => emitter.emit(event) };
}

function makeReq(path = "/documents"): Request {
  return { path } as unknown as Request;
}

/** Admit one request; returns its response double so the caller can finish it. */
function admit(): { passed: boolean; finish: () => void; close: () => void; captured: ReturnType<typeof makeRes>["captured"] } {
  const { res, captured, emit } = makeRes();
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  admissionControl(makeReq(), res, next);
  return { passed, finish: () => emit("finish"), close: () => emit("close"), captured };
}

describe("R-01 admission control", () => {
  beforeEach(() => {
    __resetAdmissionControl();
  });

  afterAll(() => {
    __resetAdmissionControl();
  });

  // The limit is derived rather than configured by default, so the tests must
  // agree with the derivation instead of hardcoding a number.
  const limit = config.REQUEST_ADMISSION_MAX > 0 ? config.REQUEST_ADMISSION_MAX : config.DB_POOL_MAX * 2;

  it("derives its limit as DB_POOL_MAX * 2 when REQUEST_ADMISSION_MAX is 0", () => {
    // Guards the default: one queued request per pooled connection. If this
    // ever became DB_POOL_MAX exactly, the pool would be refused work it could
    // have absorbed; if it became unbounded, the queue-collapse this exists to
    // prevent comes back.
    expect(config.REQUEST_ADMISSION_MAX).toBe(0);
    expect(limit).toBe(config.DB_POOL_MAX * 2);
  });

  it("admits requests up to the limit", () => {
    const admitted = Array.from({ length: limit }, () => admit());
    expect(admitted.every((a) => a.passed)).toBe(true);
    expect(currentInFlightRequests()).toBe(limit);
  });

  it("sheds the request past the limit with 503 and Retry-After", () => {
    const held = Array.from({ length: limit }, () => admit());
    expect(held.every((a) => a.passed)).toBe(true);

    const shed = admit();
    expect(shed.passed).toBe(false);
    expect(shed.captured.statusCode).toBe(503);
    expect(shed.captured.headers["Retry-After"]).toBe("1");
    expect(shed.captured.body).toEqual({
      error: {
        code: "ERR-OVERLOADED",
        message: expect.stringContaining("too many requests"),
      },
    });
  });

  it("does not count a shed request against the in-flight total", () => {
    // A shed request never got a slot, so it must not hold one — otherwise a
    // sustained overload would push the counter past the limit permanently and
    // the process would never recover.
    Array.from({ length: limit }, () => admit());
    expect(currentInFlightRequests()).toBe(limit);
    admit();
    admit();
    expect(currentInFlightRequests()).toBe(limit);
  });

  it("releases the slot when the response finishes", () => {
    const first = admit();
    expect(currentInFlightRequests()).toBe(1);
    first.finish();
    expect(currentInFlightRequests()).toBe(0);
  });

  it("releases the slot when the client disconnects before a response", () => {
    // "close" without "finish" is an aborted request — a user navigating away
    // mid-upload. Without this the slot would leak on every abort, which is
    // the most common way a real deployment drifts into refusing everything.
    const first = admit();
    expect(currentInFlightRequests()).toBe(1);
    first.close();
    expect(currentInFlightRequests()).toBe(0);
  });

  it("releases a slot exactly once when both finish and close fire", () => {
    // Express emits both for a normal response. Releasing twice would drive
    // the counter negative and hand out more concurrency than the pool has.
    const first = admit();
    first.finish();
    first.close();
    expect(currentInFlightRequests()).toBe(0);

    // And the reverse order, which is what an abort-then-teardown looks like.
    const second = admit();
    second.close();
    second.finish();
    expect(currentInFlightRequests()).toBe(0);
  });

  it("admits again once capacity frees up", () => {
    const held = Array.from({ length: limit }, () => admit());
    expect(admit().passed).toBe(false);

    held[0].finish();
    expect(currentInFlightRequests()).toBe(limit - 1);

    const afterRelease = admit();
    expect(afterRelease.passed).toBe(true);
    expect(currentInFlightRequests()).toBe(limit);
  });

  it("never drives the in-flight count negative", () => {
    const first = admit();
    first.finish();
    first.finish();
    first.close();
    expect(currentInFlightRequests()).toBe(0);
    expect(currentInFlightRequests()).toBeGreaterThanOrEqual(0);
  });
});

describe("R-01 capacity-error classification", () => {
  it("classifies a Sequelize pool-acquire timeout as capacity", () => {
    const error = Object.assign(new Error("Operation timeout"), {
      name: "SequelizeConnectionAcquireTimeoutError",
    });
    expect(isCapacityError(error)).toBe(true);
  });

  it("classifies the un-prefixed ConnectionAcquireTimeoutError name too", () => {
    // Sequelize exports the class as ConnectionAcquireTimeoutError but stamps
    // instances with the Sequelize-prefixed name; accept both rather than
    // depending on which one a given version produces.
    const error = Object.assign(new Error("Operation timeout"), {
      name: "ConnectionAcquireTimeoutError",
    });
    expect(isCapacityError(error)).toBe(true);
  });

  it("classifies 57014 query_canceled as capacity", () => {
    // What DB_STATEMENT_TIMEOUT_MS produces.
    expect(isCapacityError({ code: "57014" })).toBe(true);
  });

  it("classifies 25P03 idle_in_transaction_session_timeout as capacity", () => {
    // What DB_IDLE_IN_TRANSACTION_TIMEOUT_MS produces.
    expect(isCapacityError({ code: "25P03" })).toBe(true);
  });

  it("sees through Sequelize's wrapping on both .parent and .original", () => {
    // A statement timeout reaches application code wrapped in a
    // SequelizeDatabaseError, so classifying only the top-level error would
    // miss every real occurrence.
    expect(isCapacityError({ name: "SequelizeDatabaseError", parent: { code: "57014" } })).toBe(true);
    expect(isCapacityError({ name: "SequelizeDatabaseError", original: { code: "25P03" } })).toBe(true);
  });

  it("does not classify a malformed-id error as capacity", () => {
    // 22P02 is a 400 (a bad UUID in the path), and must not be turned into a
    // 503 that tells the client to retry a request that can never succeed.
    const malformed = { code: "22P02" };
    expect(isInvalidTextRepresentation(malformed)).toBe(true);
    expect(isCapacityError(malformed)).toBe(false);
  });

  it("does not classify ordinary failures as capacity", () => {
    expect(isCapacityError(new Error("boom"))).toBe(false);
    expect(isCapacityError({ code: "23505" })).toBe(false); // unique_violation
    expect(isCapacityError({ name: "SequelizeValidationError" })).toBe(false);
    expect(isCapacityError(null)).toBe(false);
    expect(isCapacityError(undefined)).toBe(false);
    expect(isCapacityError("57014")).toBe(false);
  });
});

describe("R-01 per-request transaction bounds", () => {
  it("caps a single statement well below the pool acquire timeout", () => {
    // If a statement could outlive DB_POOL_ACQUIRE_MS, a wedged query would
    // starve the pool for longer than a waiting request is willing to queue —
    // so the waiters fail while the connection is still held. The statement
    // cap has to be the tighter of the two.
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(config.DB_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(config.DB_POOL_ACQUIRE_MS);
  });

  it("allows an idle transaction longer than a single statement", () => {
    // The request transaction is legitimately idle while a handler awaits
    // non-DB I/O — a ClamAV scan, PDF rendering, a MinIO round-trip. If this
    // cap were at or below the statement cap it would abort healthy uploads,
    // which is a far worse failure than the one it guards against.
    expect(config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(config.DB_STATEMENT_TIMEOUT_MS);
  });
});
