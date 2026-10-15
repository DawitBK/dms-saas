// SPRINT-1: realtime handshake must continue to use the auth token, but the token source changes with external JWTs.
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { io } from "socket.io-client";
import { SOCKET_PATH, SOCKET_URL } from "../shared/lib/apiConfig";
import { useAuthStore } from "../state/auth.store";
import { useRealtimeStore } from "../state/realtime.store";

// Module scope, not inside the component. It is a constant lookup table, and
// rebuilding it on every render made it a changing dependency of the socket
// effect below (react-hooks/exhaustive-deps), which is why the effect could
// not honestly list it.
const EVENT_TYPE_TO_QUERY_KEYS: Record<string, string[][]> = {
  "DOCUMENT.CREATED": [["documents"], ["documents-list"], ["document"], ["files-mine"], ["files-checked-out"], ["folders"], ["folder-contents"], ["folders-list"], ["stats"], ["dashboard-stats"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.STATUS_CHANGED": [["documents"], ["documents-list"], ["document"], ["folders"], ["folder-contents"], ["folders-list"], ["stats"], ["dashboard-stats"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.VERSION_UPLOADED": [["documents"], ["documents-list"], ["document"], ["versions"], ["folders"], ["folder-contents"], ["folders-list"], ["stats"], ["dashboard-stats"]],
  "DOCUMENT.UPDATED": [["documents"], ["documents-list"], ["document"], ["folders"], ["folder-contents"], ["folders-list"], ["stats"], ["dashboard-stats"]],
  "DOCUMENT.DELETED": [["documents"], ["documents-list"], ["document"], ["folders"], ["folder-contents"], ["folders-list"], ["trash"], ["stats"], ["dashboard-stats"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.TRASHED": [["documents"], ["documents-list"], ["document"], ["folders"], ["folder-contents"], ["folders-list"], ["trash"], ["stats"], ["dashboard-stats"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.RESTORED": [["documents"], ["documents-list"], ["document"], ["folders"], ["folder-contents"], ["folders-list"], ["trash"], ["stats"], ["dashboard-stats"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.ARCHIVED": [["documents"], ["documents-list"], ["document"], ["archive"], ["folders"], ["folder-contents"], ["stats"], ["dashboard-stats"]],
  "DOCUMENT.CHECKED_OUT": [["documents"], ["documents-list"], ["document"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.CHECKED_IN": [["documents"], ["documents-list"], ["document"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.LOCKED": [["documents"], ["documents-list"], ["document"]],
  "DOCUMENT.UNLOCKED": [["documents"], ["documents-list"], ["document"]],
  "DOCUMENT.OCR_COMPLETED": [["documents"], ["documents-list"], ["document"], ["ai"]],
  "DOCUMENT.AI_COMPLETED": [["documents"], ["documents-list"], ["document"], ["ai"]],
  "NOTIFICATION.CREATED": [["notifications"], ["notifications-count"]],
  "WORKFLOW.STARTED": [["workflow-tasks"], ["workflow-tasks-page"], ["workflow-instances"], ["workflow-instance"], ["documents"], ["documents-list"], ["my-work"], ["my-work-count"]],
  "WORKFLOW.TASK_ASSIGNED": [["workflow-tasks"], ["workflow-tasks-page"], ["workflow-instances"], ["workflow-instance"], ["documents"], ["documents-list"], ["my-work"], ["my-work-count"]],
  "WORKFLOW.TASK_COMPLETED": [["workflow-tasks"], ["workflow-tasks-page"], ["workflow-instances"], ["workflow-instance"], ["documents"], ["documents-list"], ["my-work"], ["my-work-count"]],
  "DOCUMENT.HOLD_APPLIED": [["documents"], ["documents-list"], ["document"], ["legal-holds"]],
  "DOCUMENT.HOLD_RELEASED": [["documents"], ["documents-list"], ["document"], ["legal-holds"]],
  "COMMENT.CREATED": [["comments"], ["document-comments"], ["document"]],
  "COMMENT.UPDATED": [["comments"], ["document-comments"], ["document"]],
  "COMMENT.DELETED": [["comments"], ["document-comments"], ["document"]],
  // CAMS letters — keep the archive list, letter detail and queues live.
  "LETTER.SUBMITTED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER.RETURNED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER.APPROVED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER.REGISTERED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["notifications"], ["notifications-count"], ["my-work"], ["my-work-count"]],
  "LETTER.DISPATCHED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"]],
  "LETTER.ARCHIVED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"]],
  "LETTER.ASSIGNED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["notifications"], ["notifications-count"], ["my-work"], ["my-work-count"]],
  "LETTER.RESPONDED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER.CLOSED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER.STEP_PENDING": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["notifications"], ["notifications-count"], ["my-work"], ["my-work-count"]],
  "LETTER.PENDING_SIGNATURE": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["signing"], ["my-work"], ["my-work-count"], ["notifications"], ["notifications-count"]],
  "LETTER.CANCELLED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_CANCELLED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_RETURNED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_RECALLED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_SLA_BREACH": [["letters"], ["letter"], ["my-work"], ["my-work-count"]],
  "LETTER_STEP_ESCALATED": [["letters"], ["letter"], ["my-work"], ["my-work-count"]],
  "LETTER_APPROVED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_SIGNED": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"]],
  "LETTER_STEP_PENDING": [["letters"], ["letter"], ["letter-links"], ["letter-volume-report"], ["my-work"], ["my-work-count"], ["notifications"], ["notifications-count"]],
  // Unified Approvals, E-signing & Forms
  "APPROVAL_CHAIN.UPDATED": [["approval-chain"], ["documents"], ["documents-list"], ["document"], ["forms"], ["form"], ["audit-review"], ["my-work"], ["my-work-count"], ["dashboard-stats"]],
  "SIGNING.UPDATED": [["signing"], ["documents"], ["documents-list"], ["document"], ["my-work"], ["my-work-count"], ["dashboard-stats"], ["notifications"], ["notifications-count"]],
  "FORM.SUBMITTED": [["forms"], ["form-instances"], ["documents"], ["documents-list"], ["my-work"], ["my-work-count"], ["dashboard-stats"]],
  "FORM_TEMPLATE.UPDATED": [["form-templates"], ["forms"]],
  "FOLDER.CREATED": [["folders"], ["folders-list"], ["folder-contents"], ["folder-tree"]],
  "FOLDER.UPDATED": [["folders"], ["folders-list"], ["folder-contents"], ["folder-tree"]],
  "FOLDER.DELETED": [["folders"], ["folders-list"], ["folder-contents"], ["folder-tree"]],
  "FOLDER.MOVED": [["folders"], ["folders-list"], ["folder-contents"], ["folder-tree"]],
  "USER.UPDATED": [["users"], ["user-detail"], ["roles"], ["roles-admin-list"]],
  "ROLE.UPDATED": [["roles"], ["roles-admin-list"], ["users"]],
};

export function RealtimeBridge() {
  const queryClient = useQueryClient();
  const { accessToken, userId, hydrated } = useAuthStore();
  // F-06: queries that the socket keeps fresh consult this instead of
  // polling unconditionally — see state/realtime.store.ts.
  const setConnected = useRealtimeStore((s) => s.setConnected);


  useEffect(() => {
    if (!hydrated || !accessToken || !userId) return;

    try {
      const socket = io(SOCKET_URL, {
        auth: { token: accessToken },
        // Behind the shared reverse proxy the PATH is the only thing that
        // distinguishes DMS's socket endpoint from its siblings' — see
        // SOCKET_PATH in shared/lib/apiConfig.ts for what went wrong without
        // it. Never hardcode "/socket.io" here.
        path: SOCKET_PATH,
        // WebSocket FIRST. Socket.IO's default transport order is
        // ["polling", "websocket"]: every connection opens as HTTP
        // long-polling and only then attempts an upgrade. That default is
        // wrong for this deployment in two ways. It makes long-polling the
        // primary transport for the opening seconds of every connection, and
        // if the upgrade is ever blocked (a proxy that does not pass Upgrade,
        // an intermediary that buffers) it stays on long-polling FOREVER
        // while still reporting itself connected — the exact "polling as the
        // mechanism" this pipeline exists to avoid. It also costs far more
        // under load: a long-poll is a fresh HTTP request per event
        // round-trip, and it requires sticky sessions the moment there is
        // more than one API process, because consecutive polls of one session
        // must land on the same process.
        //
        // "polling" is kept as the SECOND entry deliberately: it is the
        // degradation path for a network that genuinely cannot carry a
        // WebSocket, not the starting point.
        transports: ["websocket", "polling"],
        // Reconnect indefinitely with backoff. The defaults are already close
        // to this; stated explicitly because the fallback-poll design in
        // state/realtime.store.ts depends on the socket actually trying to
        // come back, rather than giving up and leaving the UI polling for the
        // rest of the session.
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
        timeout: 10_000,
      });

      socket.on("connect", () => {
        setConnected(true);
        // A reconnect means events were missed while the socket was down, so
        // the cache may be stale in ways no invalidation will announce. Refetch
        // the live queries once, then go back to being event-driven.
        queryClient.invalidateQueries({ queryKey: ["my-work"] });
        queryClient.invalidateQueries({ queryKey: ["my-work-count"] });
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
      });

      socket.on("disconnect", () => setConnected(false));

      socket.on("connect_error", (err) => {
        setConnected(false);
        console.warn("Socket connection error:", err);
      });

      socket.on("domain_event", (event: { type: string; payload: unknown }) => {
        const keys = EVENT_TYPE_TO_QUERY_KEYS[event.type];
        if (keys) {
          for (const key of keys) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        } else {
          console.warn("[RealtimeBridge] Unknown domain_event type:", event.type);
          queryClient.invalidateQueries({ queryKey: ["documents"] });
        }
        console.info("domain_event", event.type);
      });

      return () => {
        setConnected(false);
        socket.disconnect();
      };
    } catch (error) {
      console.warn("Failed to initialize socket:", error);
    }
  }, [accessToken, hydrated, queryClient, setConnected, userId]);

  return null;
}
