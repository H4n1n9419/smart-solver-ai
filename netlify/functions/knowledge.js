
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

const norm = s => String(s || "")
  .toLocaleLowerCase("id")
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim();

const hash = s =>
  crypto.createHash("sha256").update(norm(s)).digest("hex");

const key = id => `q:${id}`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // Store dibuat di dalam handler agar Blobs mendapat konteks Netlify.
    const store = getStore("smart-solver-questions");
    const body = await req.json();
    const action = body.action;

    const admin = req.headers.get("x-admin-key") || "";
    const needsAdmin = ["add", "update", "delete", "export"].includes(action);

    if (
      needsAdmin &&
      (!process.env.KNOWLEDGE_ADMIN_KEY ||
        admin !== process.env.KNOWLEDGE_ADMIN_KEY)
    ) {
      return json({ error: "Kunci admin tidak cocok" }, 401);
    }

    const idx = await store.get("index", { type: "json" }) || {
      ids: [],
      exact: {}
    };

    const saveIndex = () => store.setJSON("index", idx);
    const getQuestion = id =>
      store.get(key(id), { type: "json" });

    if (action === "add") {
      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();

      if (!question || !answer) {
        return json({ error: "Soal dan jawaban wajib diisi" }, 400);
      }

      const h = hash(question);

      if (idx.exact[h]) {
        return json({ duplicate: true, id: idx.exact[h] });
      }

      const id = crypto.randomUUID();
      const item = {
        id, question, answer,
        updatedAt: new Date().toISOString()
      };

      await store.setJSON(key(id), item);
      idx.ids.unshift(id);
      idx.exact[h] = id;
      await saveIndex();

      return json({ ok: true, item });
    }

    if (action === "update") {
      const old = await getQuestion(body.id);
      if (!old) return json({ error: "Data tidak ditemukan" }, 404);

      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();

      if (!question || !answer) {
        return json({ error: "Soal dan jawaban wajib diisi" }, 400);
      }

      const oldHash = hash(old.question);
      const newHash = hash(question);
      const duplicate = idx.exact[newHash];

      if (duplicate && duplicate !== old.id) {
        return json({ error: "Soal identik sudah tersimpan" }, 409);
      }

      delete idx.exact[oldHash];
      idx.exact[newHash] = old.id;

      const item = {
        ...old, question, answer,
        updatedAt: new Date().toISOString()
      };

      await store.setJSON(key(old.id), item);
      await saveIndex();

      return json({ ok: true, item });
    }

    if (action === "delete") {
      const old = await getQuestion(body.id);
      if (!old) return json({ error: "Data tidak ditemukan" }, 404);

      await store.delete(key(old.id));
      idx.ids = idx.ids.filter(id => id !== old.id);
      delete idx.exact[hash(old.question)];
      await saveIndex();

      return json({ ok: true });
    }

    if (action === "search") {
      const q = String(body.query || "").trim();
      if (!q) return json({ results: [] });

      const exact = idx.exact[hash(q)];

      if (exact) {
        const item = await getQuestion(exact);
        return json({
          results: item ? [{ ...item, score: 1 }] : []
        });
      }

      const words = s => new Set(
        norm(s).split(/[^a-z0-9]+/).filter(x => x.length > 2)
      );

      const A = words(q);
      const all = await Promise.all(idx.ids.map(getQuestion));

      const results = all.filter(Boolean).map(item => {
        const B = words(item.question);
        let count = 0;
        for (const word of A) {
          if (B.has(word)) count++;
        }
        const score = A.size + B.size - count
          ? count / (A.size + B.size - count)
          : 0;
        return { ...item, score };
      })
      .filter(item => item.score >= 0.18)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

      return json({ results });
    }

    if (action === "list" || action === "export") {
      const limit = Math.min(
        Math.max(Number(body.limit) || 100, 1),
        5000
      );

      const ids = action === "export"
        ? idx.ids
        : idx.ids.slice(0, limit);

      const items = (await Promise.all(ids.map(getQuestion)))
        .filter(Boolean);

      return json({ items, total: idx.ids.length });
    }

    return json({ error: "Aksi tidak dikenal" }, 400);

  } catch (error) {
    console.error("Knowledge function error:", error);
    return json({
      error: error.message || "Server error"
    }, 500);
  }
}
