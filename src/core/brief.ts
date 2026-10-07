import { canEditCode, type Role } from "./roles.ts";

export interface BriefInput {
  workerName: string;
  role: Role;
  title: string;
  task: string;
  branch: string;
  baseBranch: string;
  targetBranch: string;
  worktree: string;
  statusPath: string;
  reportPath: string;
}

export function renderBrief(input: BriefInput): string {
  return [
    `# ${input.title}`,
    "",
    `You are \`${input.workerName}\`, a ${input.role}.`,
    "",
    "## Task",
    "",
    input.task.trim(),
    "",
    "## Working rules",
    "",
    `- Stay inside your worktree: ${input.worktree}`,
    commitRule(input),
    `- The project's target branch is \`${input.targetBranch}\`; Radian merges your branch into it after the user approves.`,
    "- When you mention files, give paths relative to the worktree.",
    "",
    "## Status",
    "",
    "Append one line to your status file whenever your state changes:",
    "",
    "```sh",
    `echo "done: <one-line summary>" >> ${input.statusPath}`,
    "```",
    "",
    "Each line is `working|question|blocked|done|failed: <text>`. Write `question:` when you need",
    "an answer, then wait; the answer is typed into this session. Write `done:` only after your",
    "work is committed.",
    "",
  ].join("\n");
}

function commitRule(input: BriefInput): string {
  const branch = `your branch \`${input.branch}\` (cut from \`${input.baseBranch}\`)`;
  if (canEditCode(input.role)) {
    return `- Commit your work on ${branch}. Do not switch branches, merge, rebase, or push.`;
  }
  return `- You work on ${branch} but do not change code or commit. Write your findings to ${input.reportPath}`;
}

export function firstPrompt(rolePrompt: string, briefPath: string): string {
  return `${rolePrompt.trim()}\n\nRead and do the task in ${briefPath}`;
}
