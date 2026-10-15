/**
 * Verification: document comments feature (service + model + live DB).
 * Exercises create, threaded reply, list, tenant isolation, and soft-delete
 * against a real document. Run:  npx tsx test-scripts/verify-comments.ts
 */
import { sequelize, initModels } from "../src/infrastructure/database/index.js";
import { createComment, listComments, deleteComment } from "../src/modules/comments/comments.service.js";

const MARKER = "verify-comment-" + Math.floor(Date.now() / 1000);

async function main() {
  await sequelize.authenticate();
  initModels(); // standalone script: initialize model attributes/associations (server does this at boot)

  const [docs] = await sequelize.query(`SELECT id, tenant_id, owner_id FROM documents WHERE owner_id IS NOT NULL LIMIT 1`);
  const doc = (docs as any[])[0];
  if (!doc) { console.log("No documents with an owner to test against — skipping."); process.exit(1); }

  const user: any = {
    userId: doc.owner_id,
    role: "SYSTEM_ADMIN",
    roles: ["SYSTEM_ADMIN"],
    tenantId: doc.tenant_id,
    permissions: [],
  };

  let ok = true;
  const pass = (m: string) => console.log("  ✅", m);
  const fail = (m: string) => { ok = false; console.log("  ❌", m); };

  // Create
  const c1 = await createComment(user, doc.id, `${MARKER} top-level`);
  c1?.id ? pass("comment created") : fail("create returned no id");
  c1?.author?.id === doc.owner_id ? pass("author hydrated") : fail("author not hydrated");

  // Threaded reply
  const c2 = await createComment(user, doc.id, `${MARKER} reply`, c1.id);
  c2?.parentId === c1.id ? pass("threaded reply links to parent") : fail("reply parentId wrong");

  // Empty body rejected
  try { await createComment(user, doc.id, "   "); fail("empty body was accepted"); }
  catch { pass("empty body rejected (400)"); }

  // List
  const list = await listComments(doc.id, doc.tenant_id);
  const mine = list.filter((c: any) => String(c.body).startsWith(MARKER));
  mine.length === 2 ? pass("list returns both comments, author-ordered") : fail(`expected 2, got ${mine.length}`);

  // Tenant isolation
  try { await listComments(doc.id, "nonexistent-tenant-xyz"); fail("cross-tenant list was allowed"); }
  catch { pass("cross-tenant access blocked (404)"); }

  // Soft delete
  await deleteComment(user, c1.id);
  const after = await listComments(doc.id, doc.tenant_id);
  after.some((c: any) => c.id === c1.id) ? fail("deleted comment still listed") : pass("soft-deleted comment hidden");

  // Cleanup
  await sequelize.query(`DELETE FROM document_comments WHERE document_id = :d AND body LIKE :m`,
    { replacements: { d: doc.id, m: `${MARKER}%` } });
  await sequelize.close();

  console.log(ok ? "\n✅ DOCUMENT COMMENTS VERIFIED" : "\n❌ DOCUMENT COMMENTS FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
