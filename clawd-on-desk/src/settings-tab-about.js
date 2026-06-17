"use strict";

(function initSettingsTabAbout(root) {
  let runtime = null;
  let helpers = null;
  let ops = null;

  function t(key) {
    return helpers.t(key);
  }

  function formatVersionForMessage(version) {
    return String(version || "").replace(/^v/i, "");
  }

  const STATIC_ABOUT_KEYS = ["repoUrl", "modelRepoUrl", "license", "copyright", "upstreamRepoUrl", "upstreamLabel", "heroSvgContent"];
  function fetchAboutInfo() {
    if (!window.settingsAPI || typeof window.settingsAPI.getAboutInfo !== "function") {
      return Promise.resolve(runtime.about.infoCache || null);
    }
    return window.settingsAPI.getAboutInfo().then((info) => {
      if (!info) return runtime.about.infoCache || null;
      const merged = { ...(runtime.about.infoCache || {}) };
      for (const key of STATIC_ABOUT_KEYS) {
        if (info[key] != null) merged[key] = info[key];
      }
      merged.version = info.version;
      merged.appName = info.appName;
      merged.pendingUpdateVersion = info.pendingUpdateVersion || "";
      merged.autoUpdateCheck = info.autoUpdateCheck !== false;
      runtime.about.infoCache = merged;
      return merged;
    }).catch(() => runtime.about.infoCache || null);
  }

  function handleAboutLogoClick(logoWrap) {
    const slot = logoWrap.querySelector("#shake-slot");
    if (slot) {
      slot.classList.remove("shake");
      void slot.getBoundingClientRect();
      slot.classList.add("shake");
      const onEnd = () => {
        slot.classList.remove("shake");
        slot.removeEventListener("animationend", onEnd);
      };
      slot.addEventListener("animationend", onEnd);
    }
    runtime.about.clickCount++;
    if (runtime.about.clickCount >= 7) {
      runtime.about.clickCount = 0;
      ops.showToast(t("aboutEasterEggToast"), { ttl: 5000 });
    }
  }

  function buildAboutLinkRow(label, url, displayText) {
    const row = document.createElement("div");
    row.className = "about-info-row";
    const l = document.createElement("div");
    l.className = "about-info-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "about-info-value";
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = displayText;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      helpers.openExternalSafe(url);
    });
    v.appendChild(a);
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function buildAboutLicenseRow(info) {
    const row = document.createElement("div");
    row.className = "about-info-row";
    const label = document.createElement("div");
    label.className = "about-info-label";
    label.textContent = t("aboutLicenseLabel");
    const value = document.createElement("div");
    value.className = "about-info-value about-license-value";

    const parts = [];
    if (info.license) parts.push(info.license);
    if (info.copyright) parts.push(info.copyright);

    if (parts.length > 0) {
      const text = document.createElement("span");
      text.textContent = parts.join(" · ");
      value.appendChild(text);
    }

    if (info.upstreamRepoUrl && info.upstreamLabel) {
      if (value.childNodes.length > 0) {
        value.appendChild(document.createTextNode(" · "));
      }
      const prefix = document.createElement("span");
      prefix.textContent = t("aboutBasedOnUpstream") + " ";
      value.appendChild(prefix);
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = info.upstreamLabel;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        helpers.openExternalSafe(info.upstreamRepoUrl);
      });
      value.appendChild(link);
    }

    row.appendChild(label);
    row.appendChild(value);
    return row;
  }

  function formatCleanupSummary(result) {
    const summary = result && result.cleanup && result.cleanup.summary;
    if (!summary) return t("aboutCleanupSuccess");
    const failed = Number(summary.failed || 0);
    let text = t("aboutCleanupSuccess")
      .replace("{removed}", String(Number(summary.entriesRemoved || 0)))
      .replace("{affected}", String(Number(summary.agentsAffected || 0)))
      .replace("{failed}", String(failed));
    const hasKiroNote = Array.isArray(result.cleanup.agents)
      && result.cleanup.agents.some((agent) =>
        agent
        && agent.agentId === "kiro-cli"
        && Array.isArray(agent.notes)
        && agent.notes.length > 0
      );
    if (hasKiroNote) text += " " + t("aboutCleanupKiroNote");
    return text;
  }

  function createCleanupFooterAction() {
    const wrap = document.createElement("div");
    wrap.className = "about-cleanup-wrap";
    const button = document.createElement("button");
    button.className = "about-cleanup-button";
    button.type = "button";
    button.textContent = t("aboutCleanupButton");
    const status = document.createElement("div");
    status.className = "about-cleanup-status";

    button.addEventListener("click", () => {
      if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") return;
      if (typeof window.confirm !== "function") {
        status.textContent = t("aboutCleanupFailed");
        return;
      }
      if (!window.confirm(t("aboutCleanupConfirm"))) return;
      button.disabled = true;
      button.textContent = t("aboutCleanupRunning");
      status.textContent = "";
      window.settingsAPI.command("cleanupIntegrations")
        .then((result) => {
          if (!result || result.status !== "ok") {
            throw new Error((result && result.message) || t("aboutCleanupFailed"));
          }
          const message = formatCleanupSummary(result);
          status.textContent = message;
          ops.showToast(message, { ttl: 7000 });
        })
        .catch((err) => {
          const message = t("aboutCleanupFailed") + (err && err.message ? ": " + err.message : "");
          status.textContent = message;
          ops.showToast(message, { ttl: 7000 });
        })
        .finally(() => {
          button.disabled = false;
          button.textContent = t("aboutCleanupButton");
        });
    });

    wrap.appendChild(button);
    wrap.appendChild(status);
    return wrap;
  }

  function render(parent) {
    const hero = document.createElement("div");
    hero.className = "about-hero";

    const logoWrap = document.createElement("div");
    logoWrap.className = "about-logo-wrap";
    logoWrap.title = "MiniCPM";

    const title = document.createElement("h2");
    title.className = "about-title";
    title.textContent = "MiniCPM Desk Pet";

    const tagline = document.createElement("p");
    tagline.className = "about-tagline";
    tagline.textContent = t("aboutTagline");

    hero.appendChild(logoWrap);
    hero.appendChild(title);
    hero.appendChild(tagline);
    parent.appendChild(hero);

    const infoSection = document.createElement("section");
    infoSection.className = "section";
    parent.appendChild(infoSection);

    const footer = document.createElement("div");
    footer.className = "about-footer";
    footer.textContent = t("aboutFooter");
    parent.appendChild(footer);
    parent.appendChild(createCleanupFooterAction());

    fetchAboutInfo().then((info) => {
      const safe = info || {};

      if (safe.appName) title.textContent = safe.appName;

      if (safe.heroSvgContent) {
        logoWrap.innerHTML = safe.heroSvgContent;
      }
      logoWrap.addEventListener("click", () => handleAboutLogoClick(logoWrap));

      infoSection.innerHTML = "";

      const versionRow = document.createElement("div");
      versionRow.className = "about-info-row";
      const vl = document.createElement("div");
      vl.className = "about-info-label";
      vl.textContent = t("aboutVersionLabel");
      const vvWrap = document.createElement("div");
      vvWrap.style.display = "flex";
      vvWrap.style.alignItems = "center";
      vvWrap.style.gap = "10px";
      const vv = document.createElement("span");
      vv.className = "about-info-value";
      vv.textContent = "v" + (safe.version || "?");
      vvWrap.appendChild(vv);
      if (safe.pendingUpdateVersion) {
        const hint = document.createElement("span");
        hint.className = "about-update-hint";
        hint.textContent = "· " + t("aboutUpdateAvailableHint").replace(
          "{version}",
          formatVersionForMessage(safe.pendingUpdateVersion)
        );
        hint.style.cursor = "pointer";
        hint.addEventListener("click", () => {
          if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
          window.settingsAPI.checkForUpdates().catch(() => {});
        });
        vvWrap.appendChild(hint);
      }
      const updateBtn = document.createElement("button");
      updateBtn.className = "about-check-update-btn";
      updateBtn.textContent = t("aboutCheckForUpdates");
      updateBtn.addEventListener("click", () => {
        if (!window.settingsAPI || typeof window.settingsAPI.checkForUpdates !== "function") return;
        updateBtn.disabled = true;
        window.settingsAPI.checkForUpdates()
          .catch(() => {})
          .finally(() => { updateBtn.disabled = false; });
      });
      vvWrap.appendChild(updateBtn);
      versionRow.appendChild(vl);
      versionRow.appendChild(vvWrap);
      infoSection.appendChild(versionRow);

      const autoUpdateRow = document.createElement("div");
      autoUpdateRow.className = "about-info-row";
      const autoUpdateLabelWrap = document.createElement("div");
      autoUpdateLabelWrap.className = "about-info-label";
      const autoUpdateLabel = document.createElement("div");
      autoUpdateLabel.textContent = t("autoUpdateCheck");
      const autoUpdateDesc = document.createElement("div");
      autoUpdateDesc.className = "about-info-description";
      autoUpdateDesc.textContent = t("autoUpdateCheckDescription");
      autoUpdateDesc.style.opacity = "0.7";
      autoUpdateDesc.style.fontSize = "12px";
      autoUpdateLabelWrap.appendChild(autoUpdateLabel);
      autoUpdateLabelWrap.appendChild(autoUpdateDesc);
      const autoUpdateValue = document.createElement("div");
      autoUpdateValue.className = "about-info-value";
      const autoUpdateBox = document.createElement("input");
      autoUpdateBox.type = "checkbox";
      autoUpdateBox.checked = safe.autoUpdateCheck !== false;
      autoUpdateBox.addEventListener("change", () => {
        if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") return;
        window.settingsAPI.update("autoUpdateCheck", autoUpdateBox.checked).catch(() => {});
      });
      autoUpdateValue.appendChild(autoUpdateBox);
      autoUpdateRow.appendChild(autoUpdateLabelWrap);
      autoUpdateRow.appendChild(autoUpdateValue);
      infoSection.appendChild(autoUpdateRow);

      if (safe.repoUrl) {
        infoSection.appendChild(buildAboutLinkRow(
          t("aboutRepositoryLabel"),
          safe.repoUrl,
          safe.repoUrl.replace(/^https?:\/\//, "")
        ));
      }

      if (safe.modelRepoUrl) {
        infoSection.appendChild(buildAboutLinkRow(
          t("aboutModelRepositoryLabel"),
          safe.modelRepoUrl,
          safe.modelRepoUrl.replace(/^https?:\/\//, "")
        ));
      }

      if (safe.license || safe.copyright || safe.upstreamRepoUrl) {
        infoSection.appendChild(buildAboutLicenseRow(safe));
      }
    });
  }

  function init(core) {
    runtime = core.runtime;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.about = {
      render,
    };
  }

  root.ClawdSettingsTabAbout = { init };
})(globalThis);
