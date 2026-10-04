
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { initiativeCreateProvider } from "../../providers/core/initiative.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { executeRemoteDomain } from "./internal/domain-routing.mjs";

const cliInitiativeProvider = Object.freeze({
  ...initiativeCreateProvider,
  async prepare(args) {
    const plan = await initiativeCreateProvider.prepare(args);
    args.request.action = "add-initiative";
    return {
      ...plan,
      target: {
        ...plan.target,
        desc: typeof args.input.desc === "string" ? args.input.desc : "",
        already_registered: Boolean(args.snapshot.initiatives?.[args.input.name]),
      },
    };
  },
});

export const knownFlags = ["desc", "as"];

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function validateName(name) {
  if (!name) {
    throwV2(
      "MISSING_FIELD",
      "add-initiative: name required (e.g. add-initiative migration --desc 'the big move')",
      { field: "name" },
    );
  }
  if (!NAME_RE.test(name)) {
    throwV2(
      "INVALID_NAME",
      `add-initiative: name '${name}' is invalid (must match ${NAME_RE})`,
      { name, pattern: NAME_RE.source },
    );
  }
}

function initiativePolicyAction(policy, projectDir, name, desc) {
  if (!policy) {return null;}
  return {
    action: "initiative.create",
    pluginId: policy.pluginId || null,
    decide: async ({ snapshot, target, request, action }) => authorizeAction({
      policy,
      action,
      actor: request.actor,
      target: { ...target, desc, already_registered: Boolean(snapshot.initiatives?.[name]) },
      snapshot,
      projectDir,
      projectConfig: policy.projectConfig || {},
    }),
  };
}

function initiativeEnvelopeData(name, desc, initiative) {
  return { initiative: { name, desc: initiative?.desc ?? desc, ...(initiative?.created_at ? { created_at: initiative.created_at } : {}) } };
}

async function createRemoteInitiative(backendClient, actor, name, desc) {
  const mutation = await executeRemoteDomain({ backendClient, actor, operation: "initiative.create", input: { name, desc }, command: "add-initiative" });
  const created = mutation.diff?.initiatives?.created?.find((entry) => entry.name === name);
  const initiative = created ? created.initiative : mutation.result;
  const responseDesc = initiative?.desc ?? desc;
  return initiativeEnvelopeData(name, responseDesc, initiative);
}

function initiativeEnvelope(result, name, _desc) {
  const created = result.diff.initiatives.created.find((entry) => entry.name === name);
  const initiative = created ? created.initiative : result.result;
  return initiativeEnvelopeData(name, initiative.desc, initiative);
}

export default async function addInitiative({ statePath, projectDir: suppliedProjectDir, flags = {}, positional = [], pluginId, backendClient, source }) {
  const [name] = positional;
  validateName(name);

  const actor = resolveAgent(flags, "add-initiative");
  const projectDir = suppliedProjectDir || statePath;
  const desc = typeof flags.desc === "string" ? flags.desc : "";
  if (backendClient?.type === "remote") {return createRemoteInitiative(backendClient, actor, name, desc);}
  const policy = await loadApplicablePolicy({ projectDir });
  const result = await executeOperation({
    projectDir,
    actor,
    operation: "initiative.create",
    input: { name, desc },
    source: withCliProvider(source || {
      registry: bootstrapBuiltins(),
      mutate,
      selectPolicy: async () => policy,
      policyAction: initiativePolicyAction(policy, projectDir, name, desc),
      authorizeAction,
      pluginId,
    }, "initiative.create", cliInitiativeProvider),
  });
  return initiativeEnvelope(result, name, desc);
}

function withCliProvider(source, operation, provider) {
  return {
    ...source,
    registry: {
      ...source.registry,
      lookup(id) {
        const entry = source.registry.lookup(id);
        return id === operation && entry ? { ...entry, provider } : entry;
      },
    },
  };
}
