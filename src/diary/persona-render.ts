import { estimateDiaryTokens } from "./domain";

export const PROFILE_PUBLISHED_TOKEN_BUDGET = 1_000;
export const EXPERIENCE_PUBLISHED_TOKEN_BUDGET = 1_400;

export function renderPersonaProfile(userProfile: string): string {
  return ["## Persona", "", userProfile.trim()].join("\n");
}

export function renderPersonaExperienceBody(experience: string): string {
  return experience.trim();
}

export function measurePublishedPersona(persona: {
  userProfile: string;
  experience: string;
}): { profileTokens: number; experienceTokens: number } {
  return {
    profileTokens: estimateDiaryTokens(renderPersonaProfile(persona.userProfile)),
    experienceTokens: estimateDiaryTokens(
      renderPersonaExperienceBody(persona.experience),
    ),
  };
}
