import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import packageJson from "../package.json";
import versions from "../versions.json";

describe("GitLab fork identity", () => {
  it("uses a new plugin id and GitLab-only name", () => {
    expect(manifest.id).toBe("envoy");
    expect(manifest.name).toBe("Envoy");
    expect(manifest.description).toContain("GitLab");
    expect(manifest.description).not.toContain("GitHub");
  });

  it("keeps release metadata aligned with the SecretStorage requirement", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.minAppVersion).toBe("1.11.4");
    expect(versions[manifest.version as keyof typeof versions]).toBe(manifest.minAppVersion);
  });
});
