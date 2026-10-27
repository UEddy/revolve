// "Install Revolve" banner logic. Chrome's beforeinstallprompt is caught at
// import time (it can fire before React renders), its mini-infobar
// suppressed, and the event kept for our own Install button. iOS has no such
// event, so there the banner explains Share, then Add to Home Screen.

export type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const SNOOZE_KEY = "revolve.install.snoozedUntil";
export const SNOOZE_MS = 7 * 24 * 3600_000;

let deferred: InstallEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    notify();
  });
}

export const installPrompt = {
  subscribe(f: () => void): () => void {
    listeners.add(f);
    return () => void listeners.delete(f);
  },
  available: () => deferred !== null,
  installed: () => installed,
  /** Shows Chrome's install dialog. The event works once, so it is dropped either way. */
  async show(): Promise<"accepted" | "dismissed" | "unavailable"> {
    const e = deferred;
    if (!e) return "unavailable";
    deferred = null;
    notify();
    await e.prompt();
    return (await e.userChoice).outcome;
  },
};

/** Already running as an installed app (Android/desktop display-mode, or iOS home screen). */
export function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod, or an iPad (which reports itself as a Mac with touch). */
export function isIos(ua: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Which banner to show, if any. */
export function bannerKind(s: { standalone: boolean; installed: boolean; ios: boolean; canPrompt: boolean; snoozed: boolean }): "prompt" | "ios" | null {
  if (s.standalone || s.installed || s.snoozed) return null;
  if (s.canPrompt) return "prompt";
  return s.ios ? "ios" : null;
}

/** True while a "Not now" from the last 7 days holds. Unreadable storage counts as not snoozed. */
export function isSnoozed(raw: string | null, now: number): boolean {
  const until = Number(raw);
  return Number.isFinite(until) && until > now && until - now <= SNOOZE_MS;
}

export function readSnoozed(now = Date.now()): boolean {
  try {
    return isSnoozed(localStorage.getItem(SNOOZE_KEY), now);
  } catch {
    return false;
  }
}

/** Stores "Not now" for 7 days. If storage fails the banner just shows again next visit. */
export function snooze(now = Date.now()): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(now + SNOOZE_MS));
  } catch {}
}
