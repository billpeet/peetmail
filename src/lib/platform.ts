// Which desktop the webview runs on, for the few labels that differ (WebView2 on Windows,
// WebKitGTK on Linux; both put the OS in the user agent).

export type Platform = "windows" | "linux";

export function platformOf(userAgent: string): Platform {
  return /Linux|X11/.test(userAgent) && !/Windows/.test(userAgent) ? "linux" : "windows";
}

export const platform: Platform = typeof navigator === "undefined" ? "windows" : platformOf(navigator.userAgent);

/** The Settings label for starting PeetMail at sign-in. */
export function autostartLabel(p: Platform = platform) {
  return p === "linux"
    ? { label: "Start when you log in", hint: "Starts in the tray when you log in to your desktop." }
    : { label: "Start with Windows", hint: "Starts in the tray when you sign in to Windows." };
}
