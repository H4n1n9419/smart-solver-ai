import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" }
});
const normalize = value => String(value || "").toLocaleLowerCase("id")
  .normalize("NFKC").replace(/\s+/g, " ").trim();
const hash = value => crypto.createHash("sha256").update(normalize(value)).digest("hex");
const qkey = id => `q:${id}`;

export default async function handler(request) {
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const action = body.action;
    const adminKey = request.headers.get("x-admin-key") || "";
    const protectedActions = ["admin-check", "add", "update", "delete", "export"];
    if (protectedActions.includes(action) &&
        (!process.env.KNOWLEDGE_ADMIN_KEY || adminKey !== process.env.KNOWLEDGE_ADMIN_KEY)) {
      return reply({ error: "Kunci admin tidak cocok" }, 401);
    }
    if (action === "admin-check") return reply({ ok: true });

    const store = getStore("smart-solver-questions");
    const index = await store.get("index", { type: "json" }) || { ids: [], exact: {} };
    const saveIndex = () => store.setJSON("index", index);
    const getQuestion = id => store.get(qkey(id), { type: "json" });

    if (action === "add") {
      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();
      if (!question || !answer) return reply({ error: "Soal dan jawaban wajib diisi" }, 400);
      const digest = hash(question);
      if (index.exact[digest]) return reply({ duplicate: true, id: index.exact[digest] });
      const id = crypto.randomUUID();
      const item = { id, question, answer, updatedAt: new Date().toISOString() };
      await store.setJSON(qkey(id), item);
      index.ids.unshift(id); index.exact[digest] = id; await saveIndex();
      return reply({ ok: true, item });
    }

    if (action === "update") {
      const old = await getQuestion(body.id);
      if (!old) return reply({ error: "Data tidak ditemukan" }, 404);
      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();
      if (!question || !answer) return reply({ error: "Soal dan jawaban wajib diisi" }, 400);
      const oldHash = hash(old.question), newHash = hash(question);
      if (index.exact[newHash] && index.exact[newHash] !== old.id)
        return reply({ error: "Soal identik sudah tersimpan" }, 409);
      delete index.exact[oldHash]; index.exact[newHash] = old.id;
      const item = { ...old, question, answer, updatedAt: new Date().toISOString() };
      await store.setJSON(qkey(old.id), item); await saveIndex();
      return reply({ ok: true, item });
    }

    if (action === "delete") {
      const old = await getQuestion(body.id);
      if (!old) return reply({ error: "Data tidak ditemukan" }, 404);
      await store.delete(qkey(old.id));
      index.ids = index.ids.filter(id => id !== old.id);
      delete index.exact[hash(old.question)]; await saveIndex();
      return reply({ ok: true });
    }

    if (action === "search") {
      const query = String(body.query || "").trim();
      if (!query) return reply({ results: [] });
      const exactId = index.exact[hash(query)];
      if (exactId) {
        const item = await getQuestion(exactId);
        return reply({ results: item ? [{ ...item, score: 1 }] : [] });
      }
      const words = value => new Set(normalize(value).split(/[^a-z0-9]+/).filter(w => w.length > 2));
      const A = words(query);
      const all = await Promise.all(index.ids.map(getQuestion));
      const results = all.filter(Boolean).map(item => {
        const B = words(item.question); let common = 0;
        for (const word of A) if (B.has(word)) common++;
        const union = A.size + B.size - common;
        return { ...item, score: union ? common / union : 0 };
      }).filter(x => x.score >= 0.18).sort((a,b) => b.score-a.score).slice(0,10);
      return reply({ results });
    }

    if (action === "list" || action === "export") {
      const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 5000);
      const ids = action === "export" ? index.ids : index.ids.slice(0, limit);
      const items = (await Promise.all(ids.map(getQuestion))).filter(Boolean);
      return reply({ items, total: index.ids.length });
    }
    return reply({ error: "Aksi tidak dikenal" }, 400);
  } catch (error) {
    console.error("knowledge function:", error);
    return reply({ error: error.message || "Server error" }, 500);
  }
}
