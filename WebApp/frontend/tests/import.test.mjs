import assert from "node:assert/strict";
import { parseCsv, tableObjects } from "../src/admin/import-data.ts";

assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x,y","line\n""quote"""'), [
  ["a", "b"],
  ["x,y", 'line\n"quote"'],
]);
assert.throws(() => parseCsv('a\n"open'));
assert.throws(() => parseCsv('a\n"closed"bad'));
assert.throws(() =>
  tableObjects([
    ["a", "a"],
    ["1", "2"],
  ]),
);
console.log("CSV parsing, BOM and duplicate header checks passed");
