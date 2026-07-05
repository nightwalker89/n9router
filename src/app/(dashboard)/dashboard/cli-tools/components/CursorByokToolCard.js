"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Input } from "@/shared/components";

const TERMINAL_STATUSES = new Set(["success", "error"]);
const STEP_BADGES = {
  pending: { variant: "default", label: "Pending" },
  running: { variant: "info", label: "Running" },
  waiting: { variant: "warning", label: "Waiting" },
  success: { variant: "success", label: "Done" },
  error: { variant: "error", label: "Failed" },
};

function StatusBadge({ status }) {
  if (!status) return <Badge size="sm">Loading</Badge>;
  if (!status.platformSupported) return <Badge variant="error" size="sm">Unsupported platform</Badge>;
  if (status.installed) return <Badge variant="success" size="sm">Installed</Badge>;
  if (status.cursorDetected) return <Badge variant="warning" size="sm">Ready</Badge>;
  return <Badge variant="default" size="sm">Cursor not found</Badge>;
}

function StepRow({ step }) {
  const badge = STEP_BADGES[step.status] || STEP_BADGES.pending;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-bg px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-main">{step.label}</div>
        {step.detail && <div className="mt-0.5 text-xs text-text-muted">{step.detail}</div>}
      </div>
      <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
    </div>
  );
}

function getSuccessMessage(action) {
  if (action === "prepare") {
    return "Preparation passed. Cursor was not modified. You can proceed with Install.";
  }
  if (action === "install") {
    return "Cursor BYOK is installed. Fully quit and restart Cursor before using it.";
  }
  if (action === "restore") {
    return "Original Cursor files were restored. The Cursor BYOK extension and settings remain installed. Restart Cursor to apply the rollback.";
  }
  return "Cursor BYOK action completed.";
}

export default function CursorByokToolCard({ tool }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [job, setJob] = useState(null);
  const [startingAction, setStartingAction] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [modalError, setModalError] = useState(null);
  const [submittingPassword, setSubmittingPassword] = useState(false);

  const activeJob = job && !TERMINAL_STATUSES.has(job.status);
  const platformReady = status?.platformSupported && status?.cursorDetected;
  const writeBlocked = !platformReady || status?.cursorRunning;
  const canRestore = platformReady && !status?.cursorRunning && status?.restoreAvailable;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/cursor-byok");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load Cursor BYOK status");
      setStatus(data);
      setStatusError(null);
    } catch (error) {
      setStatusError(error.message || "Failed to load Cursor BYOK status");
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!job?.id || TERMINAL_STATUSES.has(job.status)) return undefined;
    const source = new EventSource(`/api/cli-tools/cursor-byok/jobs/${job.id}/events`);
    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) {
        setJob((prev) => ({ ...(prev || {}), status: "error", error: data.error }));
        source.close();
        return;
      }
      setJob(data);
      if (data.status === "waiting_sudo") {
        setShowPasswordModal(true);
        setModalError(null);
      }
      if (TERMINAL_STATUSES.has(data.status)) {
        source.close();
        fetchStatus();
      }
    };
    source.onerror = () => {
      setJob((prev) => (
        prev && !TERMINAL_STATUSES.has(prev.status)
          ? { ...prev, status: "error", error: "Lost Cursor BYOK progress stream" }
          : prev
      ));
      source.close();
    };
    return () => source.close();
  }, [fetchStatus, job?.id, job?.status]);

  const startAction = async (action) => {
    setStartingAction(action);
    setJob(null);
    setStatusError(null);
    setShowPasswordModal(false);
    setSudoPassword("");
    try {
      const res = await fetch("/api/cli-tools/cursor-byok/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start Cursor BYOK job");
      setJob(data.job);
    } catch (error) {
      setStatusError(error.message || "Failed to start Cursor BYOK job");
    } finally {
      setStartingAction(null);
    }
  };

  const submitPassword = async () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    setSubmittingPassword(true);
    setModalError(null);
    try {
      const res = await fetch(`/api/cli-tools/cursor-byok/jobs/${job.id}/sudo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit sudo password");
      setJob(data.job);
      setShowPasswordModal(false);
      setSudoPassword("");
    } catch (error) {
      setModalError(error.message || "Failed to submit sudo password");
    } finally {
      setSubmittingPassword(false);
    }
  };

  const repoLabel = useMemo(() => {
    if (!status?.repo) return "nightwalker89/cursor-byok";
    return `${status.repo.owner}/${status.repo.name}@${status.repo.ref.slice(0, 12)}`;
  }, [status]);

  return (
    <>
      <Card padding="sm" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-primary">extension</span>
              <h2 className="text-base font-semibold text-text-main">{tool.name} Installer</h2>
              <StatusBadge status={status} />
            </div>
            <p className="mt-1 text-sm text-text-muted">
              Install or safely restore Cursor BYOK with every step and command result shown here.
            </p>
          </div>
          <Button variant="ghost" size="sm" icon="refresh" onClick={fetchStatus} disabled={activeJob}>
            Refresh
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Cursor</div>
            <div className="mt-1 truncate text-sm text-text-main" data-i18n-skip="true">
              {status?.cursorPath || "Not detected"}
            </div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Source</div>
            <div className="mt-1 truncate text-sm text-text-main" data-i18n-skip="true">{repoLabel}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Permission</div>
            <div className="mt-1 text-sm text-text-main">
              {status?.isWin
                ? (status?.needsUac ? "Windows UAC required" : "Direct write available")
                : (status?.needsSudoPassword
                  ? (status?.hasCachedPassword ? "Sudo cached for session" : "Sudo required")
                  : "No sudo prompt")}
            </div>
          </div>
        </div>

        {status?.isWin && (
          <div className={`rounded-lg border p-3 text-xs leading-relaxed ${
            status.cursorRunning
              ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300"
              : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          }`}>
            {status.cursorRunning
              ? "Cursor is running. Fully quit Cursor, including background processes, before Install or Restore."
              : status.needsUac
                ? `Detected a protected ${status.installScope || "system"} installation. Windows will show one UAC confirmation dialog for file changes.`
                : `Detected a writable ${status.installScope || "user"} installation. n9router can update it directly without a password or UAC dialog.`}
          </div>
        )}

        {!status?.platformSupported && status?.supportReason && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
            {status.supportReason}
          </div>
        )}

        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs leading-relaxed text-yellow-700 dark:text-yellow-300">
          Advanced feature: installation patches the local Cursor app bundle. Run Prepare after every Cursor update. Restore is allowed only when the saved backup matches the current signed Cursor version.
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-[11px] font-bold text-brand-600 dark:text-brand-300">1</span>
              <div className="text-sm font-semibold text-text-main">Prepare</div>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              Downloads the pinned source, installs dependencies, and checks compatibility. It does not modify Cursor or request administrator permission.
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-[11px] font-bold text-brand-600 dark:text-brand-300">2</span>
              <div className="text-sm font-semibold text-text-main">Install</div>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              Installs the extension and patches Cursor after preflight. Writable Windows user installs are modified directly; protected installs use UAC.
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg p-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-text-muted">3</span>
              <div className="text-sm font-semibold text-text-main">Restore Cursor Files</div>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              Rolls back the Cursor application patch from backup. The BYOK extension and its settings remain installed.
            </p>
          </div>
        </div>

        {status?.targets && (
          <details className="rounded-lg border border-border-subtle bg-bg p-3 text-xs">
            <summary className="cursor-pointer font-semibold text-text-main">Detected Cursor targets</summary>
            <div className="mt-2 flex flex-col gap-1 break-all font-mono text-text-muted" data-i18n-skip="true">
              <span>Root: {status.cursorRoot}</span>
              <span>Workbench: {status.targets.workbench}</span>
              <span>Extension host: {status.targets.extensionHost}</span>
            </div>
          </details>
        )}

        <div className="rounded-lg border border-border-subtle bg-surface-2/50 p-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-primary">menu_book</span>
            <h3 className="text-sm font-semibold text-text-main">Quick Guide</h3>
          </div>
          <ol className="mt-2 flex flex-col gap-1.5 text-xs leading-relaxed text-text-muted">
            <li className="flex gap-2">
              <span className="font-semibold text-text-main">1.</span>
              <span><span className="font-medium text-text-main">Prepare</span> — downloads the source and verifies your Cursor version. Safe to re-run after any Cursor update.</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-text-main">2.</span>
              <span><span className="font-medium text-text-main">Install</span> — patches Cursor and adds the BYOK extension. Fully quit Cursor first, then restart it afterward.</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-text-main">3.</span>
              <span><span className="font-medium text-text-main">Restore Cursor Files</span> — optional. Rolls back the Cursor patch from a matching backup; the extension and settings stay.</span>
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-text-muted/80">
            Tip: Run <span className="font-medium">Prepare</span> again after every Cursor update before re-installing.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            variant="secondary"
            icon="fact_check"
            onClick={() => startAction("prepare")}
            loading={startingAction === "prepare"}
            disabled={activeJob || !platformReady}
          >
            1. Prepare
          </Button>
          <Button
            icon="download"
            onClick={() => startAction("install")}
            loading={startingAction === "install"}
            disabled={activeJob || writeBlocked}
          >
            2. Install
          </Button>
          <Button
            variant="outline"
            icon="settings_backup_restore"
            onClick={() => startAction("restore")}
            loading={startingAction === "restore"}
            disabled={activeJob || !canRestore}
            title={!canRestore ? "A workbench backup is required to restore Cursor files" : undefined}
          >
            3. Restore Cursor Files
          </Button>
        </div>

        {status?.backupFilesAvailable && !status?.restoreAvailable && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
            {status.restoreReason}. Restore is disabled because backup filenames alone do not identify their original Cursor targets. If Cursor BYOK is not installed and Cursor works normally, these are retained archival backups and no restore is needed.
          </div>
        )}

        {statusError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
            {statusError}
          </div>
        )}

        {job?.status === "success" && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">
            {getSuccessMessage(job.action)}
          </div>
        )}

        {job?.status === "waiting_uac" && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-700 dark:text-blue-300">
            Approve the Windows User Account Control dialog to continue. It may appear behind another window.
          </div>
        )}

        {job && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-text-main">Job:</span>
              <Badge variant={job.status === "success" ? "success" : job.status === "error" ? "error" : "info"} size="sm">
                {job.action} / {job.status}
              </Badge>
              {job.error && <span className="text-red-500">{job.error}</span>}
            </div>
            <div className="flex flex-col gap-2">
              {job.steps?.map((step) => <StepRow key={step.id} step={step} />)}
            </div>
            <div className="max-h-72 overflow-auto rounded-lg bg-black p-3 font-mono text-[11px] leading-relaxed text-green-100" data-i18n-skip="true">
              {(job.logs || []).length === 0 ? (
                <div className="text-green-100/60">Waiting for installer output...</div>
              ) : (
                job.logs.map((line, index) => (
                  <div key={`${line.ts}-${index}`} className={line.stream === "stderr" ? "text-red-200" : ""}>
                    [{line.stream}] {line.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </Card>

      {showPasswordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-xl">
            <h3 className="mb-2 text-lg font-semibold text-text-main">Sudo Password Required</h3>
            <p className="mb-4 text-sm text-text-muted">
              {job?.action === "install"
                ? "Required to patch the local Cursor app bundle. The password is kept only in this n9router process session."
                : "Required to restore the original Cursor app files from a verified matching backup. The extension and settings remain installed."}
            </p>
            <Input
              type="password"
              label="macOS password"
              value={sudoPassword}
              onChange={(event) => setSudoPassword(event.target.value)}
              error={modalError}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") submitPassword();
              }}
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowPasswordModal(false);
                  setSudoPassword("");
                }}
                disabled={submittingPassword}
              >
                Cancel
              </Button>
              <Button onClick={submitPassword} loading={submittingPassword}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
