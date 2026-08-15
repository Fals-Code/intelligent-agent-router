export type ProjectNodeKind =
  | "repository"
  | "service"
  | "design"
  | "test"
  | "policy"
  | "provider_binding"
  | "document";

export type ProjectRelation =
  | "contains"
  | "depends_on"
  | "implemented_by"
  | "verified_by"
  | "governed_by"
  | "designed_by"
  | "bound_to";

export interface ProjectGraphNode {
  readonly id: string;
  readonly kind: ProjectNodeKind;
  readonly reference: string;
  readonly revision?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProjectGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: ProjectRelation;
}

export interface ProjectGraphSnapshot {
  readonly nodes: readonly ProjectGraphNode[];
  readonly edges: readonly ProjectGraphEdge[];
}

export class InMemoryProjectGraph {
  private readonly nodes = new Map<string, ProjectGraphNode>();
  private readonly edges: ProjectGraphEdge[] = [];

  addNode(node: ProjectGraphNode): this {
    if (!node.id.trim()) throw new Error("Project graph node id must not be empty");
    if (!node.reference.trim()) throw new Error(`Project graph node ${node.id} must have a reference`);
    if (this.nodes.has(node.id)) throw new Error(`Project graph node already exists: ${node.id}`);
    this.nodes.set(node.id, freezeNode(node));
    return this;
  }

  addEdge(edge: ProjectGraphEdge): this {
    if (!this.nodes.has(edge.from)) throw new Error(`Unknown project graph source node: ${edge.from}`);
    if (!this.nodes.has(edge.to)) throw new Error(`Unknown project graph target node: ${edge.to}`);
    if (
      this.edges.some(
        (item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation,
      )
    ) {
      throw new Error(`Project graph edge already exists: ${edge.from}/${edge.relation}/${edge.to}`);
    }
    this.edges.push(Object.freeze({ ...edge }));
    return this;
  }

  getNode(id: string): ProjectGraphNode | undefined {
    return this.nodes.get(id);
  }

  related(id: string, relation?: ProjectRelation): readonly ProjectGraphNode[] {
    if (!this.nodes.has(id)) throw new Error(`Unknown project graph node: ${id}`);
    const relatedIds = this.edges
      .filter(
        (edge) =>
          (edge.from === id || edge.to === id) &&
          (relation === undefined || edge.relation === relation),
      )
      .map((edge) => (edge.from === id ? edge.to : edge.from));
    return relatedIds.map((nodeId) => this.nodes.get(nodeId)).filter(Boolean);
  }

  snapshot(): ProjectGraphSnapshot {
    return Object.freeze({
      nodes: Object.freeze([...this.nodes.values()]),
      edges: Object.freeze([...this.edges]),
    });
  }
}

function freezeNode(node: ProjectGraphNode): ProjectGraphNode {
  return Object.freeze({
    ...node,
    metadata: node.metadata ? Object.freeze({ ...node.metadata }) : undefined,
  });
}
