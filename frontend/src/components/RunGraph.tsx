import { memo, useMemo } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import Box from "@mui/material/Box";
import { ToolNode, type ToolNodeData } from "./ToolNode";
import type { RunStep, Workflow } from "../types/domain";
import { repairWorkflowGraphHandles } from "../utils/workflowHandles";

const nodeTypes = { tool: ToolNode };

export default memo(function RunGraph({ workflow, steps, onSelect }: {
  workflow: Pick<Workflow, "nodes" | "edges">; steps: RunStep[]; onSelect: (nodeId: string) => void;
}) {
  const graph = useMemo(() => {
    const repaired = repairWorkflowGraphHandles(workflow);
    const statuses = new Map(steps.map((step) => [step.nodeId, step.status]));
    return {
      nodes: repaired.nodes.map((node): Node<ToolNodeData> => ({ id: node.id, type: "tool", position: node.position,
        data: { workflowNode: node, status: statuses.get(node.id) || "await", animate: false } })),
      edges: repaired.edges.map((edge): Edge => ({ ...edge, type: "smoothstep", animated: false }))
    };
  }, [workflow, steps]);
  return <Box sx={{ height: 560, bgcolor: "background.default", borderRadius: 1 }}>
    <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} nodesDraggable={false}
      nodesConnectable={false} onNodeClick={(_, node) => onSelect(node.id)} fitView onlyRenderVisibleElements>
      <Background /><Controls />
    </ReactFlow>
  </Box>;
});
