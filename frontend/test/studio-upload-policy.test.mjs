import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadId, uploadKey } from "../app/studio/lib/uploadPolicy.mjs";

test("upload duplicate keys distinguish file identity boundaries", () => {
  const base = { name: "track.mp3", size: 100, lastModified: 10 };
  assert.equal(uploadKey(base), "track.mp3:100:10");
  assert.notEqual(uploadKey({ ...base, name: "other.mp3" }), uploadKey(base));
  assert.notEqual(uploadKey({ ...base, size: 101 }), uploadKey(base));
  assert.notEqual(uploadKey({ ...base, lastModified: 11 }), uploadKey(base));
  assert.equal(uploadKey({}), ":0:0");
  assert.equal(uploadId(base, "nonce"), "track.mp3:100:10:nonce");
});
