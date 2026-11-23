/**
 * Worker « outils-api » : enregistre dans R2 les fiches modifiées et les commentaires de outils.html.
 *
 * R2 : un seul objet « state.json » :
 *   { v:1, updated_at, tools:{ "a-3":{…fiche complète…} }, comments:{ "a-3":[{id,author,text,at}] } }
 * Les écritures sont conditionnelles (etag) et rejouées en cas de conflit, pour ne pas perdre
 * deux commentaires envoyés en même temps.
 *
 * Routes :
 *   GET    /state                  état complet (lecture libre)
 *   PUT    /tools/:id              remplace la fiche d'un outil        (mot de passe si EDIT_KEY existe)
 *   DELETE /tools/:id              rétablit la fiche d'origine          (mot de passe si EDIT_KEY existe)
 *   POST   /tools/:id/comments     ajoute un commentaire
 *
 * Variables : BUCKET (liaison R2), ALLOWED_ORIGINS (liste), EDIT_KEY (secret, facultatif).
 */

const KEY = "state.json";
const MAX_BODY = 8 * 1024;
const MAX_TOOLS = 200;
const MAX_COMMENTS_PER_TOOL = 200;
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

      if (request.method === "GET" && parts.length === 1 && parts[0] === "state") {
        const state = await readState(env);
        return json({ ...state, edit_protected: Boolean(env.EDIT_KEY) }, 200, cors);
      }

      // Toute écriture doit venir d'un site autorisé.
      if (!allowed) throw new HttpError(403, "Origine non autorisée.");

      if (parts[0] === "tools" && ID_RE.test(parts[1] || "")) {
        const id = parts[1];

        if (parts.length === 2 && request.method === "PUT") {
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

        if (parts.length === 2 && request.method === "DELETE") {
          requireKey(request, env);
          await mutate(env, (s) => {
            delete s.tools[id];
          });
          return json({ ok: true }, 200, cors);
        }

        if (parts.length === 3 && parts[2] === "comments" && request.method === "POST") {
          const comment = checkComment(await readBody(request));
          await mutate(env, (s) => {
            const list = (s.comments[id] = s.comments[id] || []);
            if (list.length >= MAX_COMMENTS_PER_TOOL) {
              throw new HttpError(409, "Cet outil a déjà trop de commentaires.");
            }
            list.push(comment);
          });
          return json({ comment }, 201, cors);
        }
      }

      throw new HttpError(404, "Route inconnue.");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: "Erreur du serveur." }, 500, cors);
    }
  },
};

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

function requireKey(request, env) {
  if (!env.EDIT_KEY) return;
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
    author: text(body.author, "Pseudo", LIMITS.author, { required: false }) || "Anonyme",
    text: text(body.text, "Commentaire", LIMITS.comment, { multiline: true }),
    at: new Date().toISOString(),
  };
}

/* ---------- R2 ---------- */

async function readState(env) {
  const obj = await env.BUCKET.get(KEY);
  if (!obj) return emptyState();
  return normalize(await obj.json());
}

function emptyState() {
  return { v: 1, updated_at: null, tools: {}, comments: {} };
}

function normalize(s) {
  return { v: 1, updated_at: s.updated_at || null, tools: s.tools || {}, comments: s.comments || {} };
}

// Lit, modifie, réécrit seulement si personne n'a écrit entre-temps (sinon on recommence).
async function mutate(env, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const obj = await env.BUCKET.get(KEY);
    const state = obj ? normalize(await obj.json()) : emptyState();
    change(state);
    state.updated_at = new Date().toISOString();
    const saved = await env.BUCKET.put(KEY, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: obj ? { etagMatches: obj.etag } : { etagDoesNotMatch: "*" },
    });
    if (saved) return state;
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
  throw new HttpError(409, "Enregistrement en conflit : réessayez dans un instant.");
}
