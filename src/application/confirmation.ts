import type { BlockingProfile } from "../domain/types";

export type ConfirmationModel = {
  profileId: string;
  profileName: string;
  durationMinutes: number;
  endsAt: number;
  hostnameCount: number;
  hostnameLabel: string;
  endTimeLabel: string;
};

export function createConfirmationModel(
  profile: Pick<BlockingProfile, "id" | "name" | "domains">,
  durationMinutes: number,
  startedAt: number
): ConfirmationModel {
  const endsAt = startedAt + durationMinutes * 60_000;
  const hostnameCount = profile.domains.length;
  return {
    profileId: profile.id,
    profileName: profile.name,
    durationMinutes,
    endsAt,
    hostnameCount,
    hostnameLabel: `${hostnameCount} ${hostnameCount === 1 ? "hostname" : "hostnames"}`,
    endTimeLabel: new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  };
}
