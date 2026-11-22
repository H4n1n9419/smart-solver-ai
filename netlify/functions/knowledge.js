

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const store = getStore("smart-solver-questions");

const norm = s => String(s || "")
  .toLocaleLowerCase("id")
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim();

const hash = s =>
  crypto.createHash("sha256").update(norm(s)).digest("hex");

const key = id => `q:${id}`;

async function getIndex() {
  return (await store.get("index", { type: "json" })) || {
    ids: [],
    exact: {}
  };
}

async function saveIndex(index) {
  await store.setJSON("index", index);
}

async function getQuestion(id) {
  return await store.get(key(id), { type: "json" });
}

function similarity(a, b) {
  const words = s => new Set(
    norm(s).split(/[^a-z0-9]+/).filter(x => x.length > 2)
  );

  const A = words(a);
  const B = words(b);

  if (!A.size || !B.size) return 0;

  let count = 0;
  for (const w of A) {
    if (B.has(w)) count++;
  }

  return count / (A.size + B.size - count);
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const action = body.action;

    const admin =
      event.headers["x-admin-key"] ||
      event.headers["X-Admin-Key"] ||
      "";

    const needsAdmin = ["add", "update", "delete", "export"].includes(action);

    if (
      needsAdmin &&
      (!process.env.KNOWLEDGE_ADMIN_KEY ||
        admin !== process.env.KNOWLEDGE_ADMIN_KEY)
    ) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Kunci admin tidak cocok" })
      };
    }

    const idx = await getIndex();

    if (action === "add") {
      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();

      if (!question || !answer) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Soal dan jawaban wajib diisi" })
        };
      }

      const h = hash(question);

      if (idx.exact[h]) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            duplicate: true,
            id: idx.exact[h]
          })
        };
      }

      const id = crypto.randomUUID();
      const item = {
        id,
        question,
        answer,
        updatedAt: new Date().toISOString()
      };

      await store.setJSON(key(id), item);
      idx.ids.unshift(id);
      idx.exact[h] = id;
      await saveIndex(idx);

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, item })
      };
    }

    if (action === "update") {
      const old = await getQuestion(body.id);

      if (!old) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "Data tidak ditemukan" })
        };
      }

      const question = String(body.question || "").trim();
      const answer = String(body.answer || "").trim();

      if (!question || !answer) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Soal dan jawaban wajib diisi" })
        };
      }

      const oldHash = hash(old.question);
      const newHash = hash(question);
      const duplicate = idx.exact[newHash];

      if (duplicate && duplicate !== old.id) {
        return {
          statusCode: 409,
          body: JSON.stringify({ error: "Soal identik sudah tersimpan" })
        };
      }

      delete idx.exact[oldHash];
      idx.exact[newHash] = old.id;

      const item = {
        ...old,
        question,
        answer,
        updatedAt: new Date().toISOString()
      };

      await store.setJSON(key(old.id), item);
      await saveIndex(idx);

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, item })
      };
    }

    if (action === "delete") {
      const old = await getQuestion(body.id);

      if (!old) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: "Data tidak ditemukan" })
        };
      }

      await store.delete(key(old.id));
      idx.ids = idx.ids.filter(x => x !== old.id);
      delete idx.exact[hash(old.question)];
      await saveIndex(idx);

      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true })
      };
    }

    if (action === "search") {
      const q = String(body.query || "").trim();

      if (!q) {
        return {
          statusCode: 200,
          body: JSON.stringify({ results: [] })
        };
      }

      const exact = idx.exact[hash(q)];

      if (exact) {
        const item = await getQuestion(exact);

        return {
          statusCode: 200,
          body: JSON.stringify({
            results: item ? [{ ...item, score: 1 }] : []
          })
        };
      }

      const all = await Promise.all(idx.ids.map(getQuestion));

      const results = all
        .filter(Boolean)
        .map(x => ({
          ...x,
          score: similarity(q, x.question)
        }))
        .filter(x => x.score >= 0.18)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      return {
        statusCode: 200,
        body: JSON.stringify({ results })
      };
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

      return {
        statusCode: 200,
        body: JSON.stringify({
          items,
          total: idx.ids.length
        })
      };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Aksi tidak dikenal" })
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: e.message || "Server error"
      })
    };
  }
};
