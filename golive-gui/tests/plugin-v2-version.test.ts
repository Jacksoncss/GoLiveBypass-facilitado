import { describe, expect, it } from "vitest";

import { comparePluginVersions } from "../../goLiveBypass/update-channel";

describe("ordenação da linha beta do plugin", () => {
  it("mantém beta.1 e beta-1 equivalentes", () => {
    expect(comparePluginVersions("2.0.0-beta.1", "2.0.0-beta-1")).toBe(0);
  });
});
