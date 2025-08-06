type GraphNodeId = string;
export type GraphAdjacencyList = Record<GraphNodeId, Array<GraphNodeId>>;

export function findGraphCycles(graph: GraphAdjacencyList): Array<Array<GraphNodeId>> {
  const visited = new Set<GraphNodeId>();
  const recursionStack = new Set<GraphNodeId>();
  const cycles: Array<Array<GraphNodeId>> = [];
  const currentPath: Array<GraphNodeId> = [];

  function dfs(node: GraphNodeId) {
    // If node is in recursion stack, we found a cycle
    if (recursionStack.has(node)) {
      // Find the start of the cycle in the current path
      const cycleStart = currentPath.indexOf(node);
      // Extract the cycle from the current path
      const cycle = currentPath.slice(cycleStart);
      cycles.push(cycle);
      // cycles.push([...cycle, node]); // Add the node again to complete the cycle
      return;
    }

    // If node is visited and not in recursion stack, no cycle
    if (visited.has(node)) {
      return;
    }

    // Mark node as visited and add to recursion stack
    visited.add(node);
    recursionStack.add(node);
    currentPath.push(node);

    // Visit all neighbors
    for (const neighbor of graph[node] || []) {
      dfs(neighbor);
    }

    // Remove node from recursion stack and current path
    recursionStack.delete(node);
    currentPath.pop();
  }

  // Check all nodes in case graph is disconnected
  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}


