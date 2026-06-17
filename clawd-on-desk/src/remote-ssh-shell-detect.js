"use strict";

// ── Remote SSH shell-type probe ──
//
// All of Remote SSH's deploy/monitor/probe commands assume a POSIX shell
// on the remote (`mkdir -p`, `~/...` tilde expansion, `sh -c`, `nohup &`,
// `node -e`). Windows OpenSSH server with its default cmd.exe shell
// silently rejects every one of these — the symptom is a string of
// CP936/GBK error bytes that decode to mojibake locally and a hook stack
// that never installs.
//
// This module runs one cheap probe after connect to classify the remote:
//
//   { ok: true,  shell: "posix",       os: "Linux"|"Darwin"|... }
//   { ok: true,  shell: "windows-cmd", os: "windows" }
//   { ok: false, shell: "unknown",     stderr?: <decoded> }
//
// The probe is two ssh round-trips at worst (POSIX → 1, Windows → 2). It
// shares the same `buildSshArgs` plumbing so non-default-port and
// identityFile profiles work; it never throws, so a probe failure leaves
// the connect/deploy flow to whatever error path was already there.

const childProcess = require("child_process");
const { decodeShellBytes } = require("./remote-ssh-decode");

const PROBE_TIMEOUT_MS = 15000;

const POSIX_OS_RX = /^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|SunOS|AIX|CYGWIN|MINGW|MSYS)/i;

function spawnAndWait(spawn, command, args, opts = {}) {
  const { timeoutMs = PROBE_TIMEOUT_MS, runtime } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, signal: null, stdout: "", stderr: (err && err.message) || "spawn failed" });
      return;
    }
    if (runtime && typeof runtime.registerChild === "function") {
      runtime.registerChild(child);
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch {}
    }, timeoutMs);
    function finish(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (runtime && typeof runtime.unregisterChild === "function") {
        runtime.unregisterChild(child);
      }
      resolve(payload);
    }
    if (child.stdout) child.stdout.on("data", (d) => { stdoutChunks.push(d); });
    if (child.stderr) child.stderr.on("data", (d) => { stderrChunks.push(d); });
    if (child.stdin) { try { child.stdin.end(); } catch {} }
    child.on("error", (err) => {
      finish({
        code: -1,
        signal: null,
        stdout: decodeShellBytes(stdoutChunks),
        stderr: decodeShellBytes(stderrChunks) || (err && err.message) || "process error",
      });
    });
    child.on("exit", (code, signal) => {
      finish({
        code,
        signal,
        stdout: decodeShellBytes(stdoutChunks),
        stderr: decodeShellBytes(stderrChunks),
      });
    });
  });
}

async function detectRemoteShell({ profile, spawn, buildSshArgs, runtime, deps = {} }) {
  if (!profile) throw new Error("detectRemoteShell: profile required");
  if (typeof buildSshArgs !== "function") {
    throw new Error("detectRemoteShell: buildSshArgs required");
  }
  const spawnFn = spawn || (deps.spawn || childProcess.spawn);

  // POSIX probe — `uname -s` is the canonical "what kernel are you" check
  // and exists on every POSIX system Clawd targets. cmd.exe responds with
  // "'uname' is not recognized…" and non-zero exit, so a 0/Linux response
  // is a strong POSIX signal.
  const posixArgs = buildSshArgs(profile).concat(["uname -s"]);
  const posix = await spawnAndWait(spawnFn, "ssh", posixArgs, { runtime });
  if (posix.code === 0) {
    const firstLine = String(posix.stdout || "").trim().split(/\r?\n/)[0] || "";
    if (POSIX_OS_RX.test(firstLine)) {
      return { ok: true, shell: "posix", os: firstLine };
    }
  }

  // Windows cmd probe — `ver` is a cmd.exe builtin that prints
  // "Microsoft Windows [Version …]". A POSIX shell would error out
  // ("ver: command not found"), so a 0/"Microsoft Windows" response
  // confirms cmd.exe.
  const winArgs = buildSshArgs(profile).concat(["ver"]);
  const win = await spawnAndWait(spawnFn, "ssh", winArgs, { runtime });
  if (win.code === 0 && /Microsoft Windows/i.test(win.stdout || "")) {
    return { ok: true, shell: "windows-cmd", os: "windows" };
  }

  // Unknown — could be PowerShell-as-default, fish without coreutils,
  // restricted shell, or a transient network blip. Caller decides whether
  // to abort or proceed; deploy treats unknown as "proceed, the existing
  // POSIX command would have failed loudly anyway".
  return {
    ok: false,
    shell: "unknown",
    stderr: posix.stderr || win.stderr || null,
  };
}

module.exports = {
  detectRemoteShell,
  PROBE_TIMEOUT_MS,
  POSIX_OS_RX,
};
