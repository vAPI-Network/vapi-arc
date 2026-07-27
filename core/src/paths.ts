import { fileURLToPath } from "node:url";
import path from "node:path";

export const coreRoot = fileURLToPath(new URL("../", import.meta.url));
export const dataRoot = path.join(coreRoot, "data");
