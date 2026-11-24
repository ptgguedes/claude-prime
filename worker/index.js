/**
 * Worker « outils-api ».
 *  - Fiches modifiées des outils : R2, liaison DATA, un seul objet « state.json ».
 *  - Commentaires : D1, liaison DB, table « commentaires » (voir migrations/).
 *
 * Routes :
 *   GET    /state                              fiches modifiées + nombre de commentaires par outil
 *   PUT    /tools/:id                          remplace la fiche d'un outil   (mot de passe si EDIT_KEY existe)
 *   DELETE /tools/:id                          rétablit la fiche d'origine     (mot de passe si EDIT_KEY existe)
 *   GET    /api/outils/:id/commentaires        les 20 derniers, ?avant=<curseur> pour les plus anciens
 *   POST   /api/outils/:id/commentaires        ajoute un commentaire
 *   POST   /api/admin/reprise-r2               reprise unique des anciens commentaires de R2 (EDIT_KEY obligatoire,
 *                                              simulation par défaut, n'écrit jamais dans R2)
 *
 * Tâche planifiée (cron) : supprime chaque jour les commentaires plus vieux que RETENTION_MONTHS.
 * Variables : DATA (R2), DB (D1), ALLOWED_ORIGINS, RETENTION_MONTHS, EDIT_KEY (secret, facultatif).
 * Toutes les requêtes SQL utilisent prepare().bind() : aucune valeur n'est collée dans le SQL.
 */

const KEY = "state.json";
const MAX_BODY = 8 * 1024;
const MAX_TOOLS = 200;
const MAX_COMMENTS_PER_TOOL = 200;
const PAGE_SIZE = 20;
const LIMITS = { name: 120, url: 200, desc: 600, access: 300, author: 40, comment: 1000 };

// Mêmes listes que dans outils.html.
const CATS = ["prompts", "inspiration", "design system", "composants UI", "animation"];
const GROUPS = [
  "Code & édition",
  "App & UI",
  "Contexte, specs & intégrations",
  "Test, revue & sécurité",
  "Déploiement & exécution",
  "Espaces de travail & usage",
];

const ID_RE = /^[ab]-\d{1,3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const URL_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(\/[^\s"'<>\\]*)?$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = originAllowed(origin, env);
    const cors = corsHeaders(allowed ? origin : null);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: allowed ? 204 : 403, headers: cors });
      }

      const url = new URL(request.url);
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      const isComments =
        parts.length === 4 && parts[0] === "api" && parts[1] === "outils" && ID_RE.test(parts[2]) && parts[3] === "commentaires";

      // ----- lectures libres -----
      if (request.method === "GET" && parts.length === 1 && parts[0] === "state") {
        const state = await readState(env);
        const { counts, active } = await commentCounts(env);
        return json(
          { v: state.v, updated_at: state.updated_at, tools: state.tools, counts, commentaires: active, edit_protected: Boolean(env.EDIT_KEY) },
          200,
          cors
        );
      }
      if (request.method === "GET" && isComments) {
        return json(await listComments(env, parts[2], url.searchParams.get("avant")), 200, cors);
      }

      // ----- reprise unique depuis R2 : protégée par EDIT_KEY, utilisable sans navigateur -----
      if (request.method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "admin" && parts[2] === "reprise-r2") {
        requireKey(request, env, true);
        return json(await repriseR2(env, await readBody(request)), 200, cors);
      }

      // ----- écritures : uniquement depuis un site autorisé -----
      if (!allowed) throw new HttpError(403, "Origine non autorisée.");

      if (request.method === "POST" && isComments) {
        const comment = checkComment(await readBody(request));
        await insertComment(env, parts[2], comment);
        return json({ commentaire: comment }, 201, cors);
      }

      if (parts[0] === "tools" && ID_RE.test(parts[1] || "") && parts.length === 2) {
        const id = parts[1];

        if (request.method === "PUT") {
          requireKey(request, env);
          const tool = checkTool(id, await readBody(request));
          await mutate(env, (s) => {
            if (!(id in s.tools) && Object.keys(s.tools).length >= MAX_TOOLS) {
              throw new HttpError(409, "Trop de fiches modifiées.");
            }
            s.tools[id] = tool;
          });
          return json({ tool }, 200, cors);
        }

        if (request.method === "DELETE") {
          requireKey(request, env);
          await mutate(env, (s) => {
            delete s.tools[id];
          });
          return json({ ok: true }, 200, cors);
        }
      }

      throw new HttpError(404, "Route inconnue.");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: "Erreur du serveur." }, 500, cors);
    }
  },

  // Cron : une fois par jour.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOldComments(env));
  },
};

/* ---------- liaisons ---------- */

function r2(env) {
  if (!env.DATA) throw new HttpError(500, "Liaison R2 « DATA » absente du Worker.");
  return env.DATA;
}

function db(env) {
  if (!env.DB) throw new HttpError(500, "Liaison D1 « DB » absente du Worker.");
  return env.DB;
}

/* ---------- CORS ---------- */

function originAllowed(origin, env) {
  if (!origin) return false;
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((rule) => {
      if (!rule.includes("*")) return rule === origin;
      const re = new RegExp(
        "^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+") + "$",
        "i"
      );
      return re.test(origin);
    });
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Edit-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

/* ---------- mot de passe d'édition ---------- */

function requireKey(request, env, mandatory = false) {
  if (!env.EDIT_KEY) {
    if (mandatory) throw new HttpError(403, "Route désactivée : créez d'abord le secret EDIT_KEY dans le Worker.");
    return;
  }
  const given = request.headers.get("X-Edit-Key") || "";
  if (!safeEqual(given, String(env.EDIT_KEY))) throw new HttpError(401, "Mot de passe d'édition refusé.");
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/* ---------- contrôle des données ---------- */

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Message trop volumineux.");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Le corps doit être un objet JSON.");
  }
}

function text(value, label, max, { required = true, multiline = false } = {}) {
  if (typeof value !== "string") {
    if (required) throw new HttpError(400, `« ${label} » est obligatoire.`);
    return "";
  }
  let s = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  s = s.trim();
  if (required && !s) throw new HttpError(400, `« ${label} » est obligatoire.`);
  if (s.length > max) throw new HttpError(400, `« ${label} » dépasse ${max} caractères.`);
  return s;
}

function checkTool(id, body) {
  const tool = {
    name: text(body.name, "Nom", LIMITS.name),
    url: text(body.url, "URL", LIMITS.url).replace(/^https?:\/\//i, ""),
    desc: text(body.desc, "Description", LIMITS.desc),
  };
  if (!URL_RE.test(tool.url)) {
    throw new HttpError(400, "« URL » doit être une adresse sans espace, par exemple exemple.fr/page.");
  }
  if (id.startsWith("a-")) {
    tool.cat = text(body.cat, "Catégorie", 40);
    if (!CATS.includes(tool.cat)) throw new HttpError(400, "« Catégorie » inconnue.");
  } else {
    tool.access = text(body.access, "Access / scope", LIMITS.access);
    tool.date = text(body.date, "Vérifié le", 10);
    const d = new Date(tool.date + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tool.date) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== tool.date) {
      throw new HttpError(400, "« Vérifié le » doit être une date valide (AAAA-MM-JJ).");
    }
    tool.group = text(body.group, "Groupe", 60);
    if (!GROUPS.includes(tool.group)) throw new HttpError(400, "« Groupe » inconnu.");
  }
  return tool;
}

function checkComment(body) {
  return {
    id: crypto.randomUUID(),
    auteur: text(body.author, "Pseudo", LIMITS.author, { required: false }) || "Anonyme",
    texte: text(body.text, "Commentaire", LIMITS.comment, { multiline: true }),
    cree_le: new Date().toISOString(),
  };
}

/* ---------- R2 : fiches des outils ---------- */

async function readState(env) {
  const obj = await r2(env).get(KEY);
  if (!obj) return emptyState();
  return normalize(await obj.json());
}

function emptyState() {
  return { v: 1, updated_at: null, tools: {}, comments: {} };
}

// « comments » est l'ancien emplacement des commentaires : on le laisse tel quel dans R2 (jamais supprimé).
function normalize(s) {
  return { v: 1, updated_at: s.updated_at || null, tools: s.tools || {}, comments: s.comments || {} };
}

// Lit, modifie, réécrit seulement si personne n'a écrit entre-temps (sinon on recommence).
async function mutate(env, change) {
  const bucket = r2(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const obj = await bucket.get(KEY);
    const state = obj ? normalize(await obj.json()) : emptyState();
    change(state);
    state.updated_at = new Date().toISOString();
    const saved = await bucket.put(KEY, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: obj ? { etagMatches: obj.etag } : { etagDoesNotMatch: "*" },
    });
    if (saved) return state;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
  throw new HttpError(409, "Enregistrement en conflit : réessayez dans un instant.");
}

/* ---------- D1 : commentaires ---------- */

async function commentCounts(env) {
  if (!env.DB) return { counts: {}, active: false };
  try {
    const { results } = await env.DB
      .prepare("SELECT outil_id, COUNT(*) AS n FROM commentaires GROUP BY outil_id")
      .bind()
      .all();
    const counts = {};
    for (const row of results) counts[row.outil_id] = row.n;
    return { counts, active: true };
  } catch (err) {
    console.error("D1 indisponible :", err);
    return { counts: {}, active: false };
  }
}

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}

function decodeCursor(value) {
  try {
    const c = JSON.parse(unb64url(value));
    if (typeof c.at === "string" && ISO_RE.test(c.at) && typeof c.id === "string" && UUID_RE.test(c.id)) return c;
  } catch {
    /* curseur invalide : traité ci-dessous */
  }
  throw new HttpError(400, "Curseur « avant » invalide.");
}

// 20 commentaires, du plus récent au plus ancien. « suivant » = curseur de la page suivante (plus anciens) ou null.
async function listComments(env, outilId, cursorParam) {
  const cursor = cursorParam ? decodeCursor(cursorParam) : null;
  const stmt = cursor
    ? db(env)
        .prepare(
          `SELECT id, auteur, texte, cree_le FROM commentaires
           WHERE outil_id = ?1 AND (cree_le < ?2 OR (cree_le = ?2 AND id < ?3))
           ORDER BY cree_le DESC, id DESC LIMIT ?4`
        )
        .bind(outilId, cursor.at, cursor.id, PAGE_SIZE + 1)
    : db(env)
        .prepare(
          `SELECT id, auteur, texte, cree_le FROM commentaires
           WHERE outil_id = ?1
           ORDER BY cree_le DESC, id DESC LIMIT ?2`
        )
        .bind(outilId, PAGE_SIZE + 1);
  const { results } = await stmt.all();
  const more = results.length > PAGE_SIZE;
  const page = more ? results.slice(0, PAGE_SIZE) : results;
  const last = page[page.length - 1];
  return { commentaires: page, suivant: more ? b64url(JSON.stringify({ at: last.cree_le, id: last.id })) : null };
}

// Insertion atomique avec plafond par outil.
async function insertComment(env, outilId, c) {
  const res = await db(env)
    .prepare(
      `INSERT INTO commentaires (id, outil_id, texte, auteur, cree_le)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT COUNT(*) FROM commentaires WHERE outil_id = ?2) < ?6`
    )
    .bind(c.id, outilId, c.texte, c.auteur, c.cree_le, MAX_COMMENTS_PER_TOOL)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "Cet outil a déjà trop de commentaires.");
}

function retentionLimit(env) {
  const months = Number.parseInt(env.RETENTION_MONTHS, 10);
  if (!Number.isInteger(months) || months < 1) return null;
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

// Supprime les commentaires plus vieux que RETENTION_MONTHS, par lots.
async function purgeOldComments(env) {
  const limit = retentionLimit(env);
  if (!limit) {
    console.error("RETENTION_MONTHS invalide : purge annulée.");
    return 0;
  }
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const res = await db(env)
      .prepare("DELETE FROM commentaires WHERE id IN (SELECT id FROM commentaires WHERE cree_le < ?1 LIMIT ?2)")
      .bind(limit, BATCH)
      .run();
    const n = res.meta.changes || 0;
    total += n;
    if (n < BATCH) break;
  }
  console.log(`Purge : ${total} commentaire(s) antérieur(s) à ${limit} supprimé(s).`);
  return total;
}

/* ---------- reprise unique des anciens commentaires de R2 vers D1 ---------- */

// Lit seulement R2 (get). Insère avec INSERT OR IGNORE sur l'identifiant : relancer ne crée aucun doublon.
// Sans { "confirmer": true } dans le corps, rien n'est écrit : on renvoie seulement les chiffres.
async function repriseR2(env, body) {
  const confirm = body.confirmer === true;
  const obj = await r2(env).get(KEY);
  const legacy = obj ? (await obj.json()).comments || {} : {};
  const limit = retentionLimit(env);

  const rows = [];
  const report = { mode: confirm ? "reprise" : "simulation", trouves: 0, invalides: 0, trop_anciens: 0 };
  for (const [outilId, list] of Object.entries(legacy)) {
    if (!ID_RE.test(outilId) || !Array.isArray(list)) {
      report.invalides += Array.isArray(list) ? list.length : 1;
      continue;
    }
    for (const c of list) {
      report.trouves++;
      try {
        if (!c || typeof c.id !== "string" || !UUID_RE.test(c.id) || typeof c.at !== "string" || !ISO_RE.test(c.at)) throw new Error();
        const when = new Date(c.at);
        if (Number.isNaN(when.getTime())) throw new Error();
        const row = {
          id: c.id.toLowerCase(),
          outil_id: outilId,
          texte: text(c.text, "Commentaire", LIMITS.comment, { multiline: true }),
          auteur: text(c.author, "Pseudo", LIMITS.author, { required: false }) || "Anonyme",
          cree_le: when.toISOString(),
        };
        if (limit && row.cree_le < limit) report.trop_anciens++;
        else rows.push(row);
      } catch {
        report.invalides++;
      }
    }
  }

  // Combien sont déjà dans D1 ?
  let already = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map((r) => r.id);
    const marks = ids.map((_, k) => `?${k + 1}`).join(", "); // seulement des repères ?1, ?2… : aucune valeur dans le SQL
    const { results } = await db(env).prepare(`SELECT id FROM commentaires WHERE id IN (${marks})`).bind(...ids).all();
    already += results.length;
  }
  report.deja_presents = already;
  report.a_inserer = rows.length - already;

  if (!confirm) return report;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows
      .slice(i, i + 50)
      .map((r) =>
        db(env)
          .prepare("INSERT OR IGNORE INTO commentaires (id, outil_id, texte, auteur, cree_le) VALUES (?1, ?2, ?3, ?4, ?5)")
          .bind(r.id, r.outil_id, r.texte, r.auteur, r.cree_le)
      );
    for (const res of await db(env).batch(batch)) inserted += res.meta.changes || 0;
  }
  report.inseres = inserted;
  return report;
}
