import type { Account } from "../account/AccountProvider.tsx";
import { copy } from "../copy/en.ts";
import type { UpdateStep } from "./CircleProvider.tsx";

/**
 * What is said of Update now at `step` (`useCircle().updateStep`), beside it: on the Why page, and
 * under a Follow button once someone is followed, in the same words. Null while it has not been
 * tapped. `how` is how the person signed in: what asks them to approve Brainstorm's sign-in is their
 * browser add-on, or the app on their phone.
 */
export function updateWords(step: UpdateStep, how: Account["how"] | undefined): string | null {
  switch (step) {
    case "signing":
      return how === "phone" ? copy.circle.approvePhone : copy.circle.approveBrowser;
    case "updating":
      return copy.why.updating;
    case "started":
      return copy.why.updateStarted;
    case "recently":
      return copy.circle.recently;
    case "updated":
      return copy.why.updated;
    case "failed":
      return copy.why.updateFailed;
    case "idle":
      return null;
  }
}

/**
 * Which word is beside what Update now says at `step`: Cancel while the person's add-on or phone app
 * asks them, as that is the one way to stop it; none while Brainstorm builds the circle again; and
 * Update now itself otherwise, before it is tapped and once it has come to an end.
 */
export function updateWord(step: UpdateStep): "cancel" | "update" | null {
  if (step === "signing") return "cancel";
  return step === "updating" ? null : "update";
}
