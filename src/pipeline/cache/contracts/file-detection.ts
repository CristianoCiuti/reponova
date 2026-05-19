import type { CacheContract } from "../contract.js";

export const fileDetectionContract: CacheContract = {
  phaseId: "file-detection",
  check: () => ({ fresh: false, reason: "always runs" }),
  seal: () => {},
  invalidate: () => {},
};
