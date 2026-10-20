import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root=resolve(import.meta.dirname,"..");
const expected={
  apps:["daemon","cli","web","mcp","obsidian"],
  packages:["contracts","catalog","compiler","engine-qmd","search","generations","runtime","ui","evaluation"]
};
const names=new Set();
for(const [kind,items] of Object.entries(expected)) {
  assert.deepEqual(readdirSync(resolve(root,kind)).sort(),items.toSorted());
  for(const item of items) {
    const folder=resolve(root,kind,item);
    const config=JSON.parse(readFileSync(resolve(folder,"package.json"),"utf8"));
    assert.equal(config.private,true);
    assert.ok(!names.has(config.name));
    names.add(config.name);
    assert.ok(existsSync(resolve(folder,"src/index.ts")));
  }
}
const upstream=JSON.parse(readFileSync(resolve(root,"vendor/qmd-upstream.json"),"utf8"));
assert.match(upstream.commit,/^[a-f0-9]{40}$/);
assert.equal(upstream.integrationStatus,"planned");
console.log("Workspace structure passed: 5 apps, 9 packages, planned QMD integration.");
