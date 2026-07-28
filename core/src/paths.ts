import { fileURLToPath } from "node:url";
import path from "node:path";
import "./env.js";

export const coreRoot = fileURLToPath(new URL("../", import.meta.url));
export const dataRoot = process.env.VAPI_DATA_ROOT?.trim()
  ? path.resolve(process.env.VAPI_DATA_ROOT.trim())
  : path.join(coreRoot, "data");
