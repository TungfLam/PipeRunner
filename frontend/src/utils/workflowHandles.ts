import type {
  WorkflowEdgeConfig,
  WorkflowInputDefinition,
  WorkflowNodeConfig,
  WorkflowOutputDefinition
} from "../types/domain";

export function nameFromFlag(flag?: string, fallback = "value") {
  const cleaned = (flag || "")
    .trim()
    .replace(/=.*/, "")
    .replace(/^-+/, "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!cleaned) {
    return fallback;
  }
  if (/^\d/.test(cleaned)) {
    return `arg_${cleaned}`;
  }
  return cleaned;
}

export function shouldAutoUpdateName(currentName: string | undefined, previousFlag: string | undefined, fallback: string) {
  return !currentName || currentName === previousFlag || currentName === nameFromFlag(previousFlag, fallback);
}

export function normalizeInputDefinition(input: WorkflowInputDefinition, index: number): WorkflowInputDefinition {
  const fallback = `input${index + 1}`;
  if (shouldAutoUpdateName(input.name, input.flag, fallback)) {
    return { ...input, name: nameFromFlag(input.flag, fallback) };
  }
  return input;
}

export function normalizeOutputDefinition(output: WorkflowOutputDefinition, index: number): WorkflowOutputDefinition {
  const fallback = `output${index + 1}`;
  if (shouldAutoUpdateName(output.name, output.flag, fallback)) {
    return { ...output, name: nameFromFlag(output.flag, fallback) };
  }
  return output;
}

export function normalizeNodeHandles(node: WorkflowNodeConfig): WorkflowNodeConfig {
  const inputs = (node.inputs || []).map(normalizeInputDefinition);
  const outputs = (node.outputs || []).map(normalizeOutputDefinition);
  const inputAliases = buildDefinitionAliases(node.inputs || [], inputs, "input");
  const outputAliases = buildDefinitionAliases(node.outputs || [], outputs, "output");
  const repairTemplateValue = (value: string) => repairTemplateHandles(value, inputAliases, outputAliases);

  return {
    ...node,
    inputs,
    outputs,
    toolConfig: {
      ...node.toolConfig,
      bin: repairTemplateValue(node.toolConfig.bin || ""),
      args: (node.toolConfig.args || []).map(repairTemplateValue),
      workingDir: node.toolConfig.workingDir ? repairTemplateValue(node.toolConfig.workingDir) : undefined,
      env: node.toolConfig.env
        ? Object.fromEntries(Object.entries(node.toolConfig.env).map(([key, value]) => [key, repairTemplateValue(value)]))
        : node.toolConfig.env
    }
  };
}

function buildDefinitionAliases(
  previousDefinitions: Array<{ name?: string; flag?: string }>,
  nextDefinitions: Array<{ name: string; flag?: string }>,
  fallbackPrefix: "input" | "output"
) {
  const aliases = new Map<string, string>();
  previousDefinitions.forEach((previous, index) => {
    const next = nextDefinitions[index];
    if (!next?.name) return;
    const fallback = `${fallbackPrefix}${index + 1}`;
    const candidates = [
      previous.name,
      previous.flag,
      previous.flag?.replace(/^-+/, ""),
      nameFromFlag(previous.flag, fallback),
      previous.name ? nameFromFlag(previous.name, fallback) : undefined,
      next.name
    ];
    for (const candidate of candidates) {
      if (candidate) {
        aliases.set(candidate, next.name);
      }
    }
  });
  return aliases;
}

function repairTemplateHandles(value: string, inputAliases: Map<string, string>, outputAliases: Map<string, string>) {
  return value.replace(/\{\{\s*(inputs|outputs)\.([^{}]+?)\s*\}\}/g, (match, kind: "inputs" | "outputs", key: string) => {
    const resolvedKey = (kind === "inputs" ? inputAliases : outputAliases).get(key.trim());
    return resolvedKey ? `{{${kind}.${resolvedKey}}}` : match;
  });
}

function resolveInputHandle(node: WorkflowNodeConfig, handle?: string) {
  const inputs = node.inputs || [];
  if (!handle) {
    return inputs.length === 1 ? inputs[0].name : undefined;
  }

  const match =
    inputs.find((input) => input.name === handle) ||
    inputs.find((input) => input.flag === handle) ||
    inputs.find((input, index) => nameFromFlag(input.flag, `input${index + 1}`) === handle);

  if (match) {
    return match.name;
  }
  return inputs.length === 1 ? inputs[0].name : handle;
}

function resolveOutputHandle(node: WorkflowNodeConfig, handle?: string) {
  const outputs = node.outputs || [];
  if (!handle) {
    return outputs.length === 1 ? outputs[0].name : undefined;
  }

  const match =
    outputs.find((output) => output.name === handle) ||
    outputs.find((output) => output.flag === handle) ||
    outputs.find((output, index) => nameFromFlag(output.flag, `output${index + 1}`) === handle);

  if (match) {
    return match.name;
  }
  return outputs.length === 1 ? outputs[0].name : handle;
}

function hasInputHandle(node: WorkflowNodeConfig, handle?: string) {
  return !handle || (node.inputs || []).some((input) => input.name === handle);
}

function hasOutputHandle(node: WorkflowNodeConfig, handle?: string) {
  return !handle || (node.outputs || []).some((output) => output.name === handle);
}

function edgeId(edge: WorkflowEdgeConfig) {
  return `edge-${edge.source}-${edge.sourceHandle || ""}-${edge.target}-${edge.targetHandle || ""}`;
}

export function repairWorkflowGraphHandles<T extends { nodes: WorkflowNodeConfig[]; edges: WorkflowEdgeConfig[] }>(
  workflow: T
): T {
  const nodes = workflow.nodes.map(normalizeNodeHandles);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.flatMap((edge) => {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      return [];
    }

    const repairedEdge: WorkflowEdgeConfig = {
      ...edge,
      sourceHandle: resolveOutputHandle(sourceNode, edge.sourceHandle),
      targetHandle: resolveInputHandle(targetNode, edge.targetHandle)
    };

    if (!hasOutputHandle(sourceNode, repairedEdge.sourceHandle) || !hasInputHandle(targetNode, repairedEdge.targetHandle)) {
      return [];
    }

    repairedEdge.id = edgeId(repairedEdge);
    return [repairedEdge];
  });

  return {
    ...workflow,
    nodes,
    edges
  };
}
