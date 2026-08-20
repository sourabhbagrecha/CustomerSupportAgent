import { promptVersionHue, promptVersionShort } from "./evalMath";

// One chip = one prompt version (plan 012): the first 12 chars of the run's
// promptSha256, which is also the snapshot filename under evals/prompts/.
// The hue comes from the hash, so runs of the same prompt version share a
// color across the runs table, scorecards, and comparison headers, and a
// prompt change stands out without reading hex. hsla with a low alpha keeps
// the tint legible on both the light and dark theme backgrounds.
export function PromptVersionChip({ promptSha256 }: { promptSha256: string }) {
  const hue = promptVersionHue(promptSha256);
  const style =
    hue !== null
      ? {
          background: `hsla(${hue}, 70%, 50%, 0.14)`,
          borderColor: `hsla(${hue}, 70%, 45%, 0.55)`,
        }
      : undefined;
  return (
    <span
      className="eval-prompt-chip"
      style={style}
      title={promptSha256.length > 0 ? `Prompt sha256: ${promptSha256} (snapshot: evals/prompts/${promptVersionShort(promptSha256)}.txt)` : "No prompt hash recorded"}
    >
      {promptVersionShort(promptSha256)}
    </span>
  );
}
