const commitTypes = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

function isExempt(commit) {
  const subject = commit.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trimEnd();
  return /^(?:Merge |Revert |(?:fixup|squash|amend)!\s)/.test(subject)
    || /^release:\s+v\S+/i.test(subject)
    || /^chore\(release\)(?:!)?:/i.test(subject);
}

const nodeIdRule = (parsed) => {
  const valid = /^.+ \[[^\]\s]+\]$/.test(parsed.subject || "");
  return [valid, "subject must end with [<node-id>]"];
};

export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [isExempt],
  plugins: [{ rules: { "subject-node-id": nodeIdRule } }],
  rules: {
    "type-enum": [2, "always", commitTypes],
    "subject-node-id": [2, "always"],
  },
};
