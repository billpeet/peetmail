import { describe, expect, it } from "vitest";
import { autostartLabel, platformOf } from "./platform";

describe("platform", () => {
  it("tells WebKitGTK on Linux from WebView2 on Windows", () => {
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15")).toBe("linux");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("windows");
  });

  it("names autostart the way each desktop does", () => {
    expect(autostartLabel("windows").label).toBe("Start with Windows");
    expect(autostartLabel("linux").label).toBe("Start when you log in");
  });
});
