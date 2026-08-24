import { describe, expect, it } from "vitest";
import { createConfirmationModel } from "./confirmation";
import type { BlockingProfile } from "../domain/types";

const profile: BlockingProfile = {
  id: "focus",
  name: "Foco profundo",
  domains: [
    { canonicalHost: "example.com", displayHost: "example.com", kind: "domain" },
    { canonicalHost: "docs.example.com", displayHost: "docs.example.com", kind: "domain" }
  ],
  createdAt: 1,
  updatedAt: 1
};

describe("createConfirmationModel", () => {
  it("summarizes the selected profile, duration, local end time, and host count", () => {
    expect(createConfirmationModel(profile, 50, 1_700_000_000_000)).toEqual({
      profileId: "focus",
      profileName: "Foco profundo",
      durationMinutes: 50,
      endsAt: 1_700_003_000_000,
      hostnameCount: 2,
      hostnameLabel: "2 hostnames",
      endTimeLabel: new Date(1_700_003_000_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    });
  });

  it("uses the singular hostname label", () => {
    expect(createConfirmationModel({ ...profile, domains: [profile.domains[0]] }, 5, 0).hostnameLabel).toBe("1 hostname");
  });
});
