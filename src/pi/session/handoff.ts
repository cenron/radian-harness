// A long plan would crowd the fresh context it is meant to save; past this size the handoff
// names the file and Pi reads it.
const MAX_INLINE_PLAN_CHARS = 20_000;

/** The first prompt of a fresh build session: the plan from planning, handed over as the task. */
export function planHandoff(planPath: string, planText: string): string {
  const intro = [
    `Implementation handoff from the planning session. The user approved the plan in ${planPath};`,
    "coordinate building it by dispatching workers, following the radian-coordinator skill.",
    "The planning conversation is not available here; reread the plan file when you need detail.",
  ].join(" ");
  if (planText.length > MAX_INLINE_PLAN_CHARS) return `${intro}\n\nRead ${planPath} first.`;
  return `${intro}\n\n${planText}`;
}
