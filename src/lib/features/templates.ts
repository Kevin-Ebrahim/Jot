import type { NewNote } from "@/lib/types";

export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  title: string;
  body: string;
  tags: string[];
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  { id: "daily", name: "Daily note", description: "A little space for today.", title: "{{weekday}}, {{date}}", tags: ["daily"], body: "## Today\n\n- [ ] \n\n## Notes\n\n\n## Looking back\n\n" },
  { id: "meeting", name: "Meeting notes", description: "Keep the important bits together.", title: "Meeting · {{date}}", tags: ["meeting"], body: "## People\n\n\n## Agenda\n\n- \n\n## Notes\n\n\n## Follow-ups\n\n- [ ] \n" },
  { id: "study", name: "Study session", description: "Capture ideas and a next review date.", title: "Study notes · {{date}}", tags: ["study"], body: "## Topic\n\n\n## What I learned\n\n- \n\n## Questions to revisit\n\n- [ ] \n\nNext review: @review({{tomorrow}})\n" },
  { id: "journal", name: "Journal entry", description: "A quiet moment to reflect.", title: "Journal · {{date}}", tags: ["journal"], body: "## How today feels\n\n\n## On my mind\n\n\n## One thing to remember\n\n" },
  { id: "project", name: "Project brief", description: "Move an idea into action.", title: "New project", tags: ["project"], body: "## The idea\n\n\n## Why it matters\n\n\n## Next steps\n\n- [ ] \n\n## Links & references\n\n" },
  { id: "reading", name: "Reading notes", description: "Save what stays with you.", title: "Reading notes", tags: ["reading"], body: "## Source\n\n\n## Key ideas\n\n- \n\n## My thoughts\n\n" },
  { id: "review", name: "Weekly review", description: "Reflect, then make room for what’s next.", title: "Weekly review · {{date}}", tags: ["review"], body: "## Wins\n\n- \n\n## In progress\n\n- [ ] \n\n## Next week\n\n- [ ] \n" },
];

/** Expands date placeholders at creation time; templates never schedule silent jobs. */
export function createFromTemplate(template: NoteTemplate, now = new Date()): NewNote {
  const date = now.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const localDate = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, "0"), String(tomorrow.getDate()).padStart(2, "0")].join("-");
  const replace = (value: string) => value.replaceAll("{{date}}", date).replaceAll("{{weekday}}", weekday).replaceAll("{{tomorrow}}", localDate);
  return { title: replace(template.title), body: replace(template.body), tags: [...template.tags] };
}
