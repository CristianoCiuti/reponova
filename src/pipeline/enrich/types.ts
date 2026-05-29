/**
 * Intermediate file types for the intelligent enrichment pipeline (M4).
 *
 * These types represent the JSON schema of files stored in `.enrich/`
 * during the multi-step LLM enrichment process.
 */

/** Step 0 output: candidate classification */
export interface CandidateClassification {
  nodeId: string;
  boundaryRatio: number;
  status: "stable" | "candidate";
  internalDegree: number;
  externalDegree: number;
}

export interface CandidatesFile {
  threshold: number;
  totalNodes: number;
  candidates: CandidateClassification[];
  stableCount: number;
  candidateCount: number;
}

/** Step 0 output: inter-community edge density */
export interface EdgeDensityEntry {
  communityA: string;
  communityB: string;
  edgeCount: number;
}

export interface EdgeDensityFile {
  pairs: EdgeDensityEntry[];
}

/** Step 1 output: node descriptions */
export interface DescriptionEntry {
  id: string;
  description: string;
}

/** Step 2 output: community profile */
export interface CommunityProfile {
  communityId: string;
  label: string;
  profile: string;
  misfits: Array<{ nodeId: string; reason: string }>;
}

/** Step 3 output: routing decision */
export interface RoutingDecision {
  node: string;
  action: "stay" | "move";
  to?: string;
  reason: string;
}

/** Step 4 output: merge/split proposals */
export interface RestructureFile {
  merges: Array<{
    communities: string[];
    newLabel: string;
    reason: string;
  }>;
  splits: Array<{
    community: string;
    reason: string;
    into: Array<{
      label: string;
      nodes: string[];
    }>;
  }>;
}

/** Step 5 output: modified communities list */
export interface ModifiedCommunitiesFile {
  created: string[];
  modified: string[];
  removed: string[];
}
