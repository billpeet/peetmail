// Automatic updates: the Rust side checks, downloads and verifies; this mirrors its status
// for the footer and Settings, and asks it to install when the user says so.

import { api, onUpdateStatus, type UpdateChannel, type UpdateStatus } from "./api";
import { mail } from "./mail.svelte";

/** One line for Settings describing where updates stand. */
export function updateText(s: UpdateStatus): string {
  switch (s.state) {
    case "disabled":
      return s.message ?? "Updates aren't available in this build.";
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking…";
    case "downloading":
      return `Downloading ${s.version}…`;
    case "ready":
      return `${s.version} is ready. Restart to update.`;
    case "upToDate":
      return "Up to date.";
    case "error":
      return `Couldn't update: ${s.message}`;
  }
}

class Updates {
  status = $state<UpdateStatus | null>(null);

  get ready() {
    return this.status?.state === "ready";
  }

  get busy() {
    return this.status?.state === "checking" || this.status?.state === "downloading";
  }

  /** Events and command results can arrive out of order; keep the newest. */
  apply(s: UpdateStatus) {
    if (!this.status || s.seq >= this.status.seq) this.status = s;
  }

  /** Loads the status and follows it. Returns the unlisten function. */
  async init() {
    const unlisten = onUpdateStatus((s) => this.apply(s));
    this.apply(await api.updateStatus());
    return unlisten;
  }

  async check() {
    this.apply(await api.checkForUpdates());
  }

  async setChannel(channel: UpdateChannel) {
    this.apply(await api.setUpdateChannel(channel));
  }

  /** Restarts into the downloaded version, unless a draft is open or a send is in flight. */
  async install() {
    if (!this.ready) return;
    if (mail.composer) {
      mail.showToast({ text: "Send or close your draft first, then restart to update.", error: true });
      return;
    }
    try {
      await api.installUpdate();
    } catch (e) {
      mail.showToast({ text: String(e), error: true });
    }
  }
}

export const updates = new Updates();
