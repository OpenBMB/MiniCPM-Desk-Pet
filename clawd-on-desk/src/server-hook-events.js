"use strict";

const { resolveHookAgentId } = require("./server-agent-id");

const HOOK_EVENT_RING_SIZE_PER_AGENT = 50;
const HOOK_EVENT_OUTCOMES = new Set([
  "accepted",
  "dropped-by-disabled",
  "dropped-by-dnd",
]);
const HOOK_EVENT_ROUTES = new Set(["state", "permission"]);

function normalizeHookEventAgentId(data) {
  return resolveHookAgentId(data).agentId;
}

function normalizeHookEventType(data, route) {
  if (route === "permission") return "PermissionRequest";
  return data && typeof data.event === "string" && data.event
    ? data.event
    : null;
}

function recordHookEventInBuffer(buffer, data, route, outcome, options = {}) {
  try {
    if (!buffer || !HOOK_EVENT_ROUTES.has(route) || !HOOK_EVENT_OUTCOMES.has(outcome)) return null;
    const agentId = normalizeHookEventAgentId(data);
    const timestamp = typeof options.now === "function" ? options.now() : Date.now();
    const event = {
      timestamp,
      agentId,
      eventType: normalizeHookEventType(data, route),
      route,
      outcome,
    };
    const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0
      ? options.ringSize
      : HOOK_EVENT_RING_SIZE_PER_AGENT;
    const list = buffer.get(agentId) || [];
    list.push(event);
    while (list.length > ringSize) list.shift();
    buffer.set(agentId, list);
    return event;
  } catch {
    return null;
  }
}

function getRecentHookEventsFromBuffer(buffer, options = {}) {
  if (!buffer) return [];
  const since = Number.isFinite(options.since) ? options.since : null;
  const agentId = typeof options.agentId === "string" && options.agentId ? options.agentId : null;
  const source = agentId ? [buffer.get(agentId) || []] : [...buffer.values()];
  return source
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter((event) => !since || event.timestamp >= since)
    .map((event) => ({ ...event }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function createSingleRequestHookEventRecorder(recordFn, data, defaultRoute) {
  let recorded = false;
  function record(route, outcome) {
    const routeToUse = route || defaultRoute;
    if (
      recorded
      || typeof recordFn !== "function"
      || !HOOK_EVENT_ROUTES.has(routeToUse)
      || !HOOK_EVENT_OUTCOMES.has(outcome)
    ) {
      // Invalid route/outcome values stay no-op without consuming the single-flight slot.
      return null;
    }
    recorded = true;
    return recordFn(data, routeToUse, outcome);
  }
  return {
    record,
    accepted: (route) => record(route, "accepted"),
    droppedByDisabled: (route) => record(route, "dropped-by-disabled"),
    droppedByDnd: (route) => record(route, "dropped-by-dnd"),
    acceptedUnlessDnd: (dropForDnd, route) => (
      dropForDnd ? record(route, "dropped-by-dnd") : record(route, "accepted")
    ),
  };
}

module.exports = {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
};
