"use strict";

(function initSettingsTabAbout(root) {
  let runtime = null;
  let helpers = null;
  let ops = null;

  function t(key) {
    return helpers.t(key);
  }

  function fetchAboutInfo() {
    if (runtime.about.infoCache) return Promise.resolve(runtime.about.infoCache);
    if (!window.settingsAPI || typeof window.settingsAPI.getAboutInfo !== "function") {
      return Promise.resolve(null);
    }
    return window.settingsAPI.getAboutInfo().then((info) => {
      runtime.about.infoCache = info;
      return info;
    }).catch(() => null);
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
      text.textContent = parts.join(" \u00b7 ");
      value.appendChild(text);
    }

    if (info.upstreamRepoUrl && info.upstreamLabel) {
      if (value.childNodes.length > 0) {
        value.appendChild(document.createTextNode(" \u00b7 "));
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
      vvWrap.appendChild(vv);
      vvWrap.appendChild(updateBtn);
      versionRow.appendChild(vl);
      versionRow.appendChild(vvWrap);
      infoSection.appendChild(versionRow);

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
