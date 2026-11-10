import assert from "node:assert/strict";
import { api, media, send, tokenKey } from "../src/api.ts";
import { normalizeImport } from "../src/pages/shared/import-normalization.ts";
import { publicationBatchBody } from "../src/pages/shared/question-publication.ts";

const values = new Map([[tokenKey, "test-token"]]);
globalThis.sessionStorage = {
  getItem: (key) => values.get(key),
  removeItem: (key) => values.delete(key),
};
let expired = false;
globalThis.window = {
  dispatchEvent: (event) => {
    expired = event.type === "luatgt-session-expired";
  },
};
globalThis.fetch = async (url, options) => {
  assert.equal(url, "/api/auth/me");
  assert.equal(options.headers.get("Authorization"), "Bearer test-token");
  return new Response(JSON.stringify({ role: "USER" }));
};
assert.deepEqual(await api("/auth/me"), { role: "USER" });
let mediaRequest;
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  assert.ok(blob instanceof Blob);
  return "blob:test-image";
};
globalThis.fetch = async (url, options) => {
  mediaRequest = { url, authorization: options.headers.get("Authorization") };
  return new Response("image-bytes");
};
assert.equal(await media("Q1"), "blob:test-image");
assert.deepEqual(mediaRequest, {
  url: "/api/content/Q1/media",
  authorization: "Bearer test-token",
});
globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
await assert.rejects(
  media("Q1"),
  (error) => error.status === 401 && /Phiên đã hết hạn/.test(error.message),
);
assert.equal(expired, true);
assert.equal(values.has(tokenKey), false);
URL.createObjectURL = originalCreateObjectURL;

globalThis.fetch = async () =>
  new Response(JSON.stringify({ message: "Phiên đã hết hạn" }), { status: 401 });
await assert.rejects(api("/questions"), /Phiên đã hết hạn/);
assert.equal(expired, true);
assert.equal(values.has(tokenKey), false);

values.set(tokenKey, "test-token");
expired = false;
globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
await assert.rejects(
  api("/chat"),
  (error) => error.status === 401 && /đăng nhập/.test(error.message),
);
assert.equal(expired, true);
assert.equal(values.has(tokenKey), false);

values.set(tokenKey, "test-token");
expired = false;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ message: "KAG chưa khả dụng" }), { status: 503 });
await assert.rejects(
  api("/chat", send("POST", { message: "Câu hỏi tiếng Việt" })),
  (error) => error.status === 503,
);
assert.equal(expired, false);
assert.equal(values.get(tokenKey), "test-token");
globalThis.fetch = async () => {
  throw new Error("offline");
};
await assert.rejects(api("/questions"), /Không kết nối được backend/);
assert.equal(send("POST", { selected: 0 }).body, '{"selected":0}');
const mixedBatch = publicationBatchBody([
  { id: "ready-question", version: 2 },
  { id: "question-needs-review", version: 4 },
]);
let submittedBatch;
globalThis.fetch = async (url, options) => {
  assert.equal(url, "/api/admin/questions/publication-batch");
  assert.equal(options.headers.get("Authorization"), "Bearer test-token");
  submittedBatch = JSON.parse(options.body);
  return new Response(JSON.stringify({ message: "Câu hỏi cần kiểm duyệt" }), { status: 400 });
};
await assert.rejects(
  api("/admin/questions/publication-batch", send("POST", mixedBatch)),
  /Câu hỏi cần kiểm duyệt/,
);
assert.deepEqual(submittedBatch, {
  rows: [
    { id: "ready-question", version: 2 },
    { id: "question-needs-review", version: 4 },
  ],
  reviewed: true,
  published: true,
});
assert.equal(values.get(tokenKey), "test-token");
const csv = normalizeImport("questions", {
  id: "Q1",
  question: "Câu?",
  chapter: "5",
  option1: "A",
  option2: "B",
  answer: "2",
  critical: "false",
});
assert.equal(csv.externalId, "Q1");
assert.deepEqual(csv.options, ["A", "B"]);
assert.equal(csv.correctAnswer, 1);
assert.equal(csv.chapter, 5);
assert.equal(csv.critical, false);
assert.equal(normalizeImport("questions", { options: ["A", "B"], answer: 0 }).correctAnswer, 0);
assert.equal(normalizeImport("signs", { sign_id: "QCVN::P.1" }).externalId, "QCVN::P.1");
const unit = normalizeImport("units", {
  unit_id: " D::1::occ2 ",
  doc_id: "D",
  parent_id: null,
  order: "0",
  penalty_phat_tien_min: 0,
  penalty_canh_cao: false,
});
assert.equal(unit.externalId, " D::1::occ2 ");
assert.equal(unit.order, 0);
assert.equal(unit.parent_id, null);
assert.equal(unit.penalty_phat_tien_min, 0);
assert.equal(unit.penalty_canh_cao, false);
assert.equal(normalizeImport("units", { unit_id: "", id: "fallback" }).externalId, "");
assert.equal(
  normalizeImport("documents", { doc_id: "D", effective_from: "2025-01-01" }).ngay_hieu_luc,
  "2025-01-01",
);
console.log("PASS: real API session/errors and import normalization");
