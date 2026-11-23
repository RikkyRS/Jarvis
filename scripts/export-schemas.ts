import { mkdirSync, writeFileSync } from "node:fs";
import { exportSchemas } from "../src/contracts/export.js";

mkdirSync("schemas", { recursive: true });
writeFileSync("schemas/contracts.json", `${JSON.stringify(exportSchemas(), null, 2)}\n`);
console.log("schemas/contracts.json written");
