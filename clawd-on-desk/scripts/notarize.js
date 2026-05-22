const { notarize } = require("@electron/notarize");
const { execFileSync } = require("child_process");
const path = require("path");

/**
 * electron-builder afterSign hook.
 *
 * Notarizes the macOS .app bundle via Apple's notarytool.
 * Skipped automatically when the required env vars are absent,
 * so local builds without credentials still work.
 *
 * Required env vars (set as GitHub Actions secrets for CI):
 *   APPLE_ID                    – Apple ID email
 *   APPLE_APP_SPECIFIC_PASSWORD – app-specific password (https://appleid.apple.com)
 *   APPLE_TEAM_ID               – 10-char Team ID from Apple Developer portal
 */
module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      "⏭  Skipping notarization — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`🔏 Notarizing ${appPath} ...`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
    tool: "notarytool",
  });

  console.log(`✅ Notarization complete: ${appPath}`);

  // Staple the notarization ticket onto the .app so Gatekeeper can verify
  // it offline. Without this, the first launch on a fresh machine has to
  // phone home to Apple — and the DMG would have an un-stapled .app
  // inside, which is what currently causes spctl to reject the DMG.
  console.log(`📎 Stapling ticket to ${appPath} ...`);
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log(`✅ Stapled: ${appPath}`);
};
