"use strict";

// Pure gate helpers over a prefs snapshot. Most gates default true for missing
// snapshot / entry / flag so an install that predates a flag still runs.

function readFlag(snapshot, agentId, flag, defaultValue = true) {
  if (!agentId) return defaultValue;
  if (!snapshot || typeof snapshot !== "object") return defaultValue;
  const agents = snapshot.agents;
  if (!agents || typeof agents !== "object") return defaultValue;
  const entry = agents[agentId];
  if (!entry || typeof entry !== "object") return defaultValue;
  if (typeof entry[flag] !== "boolean") return defaultValue;
  return entry[flag];
}

const isAgentEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "enabled");
// Missing `integrationInstalled` defaults true only for legacy/un-normalized
// snapshots. Normal prefs snapshots carry an explicit v11 value for every
// registered agent, so fresh installs still follow prefs defaults.
const isAgentIntegrationInstalled = (snapshot, agentId) => (
  readFlag(snapshot, agentId, "integrationInstalled", true)
);
const shouldSyncAgentIntegration = (snapshot, agentId) => (
  isAgentEnabled(snapshot, agentId) && isAgentIntegrationInstalled(snapshot, agentId)
);
const isAgentPermissionsEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "permissionsEnabled");
// #451 sub-gate under permissionsEnabled: bubbles for PermissionRequests that
// fire from inside a Claude Code subagent (Task tool). Only claude-code's
// prefs entry carries the flag; other agents read default-true and are
// unaffected.
const isAgentSubagentPermissionsEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "subagentPermissionsEnabled");
const isAgentNotificationHookEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "notificationHookEnabled");
const isCodexNativeNotificationSoundEnabled = (snapshot) =>
  readFlag(snapshot, "codex", "nativeNotificationSoundEnabled", false);
function getCodexPermissionMode(snapshot) {
  const entry = snapshot && snapshot.agents && snapshot.agents.codex;
  if (entry && entry.permissionMode === "native") return "native";
  return "intercept";
}
const isCodexPermissionInterceptEnabled = (snapshot) => getCodexPermissionMode(snapshot) === "intercept";

module.exports = {
  getCodexPermissionMode,
  isAgentIntegrationInstalled,
  isAgentEnabled,
  isAgentPermissionsEnabled,
  isAgentSubagentPermissionsEnabled,
  isAgentNotificationHookEnabled,
  isCodexNativeNotificationSoundEnabled,
  isCodexPermissionInterceptEnabled,
  shouldSyncAgentIntegration,
};
